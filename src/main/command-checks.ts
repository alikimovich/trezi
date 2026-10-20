import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectKey } from '../shared/projectKey'
import { sourceSnapshot } from './source-snapshot'
import {
  type CommandReceipt,
  newReceiptId,
  receiptSession,
  recordCommandReceipt
} from './verification-receipts'

/**
 * LOCAL-WEBKIT-3: `run_checks`, the host-run checks a landing can rest on when a browser
 * check does not fit (a project without a web preview, a build, a test suite). Trezi
 * runs them itself and writes the receipt from what it saw; an agent only names them:
 *  - a `package.json` script, as the LIVE checkout defines it (`bun run <name>` in the
 *    worktree). A chat that changed the script, or its pre/post hook, cannot run it:
 *    a check the chat wrote itself would prove nothing;
 *  - `swift-build` / `swift-test` for a Swift package (`Package.swift` in both checkouts).
 * Each runs in its own process group with a deadline and a minimal environment (no
 * provider keys or Trezi variables), keeps only an output tail, and passes only with
 * exit 0 and the same exact source before and after the run. A check that edits
 * tracked or unignored files therefore never passes. Checks run against whatever the
 * project's scripts talk to: a script that needs a database or remote service uses the
 * project's own fixtures, never anything Trezi provides.
 */

export interface CheckScope {
  emitKey: string
  /** The session's checkout (its worktree). */
  root: string
  liveRoot: string
}

export const CHECK_LIMITS = { perCall: 4, defaultMs: 5 * 60_000, maxMs: 15 * 60_000 } as const
const OUTPUT_TAIL = 4000
const KILL_AFTER_MS = 3000
const SWIFT = { 'swift-build': 'build', 'swift-test': 'test' } as const

/** Checks still running, per receipt session, so a landing never passes over one. */
const running = new Map<string, Set<() => void>>()

export const checksRunning = (session: string): boolean => (running.get(session)?.size ?? 0) > 0

/** Ends the session's running checks; their receipts say `cancelled`. */
export function cancelChecks(session: string): void {
  for (const cancel of running.get(session) ?? []) cancel()
}

const scripts = (root: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    return parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {}
  } catch {
    return null
  }
}

/** The checks this project defines, as the live checkout has them. */
export function availableChecks(liveRoot: string): string[] {
  const names = Object.entries(scripts(liveRoot) ?? {})
    .filter(([name, value]) => typeof value === 'string' && !/^(pre|post)/.test(name))
    .map(([name]) => name)
  if (existsSync(join(liveRoot, 'Package.swift'))) names.push(...Object.keys(SWIFT))
  return names
}

/** What `name` runs, or why it cannot. */
export function resolveCheck(name: string, scope: CheckScope): string[] | { error: string } {
  if (name in SWIFT) {
    if (
      !existsSync(join(scope.liveRoot, 'Package.swift')) ||
      !existsSync(join(scope.root, 'Package.swift'))
    )
      return { error: `${name}: this project is not a Swift package.` }
    return ['/usr/bin/swift', SWIFT[name as keyof typeof SWIFT]]
  }
  const live = scripts(scope.liveRoot)
  if (!live || typeof live[name] !== 'string')
    return {
      error: `${name}: the project's package.json defines no such script. Checks: ${availableChecks(scope.liveRoot).join(', ') || 'none'}.`
    }
  const own = scripts(scope.root) ?? {}
  for (const key of [name, `pre${name}`, `post${name}`])
    if (live[key] !== own[key])
      return {
        error: `${name}: this chat changed the "${key}" script, so Trezi will not run it as a check. Checks run as the project defines them.`
      }
  return [process.execPath, 'run', name]
}

const minimalEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL'])
    if (process.env[key] !== undefined) env[key] = process.env[key]
  return env
}

/** Runs one check in `scope.root` and records its receipt. */
export async function runCommandCheck(
  name: string,
  scope: CheckScope,
  timeoutMs: number = CHECK_LIMITS.defaultMs
): Promise<CommandReceipt | { error: string }> {
  const command = resolveCheck(name, scope)
  if ('error' in command) return command
  const session = receiptSession(scope.emitKey, projectKey(scope.root))
  const started = Date.now()
  const before = await sourceSnapshot(scope.root).catch(() => null)
  if (!before?.id)
    return { error: `${name}: Trezi could not read this checkout's exact source, so nothing ran.` }
  const outcome = await run(command, scope.root, Math.min(timeoutMs, CHECK_LIMITS.maxMs), session)
  const after = await sourceSnapshot(scope.root).catch(() => null)
  let reason: string | null = null
  if (outcome.cancelled) reason = 'cancelled'
  else if (outcome.timedOut) reason = 'timed-out'
  else if (outcome.code !== 0) reason = outcome.error ?? 'check-failed'
  else if (!after?.id) reason = 'snapshot-unavailable'
  else if (after.id !== before.id) reason = 'source-changed'
  const receipt: CommandReceipt = {
    id: newReceiptId(),
    createdAt: new Date(started).toISOString(),
    kind: 'command',
    check: name,
    command: command[0] === process.execPath ? ['bun', ...command.slice(1)] : command,
    root: scope.root,
    source: {
      snapshot: before.id === after?.id ? before.id : null,
      tree: before.id === after?.id ? before.tree : null,
      head: after?.head ?? before.head,
      dirty: after?.dirty ?? before.dirty
    },
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    output: outcome.output,
    verified: reason === null,
    reason,
    ms: Date.now() - started
  }
  recordCommandReceipt(session, receipt)
  return receipt
}

interface RunOutcome {
  code: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  output: string
  error?: string
}

function run(argv: string[], cwd: string, timeoutMs: number, session: string): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let cancelled = false
    let settled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const proc = spawn(argv[0], argv.slice(1), {
      cwd,
      env: minimalEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    const group = (signal: NodeJS.Signals) => {
      try {
        if (proc.pid) process.kill(-proc.pid, signal)
      } catch {
        // already gone
      }
    }
    const stop = () => {
      group('SIGTERM')
      timers.push(setTimeout(() => group('SIGKILL'), KILL_AFTER_MS))
    }
    const cancel = () => {
      cancelled = true
      stop()
    }
    const set = running.get(session) ?? new Set()
    set.add(cancel)
    running.set(session, set)
    const finish = (code: number | null, signal: string | null, error?: string) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      set.delete(cancel)
      if (!set.size) running.delete(session)
      // Whatever the check left running in its group goes with it.
      group('SIGKILL')
      resolve({ code, signal, timedOut, cancelled, output: output.slice(-OUTPUT_TAIL), error })
    }
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL * 2)
    }
    proc.stdout.on('data', take)
    proc.stderr.on('data', take)
    timers.push(
      setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
    )
    proc.once('error', (error) => finish(null, null, error.message))
    proc.once('close', (code, signal) => finish(code, signal))
  })
}

/** `run_checks`: `{ checks: string[], timeoutSeconds? }`, or `{ list: true }`. */
export async function runChecksTool(raw: unknown, scope: CheckScope): Promise<unknown> {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const available = availableChecks(scope.liveRoot)
  if (a.list === true) return { checks: available }
  const names = typeof a.checks === 'string' ? [a.checks] : a.checks
  if (!Array.isArray(names) || !names.length || names.some((n) => typeof n !== 'string'))
    return {
      error: `checks must name one to ${CHECK_LIMITS.perCall} of: ${available.join(', ') || 'none'}.`
    }
  if (names.length > CHECK_LIMITS.perCall)
    return { error: `At most ${CHECK_LIMITS.perCall} checks per call.` }
  const seconds =
    typeof a.timeoutSeconds === 'number' && a.timeoutSeconds > 0 ? a.timeoutSeconds : 0
  const results = []
  for (const name of names as string[]) {
    const receipt = await runCommandCheck(name, scope, seconds ? seconds * 1000 : undefined)
    results.push('error' in receipt ? receipt : { summary: commandSummary(receipt), receipt })
  }
  return { results }
}

/** One line for the agent's answer. */
export function commandSummary(receipt: CommandReceipt): string {
  const verdict = receipt.verified
    ? `PASSED on source snapshot ${receipt.source.snapshot?.slice(0, 12)}`
    : `NOT verified (${receipt.reason}${receipt.exitCode !== null ? `, exit ${receipt.exitCode}` : ''})`
  return `Receipt ${receipt.id}: check "${receipt.check}" (${receipt.command.join(' ')}) ${verdict} in ${Math.round(receipt.ms / 100) / 10}s.`
}
