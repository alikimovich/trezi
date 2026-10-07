import { AsyncLocalStorage } from 'node:async_hooks'
import { productLog } from './product-log'
import { turnTimings } from './turn-timing'

/**
 * LKM-200: every Trezi tool call in the product log with its duration and phases
 * ("Tool call tool=preview_screenshot ms=212 phases=page:9,capture:180,encode:4"),
 * and in its chat's turn timing. Code under a call marks its phases with `phase` (or
 * `notePhase` for time measured elsewhere, such as the host's snapshot); outside a
 * call both are no-ops, so the tools run the same in tests and scripts.
 */

interface Call {
  phases: Map<string, number>
}

const calls = new AsyncLocalStorage<Call>()

const add = (call: Call, name: string, ms: number) =>
  call.phases.set(name, (call.phases.get(name) ?? 0) + Math.max(0, ms))

/** Runs `run` as the phase `name` of the tool call in progress (repeated names add up). */
export async function phase<T>(name: string, run: () => Promise<T> | T): Promise<T> {
  const call = calls.getStore()
  if (!call) return run()
  const at = performance.now()
  try {
    return await run()
  } finally {
    add(call, name, performance.now() - at)
  }
}

/** A phase measured elsewhere (the host reports its own snapshot and encode times). */
export function notePhase(name: string, ms: unknown): void {
  const call = calls.getStore()
  if (call && typeof ms === 'number' && Number.isFinite(ms)) add(call, name, ms)
}

/** `page:9,capture:180` in call order, whole milliseconds. */
export const formatPhases = (phases: Map<string, number>) =>
  [...phases].map(([name, ms]) => `${name}:${Math.round(ms)}`).join(',')

const failed = (result: unknown) => {
  const value = result as { error?: unknown; isError?: unknown } | null
  return !!value && (value.isError === true || !!value.error)
}

/** Runs one Trezi tool call for `chat`, logs it and adds it to the chat's turn timing. */
export async function timedToolCall<T>(
  chat: string,
  tool: string,
  run: () => Promise<T>
): Promise<T> {
  const call: Call = { phases: new Map() }
  const turn = turnTimings.toolStarted(chat, tool)
  const at = performance.now()
  let ok = false
  try {
    const result = await calls.run(call, run)
    ok = !failed(result)
    return result
  } finally {
    const ms = Math.round(performance.now() - at)
    turn.end(ms, ok)
    productLog.info('tool', 'Tool call', {
      chat,
      turn: turn.turn,
      tool,
      ms,
      ok,
      phases: formatPhases(call.phases) || undefined
    })
  }
}
