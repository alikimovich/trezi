/**
 * Clickable code in chat (LKM-364). `open_code` candidates carry a Markdown link to
 * their range, `trezi-code:<path>#L<start>-L<end>`. The chat routes every link that is
 * not a web link to Trezi's own editor through the same project checks as `open_code`,
 * and never hands it to another app. Relative links an agent writes itself
 * (`src/App.tsx:12`, `src/App.tsx#L12-L18`) open the same way.
 */
export const CODE_LINK_SCHEME = 'trezi-code:'

export interface CodeLinkTarget {
  file: string
  /** Inclusive 1-based lines; absent when the link names only the file. */
  lines?: { startLine: number; endLine: number }
}

const encodePath = (file: string) => file.split('/').map(encodeURIComponent).join('/')

/** The link's address for a project-relative file and inclusive lines. */
export function codeLinkHref(file: string, startLine: number, endLine = startLine): string {
  const lines = endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`
  return `${CODE_LINK_SCHEME}${encodePath(file)}${lines}`
}

/** `[src/a.css:3-5](trezi-code:src/a.css#L3-L5)`: the filename and range as one link. */
export function codeLinkMarkdown(target: {
  file: string
  startLine: number
  endLine: number
}): string {
  const { file, startLine, endLine } = target
  const label = `${file}:${endLine > startLine ? `${startLine}-${endLine}` : startLine}`
  return `[${label.replace(/[[\]\\]/g, '\\$&')}](${codeLinkHref(file, startLine, endLine)})`
}

/** Web links keep opening in the browser; everything else is project code or nothing. */
export function isWebLink(href: string): boolean {
  return /^(https?|mailto):/i.test(href.trim())
}

const HASH_LINES = /#L(\d+)(?:-L?(\d+))?$/
const SUFFIX_LINES = /:(\d+)(?:(?::\d+)|(?:-(\d+)))?$/

/** The project file and lines a chat link names, or why it cannot open in the editor. */
export function parseCodeLink(href: unknown): CodeLinkTarget | { error: string } {
  if (typeof href !== 'string' || !href.trim() || href.length > 2000)
    return { error: 'This link does not name a project file.' }
  let rest = href.trim()
  if (rest.startsWith(CODE_LINK_SCHEME)) rest = rest.slice(CODE_LINK_SCHEME.length)
  else if (isWebLink(rest)) return { error: 'Web links are not project files.' }
  else if (/^[a-z][\w+.-]*:/i.test(rest) && !/^[a-z][\w+.-]*:\d/i.test(rest))
    return {
      error:
        'Only files inside this project open from chat, in Trezi’s editor; other links are not opened.'
    }
  let lines: CodeLinkTarget['lines']
  const hash = HASH_LINES.exec(rest)
  if (hash) {
    rest = rest.slice(0, hash.index)
    lines = { startLine: Number(hash[1]), endLine: Number(hash[2] ?? hash[1]) }
  }
  let file: string
  try {
    file = decodeURIComponent(rest.replace(/[?#].*$/, ''))
  } catch {
    return { error: 'This link does not name a project file.' }
  }
  const suffix = lines ? null : SUFFIX_LINES.exec(file)
  if (suffix) {
    file = file.slice(0, suffix.index)
    lines = { startLine: Number(suffix[1]), endLine: Number(suffix[2] ?? suffix[1]) }
  }
  file = file.replace(/^\.\//, '')
  if (!file || file.includes('\0')) return { error: 'This link does not name a project file.' }
  if (file.startsWith('/') || file.startsWith('~') || /^[a-z]:[\\/]/i.test(file))
    return { error: 'Only project-relative files open from chat, in Trezi’s editor.' }
  if (
    lines &&
    (!Number.isSafeInteger(lines.startLine) ||
      !Number.isSafeInteger(lines.endLine) ||
      lines.startLine < 1 ||
      lines.endLine < lines.startLine)
  )
    return { error: 'This link’s line range is not valid.' }
  return lines ? { file, lines } : { file }
}
