// Namespace import (not `{ ipcMain }`) so this module — and `style-tokens.ts`,
// which imports `detectTokens` from here for its OWN pure re-validation logic
// — can be loaded under plain bun for unit testing (see test/style-tokens.mjs).

import type { Dirent } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import * as platform from '../native/platform'
import type { Token, TokenGroup, TokenScaffoldResult, TokenSet } from '../shared/api'
import { editingOwner } from './editing-owner'
import type { RpcHandlerRegistry } from './rpc-router'

/**
 * Design-token detection (the differentiator's last piece). A repo can expose
 * tokens three ways; we probe them in priority order and the first that yields
 * tokens wins, so the right source is chosen per project automatically:
 *
 *   1. `.trezi/tokens.json`  — an explicit, curated manifest (highest priority)
 *   2. `tailwind.config.*`  — the theme scale (static parse, no code execution)
 *   3. CSS custom properties — `--name: value` scanned from the repo's
 *      stylesheets (css/scss/sass/less/styl/pcss — the syntax is identical
 *      across them). This also covers Tailwind v4, whose `@theme { --color-…: }`
 *      block IS a custom-property declaration.
 *
 * The Tailwind config is parsed *statically* (babel, literal values only) — we
 * never execute the repo's config. @babel/parser is ESM-only → dynamic import().
 */

type BabelParser = typeof import('@babel/parser')
let babelPromise: Promise<BabelParser> | null = null
const loadBabel = (): Promise<BabelParser> => (babelPromise ??= import('@babel/parser'))

const TAILWIND_CONFIGS = [
  'tailwind.config.js',
  'tailwind.config.cjs',
  'tailwind.config.mjs',
  'tailwind.config.ts'
]
// Theme categories we surface (in this order).
const TW_CATEGORIES = ['colors', 'spacing', 'fontSize', 'borderRadius', 'fontWeight', 'boxShadow']

// ---------------------------------------------------------------------------
// 1. Manifest: .trezi/tokens.json  → { groupName: { tokenName: "value" } }
// ---------------------------------------------------------------------------
async function fromManifest(root: string): Promise<TokenSet | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(root, '.trezi', 'tokens.json'), 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const groups: TokenGroup[] = []
  for (const [groupName, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entries || typeof entries !== 'object') continue
    const tokens: Token[] = []
    for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') {
        tokens.push({ name, value: String(value) })
      }
    }
    if (tokens.length) groups.push({ name: groupName, tokens })
  }
  return groups.length ? { source: 'manifest', origin: '.trezi/tokens.json', groups } : null
}

// ---------------------------------------------------------------------------
// 2. Tailwind config (static parse)
// ---------------------------------------------------------------------------
interface Node {
  type: string
  [k: string]: unknown
}

/** Flatten an ObjectExpression of literal leaves to tokens (nested → "a-b"). */
function flattenObject(node: Node, prefix: string, out: Token[]): void {
  for (const prop of (node.properties as Node[] | undefined) ?? []) {
    if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue
    const key = keyName(prop.key as Node)
    if (key == null) continue
    const name = prefix ? `${prefix}-${key}` : key
    const value = prop.value as Node
    if (value.type === 'StringLiteral' || value.type === 'NumericLiteral') {
      out.push({ name, value: String((value as unknown as { value: unknown }).value) })
    } else if (value.type === 'ObjectExpression') {
      flattenObject(value, name, out)
    }
  }
}

function keyName(key: Node): string | null {
  if (key.type === 'Identifier') return (key as { name?: string }).name ?? null
  if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') {
    return String((key as unknown as { value: unknown }).value)
  }
  return null
}

/** Peel TS `as`/`satisfies`/parens off an expression. */
function unwrapExpr(node: Node | undefined): Node | undefined {
  let n = node
  while (
    n &&
    (n.type === 'TSAsExpression' ||
      n.type === 'TSSatisfiesExpression' ||
      n.type === 'ParenthesizedExpression')
  ) {
    n = n.expression as Node
  }
  return n
}

function isModuleExports(node: Node | undefined): boolean {
  return (
    node?.type === 'MemberExpression' &&
    (node.object as Node)?.type === 'Identifier' &&
    (node.object as { name?: string }).name === 'module' &&
    (node.property as Node)?.type === 'Identifier' &&
    (node.property as { name?: string }).name === 'exports'
  )
}

/** The config object literal: `export default {…}` or `module.exports = {…}`. */
function findConfigObject(ast: Node): Node | null {
  const body = ((ast.program as Node | undefined)?.body as Node[] | undefined) ?? []
  for (const stmt of body) {
    if (stmt.type === 'ExportDefaultDeclaration') {
      const d = unwrapExpr(stmt.declaration as Node)
      if (d?.type === 'ObjectExpression') return d
    } else if (stmt.type === 'ExpressionStatement') {
      const e = stmt.expression as Node
      if (e?.type === 'AssignmentExpression' && isModuleExports(e.left as Node)) {
        const r = unwrapExpr(e.right as Node)
        if (r?.type === 'ObjectExpression') return r
      }
    }
  }
  return null
}

/** The ObjectExpression value of `obj.<key>`, if any. */
function objectProp(obj: Node, key: string): Node | null {
  for (const prop of (obj.properties as Node[] | undefined) ?? []) {
    if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue
    if (keyName(prop.key as Node) === key && (prop.value as Node)?.type === 'ObjectExpression') {
      return prop.value as Node
    }
  }
  return null
}

async function fromTailwind(root: string): Promise<TokenSet | null> {
  let code: string | null = null
  let origin = ''
  for (const name of TAILWIND_CONFIGS) {
    try {
      code = await readFile(join(root, name), 'utf8')
      origin = name
      break
    } catch {
      /* try next */
    }
  }
  if (code == null) return null
  try {
    const { parse } = await loadBabel()
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript']
    }) as unknown as Node
    // Scope to the config's own `theme` (not any nested `theme:` in a plugin/preset).
    const config = findConfigObject(ast)
    const theme = config && objectProp(config, 'theme')
    if (!theme) return null
    const extend = objectProp(theme, 'extend')
    const groups: TokenGroup[] = []
    for (const category of TW_CATEGORIES) {
      const tokens: Token[] = []
      // `theme.extend.<cat>` is merged on top of `theme.<cat>` — emit extend
      // first so dedupe (keeps first) lets it win on a name collision.
      const ext = extend && objectProp(extend, category)
      const base = objectProp(theme, category)
      if (ext) flattenObject(ext, '', tokens)
      if (base) flattenObject(base, '', tokens)
      if (tokens.length) groups.push({ name: category, tokens: dedupe(tokens) })
    }
    return groups.length ? { source: 'tailwind', origin, groups } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 3. CSS custom properties
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage'])
const CSS_VAR_RE = /(--[A-Za-z0-9-]+)\s*:\s*([^;}{]+)[;}]/g
/** Stylesheet extensions worth scanning. The preprocessor dialects are here
 * because `--name: value` is *CSS* custom-property syntax that passes through
 * less/sass/stylus untouched — we deliberately do NOT read their own variable
 * forms (`@name:` / `$name:`), which don't exist at runtime and so can't be
 * committed back as a `var()` reference. */
const STYLESHEET_RE = /\.(css|scss|sass|less|styl|pcss)$/
/** Walk bounds — a monorepo's `packages/ui/src/styles/tokens.css` is depth 5. */
const MAX_DEPTH = 6
const MAX_FILES = 120
/** Bound the emitted set: a TokenSet rides in every PanelState push. */
const MAX_TOKENS = 400

async function findCssFiles(root: string, depth: number, acc: string[]): Promise<void> {
  if (depth > MAX_DEPTH || acc.length >= MAX_FILES) return
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      await findCssFiles(join(root, e.name), depth + 1, acc)
    } else if (STYLESHEET_RE.test(e.name)) {
      acc.push(join(root, e.name))
    }
  }
}

/** Group a custom property by its first name segment, e.g. --color-bg → "color". */
function cssGroupOf(name: string): string {
  const seg = name.replace(/^--/, '').split('-')[0]
  return seg || 'tokens'
}

/**
 * First definition of a custom property wins. That's deliberate, not a
 * limitation we mean to fix here: a theme file typically declares `--color-text`
 * once at `:root` and again under `@media (prefers-color-scheme: dark)` / a
 * `.dark` class, and picking a winner statically would mean modelling the
 * cascade. The token's *identity* (name + group) is what the UI needs; its live
 * value is read off the selected element with
 * `getComputedStyle(el).getPropertyValue('--color-text')` — see the Styles
 * panel's token resolution — which is theme-correct by construction.
 */
async function fromCss(root: string): Promise<TokenSet | null> {
  const files: string[] = []
  await findCssFiles(root, 0, files)
  const byGroup = new Map<string, Token[]>()
  const seen = new Set<string>()
  for (const f of files) {
    if (seen.size >= MAX_TOKENS) break
    let css: string
    try {
      css = await readFile(f, 'utf8')
    } catch {
      continue
    }
    if (css.length > 500_000) continue
    for (const m of css.matchAll(CSS_VAR_RE)) {
      if (seen.size >= MAX_TOKENS) break
      const name = m[1]
      const value = m[2].trim()
      if (!value || value.startsWith('var(') || seen.has(name)) continue
      seen.add(name)
      const g = cssGroupOf(name)
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g)!.push({ name, value })
    }
  }
  const groups: TokenGroup[] = [...byGroup.entries()].map(([name, tokens]) => ({ name, tokens }))
  return groups.length ? { source: 'css', origin: `${files.length} CSS file(s)`, groups } : null
}

function dedupe(tokens: Token[]): Token[] {
  const seen = new Set<string>()
  return tokens.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
}

export async function detectTokens(root: string): Promise<TokenSet> {
  return (
    (await fromManifest(root)) ??
    (await fromTailwind(root)) ??
    (await fromCss(root)) ?? { source: 'none', groups: [] }
  )
}

// A small, framework-neutral starter palette for projects that have no tokens
// yet — something to edit, and enough to make the palette useful from day one.
const STARTER_MANIFEST = {
  colors: {
    primary: '#2563eb',
    secondary: '#7c3aed',
    text: '#111827',
    muted: '#6b7280',
    background: '#ffffff',
    border: '#e5e7eb'
  },
  spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px' },
  radius: { sm: '4px', md: '8px', lg: '16px', full: '9999px' },
  fontSize: { sm: '14px', base: '16px', lg: '20px', xl: '28px' }
} as const

/**
 * Write a starter `.trezi/tokens.json` so a token-less project gets an editable,
 * canonical token source (which then wins detection). Idempotent: if a manifest
 * already exists we leave it untouched and report `written: false`. The editing
 * owner creates the file (S15): create-only, so an existing file that detection
 * could not read (damaged, or written meanwhile) is refused, never replaced.
 */
async function scaffoldManifest(root: string): Promise<TokenScaffoldResult> {
  try {
    // Only scaffold when the project has NO tokens at all — never shadow a live
    // source (Tailwind / CSS vars) or clobber an existing manifest with a starter.
    const current = await detectTokens(root)
    if (current.source !== 'none') {
      return { ok: true, written: false, set: current }
    }
    const result = await editingOwner().sidecar(
      root,
      'tokens.json',
      null,
      JSON.stringify(STARTER_MANIFEST, null, 2) + '\n'
    )
    if (!result.ok) {
      return {
        ok: false,
        written: false,
        error: '.trezi/tokens.json already exists; it was left untouched.'
      }
    }
    return { ok: true, written: true, set: await detectTokens(root) }
  } catch (err) {
    return { ok: false, written: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerTokensIpc(
  router: RpcHandlerRegistry = platform.ipcMain as unknown as RpcHandlerRegistry
): void {
  router.handle('tokens:detect', (_e, root: string) => detectTokens(root))
  router.handle('tokens:scaffold', (_e, root: string) => scaffoldManifest(root))
}
