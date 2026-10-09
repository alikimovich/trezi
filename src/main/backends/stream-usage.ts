import {
  addUsage,
  emptyUsage,
  isEmptyUsage,
  readUsage,
  type TokenUsage,
  usageDelta
} from '../../shared/run-stats'

/**
 * Usage for one API request in flight, as `usage` deltas (LKM-147).
 *
 * Claude reports a request's usage cumulatively and repeatedly: `message_start`
 * (the input side), `message_delta` (the output total, only when the message
 * ends) and the complete `assistant` message. Only the running maximum's growth
 * is sent, so nothing is counted twice. Between those reports the output side
 * would stand still for a whole long answer, thinking block or tool input, so
 * the streamed characters (text, thinking, tool-input JSON) add an estimate of
 * one token per `CHARS_PER_TOKEN` characters, at most every `interval` ms. The
 * estimate is deliberately low (Claude averages fewer characters per token), so
 * the authoritative report that follows normally only adds the rest.
 */
export const CHARS_PER_TOKEN = 4

export function streamUsage(
  emit: (delta: TokenUsage) => void,
  interval = 250,
  now = () => Date.now()
) {
  let sent = emptyUsage()
  let chars = 0
  let estimatedAt = 0
  const send = (total: TokenUsage): void => {
    const delta = usageDelta(sent, total)
    if (isEmptyUsage(delta)) return
    sent = addUsage(sent, delta)
    emit(delta)
  }
  return {
    /** A new request (`message_start`): its counters start from zero again. */
    start(): void {
      sent = emptyUsage()
      chars = 0
      estimatedAt = 0
    },
    /** A provider usage payload for the request in flight. */
    report(raw: unknown): void {
      const total = readUsage(raw)
      if (total) send(total)
    },
    /** Streamed output characters; reports the estimate when it grew (throttled). */
    streamed(count: number): void {
      if (!(count > 0)) return
      chars += count
      if (now() - estimatedAt < interval) return
      estimatedAt = now()
      send({ ...sent, output: Math.max(sent.output, Math.floor(chars / CHARS_PER_TOKEN)) })
    }
  }
}

/** The streamed characters of a `content_block_delta`: text, thinking or tool input. */
export function streamedChars(
  event: { type?: string; delta?: Record<string, unknown> } | undefined
): number {
  if (event?.type !== 'content_block_delta' || !event.delta) return 0
  const { text, thinking, partial_json: json } = event.delta
  return [text, thinking, json].reduce<number>(
    (n, part) => n + (typeof part === 'string' ? part.length : 0),
    0
  )
}
