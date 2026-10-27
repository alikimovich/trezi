import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { CodeRevealRequest } from '../shared/api'
import { projectFile, resolveCodeSources } from './code-sources'

/**
 * `open_code`: opens Trezi's code editor at an exact range. Either a file and its
 * inclusive lines, or (LKM-363) the selected preview object's `source` stamp with
 * `target: 'element' | 'styles'`, mapped read-only by `code-sources.ts`. Several or
 * uncertain mappings are returned as candidates with provenance and open nothing.
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
    const { candidates, ambiguous, notes, element, file } = sources
    const summary = { target, element: element ?? null, file, candidates, notes }
    if (candidates.length !== 1 || ambiguous)
      return {
        requested: false,
        ...summary,
        message: candidates.length
          ? 'Nothing was opened: the mapping is not one exact range. Show these candidates with their provenance and ask which one is meant (or say none is certain); then call open_code with that candidate’s file, startLine and endLine. Do not present any of them as the exact location.'
          : 'Nothing was opened: no source is mapped for this. Say so; do not guess a location.'
      }
    const [pick] = candidates
    const opened = await revealRange(root, liveRoot, key, pick, notify)
    return 'error' in opened ? opened : { ...opened, ...summary, provenance: pick.provenance }
  }
  return revealRange(root, liveRoot, key, args, notify)
}

async function revealRange(
  root: string,
  liveRoot: string,
  key: string,
  args: { file?: unknown; startLine?: unknown; endLine?: unknown },
  notify: (channel: string, payload: unknown) => void
): Promise<Record<string, unknown>> {
  if (typeof args?.file !== 'string' || !args.file)
    return { error: 'Provide a repo-relative file.' }
  const start = args.startLine
  const end = args.endLine ?? start
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    Number(start) < 1 ||
    Number(end) < Number(start)
  )
    return { error: 'Provide a valid inclusive 1-based startLine/endLine range.' }
  const located = await projectFile(root, args.file)
  if (!located) return { error: 'The file must be inside the project.' }
  try {
    const { path, file } = located
    if ((await stat(path)).size > 2 * 1024 * 1024)
      return { error: 'File is too large for code reveal.' }
    const content = await readFile(path, 'utf8')
    if (content.includes('\0')) return { error: 'Choose a text source file.' }
    const lines = content.replace(/\r\n/g, '\n').split('\n')
    if (Number(end) > lines.length) return { error: `File has only ${lines.length} lines.` }
    const code = lines.slice(Number(start) - 1, Number(end)).join('\n')
    if (!code.trim() || code.length > 100000)
      return { error: 'Choose a smaller, nonempty code range.' }
    const request: CodeRevealRequest = {
      root: liveRoot,
      key,
      source: `${file}:${start}`,
      startLine: Number(start),
      endLine: Number(end),
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
  } catch {
    return { error: 'Could not read that project file.' }
  }
}
