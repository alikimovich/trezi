/**
 * Clickable code in chat (LKM-364). `open_code` candidates carry a Markdown link to
 * their range, `trezi-code:<path>#L<start>-L<end>`. Relative links an agent writes itself
 * (`src/App.tsx:12`, `src/App.tsx#L12-L18`) open the same way. LKM-657: every non-web
 * link is parsed once by `parseChatLink` and routed by `src/main/chat-links.ts` (editor,
 * Quick Look, Finder or a notice); no link is ever handed to another app.
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

// Some macOS/Foundation versions hand AppKit's link URL back with `#` as `%23`.
const HASH_LINES = /(?:#|%23)L(\d+)(?:-L?(\d+))?$/i
const SUFFIX_LINES = /:(\d+)(?:(?::\d+)|(?:-(\d+)))?$/
const NOT_A_FILE = 'This link does not name a project file.'

type Lines = CodeLinkTarget['lines']

/**
 * LKM-657: what a link clicked in chat names, parsed once. `project` is a project-relative
 * file (the LKM-364 forms); `local` an absolute path on this Mac, from `/…`, `~/…`,
 * `trezi-code:/…` or a `file:` URL without a remote host, lexically decoded but not yet
 * checked against any root (the caller canonicalizes it and checks containment). Remote
 * file hosts, UNC/Windows paths and every other scheme are `refused`.
 */
export type ChatLink =
  | { kind: 'web'; url: string }
  | { kind: 'project'; file: string; lines?: Lines }
  | { kind: 'local'; path: string; lines?: Lines }
  | { kind: 'refused'; error: string }

const refused = (error: string): ChatLink => ({ kind: 'refused', error })

function lineRange(rest: string): { rest: string; lines?: Lines } {
  const hash = HASH_LINES.exec(rest)
  if (!hash) return { rest }
  return {
    rest: rest.slice(0, hash.index),
    lines: { startLine: Number(hash[1]), endLine: Number(hash[2] ?? hash[1]) }
  }
}

const validLines = (lines: Lines) =>
  !lines ||
  (Number.isSafeInteger(lines.startLine) &&
    Number.isSafeInteger(lines.endLine) &&
    lines.startLine >= 1 &&
    lines.endLine >= lines.startLine)

export function parseChatLink(href: unknown): ChatLink {
  if (typeof href !== 'string' || !href.trim() || href.length > 2000) return refused(NOT_A_FILE)
  let rest = href.trim()
  // Control characters (newlines, NUL, …) never name a file a link should open.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  if (/[\u0000-\u001f\u007f]/.test(rest)) return refused(NOT_A_FILE)
  if (isWebLink(rest)) return { kind: 'web', url: rest }
  let fileUrl = false
  if (/^file:/i.test(rest)) {
    let url: URL
    try {
      url = new URL(rest)
    } catch {
      return refused(NOT_A_FILE)
    }
    const host = url.hostname.toLowerCase()
    if (host && host !== 'localhost')
      return refused('Links to files on another computer or network share are not opened.')
    // The URL parser already removed dot segments; `%2F` stays encoded until decoded below.
    rest = url.pathname + url.hash
    fileUrl = true
  } else if (rest.startsWith(CODE_LINK_SCHEME)) rest = rest.slice(CODE_LINK_SCHEME.length)
  else if (/^[a-z][\w+.-]*:/i.test(rest) && !/^[a-z][\w+.-]*:\d/i.test(rest))
    return refused('Only files on this Mac open from chat; links of this kind are not opened.')
  if (/^(?:\\\\|\/\/)/.test(rest))
    return refused('Links to files on another computer or network share are not opened.')
  let { rest: path, lines } = lineRange(rest)
  let file: string
  try {
    file = decodeURIComponent(path.replace(/[?#].*$/, ''))
  } catch {
    return refused(NOT_A_FILE)
  }
  // Decoding may reveal a second `//` host or a NUL; neither names a local file.
  if (!file || file.includes('\0')) return refused(NOT_A_FILE)
  if (/^(?:\\\\|\/\/)/.test(file))
    return refused('Links to files on another computer or network share are not opened.')
  const suffix = lines || fileUrl ? null : SUFFIX_LINES.exec(file)
  if (suffix) {
    file = file.slice(0, suffix.index)
    lines = { startLine: Number(suffix[1]), endLine: Number(suffix[2] ?? suffix[1]) }
  }
  if (!validLines(lines)) return refused('This link’s line range is not valid.')
  if (/^[a-z]:[\\/]/i.test(file))
    return refused('Only files on this Mac open from chat; links of this kind are not opened.')
  const ranged = <T extends object>(target: T) => (lines ? { ...target, lines } : target)
  if (file.startsWith('/') || file === '~' || file.startsWith('~/'))
    return ranged({ kind: 'local' as const, path: file })
  if (file.startsWith('~')) return refused(NOT_A_FILE)
  file = file.replace(/^\.\//, '')
  if (!file) return refused(NOT_A_FILE)
  return ranged({ kind: 'project' as const, file })
}

/** The project file and lines a chat link names, or why it cannot open in the editor. */
export function parseCodeLink(href: unknown): CodeLinkTarget | { error: string } {
  const link = parseChatLink(href)
  if (link.kind === 'refused') return { error: link.error }
  if (link.kind === 'web') return { error: 'Web links are not project files.' }
  if (link.kind === 'local')
    return { error: 'Only project-relative files open from chat, in Trezi’s editor.' }
  return link.lines ? { file: link.file, lines: link.lines } : { file: link.file }
}
