/** Collect-all runner for the native smoke: every check runs unless a check it
 *  depends on did not pass, so one failure reports alongside every later result.
 *  Pure — the native host is reached only through the injected hooks. */

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
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  const frame = stack.split('\n').find((line) => /\bsmoke-(?!runner)[\w-]+\.[tj]s:\d+/.test(line))
  return frame?.match(/(smoke-[\w-]+\.[tj]s:\d+(?::\d+)?)/)?.[1]
}

export function validateSmokeChecks(checks: SmokeCheck[], inject: ReadonlySet<string> = new Set()) {
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
}

export async function runSmokeChecks(
  checks: SmokeCheck[],
  hooks: SmokeHooks
): Promise<SmokeResult[]> {
  const log = hooks.log ?? console.log
  const inject = hooks.inject ?? new Set<string>()
  validateSmokeChecks(checks, inject)
  const results: SmokeResult[] = []
  const outcome = new Map<string, SmokeResult['outcome']>()
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
    try {
      if (inject.has(check.name))
        throw new Error(`Deliberate failure injected by TREZI_NATIVE_SMOKE_FAIL: ${check.name}`)
      await check.run()
      const duration = Date.now() - start
      results.push({ name: check.name, outcome: 'pass', duration })
      outcome.set(check.name, 'pass')
      log(`PASS [smoke] ${check.name} ${(duration / 1000).toFixed(1)}s`)
    } catch (error) {
      const duration = Date.now() - start
      const assertion = firstAssertionLine(error)
      log(`FAIL [smoke] ${check.name} ${(duration / 1000).toFixed(1)}s — ${assertion}`)
      console.error(error)
      let capture: string
      try {
        capture = await hooks.capture(check.name, error)
      } catch (e) {
        capture = `unavailable (${firstAssertionLine(e)})`
      }
      // The check's own cleanup first (it knows what it left open), then the shared
      // foreground restore; neither may hide the original failure or stop the run.
      for (const [stage, step] of [
        ['cleanup', check.cleanup],
        ['restore', () => hooks.restore(check.name)]
      ] as const) {
        if (!step) continue
        try {
          await step()
        } catch (e) {
          log(`WARN [smoke] ${check.name} ${stage} after failure: ${firstAssertionLine(e)}`)
        }
      }
      results.push({
        name: check.name,
        outcome: 'fail',
        duration,
        assertion,
        location: assertionLocation(error),
        capture,
        error
      })
      outcome.set(check.name, 'fail')
    }
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
