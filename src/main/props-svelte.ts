import { readdir, readFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative } from 'path'
import type { PropEdit, PropEditResult, PropField, PropInspection, PropKind } from '../shared/api'
import {
  agentPromptFor,
  type CurrentAttr,
  commitEdit,
  isValidAttrName,
  mergeFields,
  type ResolvedSource,
  textAgentPrompt,
  withinRoot
} from './props'
import { pickInstance, type SvelteUsage } from './svelte-instance'

/**
 * Svelte adapter for the prop editor — the `.svelte` counterpart of the
 * React/JSX engine in props.ts. Same contract: given a `data-trezi-source` stamp,
 * find the element on that line/column, read its literal attributes, resolve a
 * component prop schema (`export let` for Svelte 4, `$props()` destructuring for
 * Svelte 5, with TS types → enums when present), and apply simple literal edits
 * by splicing source (the dev server hot-reloads). Non-literal values go to the
 * agent, exactly like the React path.
 *
 * svelte/compiler is ESM-only, so it's loaded via dynamic import() like the
 * other ESM engines (Agent SDK, babel, react-docgen).
 */

type SvelteCompiler = typeof import('svelte/compiler')
let sveltePromise: Promise<SvelteCompiler> | null = null
const loadSvelte = (): Promise<SvelteCompiler> => (sveltePromise ??= import('svelte/compiler'))

export interface Node {
  type?: string
  start?: number
  end?: number
  name?: string
  attributes?: Node[]
  value?: unknown
  [k: string]: unknown
}

const ELEMENT_TYPES = new Set([
  'RegularElement',
  'Component',
  'SvelteComponent',
  'SvelteElement',
  'SvelteSelf'
])

/** Offset → 1-based line / 0-based column (column matches babel's convention). */
function makeLocator(code: string): (offset: number) => { line: number; column: number } {
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: offset - starts[lo] }
  }
}

function collectElements(node: unknown, out: Node[]): void {
  if (!node || typeof node !== 'object') return
  const n = node as Node
  if (typeof n.type === 'string' && ELEMENT_TYPES.has(n.type) && typeof n.start === 'number') {
    out.push(n)
  }
  for (const key of Object.keys(n)) {
    if (key === 'parent') continue
    const v = (n as Record<string, unknown>)[key]
    if (Array.isArray(v)) for (const c of v) collectElements(c, out)
    else if (v && typeof v === 'object') collectElements(v, out)
  }
}

/** The element the stamp points at (mirrors the React findElementAtLine logic). */
export function findElement(root: Node, code: string, line: number, column?: number): Node | null {
  const els: Node[] = []
  collectElements((root as { fragment?: unknown }).fragment ?? root, els)
  const at = makeLocator(code)
  const lc = (n: Node) => at(n.start ?? 0)

  const sameLine = els.filter((e) => lc(e).line === line)
  if (sameLine.length) {
    if (column != null) {
      const exact = sameLine.find((e) => lc(e).column === column)
      if (exact) return exact
      const atOrBefore = sameLine
        .filter((e) => lc(e).column <= column)
        .sort((a, b) => lc(b).column - lc(a).column)[0]
      return atOrBefore ?? [...sameLine].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0]
    }
    // Innermost element starting on the line (highest start offset).
    return [...sameLine].sort((a, b) => (b.start ?? 0) - (a.start ?? 0))[0]
  }
  const enclosing = els
    .filter((e) => at(e.start ?? 0).line <= line && at(e.end ?? 0).line >= line)
    .sort((a, b) => (b.start ?? 0) - (a.start ?? 0))[0]
  return enclosing ?? null
}

function literalFrom(
  expr: Node | undefined
): { kind: PropKind; value: string | number | boolean } | null {
  if (!expr) return null
  if (expr.type === 'Literal') {
    const v = (expr as { value?: unknown }).value
    if (typeof v === 'string') return { kind: 'string', value: v }
    if (typeof v === 'number') return { kind: 'number', value: v }
    if (typeof v === 'boolean') return { kind: 'boolean', value: v }
  }
  if (
    expr.type === 'UnaryExpression' &&
    (expr as { operator?: string }).operator === '-' &&
    (expr.argument as Node)?.type === 'Literal' &&
    typeof (expr.argument as { value?: unknown }).value === 'number'
  ) {
    return { kind: 'number', value: -Number((expr.argument as { value: number }).value) }
  }
  return null
}

/** Read literal attributes off a Svelte element (skips spreads, directives, bindings). */
function readAttributes(el: Node): CurrentAttr[] {
  const out: CurrentAttr[] = []
  for (const attr of el.attributes ?? []) {
    if (attr.type !== 'Attribute') continue
    const name = attr.name
    if (typeof name !== 'string' || !isValidAttrName(name)) continue
    const start = attr.start ?? 0
    const end = attr.end ?? 0
    const value = attr.value
    if (value === true) {
      out.push({ name, kind: 'boolean', value: true, start, end })
      continue
    }
    // `name="x"` → value is an array of Text/ExpressionTag; `name={x}` → value is
    // a single ExpressionTag object. A single literal node is editable; a
    // concatenation (array length > 1) is not.
    let v: Node | null = null
    if (Array.isArray(value)) {
      if (value.length === 1) v = value[0] as Node
    } else if (value && typeof value === 'object') {
      v = value as Node
    }
    if (v?.type === 'Text') {
      out.push({
        name,
        kind: 'string',
        value: String((v as { data?: string }).data ?? ''),
        start,
        end
      })
    } else if (v && (v.type === 'ExpressionTag' || v.type === 'MustacheTag')) {
      const lit = literalFrom(v.expression as Node)
      if (lit) out.push({ name, ...lit, start, end })
      else out.push({ name, kind: 'other', expression: true, start, end })
    } else {
      out.push({ name, kind: 'other', expression: true, start, end })
    }
  }
  return out
}

// --- schema extraction (best-effort) ----------------------------------------

function kindFromTsType(typeNode: Node | undefined): { kind: PropKind; options?: string[] } | null {
  if (!typeNode) return null
  if (typeNode.type === 'TSStringKeyword') return { kind: 'string' }
  if (typeNode.type === 'TSNumberKeyword') return { kind: 'number' }
  if (typeNode.type === 'TSBooleanKeyword') return { kind: 'boolean' }
  if (typeNode.type === 'TSUnionType' && Array.isArray((typeNode as { types?: Node[] }).types)) {
    const types = (typeNode as { types: Node[] }).types
    const lits = types
      .map((t) =>
        t.type === 'TSLiteralType' && (t.literal as Node)?.type === 'Literal'
          ? (t.literal as { value?: unknown }).value
          : undefined
      )
      .filter((v): v is string => typeof v === 'string')
    if (lits.length && lits.length === types.length) return { kind: 'enum', options: lits }
  }
  return null
}

const annotationType = (typeAnnotation: Node | undefined): Node | undefined =>
  (typeAnnotation as { typeAnnotation?: Node } | undefined)?.typeAnnotation

/** name → its TS type node, from an `interface Props {}` / `type Props = {}`. */
function collectTypeMembers(body: Node[], typeName: string): Map<string, Node> {
  const members = new Map<string, Node>()
  const readSignatures = (sigs: Node[] | undefined): void => {
    for (const m of sigs ?? []) {
      if (m.type !== 'TSPropertySignature') continue
      const key = (m.key as { name?: string } | undefined)?.name
      const t = annotationType(m.typeAnnotation as Node)
      if (key && t) members.set(key, t)
    }
  }
  for (const stmt of body) {
    if (
      stmt.type === 'TSInterfaceDeclaration' &&
      (stmt.id as { name?: string })?.name === typeName
    ) {
      readSignatures((stmt.body as { body?: Node[] } | undefined)?.body)
    } else if (
      stmt.type === 'TSTypeAliasDeclaration' &&
      (stmt.id as { name?: string })?.name === typeName &&
      (stmt.typeAnnotation as Node)?.type === 'TSTypeLiteral'
    ) {
      readSignatures((stmt.typeAnnotation as { members?: Node[] }).members)
    }
  }
  return members
}

function fieldFrom(name: string, tsType: Node | undefined, defInit: Node | undefined): PropField {
  let kind: PropKind = 'other'
  let options: string[] | undefined
  const literal = literalFrom(defInit)
  const fromType = kindFromTsType(tsType)
  if (fromType) {
    kind = fromType.kind
    options = fromType.options
  } else if (literal) {
    kind = literal.kind
  }
  return {
    name,
    kind,
    ...(options ? { options } : {}),
    fromSchema: true,
    ...(literal ? { default: literal.value } : defInit ? { defaultExpression: true } : {})
  }
}

/** Extract a component's props from its instance-script Program (Svelte 4 + 5). */
function extractProps(program: Node | undefined): PropField[] {
  const body = ((program as { body?: Node[] } | undefined)?.body ?? []) as Node[]
  const fields: PropField[] = []
  const seen = new Set<string>()
  const add = (f: PropField): void => {
    if (!isValidAttrName(f.name) || seen.has(f.name)) return
    seen.add(f.name)
    fields.push(f)
  }

  // Svelte 4: `export let name (: Type) (= default)`
  for (const stmt of body) {
    if (
      stmt.type === 'ExportNamedDeclaration' &&
      (stmt.declaration as Node)?.type === 'VariableDeclaration' &&
      (stmt.declaration as { kind?: string }).kind === 'let'
    ) {
      for (const d of ((stmt.declaration as { declarations?: Node[] }).declarations ??
        []) as Node[]) {
        const id = d.id as Node
        if (id?.type !== 'Identifier' || typeof id.name !== 'string') continue
        add(fieldFrom(id.name, annotationType(id.typeAnnotation as Node), d.init as Node))
      }
    }
  }

  // Svelte 5: `let { a = 1, b }: Props = $props()`
  for (const stmt of body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const d of ((stmt as { declarations?: Node[] }).declarations ?? []) as Node[]) {
      const init = d.init as Node
      const isProps =
        init?.type === 'CallExpression' &&
        (init.callee as { name?: string } | undefined)?.name === '$props'
      const id = d.id as Node
      if (!isProps || id?.type !== 'ObjectPattern') continue
      // Resolve a Props type from `: Props` or `$props<Props>()`, else just "Props".
      const annoRef = (
        annotationType(id.typeAnnotation as Node) as { typeName?: { name?: string } } | undefined
      )?.typeName?.name
      const targ = ((init.typeArguments ?? init.typeParameters) as { params?: Node[] } | undefined)
        ?.params?.[0] as { typeName?: { name?: string } } | undefined
      const members = collectTypeMembers(body, annoRef ?? targ?.typeName?.name ?? 'Props')
      for (const p of (id.properties as Node[] | undefined) ?? []) {
        if (p.type !== 'Property') continue
        const key = (p.key as { name?: string } | undefined)?.name
        if (!key) continue
        const val = p.value as Node
        const def = val?.type === 'AssignmentPattern' ? (val.right as Node) : undefined
        add(fieldFrom(key, members.get(key), def))
      }
    }
  }

  return fields
}

// --- module resolution (Svelte default imports) ------------------------------

const SVELTE_EXTS = ['.svelte', '.svelte.ts', '.svelte.js']

async function resolveSvelteImport(
  root: string,
  fromDir: string,
  spec: string
): Promise<string | null> {
  const base = normalize(join(fromDir, spec))
  if (!withinRoot(root, base)) return null
  const candidates = spec.endsWith('.svelte') ? [base] : [base, ...SVELTE_EXTS.map((e) => base + e)]
  for (const c of candidates) {
    try {
      await readFile(c)
      return c
    } catch {
      /* try next */
    }
  }
  return null
}

/** Follow `import Name from './X.svelte'` in the usage script to its file. */
function findComponentImport(program: Node | undefined, name: string): string | null {
  const body = ((program as { body?: Node[] } | undefined)?.body ?? []) as Node[]
  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue
    const src = (stmt.source as { value?: string } | undefined)?.value
    if (typeof src !== 'string' || !src.startsWith('.')) continue
    for (const s of ((stmt as { specifiers?: Node[] }).specifiers ?? []) as Node[]) {
      const local = (s.local as { name?: string } | undefined)?.name
      if (local === name && s.type === 'ImportDefaultSpecifier') return src
    }
  }
  return null
}

// --- public adapter API ------------------------------------------------------

// SvelteKit route files (`+page.svelte`, `+layout.svelte`, `+error.svelte`) declare
// framework-injected props (`data`/`form`/`params`), not editable component props —
// the same-file schema path must skip them.
function isRouteFile(file: string): boolean {
  return basename(file).startsWith('+')
}

export async function parseSvelte(code: string): Promise<Node | null> {
  try {
    const { parse } = await loadSvelte()
    return parse(code, { modern: true }) as unknown as Node
  } catch {
    return null
  }
}

// Dirs that never hold authored usage sites — skip them while scanning so a big
// repo doesn't read its build output / deps on every inspect.
const SCAN_SKIP = new Set([
  'node_modules',
  '.git',
  '.svelte-kit',
  '.trezi',
  '.praxis',
  'dist',
  'build',
  'out'
])

/** `.svelte` files under `root` whose text mentions `<Component` (cheap pre-filter). */
async function svelteFilesUsing(root: string, component: string, limit = 4000): Promise<string[]> {
  const needle = `<${component}`
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= limit) return
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (found.length >= limit) return
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SCAN_SKIP.has(e.name) && !e.name.startsWith('.')) await walk(p)
      } else if (e.isFile() && e.name.endsWith('.svelte')) {
        try {
          if ((await readFile(p, 'utf8')).includes(needle)) found.push(p)
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  await walk(root)
  return found
}

/**
 * Find the single `<Component …/>` instance that rendered the clicked element, by
 * content-matching the clicked text against each usage's literal string props
 * (see svelte-instance.ts). Returns the usage's source + resolved loc, or null
 * when nothing matches uniquely (caller falls back to option D).
 */
async function resolveSvelteInstance(
  root: string,
  component: string,
  clickedText: string | null
): Promise<{ source: string; loc: ResolvedSource } | null> {
  if (!clickedText || !/^[A-Z]/.test(component)) return null
  const usages: SvelteUsage[] = []
  const locOf = new Map<string, ResolvedSource>()
  for (const file of await svelteFilesUsing(root, component)) {
    let code: string
    try {
      code = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const ast = await parseSvelte(code)
    if (!ast) continue
    const els: Node[] = []
    collectElements((ast as { fragment?: unknown }).fragment ?? ast, els)
    const at = makeLocator(code)
    const rel = relative(root, file)
    for (const el of els) {
      const isComp = el.type === 'Component' || el.type === 'SvelteComponent'
      if (!isComp || el.name !== component || typeof el.start !== 'number') continue
      const { line, column } = at(el.start)
      const source = `${rel}:${line}:${column}`
      const literals = readAttributes(el)
        .filter((a) => a.kind === 'string' && typeof a.value === 'string')
        .map((a) => String(a.value))
      usages.push({ source, literals })
      locOf.set(source, { file, line, column })
    }
  }
  const source = pickInstance(usages, clickedText)
  return source ? { source, loc: locOf.get(source)! } : null
}

export async function inspectSvelteProps(
  root: string,
  source: string,
  loc: ResolvedSource,
  clickedText?: string | null
): Promise<PropInspection | null> {
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return null
  }
  const ast = await parseSvelte(code)
  if (!ast) return null
  const el = findElement(ast, code, loc.line, loc.column)
  if (!el || typeof el.name !== 'string') return null

  const component = el.name
  const isComponent =
    el.type === 'Component' || el.type === 'SvelteComponent' || /^[A-Z]/.test(component)
  const current = readAttributes(el)

  const selfInstance = (ast as { instance?: { content?: Node } }).instance?.content
  let schema: PropField[] = []
  let crossFile = false
  let selfSchema = false
  if (isComponent) {
    const spec = findComponentImport(selfInstance, component)
    if (spec) {
      const file = await resolveSvelteImport(root, dirname(loc.file), spec)
      if (file) {
        try {
          const defAst = await parseSvelte(await readFile(file, 'utf8'))
          const defInstance = (defAst as { instance?: { content?: Node } } | null)?.instance
            ?.content
          schema = extractProps(defInstance)
          crossFile = schema.length > 0
        } catch {
          /* unreadable — fall back to current attributes */
        }
      }
    }
  } else if (!isRouteFile(loc.file)) {
    // First try to resolve to the concrete INSTANCE that rendered this element, by
    // content-matching the clicked text against the component's `<Self …/>` usages
    // (svelte-instance.ts). A unique match redirects the whole inspection to that
    // call site — so the panel shows the instance's real values and edits splice
    // THAT usage directly (the `<Component>` node path in applySvelteEdit), instead
    // of the option-D default change below. Only a confident unique match wins.
    const selfComponent = basename(loc.file).replace(/\.svelte$/, '')
    const inst = await resolveSvelteInstance(root, selfComponent, clickedText ?? null)
    if (inst && inst.source !== source) {
      const redirected = await inspectSvelteProps(root, inst.source, inst.loc)
      if (redirected) return redirected
    }

    // Option D — a host element inside a component *definition* carries the stamp
    // (a Svelte component instance has no DOM node to carry the usage-site stamp).
    // Surface THIS file's own props so the schema is reachable for every component
    // shape (block-root, multi-root, etc.) without mutating source. Edits route to
    // the agent as a prop-default change (see applySvelteEdit). Skip SvelteKit
    // route files, whose `data`/`form`/`params` are framework-injected, not props.
    const own = extractProps(selfInstance)
    if (own.length) {
      schema = own
      selfSchema = true
    }
  }

  // Same-file schema is the component's own props (not the clicked host element's
  // attributes), so don't fold the host attrs in.
  const fields = selfSchema ? schema : mergeFields(schema, current)
  const hasSchema = schema.length > 0
  const selfName = basename(loc.file).replace(/\.svelte$/, '')
  const note = isComponent
    ? hasSchema
      ? crossFile
        ? `Schema resolved from the imported ${component} component.`
        : undefined
      : 'No Svelte prop schema resolved — showing the props currently set.'
    : selfSchema
      ? `${selfName}'s props (from its definition) — there's no per-instance value here; ` +
        `editing changes the prop's default, which only affects instances that don't set it.`
      : 'Host element — editing its literal attributes (no component schema).'

  return {
    component: selfSchema ? selfName : component,
    source,
    fields,
    hasSchema,
    ...(note ? { note } : {})
  }
}

/** Render a Svelte attribute literal: name="x" / name={3} / name={true}. */
function renderAttr(name: string, kind: PropKind, value: string | number | boolean): string {
  if (kind === 'number') return `${name}={${Number(value)}}`
  if (kind === 'boolean') return `${name}={${value ? 'true' : 'false'}}`
  const s = String(value)
  return /^[^"\\\n<>{}]*$/.test(s) ? `${name}="${s}"` : `${name}={${JSON.stringify(s)}}`
}

export async function applySvelteEdit(
  root: string,
  edit: PropEdit,
  loc: ResolvedSource
): Promise<PropEditResult> {
  // Defense in depth — never splice an unvalidated name (the dispatching caller
  // checks too, but don't depend on that for the security boundary).
  if (!isValidAttrName(edit.name)) return { applied: false, error: 'Invalid prop name.' }
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const ast = await parseSvelte(code)
  if (!ast) return { applied: false, needsAgent: true, agentPrompt: agentPromptFor(edit, root) }
  const el = findElement(ast, code, loc.line, loc.column)
  if (!el || typeof el.name !== 'string' || typeof el.start !== 'number') {
    return { applied: false, needsAgent: true, agentPrompt: agentPromptFor(edit, root) }
  }

  // Option D: editing a prop surfaced from a host element inside a component
  // *definition* is a change to that component's prop DEFAULT (the instance has no
  // DOM node to splice). Route it to the agent rather than mis-splicing it as a
  // literal attribute on the host element.
  const isComp = el.type === 'Component' || el.type === 'SvelteComponent' || /^[A-Z]/.test(el.name)
  if (!isComp && !isRouteFile(loc.file)) {
    const selfInstance = (ast as { instance?: { content?: Node } }).instance?.content
    if (extractProps(selfInstance).some((p) => p.name === edit.name)) {
      return {
        applied: false,
        needsAgent: true,
        agentPrompt: `In ${basename(loc.file)}, change the default value of the \`${edit.name}\` prop to ${JSON.stringify(edit.value)}.`
      }
    }
  }

  const attrText = renderAttr(edit.name, edit.kind, edit.value)
  const existing = readAttributes(el).find((a) => a.name === edit.name)

  let next: string
  if (existing) {
    next = code.slice(0, existing.start) + attrText + code.slice(existing.end)
  } else {
    // Insert right after the tag name (`<Button` → after "Button").
    const insertAt = el.start + 1 + el.name.length
    if (code.slice(el.start + 1, insertAt) !== el.name) {
      return { applied: false, needsAgent: true, agentPrompt: agentPromptFor(edit, root) }
    }
    next = code.slice(0, insertAt) + ' ' + attrText + code.slice(insertAt)
  }
  return commitEdit(root, loc.file, code, next, `${edit.source}:${edit.name}`)
}

/**
 * Remove a prop attribute from a `.svelte` element's source (reset-to-default) —
 * the Svelte counterpart of `removeProp`. Reversible via the F3b edit history; an
 * already-absent prop is a successful no-op. (v8 F2)
 */
export async function removeSvelteProp(
  root: string,
  source: string,
  name: string,
  loc: ResolvedSource
): Promise<PropEditResult> {
  if (!isValidAttrName(name)) return { applied: false, error: 'Invalid prop name.' }
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const ast = await parseSvelte(code)
  if (!ast) return { applied: false, error: 'Could not parse the component.' }
  const el = findElement(ast, code, loc.line, loc.column)
  if (!el || typeof el.start !== 'number') {
    return { applied: false, error: 'Could not find the element.' }
  }
  const attr = readAttributes(el).find((a) => a.name === name)
  if (!attr) return { applied: true } // already absent
  let start = attr.start
  while (start > 0 && /\s/.test(code[start - 1])) start--
  const next = code.slice(0, start) + code.slice(attr.end)
  return commitEdit(root, loc.file, code, next, `${source}:${name}`)
}

/**
 * Inline text edit for `.svelte` — the counterpart of the JSX text-splice in
 * props.ts. Rewrites a stamped element's text content in source when its children
 * are plain text (svelte/compiler `Text` nodes) and the new text is splice-safe.
 * Expression (`{...}`) / element / mixed children fall back to the agent. Empty
 * elements also fall back here (the JSX path inserts at the opening-tag end, but
 * svelte/compiler doesn't expose that offset the way babel does, so we stay
 * conservative — and the inline editor only fires on text-bearing elements anyway).
 */
export async function applySvelteTextEdit(
  root: string,
  edit: { source: string; text: string },
  loc: ResolvedSource
): Promise<PropEditResult> {
  const fallback = (): PropEditResult => ({
    applied: false,
    needsAgent: true,
    agentPrompt: textAgentPrompt(edit.source, edit.text, root)
  })
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const ast = await parseSvelte(code)
  if (!ast) return fallback()
  const el = findElement(ast, code, loc.line, loc.column)
  if (!el || typeof el.start !== 'number') return fallback()

  // Only splice when every child is plain text and the new text can't break out
  // into a tag (`<`/`>`) or a mustache (`{`/`}`). Anything else → agent.
  const kids = ((el.fragment as { nodes?: Node[] } | undefined)?.nodes ?? []) as Node[]
  if (kids.length === 0 || !kids.every((c) => c.type === 'Text') || !/^[^<>{}]*$/.test(edit.text)) {
    return fallback()
  }
  const start = kids[0].start ?? 0
  const end = kids[kids.length - 1].end ?? 0
  // Preserve surrounding whitespace from the RAW source. An all-whitespace child
  // would have lead/trail overlap — zero them (mirrors the JSX path).
  const raw = code.slice(start, end)
  const allWs = /^\s*$/.test(raw)
  const lead = allWs ? '' : (raw.match(/^\s*/)?.[0] ?? '')
  const trail = allWs ? '' : (raw.match(/\s*$/)?.[0] ?? '')
  const next = code.slice(0, start) + lead + edit.text + trail + code.slice(end)
  return commitEdit(root, loc.file, code, next, `${edit.source}:text`)
}
