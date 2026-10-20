import type { SessionTranscriptEntry } from '../shared/api'
import type { TurnMessage } from './chat-commit'
import { clearPark, upsertParkRecord } from './chat-park'
import { type ChatState, emitIsolation } from './chat-state'
import { completeTurn, type TurnOutcome } from './chat-worktrees'
import { recordEdit } from './edit-history'
import { type GateScope, type GateVerdict, holdMessage, integrationGate } from './integration-gate'
import { commitLiveTurn } from './live-commit'
import { productLog } from './product-log'
import { retireWorktreeBranch } from './worktrees'

/**
 * Land a `merged` turn outcome: record its edits as one undo group, advance the fork
 * point, commit the merged files on the live checkout (so the turn is one revertable
 * commit in the user's own history), leave any park and retire the branch. The one
 * landing step for a finished turn (`afterTurn`), a kept stopped turn (`keepStoppedTurn`)
 * and a clean "Resolve it". Call inside the chat's chain and the repository lease.
 * `message` describes the change (`turnMessage`, LKM-189), never the prompt.
 * Answers the undo group `chat:<id>:<turn>`.
 */
export async function landTurn(
  sessionKey: string,
  st: ChatState,
  outcome: TurnOutcome,
  turn: number | 'resolve',
  message: TurnMessage
): Promise<string> {
  const group = `chat:${st.wt.id}:${turn}`
  for (const e of outcome.edits) {
    recordEdit(st.liveRoot, e.file, e.before, e.after, undefined, group)
  }
  if (outcome.newBase) st.wt.baseSha = outcome.newBase
  await commitLiveTurn(
    st.liveRoot,
    outcome.files,
    { title: message.subject, body: message.body },
    outcome.newBase
  )
  clearPark(st)
  await retireWorktreeBranch(st.wt)
  // Not revertable once this chat's work has been pushed & merged via a PR.
  emitIsolation(sessionKey, 'merged', st.wt.branch, outcome.files, group, !st.record?.prUrl)
  return group
}

/** The session a chat's checks ran under (`integration-gate.ts`). */
export const chatGateScope = (sessionKey: string, st: ChatState): GateScope => ({
  emitKey: sessionKey,
  root: st.wt.path,
  liveRoot: st.liveRoot
})

/**
 * LOCAL-WEBKIT-3: every chat landing commits through here. With `land`, the gate names
 * the checked candidate tree and the owner lands only that, onto an unchanged live
 * checkout; without a passing check it answers `held` and writes nothing live. Call
 * inside the chat's chain and the repository lease, so nothing lands between the
 * gate's read and the owner's write except what the owner itself rechecks.
 */
export async function gatedTurn(
  sessionKey: string,
  st: ChatState,
  text: string,
  land: boolean
): Promise<{ outcome: TurnOutcome; verdict: GateVerdict | null }> {
  const verdict = land ? await integrationGate(chatGateScope(sessionKey, st)) : null
  const outcome = await completeTurn(st.liveRoot, st.wt, text, {
    land,
    keepHistory: st.gitAccess === 'full',
    candidate: verdict?.candidate ?? null
  })
  return { outcome, verdict }
}

/**
 * A `held` outcome: the work is committed on the chat's branch, nothing reached the
 * project, and the chat shows the failed-landing card with the gate's reason and Retry
 * (Resolve and Discard stay available). The agent's `workspace_state` says the same.
 */
export function holdTurn(
  sessionKey: string,
  st: ChatState,
  outcome: TurnOutcome,
  verdict: GateVerdict | null,
  turn: SessionTranscriptEntry[] = []
): string {
  const reason = holdMessage(outcome.hold, verdict)
  st.parked = true
  st.interrupted = false
  st.parkedFiles = outcome.files
  st.resolvingFiles = null
  st.landingError = reason
  st.landingHold = (verdict && !verdict.ok ? verdict.reason : outcome.hold?.reason) ?? 'unchecked'
  st.lastLanding = { outcome: 'failed', files: outcome.files, at: Date.now(), error: reason }
  upsertParkRecord(st, outcome.files, turn)
  productLog.info('landing', 'Landing held by the check gate', {
    chat: sessionKey,
    hold: st.landingHold,
    files: outcome.files.length,
    tree: verdict?.tree ?? null
  })
  emitIsolation(
    sessionKey,
    'parked',
    st.wt.branch,
    outcome.files,
    undefined,
    undefined,
    'failed',
    reason
  )
  return reason
}
