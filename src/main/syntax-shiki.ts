import type { SyntaxState, SyntaxTokenizer } from './syntax-document'
import type { SyntaxLanguage } from './syntax-languages'
import { SYNTAX_THEME, syntaxCategoryOf } from './syntax-theme'

/**
 * Shiki for the code editor (LKM-183): TextMate grammars on the Oniguruma engine, the
 * same tokenizer VS Code runs. Nothing loads at app start. The engine (WASM) loads with
 * the first highlighted file and each grammar with its first file.
 *
 * Shiki comes from `syntax-shiki-bundle.ts`: from source when run unbuilt, and in the
 * app from its own ESM bundle inside `Resources/backend/syntax/` (`TREZI_SYNTAX_BUNDLE`,
 * set by `scripts/build-native.mjs`), so it never resolves from the checkout. Only the
 * surface used here is typed.
 */
declare const TREZI_SYNTAX_BUNDLE: string | undefined
type Grammar = {
  tokenizeLine2(
    line: string,
    state: SyntaxState | null
  ): { tokens: Uint32Array; ruleStack: SyntaxState }
}
type Highlighter = {
  loadLanguage(...languages: unknown[]): Promise<void>
  getLanguage(name: string): Grammar
  setTheme(name: string): { colorMap: string[] }
}
type Core = { highlighter: Highlighter; languages: Record<string, unknown>; categories: Int8Array }

/** TextMate metadata: foreground colour index, bits 15–23. */
const FOREGROUND_MASK = 0b00000000_11111111_10000000_00000000
const FOREGROUND_OFFSET = 15

/** The Shiki module: the app's own bundle when built, the source module otherwise. */
export const SYNTAX_SHIKI_MODULE =
  typeof TREZI_SYNTAX_BUNDLE === 'string' ? TREZI_SYNTAX_BUNDLE : './syntax-shiki-bundle.ts'
// A variable specifier keeps esbuild from inlining Shiki into the CJS backend bundle.
// biome-ignore lint/suspicious/noExplicitAny: module namespace typed at the use site
const load = (specifier: string): Promise<any> => import(specifier)
let core: Promise<Core> | undefined
const tokenizers = new Map<SyntaxLanguage, Promise<SyntaxTokenizer | null>>()

function loadCore(): Promise<Core> {
  core ??= (async () => {
    const shiki = await load(SYNTAX_SHIKI_MODULE)
    const highlighter: Highlighter = await shiki.createHighlighterCore({
      themes: [SYNTAX_THEME],
      langs: [],
      engine: shiki.createOnigurumaEngine(shiki.loadWasm())
    })
    const { colorMap } = highlighter.setTheme(SYNTAX_THEME.name)
    return {
      highlighter,
      languages: shiki.languages,
      categories: Int8Array.from(colorMap, syntaxCategoryOf)
    }
  })()
  // A failed load (Shiki missing) is retried with the next file, not cached forever.
  core.catch(() => {
    core = undefined
  })
  return core
}

/** The tokenizer for a language; `null` for plain text. Rejects when Shiki cannot load. */
export function syntaxTokenizer(language: SyntaxLanguage): Promise<SyntaxTokenizer | null> {
  if (language === 'plaintext') return Promise.resolve(null)
  let tokenizer = tokenizers.get(language)
  if (!tokenizer) {
    tokenizer = (async () => {
      const { highlighter, languages, categories } = await loadCore()
      const loader = languages[language]
      if (!loader) return null
      await highlighter.loadLanguage(loader)
      const grammar = highlighter.getLanguage(language)
      return {
        tokenizeLine2: (line: string, state: SyntaxState | null) =>
          grammar.tokenizeLine2(line, state),
        category: (metadata: number) =>
          categories[(metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET] ?? 0
      }
    })()
    tokenizers.set(language, tokenizer)
    tokenizer.catch(() => tokenizers.delete(language))
  }
  return tokenizer
}
