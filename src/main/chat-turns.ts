import type { AgentEvent } from '../shared/api'

/**
 * The provider adapter's half of turn identity (S11). Every provider honours "one
 * `done` per `send`" (an `error` may precede it, or end a dead session alone), and
 * runs sends in order, so a session's events belong to its oldest unfinished send.
 * `TurnTracker` keeps those sends in order and attributes each event to the turn and
 * run it belongs to; the conversation owner then decides whether a terminal completes
 * that turn. A `done` with no unfinished send left is a late event: it is attributed
 * to nothing and completes nothing.
 */
export interface Attribution {
  turn: string
  run: number
  /** The first terminal (`error` or `done`) of this run. */
  first: boolean
}

export class TurnTracker {
  private runs: Array<{ turn: string; run: number; ended: boolean }> = []

  /** A send reached the provider. */
  push(turn: string, run: number): void {
    this.runs.push({ turn, run, ended: false })
  }

  /** The run the provider is working on now, if any. */
  get current(): { turn: string; run: number } | null {
    const head = this.runs[0]
    return head ? { turn: head.turn, run: head.run } : null
  }

  attribute(event: AgentEvent): Attribution | null {
    const head = this.runs[0]
    if (!head) return null
    if (event.type !== 'done' && event.type !== 'error')
      return { turn: head.turn, run: head.run, first: false }
    const first = !head.ended
    head.ended = true
    // `done` ends the send; an `error` is followed by its `done` (or by nothing).
    if (event.type === 'done') this.runs.shift()
    return { turn: head.turn, run: head.run, first }
  }
}
