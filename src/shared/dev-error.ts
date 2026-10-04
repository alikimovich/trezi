/**
 * LKM-151: recognize a dev server's compile or parse error, and the source file it
 * names, from its log output, so Trezi can offer recovery in its own UI instead of
 * leaving the user with the dev server's overlay. Pure: fed one log line at a time.
 *
 * Covers Vite (esbuild, Babel, Oxc/Rolldown `PARSE_ERROR`), Next.js and plain tsc-style
 * `file:line:col` reports. The file may follow the error line (`File: …`, a code frame
 * header), so a recognized error waits a few lines for its file.
 */

import { projectRelative } from './project-path'

export interface DevServerError {
  /** As the dev server printed it (absolute, `./`-relative or root-relative `/src/…`). */
  file: string
  message: string
}

// biome-ignore lint/complexity/useRegexLiterals: a literal would trip noControlCharactersInRegex
const ANSI = new RegExp('\\u001B\\[[0-9;?]*[A-Za-z]', 'g')
const ERROR = /\b(Internal server error|Pre-transform error|PARSE_ERROR|Transform failed|Failed to compile|Parsing ecmascript source code failed|SyntaxError|Unexpected token|Unterminated|Expected corresponding JSX closing tag|Unexpected closing|ERROR:|error TS\d+)/i
const RECOVERED = /\b(hmr update|page reload|Compiled successfully|compiled client and server successfully|✓ Compiled)\b/i
const FILE = /((?:[A-Za-z]:)?(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.(?:tsx|ts|jsx|js|mjs|cjs|mts|cts|vue|svelte|astro|css|scss|sass|less|mdx|md|html))(?=[:\s()[\]'"`,]|$)/
const WAIT = 8

const clean = (line: string): string => line.replace(ANSI, '').replace(/\s+$/, '')

/** The first non-dependency source file a line names, without its position. */
export function sourceFileIn(line: string): string | null {
  for (const match of clean(line).matchAll(new RegExp(FILE.source, 'g'))) {
    const file = match[1]
    if (!/(^|\/)node_modules\//.test(file) && !/^https?:/.test(file) && !/^\d/.test(file)) return file
  }
  return null
}

export class DevErrorReader {
  private pending: { message: string; waited: number } | null = null

  /** An error with its file, `{ recovered }` when the dev server rebuilt, else null. */
  read(raw: string): DevServerError | { recovered: string | null } | null {
    const line = clean(raw).trim()
    if (!line) return null
    if (RECOVERED.test(line) && !ERROR.test(line)) {
      this.pending = null
      return { recovered: sourceFileIn(line) }
    }
    if (ERROR.test(line)) {
      const message = line.replace(/^.*?\[vite\]\s*/, '').replace(/^[⨯✘×x]\s+/, '').slice(0, 400)
      const file = sourceFileIn(line)
      if (file) { this.pending = null; return { file, message } }
      if (!this.pending) this.pending = { message, waited: 0 }
      return null
    }
    if (!this.pending) return null
    const file = sourceFileIn(line)
    if (file) {
      const { message } = this.pending
      this.pending = null
      return { file, message }
    }
    if (++this.pending.waited >= WAIT) this.pending = null
    return null
  }
}

/** The landed file (root-relative) a dev-server error names, if any. */
export function touchedFile(error: DevServerError, root: string, files: string[]): string | null {
  const named = projectRelative(error.file, root, { served: true })
  return files.find(file => named === file || named.endsWith(`/${file}`) || file.endsWith(`/${named}`)) ?? null
}
