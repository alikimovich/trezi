import { landStoppedTurn, markStoppedReverted, stoppedHold } from './parked-chat'

/**
 * LKM-151: what the user can do with a stopped (or failed) turn. Such a turn never
 * lands: its work is held on the chat's branch and the live checkout keeps exactly the
 * bytes it had before the turn. From the post-Stop card the user can
 *  - revert it: the hold is marked reverted (the live tree already matches) and the
 *    work is discarded at the next turn start or chat release; until then Undo puts
 *    the hold back;
 *  - keep it: land the partial work now like a finished turn, with its undo group, so
 *    the message's Revert still works; live drift parks it as an ordinary conflict;
 *  - ask the agent to finish: a normal follow-up turn on top of the held work, whose
 *    successful landing carries the whole batch.
 */

export interface StoppedTurnResult {
  ok: boolean
  files: string[]
  /** Keep: the undo group of the landed turn. */
  group?: string
  /** Keep: live drift parked the work as a conflict instead. */
  conflict?: boolean
  error?: string
}

const nothingHeld: StoppedTurnResult = {
  ok: false,
  files: [],
  error: 'Nothing from a stopped turn is on hold.'
}

/** Revert the stopped turn. The live checkout is untouched; nothing is written now. */
export function revertStoppedTurn(sessionKey: string): StoppedTurnResult {
  const hold = stoppedHold(sessionKey)
  if (!hold || hold.reverted) return { ...nothingHeld }
  markStoppedReverted(sessionKey, true)
  return { ok: true, files: hold.files }
}

/** Undo a revert that has not been settled by a new turn yet. */
export function undoStoppedRevert(sessionKey: string): StoppedTurnResult {
  const hold = stoppedHold(sessionKey)
  if (!hold?.reverted)
    return { ok: false, files: [], error: 'The stopped turn can no longer be restored.' }
  markStoppedReverted(sessionKey, false)
  return { ok: true, files: hold.files }
}

/** Land the stopped turn's partial work on the live checkout. */
export async function keepStoppedTurn(sessionKey: string): Promise<StoppedTurnResult> {
  const hold = stoppedHold(sessionKey)
  if (!hold || hold.reverted) return { ...nothingHeld }
  try {
    const landed = await landStoppedTurn(sessionKey)
    return landed ? { ok: true, ...landed } : { ...nothingHeld }
  } catch (error) {
    return { ok: false, files: [], error: error instanceof Error ? error.message : String(error) }
  }
}
