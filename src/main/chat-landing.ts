import type { TurnMessage } from './chat-commit'
import { clearPark } from './chat-park'
import { type ChatState, emitIsolation } from './chat-state'
import type { TurnOutcome } from './chat-worktrees'
import { recordEdit } from './edit-history'
import { commitLiveTurn } from './live-commit'
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
