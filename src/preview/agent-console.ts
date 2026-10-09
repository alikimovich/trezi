/**
 * Recent console messages and page errors for `preview_console` (LKM-138). A
 * page-world forwarder (`src/native/PreviewAgent.swift`) dispatches one string
 * `trezi:console` event per message; this isolated-world ring buffer keeps the
 * last 200. Everything here is page-supplied text: untrusted, already truncated.
 */

export const CONSOLE_EVENT = 'trezi:console'
export const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'pageerror'] as const
const MAX_ENTRIES = 200
const MAX_TEXT = 2000

export interface ConsoleEntry {
  seq: number
  level: (typeof CONSOLE_LEVELS)[number]
  text: string
  at: number
}

const entries: ConsoleEntry[] = []
let seq = 0

export function recordConsole(detail: unknown) {
  if (typeof detail !== 'string') return
  const split = detail.indexOf('\u0000')
  const level = detail.slice(0, split) as ConsoleEntry['level']
  if (split < 0 || !CONSOLE_LEVELS.includes(level)) return
  entries.push({
    seq: ++seq,
    level,
    text: detail.slice(split + 1, split + 1 + MAX_TEXT),
    at: Date.now()
  })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

export function readConsole(
  options: { since?: number; limit?: number; errorsOnly?: boolean } = {}
) {
  const since = Number(options.since) || 0
  const limit = Math.max(1, Math.min(MAX_ENTRIES, Math.floor(Number(options.limit) || 50)))
  const matching = entries.filter(
    (e) => e.seq > since && (!options.errorsOnly || e.level === 'error' || e.level === 'pageerror')
  )
  return {
    url: location.href,
    total: seq,
    dropped: Math.max(0, matching.length - limit),
    entries: matching.slice(-limit)
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __treziAgentConsole: { read: typeof readConsole } | undefined
}

document.addEventListener(CONSOLE_EVENT, (event) => recordConsole((event as CustomEvent).detail))
globalThis.__treziAgentConsole = { read: readConsole }
