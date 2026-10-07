import type { SyntaxState, SyntaxTokenizer } from './syntax-document'
import type { SyntaxLanguage } from './syntax-languages'
import { SYNTAX_THEME, syntaxCategoryOf } from './syntax-theme'

/**
 * Shiki for the code editor (LKM-183): TextMate grammars on the Oniguruma engine, the
 * same tokenizer VS Code runs. Nothing loads at app start. The engine (WASM) loads with
 * the first highlighted file and each grammar with its first file; Shiki's
 * `bundledLanguages` entries are lazy `import()`s, so only used grammars are read.
 *
 * Shiki is ESM-only and the backend is CJS (dynamic `import()`, like parse5). Only the
 * surface used here is typed.
 */
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

// biome-ignore lint/suspicious/noExplicitAny: module namespaces typed at the use site
const load = (specifier: string): Promise<any> => import(specifier)
let core: Promise<Core> | undefined
const tokenizers = new Map<SyntaxLanguage, Promise<SyntaxTokenizer | null>>()

function loadCore(): Promise<Core> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }, langs] = await Promise.all([
      load('shiki/core'),
      load('shiki/engine/oniguruma'),
      load('shiki/langs').catch(() => load('shiki'))
    ])
    const bundledLanguages: Record<string, unknown> = langs.bundledLanguages
    const highlighter: Highlighter = await createHighlighterCore({
      themes: [SYNTAX_THEME],
      langs: [],
      engine: createOnigurumaEngine(load('shiki/wasm'))
    })
    const { colorMap } = highlighter.setTheme(SYNTAX_THEME.name)
    return {
      highlighter,
      languages: bundledLanguages,
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
