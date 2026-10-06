import { execFile } from 'node:child_process'
import { states } from './chat-state'
import { agentWorkspaceEvidence } from './chat-status'
import { productLogDirectory, readLogs, redact } from './product-log'

/**
 * LKM-165: the diagnostics the feedback sheet attaches only with the user's consent.
 * LKM-168: the main part is the last 30 minutes of Trezi's product log (every process,
 * `product-log.ts`). Bun's own console output from the last hour (a bounded ring
 * buffer; `open -a` discards stderr) and the unified log for the Trezi processes are
 * kept beside it. The chat part is its landing state as Bun sees it and `git status`
 * of its worktree; Bun never reads the service's private repository journal. When the
 * host's main thread is slow to answer a ping, a 3-second `sample` of it shows where
 * it was stuck.
 *
 * Everything passes through `redact`: known token shapes and `key=value` secrets are
 * removed and the home folder is shortened to `~`.
 */

/** How much of the product log the feedback attaches. */
export const FEEDBACK_LOG_WINDOW = 30 * 60_000
const HOUR = 60 * 60_000
const LOG_LINES = 4000
/** A ping slower than this means the host's main thread was busy. */
export const BUSY_MS = 250
/** The whole section stays well inside the issue body's budget (feedback-body.ts). */
export const DIAGNOSTICS_LIMIT = 24_000

const logs: { at: number; text: string }[] = []
let captured = false

/** Keeps a timestamped copy of Bun's console output; the console still prints. */
export function captureConsole(target: Console = console) {
  if (captured) return
  captured = true
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = target[level].bind(target)
    target[level] = (...args: unknown[]) => {
      try {
        const text = args
          .map((a) =>
            typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? String(a)) : safe(a)
          )
          .join(' ')
        logs.push({ at: Date.now(), text: `${level}: ${text}` })
        if (logs.length > LOG_LINES) logs.splice(0, logs.length - LOG_LINES)
      } catch {}
      original(...args)
    }
  }
}

function safe(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Bun's console lines from the last hour, oldest first. */
export function recentLogs(now = Date.now()) {
  return logs
    .filter((l) => now - l.at <= HOUR)
    .map((l) => `${new Date(l.at).toISOString()} ${l.text}`)
}

export { redact }

export interface DiagnosticsSources {
  /** The chat the sheet was opened over, when there is one. */
  chat?: { key: string; root?: string } | null
  /** Runs a read-only command and returns its output (injected in tests). */
  run?: (command: string, args: string[], timeoutMs: number) => Promise<string>
  /** Round trip to the host's main thread; rejects when it does not answer. */
  ping?: () => Promise<unknown>
  hostPid?: number | null
  now?: () => number
  home?: string
  /** The product log folder (tests); the process's own otherwise. */
  logDir?: string
}

const PRODUCT_LOG_CHARS = 9000

function execRun(command: string, args: string[], timeout: number) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      command,
      args,
      { timeout, maxBuffer: 16 << 20, encoding: 'utf8' },
      (error, stdout, stderr) => (error && !stdout ? reject(error) : resolve(stdout || stderr))
    )
  )
}

const head = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text
const tail = (text: string, max: number) =>
  text.length > max ? `… (${text.length - max} earlier characters)\n${text.slice(-max)}` : text
const failed = (error: unknown) =>
  `unavailable: ${error instanceof Error ? error.message : String(error)}`

/** The redacted plain-text diagnostics section, at most `DIAGNOSTICS_LIMIT` characters. */
export async function gatherDiagnostics(sources: DiagnosticsSources = {}) {
  const run = sources.run ?? execRun
  const now = sources.now ?? Date.now
  const sections: string[] = []

  let busy = false
  if (sources.ping) {
    const start = now()
    const reply = await sources.ping().then(
      () => `replied in ${Math.round(now() - start)} ms`,
      () => 'did not reply within 2 s'
    )
    busy = !reply.startsWith('replied') || now() - start >= BUSY_MS
    sections.push(`## App main thread\n${reply}${busy ? ' (busy)' : ''}`)
  }
  const sample =
    busy && sources.hostPid
      ? run('/usr/bin/sample', [String(sources.hostPid), '3'], 15_000).then(
          (out) => `## Main thread sample (3 s)\n${head(out.trim(), 6000)}`,
          (error) => `## Main thread sample (3 s)\n${failed(error)}`
        )
      : null

  const chat = sources.chat
  const st = chat ? states.get(chat.key) : undefined
  const checkout = st?.wt.path ?? chat?.root
  const landing = chat
    ? agentWorkspaceEvidence(chat.key, chat.root ?? st?.liveRoot ?? '').then(
        (evidence) =>
          `## Chat landing state\n${JSON.stringify(
            {
              ...evidence,
              ...(st && {
                parked: st.parked,
                interrupted: st.interrupted,
                reverted: st.reverted,
                parkedFiles: st.parkedFiles,
                resolvingFiles: st.resolvingFiles,
                turnNo: st.turnNo,
                landingError: st.landingError ?? null
              })
            },
            null,
            2
          )}`,
        (error) => `## Chat landing state\n${failed(error)}`
      )
    : null
  const status = checkout
    ? run(
        'git',
        ['--no-optional-locks', '-C', checkout, 'status', '--porcelain=v1', '--branch'],
        10_000
      ).then(
        (out) => `## Chat worktree git status\n${head(out.trim() || '(clean)', 3000)}`,
        (error) => `## Chat worktree git status\n${failed(error)}`
      )
    : null
  const system = run(
    '/usr/bin/log',
    ['show', '--last', '1h', '--style', 'compact', '--predicate', 'process BEGINSWITH "Trezi"'],
    20_000
  ).then(
    (out) => `## System log, Trezi processes (last hour)\n${tail(out.trim() || '(none)', 4000)}`,
    (error) => `## System log, Trezi processes (last hour)\n${failed(error)}`
  )
  for (const part of await Promise.all([sample, landing, status])) if (part) sections.push(part)
  const product = readLogs(sources.logDir ?? productLogDirectory(), FEEDBACK_LOG_WINDOW, now())
  sections.push(
    `## Trezi log (last 30 minutes)\n${tail(product.join('\n') || '(none)', PRODUCT_LOG_CHARS)}`
  )
  const own = recentLogs(now()).join('\n')
  sections.push(`## Backend console (last hour)\n${tail(own || '(none)', 4000)}`)
  sections.push(await system)
  return head(redact(sections.join('\n\n'), sources.home), DIAGNOSTICS_LIMIT)
}
