import { projectKey } from '../shared/projectKey'
import { turnMessage } from './chat-commit'
import { landTurn } from './chat-landing'
import { clearPark, dropParkRecord, upsertParkRecord } from './chat-park'
import { type ChatState, emitIsolation, onChain, states } from './chat-state'
import {
  applyParked,
  completeTurn,
  discardParked,
  type ResolvePrep,
  stageResolve
} from './chat-worktrees'
import { commitLiveTurn } from './live-commit'
import { retireWorktreeBranch } from './worktrees'

/**
 * What the user can do with a live PARKED chat's held work: the review modal's Apply
 * and Discard, the in-chat conflict card's "Resolve it", and the stopped-turn hold
 * (LKM-151) that `stopped-turn.ts` drives through `stoppedHold`, `markStoppedReverted`
 * and `landStoppedTurn`.
 */

/** Restore the fallback after an automatic attempt was cancelled or unavailable. */
export function showParkedChat(sessionKey: string): void {
  const st = states.get(sessionKey)
  if (st?.parked && !st.reverted)
    emitIsolation(
      sessionKey,
      'parked',
      st.wt.branch,
      st.parkedFiles,
      undefined,
      undefined,
      st.interrupted ? 'interrupted' : undefined
    )
}

/** The LIVE chat (if any) whose worktree is on `branch` in `root` — the seam that lets
 *  `agent:spawn-apply`/`agent:spawn-discard` route a parked LIVE chat's branch through
 *  the isolation path (advance base + unpark) instead of the stock spawn path, while a
 *  crash-recovered (dead) chat's branch falls through to that stock path unchanged. */
function findByBranch(root: string, branch: string): [string, ChatState] | undefined {
  const pk = projectKey(root)
  for (const [key, st] of states) {
    if (st.wt.branch === branch && projectKey(st.liveRoot) === pk) return [key, st]
  }
  return undefined
}

/**
 * `agent:spawn-apply` delegation: if `branch` belongs to a live parked chat, 3-way
 * apply its cumulative diff onto the live tree (serialized on the chat's chain); on a
 * clean apply advance the fork point, unpark, and drop the park record. Returns
 * `{ handled: false }` when no live chat owns the branch, so the caller falls through
 * to the stock spawn-branch apply.
 */
export async function applyParkedBranch(
  root: string,
  branch: string
): Promise<{ handled: boolean; ok?: boolean; conflict?: boolean; error?: string }> {
  const found = findByBranch(root, branch)
  if (!found) return { handled: false }
  const [key, st] = found
  try {
    // Described before the apply advances the fork point (LKM-189).
    const { res, described } = await onChain(st, async () => {
      const described = await turnMessage(key, st, 'apply')
      return { res: await applyParked(st.liveRoot, st.wt), described }
    })
    if (res.ok) {
      if (res.newBase) st.wt.baseSha = res.newBase
      // A 3-way apply onto a dirty tree can leave conflict markers, so unlike the
      // turn path this commits whatever landed — keeping the apply revertable in one
      // step, markers and all, instead of tangling it with the user's other WIP.
      await commitLiveTurn(st.liveRoot, res.files, {
        title: described.subject,
        body: described.body
      })
      clearPark(st)
      await retireWorktreeBranch(st.wt)
      emitIsolation(key, 'merged', st.wt.branch, res.files)
    }
    return { handled: true, ok: res.ok, conflict: res.conflict, error: res.error }
  } catch (e) {
    return {
      handled: true,
      ok: false,
      conflict: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/**
 * `agent:spawn-discard` delegation: if `branch` belongs to a live parked chat, reset
 * its worktree back to the fork point (KEEPING the branch — it's still checked out by
 * the live worktree, so a `git branch -D` would fail), unpark, and drop the record.
 * Returns `{ handled: false }` when no live chat owns the branch (falls through to the
 * stock `deleteBranch`).
 */
export async function discardParkedBranch(
  root: string,
  branch: string
): Promise<{ handled: boolean }> {
  const found = findByBranch(root, branch)
  if (!found) return { handled: false }
  const [key, st] = found
  await onChain(st, async () => {
    await discardParked(st.wt)
    await retireWorktreeBranch(st.wt)
  }).catch(() => {})
  // Unparks even when the reset failed: the user asked to drop the work.
  clearPark(st)
  emitIsolation(key, 'isolated', st.wt.branch)
  return { handled: true }
}

/**
 * "Resolve it" backend for a live PARKED chat (the in-chat conflict card). Stage the
 * worktree so it holds BOTH the user's live edits and the chat's own changes 3-way
 * merged (see `stageResolve`), then:
 *  - clean (no textual overlap) → commit + merge back onto the live tree right here and
 *    unpark; the caller runs NO agent turn. Returns `conflicted: []`.
 *  - overlapping → leave the marker-bearing worktree in place (still parked) and return
 *    the conflicted files; the caller fires ONE agent turn to reconcile them, whose
 *    normal `afterTurn` commits + merges + unparks.
 * Serialized on the chat's chain. `{ ok: false }` if the chat isn't parked.
 */
export async function resolveParkedChat(
  sessionKey: string
): Promise<{ ok: boolean; conflicted: string[]; error?: string }> {
  const st = states.get(sessionKey)
  if (!st) return { ok: false, conflicted: [], error: 'no-chat' }
  if (!st.parked) return { ok: false, conflicted: [], error: 'not-parked' }
  if (st.resolvingFiles) return { ok: true, conflicted: st.resolvingFiles }
  let prep: ResolvePrep
  try {
    prep = await onChain(st, () => stageResolve(st.liveRoot, st.wt))
  } catch (e) {
    return { ok: false, conflicted: [], error: e instanceof Error ? e.message : String(e) }
  }
  if (!prep.clean) {
    st.resolvingFiles = prep.conflicted
    return { ok: true, conflicted: prep.conflicted }
  }
  // No overlap — the sides merged automatically. Commit + merge onto live and unpark now.
  // completeTurn's autoApplyWorktree still refuses a binary file (even one stageResolve
  // just resolved by policy) — the applyParked fallback below is what actually lands it.
  try {
    await onChain(st, async () => {
      const described = await turnMessage(sessionKey, st, 'resolve')
      const outcome = await completeTurn(st.liveRoot, st.wt, described.text)
      if (outcome.outcome === 'merged') {
        await landTurn(sessionKey, st, outcome, 'resolve', described)
        return
      }
      if (outcome.outcome === 'noop') {
        // Staging showed the live tree already CONTAINS the chat's work (or the
        // chat's diff vanished against it) — there is nothing left to merge.
        // Leaving the chat parked here made "Resolve it" a silent infinite loop:
        // ok:true + still-parked re-renders the same card. Unpark.
        clearPark(st)
        if (outcome.newBase) st.wt.baseSha = outcome.newBase
        await retireWorktreeBranch(st.wt)
        emitIsolation(sessionKey, 'isolated', st.wt.branch)
        return
      }
      // 'parked' again — autoApplyWorktree refused the batch (it only writes text
      // files that still match the snapshot; a DELETED or binary file in the
      // chat's diff refuses forever, so retrying can never converge). The user
      // explicitly asked to resolve, so fall back to the explicit-apply
      // machinery (the review modal's Apply): a 3-way `git apply` handles
      // deletions/binary/modes. No per-file undo entries for this path — same
      // trade-off as the modal's Apply.
      const res = await applyParked(st.liveRoot, st.wt)
      if (res.ok) {
        if (res.newBase) st.wt.baseSha = res.newBase
        clearPark(st)
        await retireWorktreeBranch(st.wt)
        emitIsolation(sessionKey, 'merged', st.wt.branch, res.files)
        return
      }
      // `res.error` is bounded by the owner and names the path and Git's reason.
      throw new Error(
        `the merged result couldn't be written onto the project${res.error ? ` (${res.error})` : ''}`
      )
    })
  } catch (e) {
    return { ok: false, conflicted: [], error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, conflicted: [] }
}

/** "Discard changes" backend for a live PARKED chat: drop the chat's unmerged work
 *  (reset its worktree to the fork point) and unpark. Thin wrapper over
 *  `discardParkedBranch` keyed by `sessionKey` so the renderer needn't know the branch. */
export async function discardParkedChat(sessionKey: string): Promise<{ ok: boolean }> {
  const st = states.get(sessionKey)
  if (!st) return { ok: false }
  const res = await discardParkedBranch(st.liveRoot, st.wt.branch)
  return { ok: res.handled }
}

/** A chat's held stopped turn (LKM-151), as `stopped-turn.ts` sees it. */
export interface StoppedHold {
  files: string[]
  reverted: boolean
}

const holding = (st: ChatState | undefined): st is ChatState => !!st && st.parked && st.interrupted

/** The chat's held stopped turn, or undefined when it holds none. */
export function stoppedHold(sessionKey: string): StoppedHold | undefined {
  const st = states.get(sessionKey)
  return holding(st) ? { files: st.parkedFiles, reverted: st.reverted } : undefined
}

/** Mark the held stopped turn reverted (the live tree already matches, so only its
 *  record goes) or restore it (its record comes back), and tell the chat. */
export function markStoppedReverted(sessionKey: string, reverted: boolean): void {
  const st = states.get(sessionKey)
  if (!holding(st)) return
  st.reverted = reverted
  if (reverted) {
    dropParkRecord(st)
    emitIsolation(
      sessionKey,
      'isolated',
      st.wt.branch,
      st.parkedFiles,
      undefined,
      undefined,
      'reverted'
    )
  } else {
    upsertParkRecord(st, st.parkedFiles)
    emitIsolation(
      sessionKey,
      'parked',
      st.wt.branch,
      st.parkedFiles,
      undefined,
      undefined,
      'interrupted'
    )
  }
}

/**
 * Land the held, unreverted stopped turn now like a finished turn (`landTurn`). Live
 * drift parks it as an ordinary conflict instead. Serialized on the chat's chain and
 * re-checked there; answers null when nothing is held any more.
 */
export function landStoppedTurn(
  sessionKey: string
): Promise<{ files: string[]; group?: string; conflict?: boolean } | null> {
  const st = states.get(sessionKey)
  if (!holding(st) || st.reverted) return Promise.resolve(null)
  return onChain(st, async () => {
    if (!holding(st) || st.reverted) return null
    const turnNo = ++st.turnNo
    const described = await turnMessage(sessionKey, st, turnNo)
    const outcome = await completeTurn(st.liveRoot, st.wt, described.text, { land: true })
    if (outcome.outcome === 'parked') {
      st.interrupted = false
      st.parkedFiles = outcome.files
      upsertParkRecord(st, outcome.files)
      emitIsolation(sessionKey, 'parked', st.wt.branch, outcome.files)
      return { files: outcome.files, conflict: true }
    }
    if (outcome.outcome === 'merged')
      return {
        files: outcome.files,
        group: await landTurn(sessionKey, st, outcome, turnNo, described)
      }
    // Nothing left to land: the hold ends all the same.
    if (outcome.newBase) st.wt.baseSha = outcome.newBase
    clearPark(st)
    await retireWorktreeBranch(st.wt)
    emitIsolation(sessionKey, 'isolated', st.wt.branch)
    return { files: outcome.files }
  })
}
