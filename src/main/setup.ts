import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { ipcMain } from '../native/platform'
import type { Frontend, SetupResult, SetupStrategy } from '../shared/api'
import { syncChatHelpers } from './chat-helpers'
import { MDX_HELPER, MDX_HELPER_CONTENT } from './setup-mdx'
import {
  detectNext,
  NEXT_ADAPTER,
  NEXT_ADAPTER_CONTENT,
  NEXT_LOADER,
  NEXT_LOADER_CONTENT
} from './setup-next'
import { REACT_HELPER_CONTENT } from './setup-react'
import { detectVite, VITE_HELPER, VITE_HELPER_CONTENT } from './setup-vite'
import { type HelperFile, workflowOwner } from './workflow-owner'

/**
 * Project setup — make a repo trezi-ready, FRAMEWORK-FIRST. We detect the UI
 * framework from package.json before generating anything, then emit the right
 * source-mapping instrumentation for it (never a React Babel plugin in a Svelte
 * repo). Everything lands in a namespaced `.trezi/` dir, is structurally dev-gated
 * (not just a comment), idempotent, and removable via uninstall. The agent does
 * the config wiring + prop typing with framework-correct instructions.
 */

const REACT_HELPER = '.trezi/trezi-source.cjs'
const RN_HELPER = '.trezi/trezi-rn-source.cjs'
// `.mjs` pins ESM regardless of the repo's package.json `type` (plain Svelte+Vite
// repos are often `type: commonjs`, where a bare `.js` ESM file fails to import) —
// mirrors the React helper pinning CommonJS via `.cjs`.
const SVELTE_HELPER = '.trezi/trezi-svelte-stamp.mjs'
// React/Solid: a JSX Babel plugin that stamps data-trezi-source. Structurally
// dev-gated (returns an empty visitor in production — not trust-the-comment).
// React Native: the data-trezi-source analog. RN host elements have no DOM, so we
// stamp `testID="trezi:path:line:col"` — which iOS surfaces as the view's
// accessibilityIdentifier, letting trezi map an idb view-hierarchy hit back to
// source. Dev-gated; only stamps elements without an existing testID.
const RN_HELPER_CONTENT = `// Added by Trezi (.trezi/). Stamps testID="trezi:path:line:col" on JSX elements so
// Trezi can map a tapped simulator element to its source via idb's accessibility
// hierarchy. Wire into the React Native Babel plugins for DEVELOPMENT ONLY; it
// also self-disables in production builds.
module.exports = function treziRnSource({ types: t }) {
  if (process.env.NODE_ENV === 'production') return { name: 'trezi-rn-source', visitor: {} }
  const path = require('path')
  return {
    name: 'trezi-rn-source',
    visitor: {
      JSXOpeningElement(p, state) {
        const loc = p.node.loc
        if (!loc) return
        // Don't clobber an existing testID (the app may rely on it for tests).
        if (p.node.attributes.some((a) => a.name && a.name.name === 'testID')) return
        const root = state.file.opts.root || process.cwd()
        const file = path.relative(root, state.file.opts.filename || '')
        p.node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier('testID'),
            t.stringLiteral('trezi:' + file + ':' + loc.start.line + ':' + loc.start.column)
          )
        )
      }
    }
  }
}
`

// Svelte: a markup preprocessor that stamps data-trezi-source on elements. The
// line/col use svelte/compiler offsets (1-based line, 0-based col) so they match
// trezi's Svelte adapter. Dev-gated; idempotent.
export const SVELTE_HELPER_CONTENT = `// Added by Trezi (.trezi/). A dev-only Svelte markup preprocessor that stamps
// data-trezi-source="path:line:col" on elements so Trezi can map them to source.
// Add to svelte.config preprocess for development only.
import { parse } from 'svelte/compiler'
import path from 'node:path'

const ELEMENT_TYPES = new Set(['RegularElement', 'Component', 'SvelteComponent'])

function lineCol(code, offset) {
  let line = 1, last = 0
  for (let i = 0; i < offset; i++) if (code[i] === '\\n') { line++; last = i + 1 }
  return { line, column: offset - last }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const k of Object.keys(node)) {
    const v = node[k]
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit))
    else if (v && typeof v === 'object') walk(v, visit)
  }
}

export default function treziStamp() {
  const noop = { name: 'trezi-stamp', markup: ({ content }) => ({ code: content }) }
  if (process.env.NODE_ENV === 'production') return noop
  return {
    name: 'trezi-stamp',
    markup({ content, filename }) {
      let ast
      try { ast = parse(content, { modern: true, filename }) } catch { return { code: content } }
      const rel = filename ? path.relative(process.cwd(), filename) : 'unknown'
      const inserts = []
      walk(ast.fragment ?? ast, (n) => {
        if (!ELEMENT_TYPES.has(n.type) || typeof n.start !== 'number' || typeof n.name !== 'string') return
        const attrs = n.attributes || []
        if (attrs.some((a) => ['data-trezi-source', 'data-praxis-source'].includes(a.name))) return
        const pos = n.start + 1 + n.name.length
        // Only splice when start points exactly at '<name' — bail on any misaligned
        // offset rather than corrupt markup mid-token (mirrors props-svelte.ts).
        if (content.slice(n.start + 1, pos) !== n.name) return
        const { line, column } = lineCol(content, n.start)
        inserts.push({ pos, text: ' data-trezi-source="' + rel + ':' + line + ':' + column + '"' })
      })
      inserts.sort((a, b) => b.pos - a.pos)
      let code = content
      for (const i of inserts) code = code.slice(0, i.pos) + i.text + code.slice(i.pos)
      return { code }
    }
  }
}
`

/** Read package.json dependency names (deps + devDeps + peerDeps). */
async function readDeps(root: string): Promise<Set<string>> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {})
    ])
  } catch {
    return new Set()
  }
}

async function svelteMajorOf(root: string): Promise<number> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const v = String(pkg.devDependencies?.svelte ?? pkg.dependencies?.svelte ?? '')
    const m = /(\d+)/.exec(v.replace(/^[^\d]*/, ''))
    return m ? Number(m[1]) : 5
  } catch {
    return 5
  }
}

export interface Detected {
  framework: Frontend
  strategy: SetupStrategy
  svelteMajor?: number
  next?: SetupResult['next']
  vite?: SetupResult['vite']
}

/** Detect the UI framework from deps FIRST — never assume React. */
export async function detect(root: string): Promise<Detected> {
  const deps = await readDeps(root)
  const has = (n: string): boolean => deps.has(n)
  // Svelte / SvelteKit
  if (has('@sveltejs/kit') || has('svelte')) {
    return {
      framework: 'svelte',
      strategy: 'svelte-preprocess',
      svelteMajor: await svelteMajorOf(root)
    }
  }
  // React Native / Expo FIRST (they also depend on react) — stamp testID, not
  // data-trezi-source, since RN host elements have no DOM.
  if (has('react-native') || has('expo')) {
    return { framework: 'react-native', strategy: 'babel-plugin-rn' }
  }
  if (has('next'))
    return { framework: 'next', strategy: 'next-loader', next: await detectNext(root) }
  // React (incl. the React Vite plugins)
  if (has('react') || has('@vitejs/plugin-react') || has('@vitejs/plugin-react-swc')) {
    // Vite (any version) gets Trezi's pre-transform plugin; other React builds keep Babel.
    const vite = await detectVite(root)
    return vite
      ? { framework: 'react', strategy: 'vite-plugin', vite }
      : { framework: 'react', strategy: 'babel-plugin' }
  }
  // Solid also uses JSX, so the same Babel JSX visitor works.
  if (has('solid-js')) return { framework: 'solid', strategy: 'babel-plugin' }
  // Vue has its own inspector ecosystem — prefer that, don't emit a bespoke plugin.
  if (has('vue')) return { framework: 'vue', strategy: 'inspector' }
  return { framework: 'unknown', strategy: 'none' }
}

/** The helper files a framework needs (their sources are this module's constants). */
export function helperFiles(d: Detected): HelperFile[] {
  if (d.strategy === 'inspector' || d.strategy === 'none') return []
  const helper =
    d.strategy === 'svelte-preprocess'
      ? SVELTE_HELPER
      : d.strategy === 'babel-plugin-rn'
        ? RN_HELPER
        : REACT_HELPER
  const content =
    d.strategy === 'svelte-preprocess'
      ? SVELTE_HELPER_CONTENT
      : d.strategy === 'babel-plugin-rn'
        ? RN_HELPER_CONTENT
        : REACT_HELPER_CONTENT
  const files = [{ path: helper, content }]
  if (d.strategy === 'vite-plugin') files.push({ path: VITE_HELPER, content: VITE_HELPER_CONTENT })
  if (d.framework === 'next') {
    files.push(
      { path: NEXT_LOADER, content: NEXT_LOADER_CONTENT },
      { path: NEXT_ADAPTER, content: NEXT_ADAPTER_CONTENT },
      { path: MDX_HELPER, content: MDX_HELPER_CONTENT }
    )
  }
  return files
}

/**
 * A chat runs in its own worktree, where the live `.trezi/` helpers are not tracked
 * and the agent may not write them (LKM-153). Trezi copies them in before the setup
 * turn and checks every hash, so a missing helper is Trezi's reported failure, not
 * the agent's dead end. The dev server keeps reading the live copies.
 */
async function provideHelpers(
  root: string,
  chat: string,
  helpers: Array<{ path: string; sha256: string }>
): Promise<string | null> {
  const checkout = await syncChatHelpers(chat, root)
  if (!checkout) return null
  for (const helper of helpers) {
    const data = await readFile(join(checkout, helper.path)).catch(() => null)
    if (!data || createHash('sha256').update(data).digest('hex') !== helper.sha256) {
      throw new Error(`Trezi could not copy ${helper.path} into the chat workspace (${checkout}).`)
    }
  }
  return checkout
}

/** Detect (JS helper), then have the workflow owner write the missing helpers. */
export async function scaffold(root: string, chat?: string): Promise<SetupResult> {
  try {
    const d = await detect(root)
    // Nothing to write for vue (use its inspector) or an unknown framework.
    const files = helperFiles(d)
    if (!files.length)
      return { ok: true, framework: d.framework, strategy: d.strategy, files: [], written: false }
    const write = await workflowOwner().writeHelpers(root, files)
    if (!write.ok) return { ok: false, error: write.error }
    const checkout = chat && write.helpers ? await provideHelpers(root, chat, write.helpers) : null
    return {
      ok: true,
      next: d.next,
      ...(d.vite ? { vite: d.vite } : {}),
      ...(checkout ? { checkout } : {}),
      helpers: write.helpers,
      framework: d.framework,
      strategy: d.strategy,
      files: files.map((file) => file.path),
      written: write.written,
      ...(d.svelteMajor ? { svelteMajor: d.svelteMajor } : {})
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerSetupIpc(): void {
  // Read-only probe: detect the UI framework without writing, so the renderer can
  // decide whether setup is even possible (an 'unknown'/vanilla project has no
  // instrumentation strategy — never offer a dead-end "Set it up").
  ipcMain.handle('setup:detect', async (_e, root: string) => {
    const d = await detect(root)
    return { framework: d.framework, canInstrument: d.framework !== 'unknown' }
  })
  ipcMain.handle('setup:scaffold', (_e, root: string, chat?: unknown) =>
    scaffold(root, typeof chat === 'string' && chat ? chat : undefined)
  )
  ipcMain.handle('setup:uninstall', (_e, root: string) => workflowOwner().removeHelpers(root))
}
