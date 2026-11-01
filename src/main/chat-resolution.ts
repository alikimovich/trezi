import type { PeerGateNote, SessionTranscriptEntry } from '../shared/api'
import { finalReply } from './chat-commit'
import { chatGateScope } from './chat-landing'
import { upsertParkRecord } from './chat-park'
import { type ChatState, emitIsolation } from './chat-state'
import { completeTurn, conflictMarkerFiles, type ResolvePrep } from './chat-worktrees'
import { peerGateMatters } from './peer-freshness'
import { peerTurn } from './peer-work'
import { heldResolution, resolutionFor, restoreOwnFiles } from './resolution-context'
import type { TurnTerminalOutcome } from './turn-terminal'

/**
 * A chat's side of reconciliation with both goals (LKM-403): what staging leaves for its
 * agent, and the hold when both requests cannot be kept. The hold commits the work on
 * the chat's branch and lands nothing; the user's next message answers the question and
 * that turn ends with the same check, so a clarifying message that changes nothing holds
 * the work again. The question and resolution stay until the work lands, is discarded or
 * passes that check (Discard stays available). See `resolution-context.ts`.
 */

const lastAsk = (st: ChatState): string =>
  [...(st.record?.transcript ?? [])].reverse().find((entry) => entry.role === 'user')?.text ?? ''

/** Record what `prep` staged. Inside the chain and the lease, right after `stageResolve`. */
export async function noteResolution(
  sessionKey: string,
  st: ChatState,
  prep: ResolvePrep
): Promise<void> {
  st.resolution =
    prep.clean || !prep.stage
      ? undefined
      : await resolutionFor(prep.stage, prep.conflicted, {
          scope: chatGateScope(sessionKey, st),
          self: peerTurn(sessionKey),
          goal: lastAsk(st)
        })
}

/** The gate's note as `lastLanding` keeps it: only when there was something to see. */
export function landingPeers(
  gate: PeerGateNote,
  rechecked: boolean,
  tree: string | null
): { peers?: PeerGateNote } {
  const peers = { ...gate, combinedRechecked: rechecked, tree: rechecked ? tree : null }
  return peerGateMatters(peers) ? { peers } : {}
}

/**
 * Keep a finished reconciliation unlanded when it dropped a side or left the choice
 * open, and ask the user. Answers whether it did. `turn` is empty for a landing without
 * a finished reply (`land_now`, Retry): only a silent choice of a side can be seen then.
 */
export async function holdForDecision(
  sessionKey: string,
  st: ChatState,
  turn: SessionTranscriptEntry[],
  message: string,
  terminal: TurnTerminalOutcome,
  gate: PeerGateNote
): Promise<boolean> {
  const pending = st.resolution
  if (!pending || (terminal !== 'success' && !st.decision)) return false
  // A stopped or failed answer turn was not checked, so the question stays asked.
  const held =
    terminal === 'success'
      ? await heldResolution(st.wt, pending, turn.length ? finalReply(turn) : null, st.decision)
      : { question: st.decision ?? '', files: st.parkedFiles, restore: [] }
  if (!held) return false
  await restoreOwnFiles(st.wt, pending, held.restore)
  const { files } = await completeTurn(st.liveRoot, st.wt, message, {
    land: false,
    keepHistory: st.gitAccess === 'full'
  })
  const kept = files.length ? files : held.files
  const markers = await conflictMarkerFiles(st.wt, kept)
  const error = `Decision needed: ${held.question}`
  st.parked = true
  st.interrupted = false
  st.parkedFiles = kept
  st.resolvingFiles = markers.length ? markers : null
  st.decision = held.question
  st.landingError = error
  st.landingHold = undefined
  st.lastLanding = {
    outcome: 'parked',
    files: kept,
    at: Date.now(),
    error,
    decision: held.question,
    ...landingPeers(gate, false, null)
  }
  upsertParkRecord(st, kept, turn)
  emitIsolation(sessionKey, 'parked', st.wt.branch, kept, undefined, undefined, 'failed', error)
  return true
}
