import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { CodeRevealRequest } from '../shared/api'
import { codeLinkMarkdown, parseCodeLink } from '../shared/code-link'
import type { SourceRange } from '../shared/native-editor'
import { projectFile, resolveCodeSources } from './code-sources'

/**
 * `open_code`: opens Trezi's code editor at an exact range. Either a file and its
 * inclusive lines, or (LKM-363) the selected preview object's `source` stamp with
 * `target: 'element' | 'styles'`, mapped read-only by `code-sources.ts`. Several or
 * uncertain mappings are returned as candidates with provenance and open nothing;
 * each carries a clickable `link` (LKM-364) the chat opens in the same editor.
 * Never writes a file.
 */
export async function openAgentCode(
  root: string,
  liveRoot: string,
  key: string,
  raw: unknown,
  notify: (channel: string, payload: unknown) => void
): Promise<unknown> {
  const args = raw as {
    file?: unknown
    startLine?: unknown
    endLine?: unknown
    source?: unknown
    target?: unknown
    classes?: unknown
  }
  if (args?.source !== undefined) {
    const target = args.target ?? 'element'
    if (target !== 'element' && target !== 'styles')
      return { error: 'target must be "element" or "styles".' }
    const sources = await resolveCodeSources(root, args.source, target, args.classes)
    if ('error' in sources) return sources
    const { ambiguous, notes, element, file } = sources
    const candidates = sources.candidates.map((c) => ({ ...c, link: codeLinkMarkdown(c) }))
    const summary = { target, element: element ?? null, file, candidates, notes }
    if (candidates.length !== 1 || ambiguous)
      return {
        requested: false,
        ...summary,
        message: candidates.length
          ? 'Nothing was opened: the mapping is not one exact range. Show every candidate as its `link` (a clickable filename that opens Trezi’s editor at that range) followed by its provenance, and ask which one is meant (or say none is certain). Do not present any of them as the exact location.'
          : 'Nothing was opened: no source is mapped for this. Say so; do not guess a location.'
      }
    const [pick] = candidates
    const opened = await revealRange(root, liveRoot, key, pick, notify)
    return 'error' in opened ? opened : { ...opened, ...summary, provenance: pick.provenance }
  }
  return revealRange(root, liveRoot, key, args, notify)
}

/**
 * A project file's inclusive lines and the code they hold, read-only and realpath-checked
 * (`projectFile`: no `..`, absolute path or symlink leaves the project). `clamp` fits the
 * range into the file (LKM-364: chat links and the Diff panel) instead of refusing it.
 */
export async function projectLines(
  root: string,
  file: unknown,
  startLine: unknown,
  endLine: unknown,
  clamp = false
): Promise<{ file: string; startLine: number; endLine: number; code: string } | { error: string }> {
  if (typeof file !== 'string' || !file) return { error: 'Provide a repo-relative file.' }
  const end = endLine ?? startLine
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(end) ||
    Number(startLine) < 1 ||
    Number(end) < Number(startLine)
  )
    return { error: 'Provide a valid inclusive 1-based startLine/endLine range.' }
  const located = await projectFile(root, file)
  if (!located) return { error: 'The file must be inside the project.' }
  try {
    const { path } = located
    if ((await stat(path)).size > 2 * 1024 * 1024)
      return { error: 'File is too large for code reveal.' }
    const content = await readFile(path, 'utf8')
    if (content.includes('\0')) return { error: 'Choose a text source file.' }
    const lines = content.replace(/\r\n/g, '\n').split('\n')
    let [first, last] = [Number(startLine), Number(end)]
    if (clamp) {
      // A final newline ends the last line rather than starting an empty one.
      const count = lines.length > 1 && lines.at(-1) === '' ? lines.length - 1 : lines.length
      ;[first, last] = [Math.min(first, count), Math.min(last, count)]
    } else if (last > lines.length) return { error: `File has only ${lines.length} lines.` }
    const code = lines.slice(first - 1, last).join('\n')
    return { file: located.file, startLine: first, endLine: last, code }
  } catch {
    return { error: 'Could not read that project file.' }
  }
}

async function revealRange(
  root: string,
  liveRoot: string,
  key: string,
  args: { file?: unknown; startLine?: unknown; endLine?: unknown },
  notify: (channel: string, payload: unknown) => void
): Promise<Record<string, unknown>> {
  const lines = await projectLines(root, args?.file, args?.startLine, args?.endLine)
  if ('error' in lines) return lines
  const { file, startLine: start, endLine: end, code } = lines
  if (!code.trim() || code.length > 100000)
    return { error: 'Choose a smaller, nonempty code range.' }
  const request: CodeRevealRequest = {
    root: liveRoot,
    key,
    source: `${file}:${start}`,
    startLine: start,
    endLine: end,
    code,
    requestId: randomUUID()
  }
  notify('source:reveal', request)
  return {
    requested: true,
    file,
    startLine: start,
    endLine: end,
    message:
      'Requested Trezi’s code editor with this exact code selected and highlighted. It opens while this chat is the active chat of its project; when the live file does not contain this code yet, the editor shows the line without claiming the range. Unsaved editor changes are preserved and nothing is written.'
  }
}

/** Where the editor opens for a project file's lines (LKM-364): the same checks as
 *  `open_code`, so nothing outside the project, binary or oversized opens. Without
 *  lines the file opens at its top with nothing highlighted. */
export async function codeTarget(
  root: string,
  file: string,
  lines?: { startLine: number; endLine: number }
): Promise<{ root: string; source: string; range?: SourceRange } | { error: string }> {
  const read = await projectLines(root, file, lines?.startLine ?? 1, lines?.endLine, true)
  if ('error' in read) return read
  const source = `${read.file}:${read.startLine}`
  if (!lines) return { root, source }
  const { startLine, endLine, code } = read
  return { root, source, range: { startLine, endLine, code } }
}

/** A link clicked in chat (LKM-364): a project file of `root`, or why nothing opens. */
export async function codeLinkTarget(root: string, href: unknown) {
  if (!root) return { error: 'Open a project to show its code.' }
  const link = parseCodeLink(href)
  if ('error' in link) return link
  return codeTarget(root, link.file, link.lines)
}
