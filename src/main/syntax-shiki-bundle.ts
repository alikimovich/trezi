/**
 * The Shiki surface the code editor uses (LKM-183), built into its own ESM bundle that
 * ships inside `Trezi.app` (`Resources/backend/syntax/`, `scripts/build-native.mjs`), so
 * highlighting never resolves packages from the checkout. Each grammar is a separate
 * lazy chunk: only the editor's languages ship and a grammar loads with its first file.
 */
import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import type { SyntaxLanguage } from './syntax-languages'

export { createHighlighterCore, createOnigurumaEngine }
export const loadWasm = () => import('shiki/wasm')

export const languages: Record<Exclude<SyntaxLanguage, 'plaintext'>, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs')
}
