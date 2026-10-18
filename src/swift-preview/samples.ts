import type { ScannedInit, ScannedParam, ScannedType } from './scanner'

/**
 * Sample values for a component's parameters (LKM-276): the expression a generated
 * preview passes for each required parameter, inferred from its type alone. Strings
 * are the parameter's name ("title" → "Title"), numbers small, flags true, optionals
 * nil, collections hold one sample, bindings are constant, closures do nothing; scanned
 * enums use their first case without associated values and scanned structs and classes
 * their simplest initializer, two levels deep. What cannot be made says so. Pure.
 */
export interface TypeIndex {
  /** Scanned types by name and qualified name, extensions merged in. */
  types: Map<string, KnownType[]>
}

export interface KnownType {
  decl: ScannedType
  module: string
  /** Absolute path of the declaring file. */
  file: string
  /** Initializers from the type and its extensions (only the type's own replace the memberwise one). */
  inits: ScannedInit[]
  inherits: string[]
  /** Methods from the type and its extensions. */
  methods: string[]
}

export interface SampleContext {
  /** The module and file the generated code lives in. */
  module: string
  file: string
  index: TypeIndex
  depth: number
}

export type Sample = { expr: string; filePrivate: boolean } | { error: string }

const KNOWN: Record<string, string> = {
  Int: '1',
  Int8: '1',
  Int16: '1',
  Int32: '1',
  Int64: '1',
  UInt: '1',
  UInt8: '1',
  UInt16: '1',
  UInt32: '1',
  UInt64: '1',
  Double: '0.5',
  Float: '0.5',
  CGFloat: '0.5',
  TimeInterval: '1',
  Bool: 'true',
  Character: '"A"',
  Date: 'Date(timeIntervalSince1970: 0)',
  URL: 'URL(fileURLWithPath: "/")',
  UUID: 'UUID(uuidString: "00000000-0000-0000-0000-000000000000")!',
  Data: 'Data()',
  CGSize: 'CGSize(width: 120, height: 80)',
  NSSize: 'NSSize(width: 120, height: 80)',
  CGPoint: '.zero',
  NSPoint: '.zero',
  CGRect: 'CGRect(x: 0, y: 0, width: 120, height: 80)',
  NSRect: 'NSRect(x: 0, y: 0, width: 120, height: 80)',
  Color: '.accentColor',
  NSColor: '.controlAccentColor',
  Font: '.body',
  NSFont: '.systemFont(ofSize: 13)',
  Image: 'Image(systemName: "star")',
  NSImage: 'NSImage(systemSymbolName: "star", accessibilityDescription: nil)!',
  AnyView: 'AnyView(EmptyView())',
  EmptyView: 'EmptyView()',
  Text: 'Text("Text")'
}
const STRINGS = new Set(['String', 'Substring', 'LocalizedStringKey', 'LocalizedStringResource'])

/** "projectTitle" → "Project title". */
export function words(name: string): string {
  const spaced = name
    .replace(/^_+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : 'Text'
}

/** Splits at top-level commas (outside (), [], <>). */
export function splitTop(text: string, separator = ','): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if ('([<{'.includes(char)) depth++
    if (')]>}'.includes(char)) depth--
    if (char === separator && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function stripAttributes(type: string): string {
  return type
    .replace(/^(?:(?:@\w+(?:\([^)]*\))?|inout|borrowing|consuming|sending)\s+)+/, '')
    .trim()
}

/** The return type of a function type, and its parameter count; null when it is not one. */
function functionType(type: string): { params: number; returns: string } | null {
  if (!type.startsWith('(')) return null
  let depth = 0
  for (let i = 0; i < type.length; i++) {
    if (type[i] === '(') depth++
    if (type[i] === ')' && --depth === 0) {
      const after = type.slice(i + 1).trim()
      const arrow = /^(?:async\s+)?(?:throws(?:\([^)]*\))?\s+)?->\s*(.+)$/.exec(after)
      if (!arrow) return null
      const inner = type.slice(1, i).trim()
      return { params: inner ? splitTop(inner).length : 0, returns: arrow[1].trim() }
    }
  }
  return null
}

export function sampleFor(type: string, name: string, context: SampleContext): Sample {
  const t = stripAttributes(type)
  if (!t) return { error: `${name} has no written type` }
  if (/[?!]$/.test(t) || /^Optional</.test(t)) return { expr: 'nil', filePrivate: false }
  if (STRINGS.has(t)) return { expr: JSON.stringify(words(name)), filePrivate: false }
  if (KNOWN[t]) return { expr: KNOWN[t], filePrivate: false }
  const fn = functionType(t)
  if (fn) {
    const params = fn.params ? `${Array(fn.params).fill('_').join(', ')} in ` : ''
    if (/^(Void|\(\))$/.test(fn.returns)) return { expr: `{ ${params}}`, filePrivate: false }
    const value = sampleFor(fn.returns, name, context)
    return 'error' in value ? value : { ...value, expr: `{ ${params}${value.expr} }` }
  }
  const binding = /^Binding<(.+)>$/.exec(t)
  if (binding) {
    const value = sampleFor(binding[1], name, context)
    return 'error' in value ? value : { ...value, expr: `.constant(${value.expr})` }
  }
  const array = /^\[(.+)\]$/.exec(t)
  if (array) {
    if (splitTop(array[1], ':').length > 1) return { expr: '[:]', filePrivate: false }
    const value = sampleFor(array[1], singular(name), context)
    return 'error' in value
      ? { expr: '[]', filePrivate: false }
      : { ...value, expr: `[${value.expr}]` }
  }
  if (/^(Array|Set|ContiguousArray)<.+>$/.test(t)) return { expr: '[]', filePrivate: false }
  if (/^Dictionary<.+>$/.test(t)) return { expr: '[:]', filePrivate: false }
  if (/^(some|any)\s/.test(t) || t.includes('&'))
    return { error: `${name}: ${t} is an existential or opaque type` }
  return construct(t, context, name)
}

function singular(name: string): string {
  return name.length > 3 && name.endsWith('s') ? name.slice(0, -1) : name
}

/** The visible scanned type named `name` (same module first), or why there is none. */
export function findType(name: string, context: SampleContext): KnownType | string {
  const found = (context.index.types.get(name) ?? []).filter((t) => t.decl.kind !== 'extension')
  if (!found.length) return `${name} is not a type Trezi found in the target's sources`
  const visible = found.filter((t) => visibleFrom(t, context))
  if (!visible.length) return `${name} is not visible from the generated preview`
  return visible.find((t) => t.module === context.module) ?? visible[0]
}

function visibleFrom(known: KnownType, context: SampleContext): boolean {
  const { access } = known.decl
  if (known.module !== context.module) return access === 'public' || access === 'open'
  if (access === 'private' || access === 'fileprivate')
    return (
      known.file === context.file &&
      !known.decl.parentPrivate &&
      !(access === 'private' && known.decl.nested)
    )
  return true
}

function construct(name: string, context: SampleContext, param: string): Sample {
  if (context.depth > 2) return { error: `${param}: ${name} nests too deeply to sample` }
  const known = findType(name, context)
  if (typeof known === 'string') return { error: `${param}: ${known}` }
  const filePrivate = known.decl.access === 'private' || known.decl.access === 'fileprivate'
  if (known.decl.kind === 'enum') {
    const first = known.decl.cases.find((c) => !c.associated)
    return first
      ? { expr: `${known.decl.qualified}.${first.name}`, filePrivate }
      : { error: `${param}: the enum ${name} has no case without associated values` }
  }
  if (known.decl.generic) return { error: `${param}: ${name} is generic` }
  const made = initCall(known, { ...context, depth: context.depth + 1 })
  return 'error' in made
    ? { error: `${param}: ${made.error}` }
    : { ...made, filePrivate: filePrivate || made.filePrivate }
}

const NO_PARAM_WRAPPERS = new Set([
  'Environment',
  'EnvironmentObject',
  'FocusState',
  'FocusedValue',
  'FocusedBinding',
  'Namespace',
  'GestureState',
  'ScaledMetric'
])

/**
 * The memberwise initializer of a struct, as Swift synthesizes it (checked against
 * swiftc 6.3, LKM-277): a `var` of sugared optional type starts as nil, plain or
 * `@State`; a private wrapped property with a value is not a parameter at all; any
 * other private property makes the initializer private.
 */
export function memberwise(decl: ScannedType): ScannedInit | null {
  if (decl.kind !== 'struct') return null
  const params: ScannedParam[] = []
  let access = 'internal'
  for (const p of decl.properties) {
    if (p.isStatic || p.computed || (p.isLet && p.hasDefault)) continue
    if (p.wrapper && (NO_PARAM_WRAPPERS.has(p.wrapper) || p.wrapperArgs)) continue
    const hasDefault =
      p.hasDefault ||
      (!p.isLet && (!p.wrapper || p.wrapper === 'State') && /[?!]$/.test(p.type.trim()))
    const hidden = p.access === 'private' || p.access === 'fileprivate'
    if (hidden && p.wrapper && hasDefault) continue
    if (hidden) access = 'fileprivate'
    const type = p.wrapper === 'Binding' ? `Binding<${p.type}>` : p.type
    params.push({ label: p.name, name: p.name, type, hasDefault })
  }
  return { access, failable: false, effects: '', params, line: decl.line }
}

/**
 * The simplest call that makes `known`: the usable initializer whose required
 * parameters all have samples, fewest first.
 */
export function initCall(known: KnownType, context: SampleContext): Sample {
  const { decl } = known
  const own = decl.inits
  const candidates: ScannedInit[] = [...known.inits]
  const synthesized = !own.length ? memberwise(decl) : null
  if (synthesized) candidates.push(synthesized)
  if (decl.kind === 'class' && !own.length)
    candidates.push({
      access: 'internal',
      failable: false,
      effects: '',
      params: [],
      line: decl.line
    })
  const sameFile = known.file === context.file
  const crossModule = known.module !== context.module
  let lastError = `${decl.qualified} has no initializer Trezi can call`
  const usable = candidates
    .filter((i) => !i.failable && !/throws|async/.test(i.effects))
    .filter((i) => !i.params.some((p) => p.label === 'coder'))
    .filter((i) => {
      if (crossModule) return i.access === 'public' || i.access === 'open'
      return (i.access !== 'private' && i.access !== 'fileprivate') || sameFile
    })
    .sort((a, b) => required(a) - required(b))
  for (const init of usable) {
    const args: string[] = []
    let filePrivate = init.access === 'private' || init.access === 'fileprivate'
    let failed = ''
    for (const p of init.params) {
      if (p.hasDefault) continue
      const value = sampleFor(p.type, p.name, context)
      if ('error' in value) {
        failed = value.error
        break
      }
      filePrivate ||= value.filePrivate
      args.push(p.label === '_' ? value.expr : `${p.label}: ${value.expr}`)
    }
    if (failed) {
      lastError = `needs ${failed}`
      continue
    }
    return { expr: `${decl.qualified}(${args.join(', ')})`, filePrivate }
  }
  return { error: lastError }
}

function required(init: ScannedInit): number {
  return init.params.filter((p) => !p.hasDefault).length
}
