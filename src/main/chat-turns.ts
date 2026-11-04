import type { AgentEvent } from '../shared/api'

/** Forward only the conversation owner's accepted terminal, never the provider observation. */
export async function acceptOwnerTerminal<
  T extends { claimed: true; outcome: 'success' | 'failed' } | { claimed: false }
>(
  claim: Promise<T>,
  owner: Extract<AgentEvent, { type: 'owner-terminal' }>['owner'],
  emit: (event: AgentEvent) => void
): Promise<T> {
  const result = await claim
  if (result.claimed) emit({ type: 'owner-terminal', outcome: result.outcome, owner })
  return result
}

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
  heldOperationId?: string
  attemptId?: string
  /** The first terminal (`error` or `done`) of this run. */
  first: boolean
}

export class TurnTracker {
  private runs: Array<{
    turn: string
    run: number
    ended: boolean
    heldOperationId?: string
    attemptId?: string
  }> = []
  private owners = new Map<string, { heldOperationId?: string; attemptId?: string }>()

  /** A send reached the provider. */
  push(turn: string, run: number, heldOperationId?: string, attemptId?: string): void {
    if (heldOperationId || attemptId) this.owners.set(turn, { heldOperationId, attemptId })
    this.runs.push({ turn, run, ended: false, ...(this.owners.get(turn) ?? {}) })
  }

  /** The run the provider is working on now, if any. */
  get current(): { turn: string; run: number } | null {
    const head = this.runs[0]
    return head ? { turn: head.turn, run: head.run } : null
  }

  /**
   * A turn settled without its provider terminal (a Stop the provider never answered):
   * forget its sends, so the next turn's events are not credited to it.
   */
  drop(turn: string): void {
    this.runs = this.runs.filter((run) => run.turn !== turn)
    this.owners.delete(turn)
  }

  attribute(event: AgentEvent): Attribution | null {
    const head = this.runs[0]
    if (!head) return null
    if (event.type !== 'done' && event.type !== 'error') return { ...head, first: false }
    const first = !head.ended
    head.ended = true
    // `done` ends the send; an `error` is followed by its `done` (or by nothing).
    if (event.type === 'done') this.runs.shift()
    return { ...head, first }
  }
}
