import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CodeRevealRequest } from '../shared/api'

export async function openAgentCode(
  root: string,
  liveRoot: string,
  key: string,
  raw: unknown,
  notify: (channel: string, payload: unknown) => void
): Promise<unknown> {
  const args = raw as { file?: unknown; startLine?: unknown; endLine?: unknown }
  if (typeof args?.file !== 'string' || !args.file || isAbsolute(args.file))
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
  try {
    const base = await realpath(root)
    const path = await realpath(resolve(base, args.file))
    const file = relative(base, path)
    if (!file || file === '..' || file.startsWith(`..${sep}`) || isAbsolute(file))
      return { error: 'The file must be inside the project.' }
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
        'Requested the mini code editor with this exact code highlighted. Opens in the active chat after the code is available in the live project; unsaved editor changes are preserved.'
    }
  } catch {
    return { error: 'Could not read that project file.' }
  }
}
