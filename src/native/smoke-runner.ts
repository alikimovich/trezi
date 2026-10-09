/** Collect-all runner for the native smoke: every check runs unless a check it
 *  depends on did not pass, so one failure reports alongside every later result.
 *  Pure — the native host is reached only through the injected hooks. */
import { smokeFrame } from './smoke-wait'

/** The host's focus state after it tried to make Trezi the active app with a key window. */
export interface FocusReport {
  focused: boolean
  /** Focus was missing at the call and had to be restored. */
  restored: boolean
  /** Focus was taken away (another app, a system dialog, the simulation) since the last call. */
  lost: boolean
  /** Why focus cannot be had, e.g. `display asleep`; set when `focused` is false. */
  reason?: string
}

export interface SmokeCheck {
  name: string
  /** Checks whose app/window state this one builds on; if any did not pass, it is skipped. */
  dependsOn?: string[]
  run: () => Promise<void>
  /** Undo this check's own leftovers after it fails (e.g. close its sheet). Never runs after a pass. */
  cleanup?: () => Promise<void>
}

export type SmokeResult =
  | { name: string; outcome: 'pass'; duration: number }
  | {
      name: string
      outcome: 'fail'
      duration: number
      assertion: string
      location?: string
      capture: string
      error: unknown
      /** Set when the environment failed the check (focus not obtainable, display asleep). */
      environment?: string
    }
  | { name: string; outcome: 'skip'; dependsOn: string }

export interface SmokeHooks {
  /** Save the failure's window capture; returns its path. A throw is reported, never fatal. */
  capture(name: string, error: unknown): Promise<string>
  /** Return the app to a clean foreground (menus, sheets, key window) after a failure. */
  restore(name: string): Promise<void>
  log?(line: string): void
  /** Check names that fail deliberately without running (TREZI_NATIVE_SMOKE_FAIL). */
  inject?: ReadonlySet<string>
  /** Names shared state every remaining check needs once it is gone (e.g. the host exited). */
  halted?(): string | undefined
  /** LKM-176: restore focus (bounded) before and after every check; a check that fails
   *  after focus was lost during it is retried once. Absent in background runs. */
  focus?(): Promise<FocusReport>
  /** Take focus away through the host test command, before the named checks' first
   *  attempt (TREZI_NATIVE_SMOKE_STEAL_FOCUS). */
  loseFocus?(): Promise<void>
  stealFocus?: ReadonlySet<string>
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** First non-empty line of the failure's message: AssertionError diffs span many lines. */
export function firstAssertionLine(error: unknown): string {
  return (
    message(error)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '(no message)'
  )
}

/** The first stack frame inside a smoke module, i.e. the assertion that fired. */
export function assertionLocation(error: unknown): string | undefined {
  return smokeFrame(error instanceof Error ? error.stack : undefined)
}

export function validateSmokeChecks(
  checks: SmokeCheck[],
  inject: ReadonlySet<string> = new Set(),
  steal: ReadonlySet<string> = new Set()
) {
  const seen = new Set<string>()
  for (const check of checks) {
    if (seen.has(check.name)) throw new Error(`Duplicate native smoke check: ${check.name}`)
    for (const dep of check.dependsOn ?? [])
      if (!seen.has(dep))
        throw new Error(
          `Native smoke check ${check.name} depends on ${dep}, which must run earlier`
        )
    seen.add(check.name)
  }
  for (const name of inject)
    if (!seen.has(name)) throw new Error(`TREZI_NATIVE_SMOKE_FAIL names an unknown check: ${name}`)
  for (const name of steal)
    if (!seen.has(name))
      throw new Error(`TREZI_NATIVE_SMOKE_STEAL_FOCUS names an unknown check: ${name}`)
}

/** Why a failed check is the environment's fault, or undefined for a product failure. */
function environmentCause(
  name: string,
  before: FocusReport | undefined,
  after: FocusReport | undefined
): string | undefined {
  if (before && !before.focused)
    return `focus not obtainable before ${name}: ${before.reason ?? 'unknown'}`
  if (after?.lost)
    return `focus lost during ${name}${after.focused ? '' : `: ${after.reason ?? 'not restored'}`}`
  if (after && !after.focused)
    return `focus not obtainable after ${name}: ${after.reason ?? 'unknown'}`
  return undefined
}

export async function runSmokeChecks(
  checks: SmokeCheck[],
  hooks: SmokeHooks
): Promise<SmokeResult[]> {
  const log = hooks.log ?? console.log
  const inject = hooks.inject ?? new Set<string>()
  const steal = hooks.stealFocus ?? new Set<string>()
  validateSmokeChecks(checks, inject, steal)
  const results: SmokeResult[] = []
  const outcome = new Map<string, SmokeResult['outcome']>()
  const focus = async (name: string, when: string): Promise<FocusReport | undefined> => {
    if (!hooks.focus) return undefined
    try {
      const report = await hooks.focus()
      if (report.restored) log(`FOCUS [smoke] ${name} — focus restored ${when}`)
      else if (report.lost) log(`FOCUS [smoke] ${name} — focus was lost ${when}; it returned`)
      if (!report.focused)
        log(`WARN [smoke] ${name} — focus not obtainable ${when}: ${report.reason ?? 'unknown'}`)
      return report
    } catch (e) {
      log(`WARN [smoke] ${name} focus check ${when}: ${firstAssertionLine(e)}`)
      return undefined
    }
  }
  // The check's own cleanup first (it knows what it left open), then the shared
  // foreground restore; neither may hide the original failure or stop the run.
  const recover = async (check: SmokeCheck, after: string) => {
    for (const [stage, step] of [
      ['cleanup', check.cleanup],
      ['restore', () => hooks.restore(check.name)]
    ] as const) {
      if (!step) continue
      try {
        await step()
      } catch (e) {
        log(`WARN [smoke] ${check.name} ${stage} after ${after}: ${firstAssertionLine(e)}`)
      }
    }
  }
  for (const check of checks) {
    const blocked =
      hooks.halted?.() ?? (check.dependsOn ?? []).find((dep) => outcome.get(dep) !== 'pass')
    if (blocked) {
      results.push({ name: check.name, outcome: 'skip', dependsOn: blocked })
      outcome.set(check.name, 'skip')
      log(`SKIP [smoke] ${check.name} — skipped: depends on ${blocked}`)
      continue
    }
    const start = Date.now()
    log(`START [smoke] ${check.name}`)
    let error: unknown
    let failed = false
    let environment: string | undefined
    for (let attempt = 1; ; attempt++) {
      failed = false
      const before = await focus(check.name, 'before the check')
      if (attempt === 1 && steal.has(check.name) && hooks.loseFocus) {
        await hooks.loseFocus()
        log(`FOCUS [smoke] ${check.name} — focus taken away (simulated by the host test command)`)
      }
      try {
        if (inject.has(check.name))
          throw new Error(`Deliberate failure injected by TREZI_NATIVE_SMOKE_FAIL: ${check.name}`)
        await check.run()
      } catch (e) {
        failed = true
        error = e
      }
      // Restores focus a check lost so the next one starts in the foreground.
      const after = await focus(check.name, 'during the check')
      if (failed && attempt === 1 && after?.lost && !hooks.halted?.()) {
        log(
          `RETRY [smoke] ${check.name} — focus was lost during the check; retrying once: ${firstAssertionLine(error)}`
        )
        await recover(check, 'focus loss')
        continue
      }
      if (failed) environment = environmentCause(check.name, before, after)
      break
    }
    const duration = Date.now() - start
    if (!failed) {
      results.push({ name: check.name, outcome: 'pass', duration })
      outcome.set(check.name, 'pass')
      log(`PASS [smoke] ${check.name} ${(duration / 1000).toFixed(1)}s`)
      continue
    }
    const assertion = firstAssertionLine(error)
    log(
      `FAIL [smoke] ${check.name} ${(duration / 1000).toFixed(1)}s — ${assertion}${environment ? ` [environment: ${environment}]` : ''}`
    )
    console.error(error)
    let capture: string
    try {
      capture = await hooks.capture(check.name, error)
    } catch (e) {
      capture = `unavailable (${firstAssertionLine(e)})`
    }
    await recover(check, 'failure')
    results.push({
      name: check.name,
      outcome: 'fail',
      duration,
      assertion,
      location: assertionLocation(error),
      capture,
      error,
      ...(environment ? { environment } : {})
    })
    outcome.set(check.name, 'fail')
  }
  return results
}

/** The end-of-run report; format documented in docs/TESTING.md ("Native smoke summary"). */
export function formatSmokeSummary(results: SmokeResult[]): string {
  const count = (kind: SmokeResult['outcome']) => results.filter((r) => r.outcome === kind).length
  const lines = [
    `NATIVE SMOKE SUMMARY: ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped (${results.length} checks)`
  ]
  for (const r of results) {
    if (r.outcome === 'fail') {
      lines.push(`FAILED ${r.name}`, `  assertion: ${r.assertion}`)
      if (r.location) lines.push(`  at: ${r.location}`)
      lines.push(`  capture: ${r.capture}`)
      if (r.environment) lines.push(`  environment: ${r.environment}`)
    } else if (r.outcome === 'skip')
      lines.push(`SKIPPED ${r.name}`, `  skipped: depends on ${r.dependsOn}`)
  }
  return lines.join('\n')
}

export function parseInjectedFailures(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  )
}
