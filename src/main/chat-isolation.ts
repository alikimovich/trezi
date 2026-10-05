import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { SessionRecord, SessionTranscriptEntry } from '../shared/api'
import { projectKey } from '../shared/projectKey'
import { landTurn } from './chat-landing'
import { clearPark, gitOut, upsertParkRecord } from './chat-park'
import {
  type ChatState,
  chatDeps,
  emitIsolation,
  onChain,
  recreateWorkspace,
  states
} from './chat-state'
import { LandingGuard } from './chat-watchdog'
import {
  canReconcileText,
  completeTurn,
  conflictMarkerFiles,
  createChatWorktree,
  discardParked,
  stageResolve,
  syncFromLive
} from './chat-worktrees'
import { recordEdit } from './edit-history'
import { editingOwner } from './editing-owner'
import { isRepoRoot } from './git'
import { commitLiveTurn } from './live-commit'
import { enqueueRepoWrite } from './repo-write-queue'
import type { TurnTerminalOutcome } from './turn-terminal'
import { reclaimWorktree, removeWorktree, retireWorktreeBranch } from './worktrees'

export { handleReclaimed, hasParkRecord } from './chat-park'
export { initChatIsolation } from './chat-state'
export {
  agentWorkspaceEvidence,
  agentWorkspaceState,
  isolationSnapshot,
  sendRefusal
} from './chat-status'
export {
  applyParkedBranch,
  discardParkedBranch,
  discardParkedChat,
  resolveParkedChat,
  showParkedChat
} from './parked-chat'

/**
 * Per-CHAT git-worktree isolation glue (v9). Generalizes the comment-spawn
 * worktree machinery to interactive chats: every chat on a git repo ROOT gets one
 * long-lived `trezi/chat-<id>` worktree, forked before its session starts and used
 * as the session's `cwd` for the chat's whole life. After each completed agent turn
 * the chat's work auto-merges back onto the LIVE checkout (which the preview always
 * serves) so the preview updates between turns, and the merged files are committed
 * there too (`live-commit.ts`) so every turn is one revertable commit in the user's
 * own history; on mid-turn drift the turn PARKS on
 * its branch for the existing SessionReview UI instead of clobbering the user's edit.
 *
 * Dependency-injected (`initChatIsolation`) so `agent.ts` barely grows — the pure git
 * mechanics live in `chat-worktrees.ts`/`worktrees.ts`, the Electron/store/window seam
 * is passed in here. Non-repo / subdir / non-git projects get no worktree and every
 * hook no-ops (the chat runs on the live root exactly as before).
 *
 * This module owns a chat's lifecycle. Its state is in `chat-state.ts`, park records
 * and crash recovery in `chat-park.ts`, the landing step in `chat-landing.ts`, its
 * read-only views (snapshot, send guard, agent workspace state) in `chat-status.ts`, the
 * parked-chat actions in `parked-chat.ts` and the setup helper sync in `chat-helpers.ts`.
 *
 * Serialization has two levels: each chat has a promise `chain`, and every live-tree
 * snapshot/landing also passes through a repository-scoped queue. The first orders a
 * chat's own turns; the second protects the one shared live index/HEAD from other chats.
 */

/**
 * The cwd a chat's session should run in: its private worktree when `liveRoot` is a
 * git repo root, else `liveRoot` itself (all hooks then no-op). Idempotent — a known
 * `sessionKey` (e.g. `agent:restart-chat` reusing the same chat) returns its existing
 * worktree rather than forking a second. A repository-root isolation failure rejects
 * the open instead of silently running the chat in the shared live checkout.
 */
export async function isolatedCwd(liveRoot: string, sessionKey: string): Promise<string> {
  const existing = states.get(sessionKey)
  if (existing) {
    // Idle cleanup removed the checkout: a session restarted without a turn (model
    // change, rebuild after a stop) needs it back before a provider starts in it.
    if (existing.reclaimed) await recreateReclaimed(existing)
    return existing.wt.path
  }
  const deps = chatDeps()
  if (!deps) return liveRoot
  if (!(await isRepoRoot(liveRoot))) return liveRoot
  try {
    const id = randomUUID().slice(0, 8)
    const dir = deps.worktreesDir()
    const wt = await enqueueRepoWrite(liveRoot, async () => {
      const created = await createChatWorktree(liveRoot, id, dir)
      await retireWorktreeBranch(created)
      return created
    })
    states.set(sessionKey, {
      wt,
      liveRoot,
      parked: false,
      parkRecordId: null,
      parkedFiles: [],
      resolvingFiles: null,
      interrupted: false,
      reverted: false,
      turnNo: 0,
      chain: Promise.resolve(),
      lastUsed: Date.now(),
      reclaimed: false
    })
    emitIsolation(sessionKey, 'isolated', wt.branch)
    return wt.path
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Trezi couldn't create an isolated chat workspace: ${detail}`)
  }
}

/**
 * Re-stamp a chat session's record back to the LIVE project. A chat runs with `cwd`
 * = its worktree, so `createRecordCapture(root, projectKey(root))` keyed the record to
 * `projectKey(wt.path)` — which would hide the record from `sessions:list` and point
 * `agent:workspace-snapshot`'s reattach at the worktree. Called synchronously right
 * after `startSession` resolves, on every chat path. No-op for a non-isolated chat
 * (its cwd already IS `liveRoot`).
 */
export function adoptSession(sessionKey: string, record: SessionRecord, liveRoot: string): void {
  record.projectKey = projectKey(liveRoot)
  record.projectRoot = liveRoot
  record.projectName = basename(liveRoot) || liveRoot
  const st = states.get(sessionKey)
  if (st) st.record = record
}

/** `recreateWorkspace` queued behind the chat's in-flight work, like a turn start. */
function recreateReclaimed(st: ChatState): Promise<void> {
  st.lastUsed = Date.now()
  return onChain(st, () => recreateWorkspace(st))
}

/**
 * Turn-start hook: sync the live tree into the worktree so the agent sees the user's
 * between-turn edits. Queued on the chat's chain so it waits out any in-flight
 * post-`done` merge. Skipped while parked (never merge live drift into unmerged work).
 * A checkout idle cleanup removed is recreated first, at the same path and id.
 * Awaited by `agent:send` before `session.send`.
 */
export async function beforeTurn(sessionKey: string, _text: string): Promise<void> {
  const st = states.get(sessionKey)
  if (!st) return
  st.lastUsed = Date.now()
  await onChain(st, async () => {
    await recreateWorkspace(st)
    await settleReverted(st)
    // Helpers live under excluded `.trezi/` paths, so a parked chat gets them too
    // without looking changed (LKM-153: a stopped chat ran setup without them).
    if (st.parked) return editingOwner().syncSetupHelpers(st.liveRoot, st.wt.path)
    await syncFromLive(st.liveRoot, st.wt)
  })
}

/** Drop a reverted stopped turn's held work for good (inside the repository lease).
 *  The owner keeps a recovery ref of what it discards. Its park record already went
 *  when the user reverted, so `clearPark` drops nothing more. */
async function settleReverted(st: ChatState): Promise<void> {
  if (!st.reverted) return
  await discardParked(st.wt)
  await retireWorktreeBranch(st.wt)
  clearPark(st)
}

const landings = new LandingGuard()
/** Stop on a landing: ends the wait now; the work is held (Retry) and the chat is free. */
export function abandonLanding(sessionKey: string, reason: string): boolean {
  return landings.abandon(sessionKey, reason)
}
/** Whether a landing of this chat is in flight. */
export function landingInFlight(sessionKey: string): boolean {
  return landings.has(sessionKey)
}

/** The tail of a transcript from its LAST user message on — the "last turn" a park
 *  record surfaces in the review UI (prompt + the assistant's reply to it). */
function lastTurn(transcript: SessionTranscriptEntry[]): SessionTranscriptEntry[] {
  const idx = transcript.map((t) => t.role).lastIndexOf('user')
  return idx >= 0 ? transcript.slice(idx) : transcript.slice(-4)
}

/**
 * Turn-end hook (fired on `done` AND `error` to salvage interrupted work): commit the
 * turn, merge it onto the live tree, and advance the fork point. Queued on the chat's
 * chain (never awaited by the caller). On `merged`, lands it (`landTurn`: one undo group
 * `chat:<id>:<turnNo>`, one revertable commit on the live checkout, advanced `baseSha`,
 * unparked). On `parked`, upserts the park record (with the last turn's transcript) for
 * the review UI. `noop` emits a successful landing acknowledgement without a commit.
 * With reconciliation enabled, stage text drift privately and return marker-bearing
 * files for one provider continuation; clean three-way results land in this queue.
 * A landing that throws holds the work as a failed park with Retry (LKM-165); it is
 * never swallowed silently, which left the chat "isolated" with nothing landed.
 */
export function afterTurn(
  sessionKey: string,
  message: string,
  transcript: SessionTranscriptEntry[] = [],
  terminal: TurnTerminalOutcome = 'success',
  reconcile = false
): Promise<string[] | null> {
  const st = states.get(sessionKey)
  if (!st) return Promise.resolve(null)
  const turn = lastTurn(transcript)
  st.lastUsed = Date.now()
  const task = st.chain.then(() =>
    enqueueRepoWrite(st.liveRoot, async () => {
      st.lastUsed = Date.now()
      if (st.reclaimed) return null
      try {
        // Bounded (LKM-165): a landing that stalls, or that Stop ends, is held with Retry
        // and frees the chain and the repository lease behind it.
        return await landings.run(
          sessionKey,
          landBatch(sessionKey, st, message, turn, terminal, reconcile)
        )
      } catch (error) {
        await landingFailed(sessionKey, st, error, turn)
        return null
      }
    })
  )
  st.chain = task.catch(() => null)
  return task.catch(() => null)
}

/** One landing attempt of the chat's cumulative batch. Inside the repository lease. */
async function landBatch(
  sessionKey: string,
  st: ChatState,
  message: string,
  turn: SessionTranscriptEntry[],
  terminal: TurnTerminalOutcome,
  reconcile: boolean
): Promise<string[] | null> {
  await settleReverted(st)
  const turnNo = ++st.turnNo
  let outcome = await completeTurn(st.liveRoot, st.wt, message, {
    land: terminal === 'success'
  })
  let reconcileFiles: string[] | null = null
  if (
    reconcile &&
    terminal === 'success' &&
    outcome.outcome === 'parked' &&
    !(await conflictMarkerFiles(st.wt, outcome.files)).length &&
    (await canReconcileText(st.liveRoot, st.wt, outcome.files))
  ) {
    try {
      const prep = await stageResolve(st.liveRoot, st.wt)
      if (prep.clean) outcome = await completeTurn(st.liveRoot, st.wt, message)
      else reconcileFiles = prep.conflicted
    } catch {
      /* preserve the recovery branch and surface the fallback */
    }
  }
  const at = Date.now()
  if (outcome.outcome === 'merged') {
    await landTurn(sessionKey, st, outcome, turnNo, message)
    st.lastLanding = { outcome: 'merged', files: outcome.files, at }
  } else if (outcome.outcome === 'parked') {
    // A stopped or failed turn holds its work (LKM-151); a drift park stays a
    // conflict even when a later turn on top of it is stopped.
    st.interrupted = terminal !== 'success' && (!st.parked || st.interrupted)
    st.parked = true
    st.parkedFiles = outcome.files
    // This attempt reached the repository: an earlier landing error is history.
    st.landingError = undefined
    const markers = await conflictMarkerFiles(st.wt, outcome.files)
    st.resolvingFiles = markers.length ? markers : null
    upsertParkRecord(st, outcome.files, turn)
    if (terminal === 'success') st.lastLanding = { outcome: 'parked', files: outcome.files, at }
    if (!reconcileFiles)
      emitIsolation(
        sessionKey,
        'parked',
        st.wt.branch,
        outcome.files,
        undefined,
        undefined,
        st.interrupted ? 'interrupted' : undefined
      )
  } else if (outcome.newBase) {
    clearPark(st)
    st.wt.baseSha = outcome.newBase
    await retireWorktreeBranch(st.wt)
    if (terminal === 'success') st.lastLanding = { outcome: 'unchanged', files: outcome.files, at }
    // Setup may only restore an excluded helper; config can already be wired.
    // Acknowledge the no-op so it can restart and verify instead of waiting forever.
    if (terminal === 'success') emitIsolation(sessionKey, 'merged', st.wt.branch, [])
  }
  return reconcileFiles
}

/** The landing threw (the repository owner refused or Git failed). Hold the work —
 *  parked, so the next turn start never resets it away — and say so with the reason,
 *  so the chat shows Retry instead of looking landed or pending forever. */
async function landingFailed(
  sessionKey: string,
  st: ChatState,
  error: unknown,
  turn: SessionTranscriptEntry[] = []
): Promise<void> {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500)
  // The batch's files, best effort: the checkout itself may be what failed.
  const changed = await gitOut(st.wt.path, ['diff', '--name-only', st.wt.baseSha]).then(
    (out) => out.split('\n').filter(Boolean),
    () => [] as string[]
  )
  if (changed.length) st.parkedFiles = changed
  st.parked = true
  st.landingError = reason || 'The landing failed.'
  st.lastLanding = { outcome: 'failed', files: st.parkedFiles, at: Date.now(), error: reason }
  upsertParkRecord(st, st.parkedFiles, turn)
  emitIsolation(
    sessionKey,
    'parked',
    st.wt.branch,
    st.parkedFiles,
    undefined,
    undefined,
    'failed',
    st.landingError
  )
}

/**
 * The chat card's Retry (LKM-165): land the held cumulative batch again, as a finished
 * turn would. A failed landing or a drift park the user has since cleared up lands;
 * otherwise the chat shows the same card with the new reason. A stopped turn's hold
 * is not retried here: its own card offers Keep.
 */
export async function retryLanding(
  sessionKey: string
): Promise<{ ok: boolean; state: 'isolated' | 'parked'; error?: string }> {
  const st = states.get(sessionKey)
  if (!st) return { ok: false, state: 'isolated', error: 'That chat is no longer open.' }
  if (!st.parked || st.reverted || (st.interrupted && !st.landingError))
    return { ok: true, state: st.parked && !st.reverted ? 'parked' : 'isolated' }
  // Its outcome reaches the chat as the usual isolation event (merged, or the card again).
  await afterTurn(sessionKey, 'Land held chat changes', [], 'success')
  return {
    ok: true,
    state: st.parked ? 'parked' : 'isolated',
    ...(st.landingError ? { error: st.landingError } : {})
  }
}

/** Ids of every live chat worktree across ALL open projects — the `pruneOrphans`
 *  skip set must include these so a crash-recovery sweep never reclaims a live chat's
 *  checkout (the global worktrees dir is shared across projects). */
export function liveChatWorktreeIds(): string[] {
  return [...states.values()].map((s) => s.wt.id)
}

/** Every open chat with a worktree (the idle sweep's candidates). */
export function chatWorkspaceKeys(): string[] {
  return [...states.keys()]
}

/**
 * Idle cleanup (LKM-136, see `chat-workspaces.ts`): remove the chat's checkout when it
 * has had no turn since `idleBefore`. Re-checked inside the chat's chain and the
 * repository lease, so a turn that starts meanwhile wins. A parked, resolving or busy
 * chat is skipped; a dirty checkout stays, its work at a recovery ref. The next turn
 * recreates the checkout (`beforeTurn`). Never throws.
 */
export async function reclaimIdleWorkspace(
  sessionKey: string,
  idleBefore: number,
  busy: (sessionKey: string) => boolean
): Promise<'removed' | 'kept-dirty' | 'skipped'> {
  const st = states.get(sessionKey)
  const eligible = () =>
    !!st &&
    states.get(sessionKey) === st &&
    !st.reclaimed &&
    !st.parked &&
    !st.resolvingFiles &&
    st.lastUsed <= idleBefore &&
    !busy(sessionKey)
  if (!st || !eligible()) return 'skipped'
  return onChain(st, async () => {
    if (!eligible()) return 'skipped' as const
    const result = await reclaimWorktree(st.liveRoot, st.wt)
    if (!result.removed) return result.dirty ? ('kept-dirty' as const) : ('skipped' as const)
    st.reclaimed = true
    return 'removed' as const
  }).catch(() => 'skipped' as const)
}

/**
 * Tear down one chat's worktree (close-chat / close-project / open-project's replace
 * path). Runs one final commit+merge to salvage the last turn, then removes the
 * checkout — keeping the branch only when parked (its work still awaits review).
 * Never throws (teardown runs in finalizers).
 */
export async function releaseChat(
  sessionKey: string,
  pendingTerminal: TurnTerminalOutcome = 'success'
): Promise<void> {
  const st = states.get(sessionKey)
  if (!st) return
  states.delete(sessionKey)
  try {
    await st.chain.catch(() => {})
    await enqueueRepoWrite(st.liveRoot, async () => {
      if (st.reclaimed) return // idle cleanup already removed the checkout and branch
      await settleReverted(st)
      if (!st.parked) {
        const turnNo = ++st.turnNo
        const outcome = await completeTurn(st.liveRoot, st.wt, 'trezi chat changes', {
          land: pendingTerminal === 'success'
        })
        // Not `landTurn`: the chat is gone, so there is no park to leave, no branch
        // to retire (the checkout is removed below) and nobody to tell.
        if (outcome.outcome === 'merged') {
          for (const e of outcome.edits) {
            recordEdit(
              st.liveRoot,
              e.file,
              e.before,
              e.after,
              undefined,
              `chat:${st.wt.id}:${turnNo}`
            )
          }
          await commitLiveTurn(st.liveRoot, outcome.files, {
            title: 'Trezi chat changes',
            body: `Trezi final turn (${st.wt.branch}).`
          })
        } else if (outcome.outcome === 'parked') {
          st.parked = true
          upsertParkRecord(st, outcome.files)
        }
      }
      await removeWorktree(st.liveRoot, st.wt, {
        keepBranch: st.parked,
        intent: st.parked ? 'release' : 'landed'
      })
    })
  } catch {
    /* teardown never throws */
  }
}

/** Forget every chat's in-memory state on quit — a mirror of the spawns map. The
 *  checkouts stay on disk for the next launch's crash recovery (C4). */
export function dropAll(): void {
  states.clear()
}
