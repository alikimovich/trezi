import { typescriptProps } from './props-typescript'
import { ipcMain } from '../native/platform'
import { readFile, stat } from 'fs/promises'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'path'
import type {
  PropEdit,
  PropEditResult,
  PropField,
  PropInspection,
  PropKind,
  SourceView,
  SourceWriteResult
} from '../shared/api'
import { projectRelative } from '../shared/project-path'
import {
  applySvelteEdit,
  applySvelteTextEdit,
  inspectSvelteProps,
  removeSvelteProp
} from './props-svelte'
import { looksBinary, mediaTypeFor } from './media-types'
import { platformOwner } from './platform-owner'
import { spliceHtmlText } from './html-source'
import { undo, redo, editAvailability, revertGroup, canRevertGroup } from './edit-history'
import { proposeEdit } from './source-commit'
import { contentHash, sourceOwner } from './source-owner'

/**
 * Hand a source-edit engine's result to the source owner (v8 F3b Undo included).
 * The engines only compute: `before` is the exact text they parsed and `after` their
 * proposal; `proposeEdit` is the one committing call (hash-bound, see
 * source-commit.ts). `key` coalesces rapid edits of one target into one
 * Undo step; `group` batches the distinct-key edits of one gesture (the four sides of
 * a linked padding scrub) into one atomic Undo. Shared by the React + Svelte + HTML
 * adapters so EVERY trezi source edit is reversible.
 */
export function commitEdit(
  root: string,
  file: string,
  before: string,
  after: string,
  key: string,
  group?: string
): Promise<PropEditResult> {
  return proposeEdit(root, file, before, after, key, group)
}

/**
 * Prop editing is framework-agnostic by dispatch: the source file's extension
 * picks an adapter. `.svelte` → props-svelte.ts; JavaScript/TypeScript sources
 * → the React/JSX engine below. Inspection skips other source formats.
 * Both speak the same `data-trezi-source`
 * stamp, the same shared helpers (resolveSource, mergeFields, …), and return the
 * same PropInspection / PropEditResult shapes.
 */

/**
 * Prop/token editing for the v2 inspector. Given an element's `data-trezi-source`
 * stamp ("relpath:line"), we parse the source file, find the JSX element on that
 * line, and read its current literal attributes — enriched, when we can resolve
 * a schema, by react-docgen. Edits are applied the "hybrid" way: simple literal
 * props are spliced straight into the source (instant hot-reload); anything
 * non-literal is handed back for the agent to do.
 *
 * @babel/parser is CJS-friendly (externalized). react-docgen v8 is ESM-only, so
 * it's loaded via dynamic import() like the Agent SDK.
 */

interface FoundElement {
  name: string
  /** The opening element AST node (with babel ranges). */
  opening: BabelNode
  /** The parsed file AST (reused to resolve imports without re-parsing). */
  ast: BabelNode
}

export interface BabelNode {
  type: string
  start: number
  end: number
  loc?: { start: { line: number; column: number }; end: { line: number } }
  // JSX-ish fields we touch (loosely typed — we duck-type by `.type`).
  name?: BabelNode | { type: string; name?: string }
  attributes?: BabelNode[]
  value?: BabelNode | null
  expression?: BabelNode
  argument?: BabelNode
  openingElement?: BabelNode
  [k: string]: unknown
}

// Both @babel/parser@8 and react-docgen@8 are ESM-only; this CJS main bundle
// must reach them via dynamic import() (like the Agent SDK), not a static require.
type BabelParser = typeof import('@babel/parser')
let babelPromise: Promise<BabelParser> | null = null
const loadBabel = (): Promise<BabelParser> => (babelPromise ??= import('@babel/parser'))

type ReactDocgen = typeof import('react-docgen')
let docgenPromise: Promise<ReactDocgen> | null = null
const loadDocgen = (): Promise<ReactDocgen> => (docgenPromise ??= import('react-docgen'))

export interface ResolvedSource {
  file: string
  line: number
  column?: number
}

/** Resolve "relpath:line[:col]" against the project root, refusing escapes. */
export function resolveSource(root: string, source: string): ResolvedSource | null {
  // Non-greedy path so "a/b.tsx:7:41" parses as file="a/b.tsx", line=7, col=41
  // (a greedy `.*` would swallow the line into the path and treat col as line).
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(source)
  if (!m) return null
  const rel = m[1]
  if (isAbsolute(rel)) return null
  const file = normalize(join(root, rel))
  // Don't read outside the project.
  const within = relative(root, file)
  if (within.startsWith('..') || isAbsolute(within)) return null
  return { file, line: Number(m[2]), ...(m[3] != null ? { column: Number(m[3]) } : {}) }
}

// A safe JSX attribute name: identifier-ish, plus hyphens for data-*/aria-*.
// Anything else (from a hostile prop schema or a spoofed edit) must never be
// spliced into source.
const ATTR_NAME_RE = /^[A-Za-z_][\w-]*$/
export const isValidAttrName = (name: string): boolean => ATTR_NAME_RE.test(name)

function jsxName(node: BabelNode | { type: string; name?: string } | undefined): string {
  if (!node) return ''
  const n = node as BabelNode
  if (n.type === 'JSXIdentifier') return (n as { name?: string }).name ?? ''
  // JSXMemberExpression e.g. <Foo.Bar> → "Foo.Bar"
  if (n.type === 'JSXMemberExpression') {
    return `${jsxName(n.object as BabelNode)}.${jsxName(n.property as BabelNode)}`
  }
  return ''
}

/** Recursively collect every node of a given `.type` in the tree. */
export function collectNodes(node: unknown, type: string, out: BabelNode[]): void {
  if (!node || typeof node !== 'object') return
  const n = node as BabelNode
  if (n.type === type) out.push(n)
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const v = (n as Record<string, unknown>)[key]
    if (Array.isArray(v)) v.forEach((c) => collectNodes(c, type, out))
    else if (v && typeof v === 'object') collectNodes(v, type, out)
  }
}

export async function parseFile(code: string): Promise<BabelNode> {
  const { parse } = await loadBabel()
  return parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
    errorRecovery: true
  }) as unknown as BabelNode
}

/**
 * The JSX opening element the stamp refers to, given an ALREADY-PARSED ast.
 * Multiple elements can share a start line (e.g. `<li>Label <Badge/></li>`),
 * so when the stamp carries a column we match it; otherwise we take the
 * innermost element starting on that line (a DOM click resolves to the
 * deepest stamped element), falling back to the smallest element that
 * encloses the line.
 *
 * Split out from `findElementAtLine` so a caller needing TWO locations in the
 * same file (the Layers panel's move engine) can parse once and locate both
 * against the same ast — the JSX element objects then stay reference-equal,
 * which is what its parent/sibling lookup depends on.
 */
export function locateJsxOpening(
  ast: BabelNode,
  line: number,
  column?: number
): { name: string; opening: BabelNode } | null {
  const openings: BabelNode[] = []
  collectNodes(ast, 'JSXOpeningElement', openings)
  const wrap = (o: BabelNode): { name: string; opening: BabelNode } => ({
    name: jsxName(o.name as BabelNode),
    opening: o
  })

  const sameLine = openings.filter((o) => o.loc?.start.line === line)
  if (sameLine.length) {
    if (column != null) {
      const exactCol = sameLine.find((o) => o.loc?.start.column === column)
      if (exactCol) return wrap(exactCol)
      // Nearest element starting at or before the column, else the earliest.
      const atOrBefore = sameLine
        .filter((o) => (o.loc?.start.column ?? 0) <= column)
        .sort((a, b) => (b.loc?.start.column ?? 0) - (a.loc?.start.column ?? 0))[0]
      return wrap(atOrBefore ?? sameLine.sort((a, b) => a.start - b.start)[0])
    }
    // No column: innermost element on the line (highest start offset).
    return wrap([...sameLine].sort((a, b) => b.start - a.start)[0])
  }

  const enclosing = openings
    .filter((o) => (o.loc?.start.line ?? 0) <= line && (o.loc?.end.line ?? 0) >= line)
    .sort((a, b) => b.start - a.start)[0]
  return enclosing ? wrap(enclosing) : null
}

export async function findElementAtLine(
  code: string,
  line: number,
  column?: number
): Promise<FoundElement | null> {
  const ast = await parseFile(code)
  const hit = locateJsxOpening(ast, line, column)
  return hit ? { ...hit, ast } : null
}

export interface CurrentAttr {
  name: string
  kind: PropKind
  value?: string | number | boolean
  expression?: boolean
  start: number
  end: number
}

/** Read the current attributes off an opening element (literal values only). */
export function readAttributes(opening: BabelNode): CurrentAttr[] {
  const attrs: CurrentAttr[] = []
  for (const attr of opening.attributes ?? []) {
    if (attr.type !== 'JSXAttribute') continue // skip spreads
    const nameNode = attr.name as { type: string; name?: string }
    const name = nameNode?.name
    if (!name || !isValidAttrName(name)) continue
    const v = attr.value as BabelNode | null
    if (v == null) {
      attrs.push({ name, kind: 'boolean', value: true, start: attr.start, end: attr.end })
    } else if (v.type === 'StringLiteral') {
      attrs.push({
        name,
        kind: 'string',
        value: (v as { value?: string }).value,
        start: attr.start,
        end: attr.end
      })
    } else if (v.type === 'JSXExpressionContainer') {
      const lit = literalFromExpression(v.expression as BabelNode)
      if (lit) attrs.push({ name, ...lit, start: attr.start, end: attr.end })
      else attrs.push({ name, kind: 'other', expression: true, start: attr.start, end: attr.end })
    } else {
      attrs.push({ name, kind: 'other', expression: true, start: attr.start, end: attr.end })
    }
  }
  return attrs
}

/** Peel TS-cast / `satisfies` wrappers off a literal value, so
 * `variant={'ok' as Variant}` or `size={4 satisfies number}` read as plain
 * literals. (@babel/parser doesn't emit ParenthesizedExpression by default, so
 * `count={(3)}` already arrives as a bare NumericLiteral — no unwrap needed.) */
function unwrapExpr(e: BabelNode | undefined): BabelNode | undefined {
  let cur = e
  while (cur && (cur.type === 'TSAsExpression' || cur.type === 'TSSatisfiesExpression')) {
    cur = cur.expression as BabelNode | undefined
  }
  return cur
}

function literalFromExpression(
  raw: BabelNode | undefined
): { kind: PropKind; value: string | number | boolean } | null {
  const expr = unwrapExpr(raw)
  if (!expr) return null
  const lit = expr as unknown as { value: string | number | boolean }
  if (expr.type === 'StringLiteral') return { kind: 'string', value: lit.value }
  if (expr.type === 'NumericLiteral') return { kind: 'number', value: lit.value }
  if (expr.type === 'BooleanLiteral') return { kind: 'boolean', value: lit.value }
  // A template literal with no ${} interpolations is just a string literal.
  if (expr.type === 'TemplateLiteral') {
    const quasis = (expr as { quasis?: Array<{ value?: { cooked?: string } }> }).quasis ?? []
    const exprs = (expr as { expressions?: unknown[] }).expressions ?? []
    if (exprs.length === 0 && quasis.length === 1) {
      return { kind: 'string', value: quasis[0]?.value?.cooked ?? '' }
    }
  }
  if (
    expr.type === 'UnaryExpression' &&
    (expr as { operator?: string }).operator === '-' &&
    (expr.argument as BabelNode)?.type === 'NumericLiteral'
  ) {
    return { kind: 'number', value: -Number((expr.argument as unknown as { value: number }).value) }
  }
  return null
}

/**
 * Run react-docgen and return the prop schema for the component named `name`.
 * We only accept an exact displayName match (or a sole anonymous default
 * export) — never a *different* component's schema. For the cross-file case,
 * `name` is the *exported* name resolved from the import, so a re-export barrel
 * that also defines an unrelated component can't be mis-attached.
 */
async function schemaFor(code: string, name: string): Promise<PropField[]> {
  try {
    const { parse, builtinResolvers } = await loadDocgen()
    // FindAll (not the default exported-definitions resolver, which throws when a
    // file declares more than one component) so a file that defines + uses a
    // component still resolves.
    const docs = parse(code, {
      filename: 'component.tsx',
      resolver: new builtinResolvers.FindAllDefinitionsResolver()
    }) as Array<{ displayName?: string; props?: Record<string, DocgenProp> }>
    const doc =
      docs.find((d) => d.displayName === name) ??
      (docs.length === 1 && !docs[0].displayName ? docs[0] : undefined)
    if (!doc?.props) return []
    return Object.entries(doc.props)
      .filter(([n]) => isValidAttrName(n))
      .map(([n, p]) => docgenPropToField(n, p))
  } catch {
    return []
  }
}

const MODULE_EXTS = ['.tsx', '.ts', '.jsx', '.js']

/** Is `file` inside the project root (refuse imports that escape it)? */
export function withinRoot(root: string, file: string): boolean {
  const rel = relative(root, file)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** Parsed tsconfig path-mapping: `baseUrl` (absolute) + the raw `paths` map. */
export interface TsAliases {
  baseUrl: string
  paths: Record<string, string[]>
}

/** Strip `//`/`/* *​/` comments and trailing commas so JSONC tsconfigs parse. */
function parseJsonc(text: string): unknown {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(noTrailingCommas)
}

/**
 * Read a project's TypeScript path aliases (`compilerOptions.paths`/`baseUrl`).
 * Modern React apps (Vite + shadcn) import via aliases like `@/components/*`
 * rather than relative paths, so without this cross-file prop resolution never
 * finds the component definition. Checks `tsconfig.json` first, then follows a
 * single `extends`, then falls back to the common Vite split `tsconfig.app.json`
 * — whichever first yields a `paths` map. Never throws (missing/invalid → null).
 */
export async function loadTsAliases(root: string): Promise<TsAliases | null> {
  const tried = new Set<string>()
  const readConfig = async (file: string): Promise<TsAliases | null> => {
    if (tried.has(file) || tried.size > 4) return null
    tried.add(file)
    let cfg: {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
      extends?: string
    }
    try {
      cfg = parseJsonc(await readFile(file, 'utf8')) as typeof cfg
    } catch {
      return null
    }
    const co = cfg.compilerOptions ?? {}
    if (co.paths && Object.keys(co.paths).length) {
      // `paths` resolve against baseUrl if set, else the tsconfig's own dir.
      const baseUrl = join(dirname(file), co.baseUrl ?? '.')
      return { baseUrl, paths: co.paths }
    }
    if (typeof cfg.extends === 'string') {
      const ext = cfg.extends.startsWith('.')
        ? join(dirname(file), cfg.extends.endsWith('.json') ? cfg.extends : cfg.extends + '.json')
        : null
      if (ext) return readConfig(ext)
    }
    return null
  }
  return (
    (await readConfig(join(root, 'tsconfig.json'))) ??
    (await readConfig(join(root, 'tsconfig.app.json')))
  )
}

/** Candidate on-disk bases an import spec maps to via tsconfig `paths`/`baseUrl`. */
function aliasedBases(spec: string, aliases: TsAliases): string[] {
  const out: string[] = []
  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const star = pattern.indexOf('*')
    if (star >= 0) {
      const pre = pattern.slice(0, star)
      const post = pattern.slice(star + 1)
      if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) {
        const matched = spec.slice(pre.length, spec.length - post.length)
        for (const t of targets) out.push(join(aliases.baseUrl, t.replace('*', matched)))
      }
    } else if (spec === pattern) {
      for (const t of targets) out.push(join(aliases.baseUrl, t))
    }
  }
  return out
}

/**
 * Resolve an import spec to an on-disk file (trying extensions + /index).
 * Relative specs resolve from `fromDir`; bare specs resolve via tsconfig
 * `paths` aliases and then a `baseUrl` fallback (both gated to inside the root).
 */
async function resolveModulePath(
  root: string,
  fromDir: string,
  spec: string,
  aliases?: TsAliases | null
): Promise<string | null> {
  const bases: string[] = []
  if (spec.startsWith('.')) {
    bases.push(normalize(join(fromDir, spec)))
  } else if (aliases) {
    bases.push(...aliasedBases(spec, aliases).map((b) => normalize(b)))
    // baseUrl fallback: `import x from "components/..."` with baseUrl "src".
    bases.push(normalize(join(aliases.baseUrl, spec)))
  }
  for (const base of bases) {
    if (!withinRoot(root, base)) continue // never read outside the project
    const candidates = [
      base,
      ...MODULE_EXTS.map((e) => base + e),
      ...MODULE_EXTS.map((e) => join(base, 'index' + e))
    ]
    for (const c of candidates) {
      if (/\.[a-z]+$/.test(c)) {
        try {
          await readFile(c)
          return c
        } catch {
          /* try next */
        }
      }
    }
  }
  return null
}

/**
 * Find where `component` (the local JSX name) is imported from, resolve the
 * file, and return the *exported* name to match in that file. For a named
 * import we use the original export name (so `{ Button as B }` matches `Button`,
 * and a barrel re-export can't mis-attach); for a default import we fall back to
 * the local name (best effort — default exports' displayName usually agrees).
 */
async function resolveComponentFile(
  root: string,
  usageFile: string,
  ast: BabelNode,
  component: string
): Promise<{ file: string; exportName: string } | null> {
  const imports: BabelNode[] = []
  collectNodes(ast, 'ImportDeclaration', imports)
  let aliases: TsAliases | null | undefined
  for (const imp of imports) {
    const src = (imp.source as { value?: string } | undefined)?.value
    if (typeof src !== 'string') continue
    const isRelative = src.startsWith('.')
    for (const s of (imp.specifiers as BabelNode[] | undefined) ?? []) {
      const local = (s.local as { name?: string } | undefined)?.name
      if (local !== component) continue
      if (s.type !== 'ImportSpecifier' && s.type !== 'ImportDefaultSpecifier') continue
      const exportName =
        s.type === 'ImportSpecifier'
          ? ((s.imported as { name?: string } | undefined)?.name ?? component)
          : component
      // Load aliases lazily, once, only when a non-relative import is in play.
      if (!isRelative && aliases === undefined) aliases = await loadTsAliases(root)
      const file = await resolveModulePath(root, dirname(usageFile), src, aliases)
      return file ? { file, exportName } : null
    }
  }
  return null
}

interface DocgenProp {
  required?: boolean
  description?: string
  tsType?: { name?: string; elements?: Array<{ name?: string; value?: string }> }
  type?: { name?: string; value?: unknown }
  /** react-docgen's source for the prop's default (e.g. `"'brand'"`, `"3"`, `"false"`). */
  defaultValue?: { value?: string; computed?: boolean }
}

/**
 * Parse react-docgen's default-value *source string* into a typed literal, matching
 * the field's kind. Computed defaults (a non-literal expression) and values that
 * don't fit the kind are dropped — we only surface a default we can faithfully
 * round-trip into the "reset to default" affordance. (v8 F2)
 */
function parseDefaultValue(
  kind: PropKind,
  raw: { value?: string; computed?: boolean } | undefined,
  options?: string[]
): string | number | boolean | undefined {
  if (!raw || raw.computed || raw.value == null) return undefined
  const v = raw.value.trim()
  if (kind === 'boolean') return v === 'true' ? true : v === 'false' ? false : undefined
  if (kind === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  // string / enum — strip a single/double-quote or template-backtick wrapper.
  const m = v.match(/^(['"`])([\s\S]*)\1$/)
  if (!m) return undefined
  const s = m[2]
  if (kind === 'enum' && options && !options.includes(s)) return undefined
  return s
}

function docgenPropToField(name: string, p: DocgenProp): PropField {
  let kind: PropKind = 'other'
  let options: string[] | undefined
  const ts = p.tsType
  if (ts?.name === 'string') kind = 'string'
  else if (ts?.name === 'number') kind = 'number'
  else if (ts?.name === 'boolean') kind = 'boolean'
  else if (ts?.name === 'union' && Array.isArray(ts.elements)) {
    const lits = ts.elements.filter((e) => e.name === 'literal' && /^["']/.test(e.value ?? ''))
    if (lits.length && lits.length === ts.elements.length) {
      kind = 'enum'
      options = lits.map((e) => (e.value ?? '').replace(/^['"]|['"]$/g, ''))
    }
  } else if (p.type?.name === 'enum' && Array.isArray(p.type.value)) {
    const vals = (p.type.value as Array<{ value?: string }>)
      .map((v) => v.value ?? '')
      .filter((v) => /^['"]/.test(v))
    if (vals.length) {
      kind = 'enum'
      options = vals.map((v) => v.replace(/^['"]|['"]$/g, ''))
    }
  }
  const def = parseDefaultValue(kind, p.defaultValue, options)
  return {
    name,
    kind,
    ...(options ? { options } : {}),
    ...(p.required ? { required: true } : {}),
    ...(p.description ? { description: p.description } : {}),
    ...(def !== undefined ? { default: def } : {}),
    fromSchema: true
  }
}

/**
 * Merge a component's prop schema with the values actually set on the element:
 * schema-defined props first (richer — types, enums, descriptions) with any
 * current value overlaid, then attributes present on the element but not in the
 * schema. Shared by the React and Svelte adapters.
 */
export function mergeFields(schema: PropField[], current: CurrentAttr[]): PropField[] {
  const currentByName = new Map(current.map((c) => [c.name, c]))
  const fields: PropField[] = []
  const seen = new Set<string>()
  for (const f of schema) {
    seen.add(f.name)
    const cur = currentByName.get(f.name)
    fields.push({
      ...f,
      ...(cur && !cur.expression ? { value: cur.value, fromSchema: false } : {}),
      ...(cur?.expression ? { expression: true } : {})
    })
  }
  for (const c of current) {
    if (seen.has(c.name)) continue
    fields.push({
      name: c.name,
      kind: c.kind,
      ...(c.value !== undefined ? { value: c.value } : {}),
      ...(c.expression ? { expression: true } : {})
    })
  }
  return fields
}

async function inspectProps(
  root: string,
  source: string,
  text?: string | null
): Promise<PropInspection | null> {
  const loc = resolveSource(root, source)
  if (!loc) return null
  if (loc.file.endsWith('.svelte')) return inspectSvelteProps(root, source, loc, text)
  // Stamps also come from MDX/HTML. Those authored files are not JavaScript;
  // selection and source viewing still work without a React prop inspection.
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(loc.file)) return null
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return null
  }
  let found: FoundElement | null
  try {
    found = await findElementAtLine(code, loc.line, loc.column)
  } catch (error) {
    // Babel's errorRecovery cannot recover every syntax error (including an
    // incomplete edit). Treat this as unavailable inspection, not failed IPC.
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (!found) return null

  const current = readAttributes(found.opening)

  // Schema only resolves for capitalized components (host tags like <h1> have none).
  const isComponent = /^[A-Z]/.test(found.name)
  let schema = isComponent ? await schemaFor(code, found.name) : []
  let crossFile = false
  // Not defined in this file? Follow the component's import to its definition.
  if (isComponent && schema.length === 0) {
    const def = await resolveComponentFile(root, loc.file, found.ast, found.name)
    if (def) {
      try {
        schema = await schemaFor(await readFile(def.file, 'utf8'), def.exportName)
        crossFile = schema.length > 0
      } catch {
        /* unreadable — fall back to current attributes */
      }
    }
  }

  if (isComponent && schema.length === 0) schema = typescriptProps(root, loc.file, loc.line, loc.column ?? 0)

  const fields = mergeFields(schema, current)

  const hasSchema = schema.length > 0
  const note = isComponent
    ? hasSchema
      ? crossFile
        ? `Schema resolved from the imported ${found.name} definition.`
        : undefined
      : 'No react-docgen schema resolved — showing the props currently set.'
    : 'Host element — editing its literal attributes (no component schema).'

  return { component: found.name, source, fields, hasSchema, ...(note ? { note } : {}) }
}

/** Render a JSX attribute literal, e.g. variant="primary" / count={3} / ok={true}. */
function renderAttr(name: string, kind: PropKind, value: string | number | boolean): string {
  if (kind === 'number') return `${name}={${Number(value)}}`
  if (kind === 'boolean') return `${name}={${value ? 'true' : 'false'}}`
  const s = String(value)
  // Safe to use the plain quoted form when the string has no quotes/braces/newlines.
  return /^[^"\\\n<>{}]*$/.test(s) ? `${name}="${s}"` : `${name}={${JSON.stringify(s)}}`
}

export async function applyPropEdit(root: string, edit: PropEdit): Promise<PropEditResult> {
  // Never splice an unvalidated name into source — don't trust the renderer
  // payload (defense in depth; inspection already drops non-identifier keys).
  if (!isValidAttrName(edit.name)) {
    return { applied: false, error: 'Invalid prop name.' }
  }
  // 'other' values can't be expressed as a literal here — that's the agent's job.
  if (edit.kind === 'other') {
    return { applied: false, needsAgent: true, agentPrompt: agentPromptFor(edit, root) }
  }
  const loc = resolveSource(root, edit.source)
  if (!loc) return { applied: false, error: 'Could not resolve the source location.' }
  if (loc.file.endsWith('.svelte')) return applySvelteEdit(root, edit, loc)
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const found = await findElementAtLine(code, loc.line, loc.column)
  if (!found) {
    return { applied: false, needsAgent: true, agentPrompt: agentPromptFor(edit, root) }
  }
  const attrText = renderAttr(edit.name, edit.kind, edit.value)
  const existing = readAttributes(found.opening).find((a) => a.name === edit.name)

  let next: string
  if (existing) {
    next = code.slice(0, existing.start) + attrText + code.slice(existing.end)
  } else {
    const nameNode = found.opening.name as BabelNode
    const insertAt = nameNode.end
    next = code.slice(0, insertAt) + ' ' + attrText + code.slice(insertAt)
  }
  // commitEdit skips a no-op write and records the edit for undo/redo.
  return commitEdit(root, loc.file, code, next, `${edit.source}:${edit.name}`)
}

/**
 * Remove a prop attribute from the element's source — the "reset to default"
 * action (the value falls back to the component's declared default). Works for any
 * attribute, including expression-valued ones. Reversible via the F3b edit history;
 * an already-absent prop is a successful no-op. (v8 F2)
 */
export async function removeProp(root: string, source: string, name: string): Promise<PropEditResult> {
  if (!isValidAttrName(name)) return { applied: false, error: 'Invalid prop name.' }
  const loc = resolveSource(root, source)
  if (!loc) return { applied: false, error: 'Could not resolve the source location.' }
  if (loc.file.endsWith('.svelte')) return removeSvelteProp(root, source, name, loc)
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const found = await findElementAtLine(code, loc.line, loc.column)
  if (!found) return { applied: false, error: 'Could not find the element.' }
  const attr = readAttributes(found.opening).find((a) => a.name === name)
  if (!attr) return { applied: true } // already absent — nothing to remove
  // Delete the attribute and one run of preceding whitespace, so we don't leave a
  // double space or a dangling indented blank where it sat.
  let start = attr.start
  while (start > 0 && /\s/.test(code[start - 1])) start--
  const next = code.slice(0, start) + code.slice(attr.end)
  return commitEdit(root, loc.file, code, next, `${source}:${name}`)
}

// Agent prompts name the source relative to `root`, so a worktree chat edits its own
// checkout rather than the live tree (LKM-155).
export function agentPromptFor(edit: PropEdit, root: string): string {
  const val = typeof edit.value === 'string' ? `"${edit.value}"` : String(edit.value)
  return `In ${projectRelative(edit.source, root)}, set the \`${edit.name}\` prop of the selected element to ${val}.`
}

export function textAgentPrompt(source: string, text: string, root: string): string {
  return `In ${projectRelative(source, root)}, change only the selected element's rendered text to “${text.slice(0, 200)}”. Make the smallest source edit needed. Do not update matching copy elsewhere unless this exact element is driven by a shared value that must change.`
}

/**
 * Inline text edit: rewrite a stamped element's text content in source. Only
 * elements whose children are plain text (a single JSXText, or empty) and whose
 * new text is splice-safe are applied directly — mixed/expression content,
 * self-closing elements, or `<{}>`-bearing text fall back to the agent.
 */
export async function applyTextEdit(
  root: string,
  edit: { source: string; text: string }
): Promise<PropEditResult> {
  const loc = resolveSource(root, edit.source)
  if (!loc) return { applied: false, error: 'Could not resolve the source location.' }
  const newText = edit.text.replace(/\s+/g, ' ').trim()
  // `.svelte` → the Svelte adapter splices via svelte/compiler (agent-fallback for
  // expression/mixed content), mirroring the JSX path below.
  if (loc.file.endsWith('.svelte')) {
    return applySvelteTextEdit(root, { source: edit.source, text: newText }, loc)
  }
  // `.html`/`.htm` (vanilla projects, stamped at serve time) → splice the text
  // node back into the HTML file; mixed/void content falls back to the agent.
  if (/\.html?$/i.test(loc.file)) {
    let html: string
    try {
      html = await readFile(loc.file, 'utf8')
    } catch {
      return { applied: false, error: 'Could not read the source file.' }
    }
    const next =
      loc.column != null ? await spliceHtmlText(html, loc.line, loc.column, newText) : null
    if (next == null) {
      return {
        applied: false,
        needsAgent: true,
        agentPrompt: textAgentPrompt(edit.source, newText, root)
      }
    }
    return commitEdit(root, loc.file, html, next, `${edit.source}:text`)
  }
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const agentFallback = (): PropEditResult => ({
    applied: false,
    needsAgent: true,
    agentPrompt: textAgentPrompt(edit.source, newText, root)
  })
  if (!/\.[cm]?[jt]sx?$/i.test(loc.file)) return agentFallback()
  let found: Awaited<ReturnType<typeof findElementAtLine>>
  try {
    found = await findElementAtLine(code, loc.line, loc.column)
  } catch (error) {
    if (error instanceof SyntaxError) return agentFallback()
    throw error
  }
  if (!found) return agentFallback()

  const elements: BabelNode[] = []
  collectNodes(found.ast, 'JSXElement', elements)
  const element = elements.find(
    (e) => (e.openingElement as BabelNode | undefined)?.start === found.opening.start
  )
  if (!element || (found.opening as { selfClosing?: boolean }).selfClosing) return agentFallback()

  const children = (element.children as BabelNode[] | undefined) ?? []
  // Editable only when there are no element/expression children, and the new
  // text can't break out of a JSXText node.
  if (!children.every((c) => c.type === 'JSXText') || !/^[^<>{}]*$/.test(newText)) {
    return agentFallback()
  }

  let next: string
  if (children.length === 0) {
    const insertAt = (found.opening as BabelNode).end
    next = code.slice(0, insertAt) + newText + code.slice(insertAt)
  } else {
    const start = children[0].start
    const end = children[children.length - 1].end
    // Derive surrounding whitespace from the RAW source (not the entity-decoded
    // value, which would rewrite `&nbsp;` etc. as literal bytes). For an
    // all-whitespace child, lead and trail would overlap — zero them.
    const raw = code.slice(start, end)
    const allWs = /^\s*$/.test(raw)
    const lead = allWs ? '' : (raw.match(/^\s*/)?.[0] ?? '')
    const trail = allWs ? '' : (raw.match(/\s*$/)?.[0] ?? '')
    next = code.slice(0, start) + lead + newText + trail + code.slice(end)
  }
  return commitEdit(root, loc.file, code, next, `${edit.source}:text`)
}

/** The literal-string AST node behind a className attr value (`"…"` or `{'…'}`),
 * or null for an expression/dynamic className we must not rewrite. */
export function classNameStringNode(v: BabelNode | null | undefined): BabelNode | null {
  if (!v) return null
  if (v.type === 'StringLiteral') return v
  if (v.type === 'JSXExpressionContainer') {
    const inner = unwrapExpr(v.expression as BabelNode)
    if (inner?.type === 'StringLiteral') return inner
  }
  return null
}

// --- code peek: read the stamped file / jump to it in the user's editor ------

/**
 * The stamped element's source file for the inspector's inline code peek: the
 * whole file (surrounding context stays visible) plus the element's full line
 * span so the renderer can highlight it. Svelte / unparsable files fall back to
 * the stamp line alone — the peek still works, just without the span.
 *
 * Images/video/audio come back as `media` (an opaque `trezi-media://` grant the
 * native editor turns into a path) and other non-text files as `binary`;
 * both carry an empty `code`. Before that, a `.png` opened here was decoded as
 * utf8 and rendered as thousands of lines of mojibake.
 */
export async function readSourceView(root: string, source: string): Promise<SourceView | null> {
  const loc = resolveSource(root, source)
  if (!loc) return null
  const rel = relative(root, loc.file)

  const media = mediaTypeFor(loc.file)
  if (media) {
    let bytes: number
    try {
      bytes = (await stat(loc.file)).size
    } catch {
      return null
    }
    // A grant bound to the source editor, the file's size and hash, with an expiry. A
    // file the platform owner refuses (too large, changed while read) shows as binary.
    let url: string
    try {
      url = (await platformOwner().grantMedia(root, loc.file)).url
    } catch {
      return { file: rel, code: '', line: loc.line, binary: true, bytes }
    }
    return {
      file: rel,
      code: '',
      line: loc.line,
      media: { ...media, url },
      bytes
    }
  }

  let code: string
  let hash: string | undefined
  try {
    // The owner authorizes the path (symlinks included) and issues the baseline hash.
    const read = await sourceOwner().read(root, loc.file)
    if (read.binary || read.content === undefined) return { file: rel, code: '', line: loc.line, binary: true, bytes: read.size }
    code = read.content
    hash = read.hash
  } catch {
    return null
  }
  if (looksBinary(code)) {
    let bytes = 0
    try {
      bytes = (await stat(loc.file)).size
    } catch {
      /* size is cosmetic — the placeholder still renders without it */
    }
    return { file: rel, code: '', line: loc.line, binary: true, bytes }
  }
  const view: SourceView = { file: rel, code, line: loc.line, hash }
  if (!loc.file.endsWith('.svelte')) {
    try {
      const found = await findElementAtLine(code, loc.line, loc.column)
      if (found) {
        // The opening element gives the start; the enclosing JSXElement (when it
        // exists — self-closing tags included) carries the closing tag's end line.
        const elements: BabelNode[] = []
        collectNodes(found.ast, 'JSXElement', elements)
        const el = elements.find(
          (e) => (e.openingElement as BabelNode | undefined)?.start === found.opening.start
        )
        view.elementStart = found.opening.loc?.start.line ?? loc.line
        view.elementEnd = (el ?? found.opening).loc?.end.line ?? view.elementStart
      }
    } catch {
      /* parse failure — stamp line alone */
    }
  }
  return view
}

/**
 * Save the whole file from the v9 code drawer. The drawer loaded `baseline` (and,
 * since S08, the hash the owner issued for it: `baseHash`, which wins — a draft
 * restored after a restart only knows the hash it was typed against). If the file on
 * disk no longer matches (the user edited it in their own editor, or the agent wrote
 * it), refuse rather than clobber — same contract as undo/redo; the draft stays in
 * the editor. Otherwise the save is a proposal like any other edit, so it lands in
 * the Undo history and the dev server's HMR refreshes the preview.
 */
async function writeSourceFile(
  root: string,
  source: string,
  baseline: string,
  content: string,
  baseHash?: string
): Promise<SourceWriteResult> {
  const loc = resolveSource(root, source)
  if (!loc) return { ok: false, error: 'Could not resolve the source location.' }
  // The drawer shows these as a preview/placeholder rather than text, so a save
  // could only ever be a utf8 round-trip that corrupts them.
  if (mediaTypeFor(loc.file)) return { ok: false, error: 'This file is not editable as text.' }
  const expected = typeof baseHash === 'string' && /^[0-9a-f]{64}$/.test(baseHash) ? baseHash : contentHash(baseline)
  try {
    const owner = sourceOwner()
    const current = await owner.read(root, loc.file)
    if (current.binary || current.content === undefined || looksBinary(current.content)) {
      return { ok: false, error: 'This file is not editable as text.' }
    }
    if (current.hash !== expected) return { ok: false, conflict: true }
    if (current.content === content) return { ok: true, hash: expected }
    const result = await owner.commit(root, [{ path: loc.file, expectedHash: expected, content }], { key: `${source}:drawer` })
    return result.ok ? { ok: true, hash: result.hashes[0] } : { ok: false, conflict: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not write the source file.' }
  }
}

// "Open in editor": the platform owner runs the editor CLIs (`PlatformOpen.swift`).
async function openInEditor(
  root: string,
  source: string
): Promise<{ ok: boolean; error?: string }> {
  const loc = resolveSource(root, source)
  if (!loc) return { ok: false, error: 'Could not resolve the source location.' }
  try {
    await readFile(loc.file) // don't hand a nonexistent path to an editor
  } catch {
    return { ok: false, error: 'The source file does not exist.' }
  }
  try {
    return await platformOwner().openInEditor(root, loc.file, loc.line, loc.column)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve a component NAME used in `fromFile` (repo-relative) to the file that
 * defines it, by reading the import statement and resolving its specifier —
 * relative paths, the common `src` aliases ($lib for SvelteKit, @/ and ~/), and
 * one hop through a barrel/index re-export. Returns a repo-relative path, or
 * null when the import is a bare package or nothing matches.
 */
function resolveComponentByImports(root: string, fromFile: string, name: string): string | null {
  if (!/^[A-Za-z_][\w$]*$/.test(name)) return null
  const abs = normalize(join(root, fromFile))
  if (!abs.startsWith(normalize(root))) return null
  let code: string
  try {
    code = readFileSync(abs, 'utf8')
  } catch {
    return null
  }
  const spec = findImportSpec(code, name)
  if (!spec) return null
  return resolveSpec(root, dirname(abs), spec, name, 0)
}

/** The module specifier importing `name` (default, named, or aliased). */
function findImportSpec(code: string, name: string): string | null {
  for (const m of code.matchAll(/import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const locals = m[1]
      .replace(/[{}]/g, ',')
      .split(',')
      .map((part) => {
        const bits = part.trim().split(/\s+as\s+/)
        return (bits[1] ?? bits[0]).trim()
      })
    if (locals.includes(name)) return m[2]
  }
  return null
}

const RESOLVE_EXTS = ['', '.svelte', '.tsx', '.jsx', '.ts', '.js', '.vue', '.mjs']

function resolveSpec(
  root: string,
  fromDir: string,
  spec: string,
  name: string,
  depth: number
): string | null {
  let base: string | null = null
  if (spec.startsWith('.')) base = resolve(fromDir, spec)
  else if (spec === '$lib' || spec.startsWith('$lib/')) base = join(root, 'src/lib', spec.slice(5))
  else if (spec.startsWith('@/')) base = join(root, 'src', spec.slice(2))
  else if (spec.startsWith('~/')) base = join(root, 'src', spec.slice(2))
  else return null // bare package import — nothing to open
  if (!normalize(base).startsWith(normalize(root))) return null

  const candidates: string[] = RESOLVE_EXTS.map((e) => base + e)
  for (const e of RESOLVE_EXTS.slice(1)) candidates.push(join(base, `index${e}`))
  const hit = candidates.find((c) => {
    try {
      return existsSync(c) && statSync(c).isFile()
    } catch {
      return false
    }
  })
  if (!hit) return null

  const rel = relative(root, hit)
  const stem = basename(hit).replace(/\.[^.]+$/, '')
  // Direct hit (file named after the component) — done. Otherwise this is
  // likely a barrel; follow ONE re-export hop for `name`.
  if (stem.toLowerCase() === name.toLowerCase() || depth >= 2) return rel
  try {
    const barrel = readFileSync(hit, 'utf8')
    const reExport = new RegExp(
      `export\\s+(?:\\{[^}]*\\b(?:default\\s+as\\s+)?${name}\\b[^}]*\\}|\\*)\\s*from\\s*['"]([^'"]+)['"]`,
      'g'
    )
    for (const m of barrel.matchAll(reExport)) {
      const next = resolveSpec(root, dirname(hit), m[1], name, depth + 1)
      if (next) return next
    }
    // import X … ; export { X } — the two-statement barrel style.
    const spec2 = findImportSpec(barrel, name)
    if (spec2 && new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(barrel)) {
      const next = resolveSpec(root, dirname(hit), spec2, name, depth + 1)
      if (next) return next
    }
  } catch {
    /* barrel unreadable — the barrel itself is still a useful destination */
  }
  return rel
}

export function registerPropsIpc(): void {
  ipcMain.handle('props:inspect', (_e, root: string, source: string, text?: string | null) =>
    inspectProps(root, source, text)
  )
  ipcMain.handle('props:apply', (_e, root: string, edit: PropEdit) => applyPropEdit(root, edit))
  ipcMain.handle('props:remove', (_e, root: string, source: string, name: string) =>
    removeProp(root, source, name)
  )
  ipcMain.handle('text:apply', (_e, root: string, edit: { source: string; text: string }) =>
    applyTextEdit(root, edit)
  )
  // Cmd+click in the code drawer: resolve a component tag name to its source
  // file via the current file's imports (aliases + one barrel hop included).
  ipcMain.handle('source:resolve-component', (_e, root: string, fromFile: string, name: string) =>
    resolveComponentByImports(root, fromFile, name)
  )
  // v2 code peek: read the stamped file inline / jump to it in the user's editor.
  ipcMain.handle('source:read', (_e, root: string, source: string) => readSourceView(root, source))
  ipcMain.handle('source:open-in-editor', (_e, root: string, source: string) =>
    openInEditor(root, source)
  )
  // v9 phase 2: save the whole file from the editable code drawer.
  ipcMain.handle(
    'source:write',
    (_e, root: string, source: string, baseline: string, content: string, baseHash?: string) =>
      writeSourceFile(root, source, baseline, content, baseHash)
  )
  // S08: unsaved editor drafts survive a restart in the source owner.
  ipcMain.handle('source:drafts', (_e, root: string) => sourceOwner().drafts(root))
  ipcMain.handle('source:save-draft', (_e, root: string, file: string, base: string, text: string) =>
    sourceOwner().saveDraft(root, file, base, text)
  )
  ipcMain.handle('source:clear-draft', (_e, root: string, file: string) => sourceOwner().clearDraft(root, file))
  // v8 F3b: undo/redo over ALL trezi source edits (props, text, token swaps),
  // scoped to the active project root (the rail keeps several projects open).
  ipcMain.handle('edit:undo', (_e, root: string) => undo(root))
  ipcMain.handle('edit:redo', (_e, root: string) => redo(root))
  ipcMain.handle('edit:can', (_e, root: string) => editAvailability(root))
  // Per-turn "Revert changes" (chat): addressable revert of one recorded turn group
  // (chat:<wtId>:<turnNo>) — restores its pre-turn files unless any drifted since.
  ipcMain.handle('edit:revert', (_e, root: string, group: string) => revertGroup(root, group))
  ipcMain.handle('edit:can-revert', (_e, root: string, group: string) =>
    canRevertGroup(root, group)
  )
}
