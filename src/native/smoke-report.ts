/** One fixed line per native smoke failure (LKM-176), printed after the summary and
 *  again by the launcher as the last lines of the run, so a log tail always names
 *  what failed. Format and exit codes: docs/TESTING.md ("Failure lines and exit codes").
 *  Pure. */
import { SMOKE_CHECK_GROUPS } from './smoke-groups'
import { SmokeTimeoutError, summarizeState } from './smoke-wait'

/** A product failure (or a harness error that is not the environment's fault). */
export const SMOKE_EXIT_PRODUCT = 1
/** Only environment failures: focus not obtainable, display asleep. */
export const SMOKE_EXIT_ENV = 3

export interface SmokeFailureLine {
  group: string
  check: string
  message: string
  expected?: string
  actual?: string
  artifact?: string
}

const MAX_VALUE = 160

/** One line, bounded: collapses whitespace and truncates with the original length. */
export function oneLine(value: string, max = MAX_VALUE): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}… (${flat.length} chars)` : flat
}

/** Compact rendering of an assertion's expected/actual value. */
export function renderValue(value: unknown): string {
  if (typeof value === 'string') return oneLine(JSON.stringify(value))
  if (value instanceof Error) return oneLine(`${value.name}: ${value.message}`)
  if (value === undefined) return 'undefined'
  try {
    return oneLine(JSON.stringify(summarizeState(value)) ?? String(value))
  } catch {
    return oneLine(String(value))
  }
}

/** The group a check belongs to (`core`, `islands+shadow-light`); prelude checks report `prelude`. */
export function smokeGroupOf(check: string): string {
  return SMOKE_CHECK_GROUPS[check]?.join('+') ?? 'prelude'
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '(no message)'

/** Message plus expected/actual for an assertion, a timed-out wait or any other error. */
export function describeFailure(
  error: unknown
): Pick<SmokeFailureLine, 'message' | 'expected' | 'actual'> {
  if (error instanceof SmokeTimeoutError)
    return {
      message: `timed out after ${(error.timeout / 1000).toFixed(1)} s${error.step ? ` at ${error.step}` : ''} waiting for ${error.label}`,
      expected: `${error.label} ready`,
      actual: typeof error.last === 'string' ? oneLine(error.last) : renderValue(error.last)
    }
  if (error instanceof Error && error.name === 'AssertionError' && 'expected' in error) {
    const assertion = error as Error & { expected: unknown; actual: unknown; operator?: string }
    const negated = assertion.operator?.startsWith('not')
    return {
      message: oneLine(firstLine(assertion.message), 240),
      expected: `${negated ? 'not ' : ''}${renderValue(assertion.expected)}`,
      actual: renderValue(assertion.actual)
    }
  }
  return {
    message: oneLine(firstLine(error instanceof Error ? error.message : String(error)), 240)
  }
}

/** `SMOKE FAIL <group>/<check>: <message> (expected …, actual …) [artifact: <path>]`.
 *  The parenthesis is omitted when the failure carries no expected/actual value. */
export function formatFailureLine(line: SmokeFailureLine): string {
  const values =
    line.expected !== undefined || line.actual !== undefined
      ? ` (expected ${line.expected ?? 'n/a'}, actual ${line.actual ?? 'n/a'})`
      : ''
  return `SMOKE FAIL ${line.group}/${line.check}: ${oneLine(line.message, 240)}${values} [artifact: ${line.artifact || 'none'}]`
}

export function formatEnvLine(reason: string): string {
  return `SMOKE ENV ${oneLine(reason, 240)}`
}

/** 0 when everything passed; 1 when any failure is a product failure; 3 when every
 *  failure is an environment failure. A run that failed outside any check is 1. */
export function smokeExitCode(failures: readonly { environment?: string }[]): number {
  if (!failures.length) return 0
  return failures.every((failure) => failure.environment) ? SMOKE_EXIT_ENV : SMOKE_EXIT_PRODUCT
}

/** Thrown by the smoke with the lines it printed; index.ts hands both to the launcher. */
export class SmokeRunFailure extends Error {
  constructor(
    message: string,
    readonly lines: string[],
    readonly exitCode: number
  ) {
    super(message)
    this.name = 'SmokeRunFailure'
  }
}

/** What Bun leaves for the launcher in the test directory (`smoke-result.json`). */
export interface SmokeResultFile {
  exitCode: number
  lines: string[]
}

/** Product log lines written by the host (`<time> <level> app <area> …`), else the last lines. */
export function hostLogTail(log: string, count = 12): string[] {
  const lines = log.split('\n').filter(Boolean)
  const host = lines.filter((line) => /^\S+ \S+ app /.test(line))
  return (host.length ? host : lines).slice(-count)
}

/** The launcher's last word after the host exits: Bun's failure lines, plus a host-exit
 *  line and the host's last log lines when the host crashed or exited without a result.
 *  Returns the run's exit code (3 only when Bun classified every failure as environment). */
export function finishSmokeRun(
  host: { code: number | null; signal: string | null },
  result: SmokeResultFile | undefined,
  logTail: readonly string[],
  artifact?: string
): SmokeResultFile {
  const lines = [...(result?.lines ?? [])]
  const crashed = !!host.signal || (host.code !== 0 && !result?.exitCode)
  if (crashed) {
    const actual = host.signal ? `signal ${host.signal}` : `exit code ${host.code ?? 'unknown'}`
    lines.push(
      formatFailureLine({
        group: 'host',
        check: 'exit',
        message: `native host exited with ${actual} ${result ? 'after the smoke reported its result' : 'before the smoke reported a result'}`,
        expected: 'exit code 0',
        actual,
        artifact
      }),
      ...(logTail.length
        ? logTail.map((line) => `  host log: ${line}`)
        : ['  host log: (no lines)'])
    )
    return { exitCode: SMOKE_EXIT_PRODUCT, lines }
  }
  if (host.code === 0 && !result?.exitCode) return { exitCode: 0, lines }
  return {
    exitCode: result?.exitCode === SMOKE_EXIT_ENV ? SMOKE_EXIT_ENV : SMOKE_EXIT_PRODUCT,
    lines
  }
}

/** The lines the run ends with: one `SMOKE FAIL` per failure, then one `SMOKE ENV` per
 *  distinct environment reason. */
export function formatFailureReport(
  failures: readonly {
    name: string
    error: unknown
    capture?: string
    environment?: string
  }[]
): string[] {
  const lines = failures.map((failure) =>
    formatFailureLine({
      group: smokeGroupOf(failure.name),
      check: failure.name,
      ...describeFailure(failure.error),
      artifact: failure.capture
    })
  )
  for (const reason of new Set(failures.flatMap((f) => (f.environment ? [f.environment] : []))))
    lines.push(formatEnvLine(reason))
  return lines
}
