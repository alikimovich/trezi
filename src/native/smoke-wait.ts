/** Polling helpers for the native smoke. A timeout reports the last state it
 * inspected (not just the predicate's `false`), so a failure names the field
 * that never became ready. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Describe = () => unknown | Promise<unknown>

/** Scalars kept (long strings truncated); arrays reduced to their length;
 * nested objects one level deep. Attachment/choice payloads stay out of logs. */
export function summarizeState(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > 120 ? `${value.slice(0, 120)}… (${value.length} chars)` : value
  if (Array.isArray(value)) return `[${value.length} items]`
  if (value && typeof value === 'object') {
    if (depth > 0) return '{…}'
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, summarizeState(item, depth + 1)])
    )
  }
  return value
}

/** A wait that gave up: what it waited for, where, for how long, and the last value it saw.
 *  smoke-report turns it into the `SMOKE FAIL` line (LKM-176). */
export class SmokeTimeoutError extends Error {
  constructor(
    message: string,
    readonly label: string,
    readonly timeout: number,
    readonly last: unknown,
    /** `smoke-<module>.ts:<line>` of the call that waited, when the stack names one. */
    readonly step?: string
  ) {
    super(message)
    this.name = 'SmokeTimeoutError'
  }
}

/** The first smoke-module frame of a stack, skipping the runner and the wait helpers. */
export function smokeFrame(stack: string | undefined): string | undefined {
  const frame = (stack ?? '')
    .split('\n')
    .find((line) => /\bsmoke-(?!runner|wait|report)[\w-]+\.[tj]s:\d+/.test(line))
  return frame?.match(/(smoke-[\w-]+\.[tj]s:\d+(?::\d+)?)/)?.[1]
}

// Results are `any`, like the inline helpers these replace: callers read host state fields.
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
export async function waitFor(
  check: () => any,
  label: string,
  timeout = 10000,
  describe?: Describe,
  interval = 80
): Promise<any> {
  // Taken before the first await: async continuations lose the caller's frames.
  const step = smokeFrame(new Error().stack)
  const end = Date.now() + timeout
  let last: unknown
  while (Date.now() < end) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = error
    }
    await delay(interval)
  }
  let detail = ''
  if (describe) {
    try {
      detail = ` ${JSON.stringify(await describe())}`
    } catch (error) {
      detail = ` (diagnostics unavailable: ${String(error)})`
    }
  }
  throw new SmokeTimeoutError(
    `Native check timed out: ${label}; ${String(last)}${detail}`,
    label,
    timeout,
    detail ? detail.trim() : last,
    step
  )
}

/** Polls a host inspection until `check` passes; on timeout reports the last
 * inspected state and any `extra` context (e.g. the Bun-side chat). */
export function inspectUntil(
  request: (method: string) => Promise<any>,
  method: string,
  check: (state: any) => boolean,
  extra?: Describe,
  timeout = 10000,
  interval = 80
): Promise<any> {
  let state: unknown
  return waitFor(
    async () => {
      state = await request(method)
      return check(state) && state
    },
    method,
    timeout,
    async () => ({
      lastState: summarizeState(state),
      ...(extra ? { context: await extra() } : {})
    }),
    interval
  )
}
