/**
 * The code editor's languages (LKM-183). Ids are Shiki's bundled grammar ids; a file
 * whose extension is not listed is plain text and never loads a grammar.
 */
export const SYNTAX_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'css',
  'scss',
  'html',
  'json',
  'jsonc',
  'markdown',
  'mdx',
  'svelte',
  'vue',
  'swift',
  'yaml',
  'shellscript'
] as const
export type SyntaxLanguage = (typeof SYNTAX_LANGUAGES)[number] | 'plaintext'

const EXTENSIONS: Record<string, SyntaxLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  svelte: 'svelte',
  vue: 'vue',
  swift: 'swift',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript'
}
/** Config files that are JSON with comments, and dotfiles that are shell. */
const NAMES: Record<string, SyntaxLanguage> = {
  'tsconfig.json': 'jsonc',
  'jsconfig.json': 'jsonc',
  '.eslintrc.json': 'jsonc',
  '.babelrc': 'jsonc',
  'biome.json': 'jsonc',
  '.zshrc': 'shellscript',
  '.bashrc': 'shellscript',
  '.profile': 'shellscript',
  '.env': 'shellscript'
}

/** The language for a project-relative path, from its name or extension. */
export function syntaxLanguage(path: string): SyntaxLanguage {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (NAMES[name]) return NAMES[name]
  if (/^tsconfig\..*\.json$/.test(name)) return 'jsonc'
  if (/^\.env\./.test(name)) return 'shellscript'
  const dot = name.lastIndexOf('.')
  return (dot > 0 && EXTENSIONS[name.slice(dot + 1)]) || 'plaintext'
}
