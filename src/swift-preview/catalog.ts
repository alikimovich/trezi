import { basename, relative } from 'node:path'
import type { NativePreviewEntry } from '../shared/api'
import { initCall, type KnownType, type SampleContext, sampleFor, type TypeIndex } from './samples'
import type { ScannedFile, ScannedPreview, ScannedType } from './scanner'
import { maxVersion } from './settings'

/**
 * What a project with no manifest can preview (LKM-276), from the scanner's output:
 * every `#Preview` and `PreviewProvider` of the target's modules, and every SwiftUI
 * view, AppKit `NSView` and `NSViewController` as a picker component with inferred
 * sample state (`samples.ts`). Each entry is supported or says why not; a supported
 * one comes with the factory `generate.ts` writes for it. A factory that needs a
 * file's private declarations is built into an isolated copy of that file (an
 * overlay), all others into a companion file; the original is never changed. Pure.
 */
export type CatalogEntry = NativePreviewEntry

export interface Factory {
  id: string
  title: string
  kind: string
  module: string
  /** The original file (absolute). */
  file: string
  /** Built into the overlay of `file` (it uses the file's private declarations). */
  overlay: boolean
  conditions: string[]
  /** The declaration's own `@available` attributes. */
  availability: string[]
  /** At least 14.0 (the AppKit preview builders and the host need it). */
  macOS: string
  size: { width: string; height: string } | null
  body:
    | { type: 'preview'; preview: ScannedPreview }
    | { type: 'value'; wrap: 'swiftUI' | 'view' | 'controller'; expr: string }
}

export interface CatalogModule {
  module: string
  /** Absolute sources compiled into the module. */
  sources: string[]
  /** Absolute app-entry files left out of it. */
  entries: string[]
}

const VIEW_BASES = new Set(
  'NSView NSControl NSButton NSTextField NSTextView NSImageView NSStackView NSScrollView NSTableView NSOutlineView NSCollectionView NSVisualEffectView NSBox NSSplitView NSTabView NSProgressIndicator NSSlider NSSegmentedControl NSPopUpButton NSGridView NSClipView NSSearchField NSSecureTextField NSComboBox NSDatePicker NSColorWell NSLevelIndicator NSPathControl NSSwitch NSStepper'.split(
    ' '
  )
)
const CONTROLLER_BASES = new Set(['NSViewController', 'NSTitlebarAccessoryViewController'])
const OWN_VIEW_CONTROLLERS = new Set([
  'NSSplitViewController',
  'NSTabViewController',
  'NSPageController'
])
const ORIENTATIONS = new Set([
  '.portrait',
  '.portraitUpsideDown',
  '.landscapeLeft',
  '.landscapeRight'
])

const strip = (name: string) => name.replace(/^(SwiftUI|AppKit)\./, '')

export function availability(attributes: string[]): { unavailable: string; macOS: string } {
  let macOS = ''
  let unavailable = ''
  for (const attribute of attributes) {
    const inner = /^@available\s*\((.*)\)$/s.exec(attribute.trim())?.[1]
    if (!inner) continue
    if (/^\s*(\*|macOS)\s*,\s*unavailable\b/.test(inner)) unavailable = attribute
    const version =
      /\bmacOS\s+(\d+(?:\.\d+)*)/.exec(inner)?.[1] ??
      /\bmacOS\s*,\s*introduced:\s*(\d+(?:\.\d+)*)/.exec(inner)?.[1]
    if (version) macOS = maxVersion(macOS, version)
  }
  return { unavailable, macOS }
}

/** Every scanned type by name and qualified name, its extensions merged in. */
export function indexTypes(modules: CatalogModule[], scans: Map<string, ScannedFile>): TypeIndex {
  const types = new Map<string, KnownType[]>()
  const add = (key: string, known: KnownType) => types.set(key, [...(types.get(key) ?? []), known])
  const extensions: { decl: ScannedType; module: string }[] = []
  for (const { module, sources, entries } of modules)
    for (const file of [...sources, ...entries])
      for (const decl of scans.get(file)?.types ?? []) {
        if (decl.kind === 'extension') {
          extensions.push({ decl, module })
          continue
        }
        const known: KnownType = {
          decl,
          module,
          file,
          inits: [...decl.inits],
          inherits: [...decl.inherits],
          methods: [...decl.methods]
        }
        add(decl.qualified, known)
        if (decl.nested) add(decl.name, known)
      }
  for (const { decl, module } of extensions)
    for (const known of types.get(decl.qualified) ?? [])
      if (
        known.decl.qualified === decl.qualified &&
        (known.module === module || decl.inits.length === 0)
      ) {
        known.inits.push(...decl.inits)
        known.inherits.push(...decl.inherits)
        known.methods.push(...decl.methods)
      }
  return { types }
}

function role(
  known: KnownType,
  index: TypeIndex,
  seen = new Set<string>()
): { kind: 'swiftUI' | 'view' | 'controller' | ''; loadsView: boolean } {
  const inherits = known.inherits.map(strip)
  if (inherits.includes('View') && known.decl.kind !== 'class')
    return { kind: 'swiftUI', loadsView: false }
  if (known.decl.kind !== 'class' || !inherits.length) return { kind: '', loadsView: false }
  const base = inherits[0]
  const loadsView = known.methods.includes('loadView')
  if (VIEW_BASES.has(base)) return { kind: 'view', loadsView }
  if (CONTROLLER_BASES.has(base)) return { kind: 'controller', loadsView }
  if (OWN_VIEW_CONTROLLERS.has(base)) return { kind: 'controller', loadsView: true }
  if (seen.has(base)) return { kind: '', loadsView }
  seen.add(base)
  const parent = (index.types.get(base) ?? []).find((t) => t.decl.kind === 'class')
  if (!parent) return { kind: inherits.includes('View') ? 'swiftUI' : '', loadsView }
  const found = role(parent, index, seen)
  return { kind: found.kind, loadsView: loadsView || found.loadsView }
}

function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

/** The Swift name of an entry's generated factory. */
export const factoryName = (id: string) => `__trezi_${hash(id)}`

function traits(preview: ScannedPreview): {
  size: Factory['size']
  notes: string[]
  reason: string
} {
  const notes: string[] = []
  let size: Factory['size'] = null
  for (const trait of preview.traits) {
    const fixed = /^\.fixedLayout\(\s*width:\s*(.+?)\s*,\s*height:\s*(.+?)\s*\)$/s.exec(trait)
    if (fixed) {
      size = { width: fixed[1], height: fixed[2] }
      notes.push(`fixed size ${fixed[1]}×${fixed[2]}`)
    } else if (trait === '.sizeThatFitsLayout' || trait === '.defaultLayout')
      notes.push('sized to fit')
    else if (ORIENTATIONS.has(trait) || trait === '.assistiveAccess')
      notes.push(`${trait} applies to iOS devices and is ignored on macOS`)
    else if (trait.startsWith('.modifier('))
      return {
        size,
        notes,
        reason: `uses a preview modifier trait (${trait}); its async shared context is not created by Trezi yet`
      }
    else return { size, notes, reason: `uses the trait ${trait}, which Trezi does not know` }
  }
  return { size, notes, reason: '' }
}

export function buildCatalog(input: {
  root: string
  modules: CatalogModule[]
  scans: Map<string, ScannedFile>
  /** Entries a failed build ruled out, with the compiler's reason. */
  rejected?: Record<string, string>
}): { entries: CatalogEntry[]; factories: Factory[] } {
  const { root, modules, scans } = input
  const rejected = input.rejected ?? {}
  const index = indexTypes(modules, scans)
  const entries: CatalogEntry[] = []
  const factories: Factory[] = []
  const push = (
    entry: CatalogEntry,
    factory: Omit<Factory, 'id' | 'title' | 'kind' | 'module'> | null
  ) => {
    if (entry.supported && rejected[entry.id]) {
      entry.supported = false
      entry.reason = rejected[entry.id]
    }
    entries.push(entry)
    if (entry.supported && factory)
      factories.push({
        ...factory,
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        module: entry.module
      })
  }
  for (const { module, sources, entries: entryFiles } of modules)
    for (const file of [...sources, ...entryFiles]) {
      const scan = scans.get(file)
      if (!scan) continue
      const rel = relative(root, file)
      const isEntry = entryFiles.includes(file)
      const unnamed = scan.previews.filter((p) => !p.name).length
      const privateNames = new Set(scan.privateNames)
      for (const preview of scan.previews) {
        const stem = basename(file, '.swift')
        const entry: CatalogEntry = {
          id: `preview:${rel}#${preview.index}`,
          title: preview.name ?? `${stem}${unnamed > 1 ? ` ${preview.index}` : ''}`,
          source: 'preview',
          kind: '#Preview',
          module,
          file: rel,
          line: preview.line,
          supported: true,
          reason: '',
          notes: []
        }
        const layout = traits(preview)
        const available = availability(preview.attributes)
        const overlay = preview.identifiers.some((name) => privateNames.has(name))
        entry.notes.push(...layout.notes)
        if (preview.previewable.length) entry.notes.push('@Previewable state')
        if (overlay)
          entry.notes.push(`uses private declarations of ${rel}: built from an isolated copy`)
        if (available.macOS) entry.notes.push(`needs macOS ${available.macOS}`)
        if (preview.conditions.length)
          entry.notes.push(`only where #if ${preview.conditions.join(' && ')}`)
        if (preview.nameExpr) entry.notes.push(`named by ${preview.nameExpr}`)
        entry.reason = isEntry
          ? 'it is in the app entry file (@main), which the preview build leaves out'
          : preview.context !== 'file'
            ? 'it is inside a type; only file-scope #Preview blocks are listed'
            : preview.problems.length
              ? `it has ${preview.problems.join(', ')}`
              : preview.previewableAfter
                ? '@Previewable declarations come after other statements'
                : available.unavailable
                  ? `it is unavailable on macOS (${available.unavailable})`
                  : layout.reason
        entry.supported = !entry.reason
        push(entry, {
          file,
          overlay,
          conditions: preview.conditions,
          availability: preview.attributes.filter((a) => a.startsWith('@available')),
          macOS: maxVersion('14.0', available.macOS),
          size: layout.size,
          body: { type: 'preview', preview }
        })
      }
      for (const decl of scan.types) {
        if (decl.kind === 'extension' || decl.name.startsWith('__Trezi')) continue
        const known = (index.types.get(decl.qualified) ?? []).find((t) => t.decl === decl)
        if (!known) continue
        const inherits = known.inherits.map(strip)
        if (
          decl.attributes.includes('@main') ||
          inherits.some((i) => ['App', 'Scene', 'PreviewModifier'].includes(i))
        )
          continue
        const provider = inherits.includes('PreviewProvider')
        const found = provider ? { kind: 'swiftUI' as const, loadsView: false } : role(known, index)
        if (!found.kind) continue
        const kind = provider
          ? 'PreviewProvider'
          : { swiftUI: 'SwiftUI view', view: 'AppKit view', controller: 'AppKit view controller' }[
              found.kind
            ]
        const entry: CatalogEntry = {
          id: provider
            ? `provider:${rel}#${decl.qualified}`
            : `component:${module}.${decl.qualified}`,
          title: decl.qualified,
          source: provider ? 'provider' : 'component',
          kind,
          module,
          file: rel,
          line: decl.line,
          supported: true,
          reason: '',
          notes: []
        }
        const available = availability(decl.attributes)
        const filePrivate = decl.access === 'private' || decl.access === 'fileprivate'
        let expr = ''
        let overlay = filePrivate
        let reason = isEntry
          ? 'it is in the app entry file (@main), which the preview build leaves out'
          : decl.generic
            ? 'it is generic; Trezi cannot choose its type parameters'
            : decl.parentPrivate || (decl.nested && decl.access === 'private')
              ? 'it is private inside another type, out of reach of a generated preview'
              : available.unavailable
                ? `it is unavailable on macOS (${available.unavailable})`
                : found.kind === 'controller' && !found.loadsView
                  ? 'it loads its view from a nib or storyboard (no loadView), which Trezi does not compile'
                  : ''
        if (!reason && provider) expr = `${decl.qualified}.previews`
        else if (!reason) {
          const context: SampleContext = { module, file, index, depth: 0 }
          const made = initCall(known, context)
          if ('error' in made) reason = `Trezi cannot make one: ${made.error}`
          else {
            expr = made.expr
            overlay ||= made.filePrivate
            for (const p of known.decl.properties) {
              if (p.isStatic || p.computed) continue
              // `@Environment(Store.self)` reads an observable object; a key path reads a value.
              const environment = /^\(?\s*([\w.]+)\.self\s*\)?$/.exec(p.wrapperArgs)
              const type =
                p.wrapper === 'EnvironmentObject'
                  ? p.type
                  : p.wrapper === 'Environment'
                    ? environment?.[1]
                    : ''
              if (!type) continue
              const value = sampleFor(type, p.name, context)
              if ('error' in value) {
                reason = `it reads ${type} from the environment and Trezi cannot make one: ${value.error}`
                break
              }
              overlay ||= value.filePrivate
              expr +=
                p.wrapper === 'EnvironmentObject'
                  ? `.environmentObject(${value.expr})`
                  : `.environment(${value.expr})`
              entry.notes.push(`injects ${type} into the environment`)
            }
          }
        }
        entry.reason = reason
        entry.supported = !reason
        if (expr && !provider) entry.sample = expr
        if (overlay)
          entry.notes.push(`uses private declarations of ${rel}: built from an isolated copy`)
        if (available.macOS) entry.notes.push(`needs macOS ${available.macOS}`)
        if (decl.conditions.length)
          entry.notes.push(`only where #if ${decl.conditions.join(' && ')}`)
        push(entry, {
          file,
          overlay,
          conditions: decl.conditions,
          availability: decl.attributes.filter((a) => a.startsWith('@available')),
          macOS: maxVersion('14.0', available.macOS),
          size: null,
          body: { type: 'value', wrap: found.kind, expr }
        })
      }
    }
  const order = { preview: 0, provider: 1, component: 2 }
  entries.sort((a, b) => order[a.source] - order[b.source])
  return { entries, factories }
}
