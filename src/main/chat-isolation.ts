import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { SessionRecord, SessionTranscriptEntry } from '../shared/api'
import type { DependencyIssue } from '../shared/dependency-issue'
import { projectKey } from '../shared/projectKey'
import { currentAgentGitAccess } from './agent-git-access'
import { finalReply, turnMessage } from './chat-commit'
import { chatGateScope, gatedTurn, holdTurn, landTurn } from './chat-landing'
import { clearPark, gitOut, upsertParkRecord } from './chat-park'
import { holdForDecision, landingPeers, noteResolution, noteResolved } from './chat-resolution'
import { spareWorktreeIds, takeSpare } from './chat-spare'
import {
  type ChatState,
  chatDeps,
  emitIsolation,
  onChain,
  recreateWorkspace,
  states
} from './chat-state'
import { agentWorkspaceState } from './chat-status'
import { LandingEnded, LandingGuard } from './chat-watchdog'
import {
  applyParked,
  canReconcileText,
  conflictMarkerFiles,
  createChatWorktree,
  discardParked,
  stageResolve,
  syncFromLive
} from './chat-worktrees'
import { cancelChecks, waitForChecks } from './command-checks'
import { recordEdit } from './edit-history'
import { editingOwner } from './editing-owner'
import { isRepoRoot } from './git'
import {
  arrangeChecks,
  dropGateEvidence,
  integrationGate,
  lastReplayFailures,
  replayChecks
} from './integration-gate'
import { commitLiveTurn } from './live-commit'
import { reconcileParkOnChain } from './park-reconcile'
import {
  discardParkedChat as discardHeldChat,
  resolveParkedChat as resolveHeldChat
} from './parked-chat'
import { peerGateRefresh } from './peer-freshness'
import { peerTurn } from './peer-work'
import { previewEvidence } from './preview-evidence'
import { liveHead } from './preview-identity'
import { enqueueRepoWrite } from './repo-write-queue'
import { sourceSnapshot } from './source-snapshot'
import { logLanding, logLandingFailed } from './turn-log'
import type { TurnTerminalOutcome } from './turn-terminal'
import { receiptSession } from './verification-receipts'
import { dependencyInstall } from './worktree-dependencies'
import { reclaimWorktree, removeWorktree, retireWorktreeBranch } from './worktrees'

export { handleReclaimed, hasParkRecord } from './chat-park'
export { initChatIsolation } from './chat-state'
export {
  agentWorkspaceEvidence,
  agentWorkspaceState,
  isolationSnapshot,
  sendRefusal
} from './chat-status'
export { reconcileIdleParks, reconcilePark } from './park-reconcile'
export {
  applyParkedBranch,
  discardParkedBranch,
  parkedResolution,
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
    // LKM-182: the project's prewarmed spare, brought up to the live tree on take.
    const spare = await takeSpare(liveRoot)
    const wt = await enqueueRepoWrite(liveRoot, async () => {
      if (spare) {
        const synced = await syncFromLive(liveRoot, spare, { backgroundInstall: true }).catch(
          async () => {
            // The sync may have started an install in the checkout: let it settle first.
            await dependencyInstall(spare.path)
            await removeWorktree(liveRoot, spare, { intent: 'abandon' }).catch(() => {})
          }
        )
        if (synced) return spare
      }
      const created = await createChatWorktree(liveRoot, id, dir)
      await retireWorktreeBranch(created)
      return created
    })
    states.set(sessionKey, {
      wt,
      liveRoot,
      gitAccess: currentAgentGitAccess(),
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
 * Awaited by `agent:send` before `session.send`. Resolves to what keeps the checkout's
 * dependencies from installing (conflict markers, a failed install), which the turn
 * reports instead of being refused (LKM-194); null when there is nothing to report.
 */
export async function beforeTurn(
  sessionKey: string,
  _text: string
): Promise<DependencyIssue | null> {
  const st = states.get(sessionKey)
  if (!st) return null
  st.lastUsed = Date.now()
  return onChain(st, async () => {
    await recreateWorkspace(st)
    await settleReverted(st)
    // LKM-403: a turn on held work answers its question, but the question and the staged
    // resolution stay: the turn's end checks the answer (`holdForDecision`) and clears
    // them only once the work passes it, lands or is discarded. `landingError` stays too,
    // so the send guard keeps letting the chat continue on top of its held work.
    // LKM-196: a park whose work is already live (or whose batch went missing) is
    // settled before the send guard reads it.
    await reconcileParkOnChain(sessionKey, st, 'turn-start', true)
    // Helpers live under excluded `.trezi/` paths, so a parked chat gets them too
    // without looking changed (LKM-153: a stopped chat ran setup without them).
    if (st.parked) {
      await editingOwner().syncSetupHelpers(st.liveRoot, st.wt.path)
      return null
    }
    return (await syncFromLive(st.liveRoot, st.wt)).dependencies
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
/** Chats whose abandoned landing is still finishing; the lease and chain stay held. */
const draining = new Set<string>()
/** Whether a landing of this chat is in flight. */
export function landingInFlight(sessionKey: string): boolean {
  return landings.has(sessionKey) || draining.has(sessionKey)
}

/** Chats with a card Retry, Resolve or Discard running: one mutation at a time. */
const recovering = new Set<string>()
const LANDING_BUSY = 'The previous landing is still finishing. Try again in a moment.'
const RECOVERY_BUSY = 'Another recovery step for this chat is still running. Try again in a moment.'

/** Runs one recovery mutation unless a landing or another recovery of this chat is in
 *  flight; `refused` builds the typed refusal the card shows as its reason. */
async function exclusive<T>(
  sessionKey: string,
  refused: (error: string) => T,
  run: () => Promise<T>
): Promise<T> {
  if (landingInFlight(sessionKey)) return refused(LANDING_BUSY)
  if (recovering.has(sessionKey)) return refused(RECOVERY_BUSY)
  recovering.add(sessionKey)
  try {
    return await run()
  } finally {
    recovering.delete(sessionKey)
  }
}

/** Resolve for a held chat, refused while a landing or another recovery runs. */
export const resolveParkedChat = (sessionKey: string) =>
  exclusive(
    sessionKey,
    (error) => ({ ok: false, conflicted: [] as string[], error }),
    () => resolveHeldChat(sessionKey)
  )

/** Discard for a held chat, refused while a landing or another recovery runs. */
export const discardParkedChat = (sessionKey: string) =>
  exclusive(
    sessionKey,
    (error): { ok: boolean; error?: string } => ({ ok: false, error }),
    () => discardHeldChat(sessionKey)
  )

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
  reconcile = false,
  ordinaryCompletion = false
): Promise<string[] | null> {
  const st = states.get(sessionKey)
  if (!st) return Promise.resolve(null)
  const turn = lastTurn(transcript)
  st.lastUsed = Date.now()
  // Register Stop and the timeout at enqueue, including time spent behind this
  // chat's earlier turn. A cancelled waiter skips all Git work at admission.
  let admitted = false
  let cancelled = false
  let settled: 'pending' | 'ok' | 'failed' = 'pending'
  const write = st.chain.then(async () => {
    let recoveryFailure: string | undefined
    const changed =
      ordinaryCompletion && terminal === 'success' && !cancelled && !st.reclaimed
        ? (await sourceSnapshot(st.wt.path)).tree !==
          (await gitOut(st.wt.path, ['rev-parse', `${st.wt.baseSha}^{tree}`])).trim()
        : false
    if (changed && !cancelled && !st.decision) {
      const scope = chatGateScope(sessionKey, st)
      let verdict = await integrationGate(scope)
      if (verdict.reason === 'check-running') {
        const settled = await waitForChecks(receiptSession(sessionKey, projectKey(st.wt.path)))
        if (!settled) recoveryFailure = 'the existing check did not finish within its limit.'
        else verdict = await integrationGate(scope)
      }
      if (!cancelled && (verdict.reason === 'unchecked' || verdict.reason === 'runtime-changed')) {
        const arranged = await arrangeChecks(scope, () => cancelled)
        if (arranged.failures.length) recoveryFailure = arranged.failures.join('; ')
        else if (!arranged.ran && (await integrationGate(scope)).reason === 'unchecked')
          recoveryFailure = 'no supported private check was available.'
      }
    }
    if (cancelled) return null
    return enqueueRepoWrite(st.liveRoot, async () => {
      if (cancelled) return null
      admitted = true
      st.lastUsed = Date.now()
      if (st.reclaimed) return null
      const batch = landBatch(sessionKey, st, message, turn, terminal, reconcile, recoveryFailure)
      batch.then(
        () => {
          settled = 'ok'
        },
        () => {
          settled = 'failed'
        }
      )
      return batch
    })
  })
  const task = landings
    .run(sessionKey, write, ordinaryCompletion ? 16 * 60_000 : undefined, () => {
      cancelled = true
      if (ordinaryCompletion) cancelChecks(receiptSession(sessionKey, projectKey(st.wt.path)))
    })
    .catch(async (error) => {
      if (!(error instanceof LandingEnded)) {
        await landingFailed(sessionKey, st, error, turn)
        return null
      }
      if (!admitted) {
        await landingFailed(sessionKey, st, error, turn)
        return null
      }
      // An admitted batch owns the lease until its real Git work finishes. Stop
      // ends the visible wait, but never interrupts a write partway through apply.
      draining.add(sessionKey)
      try {
        await landingFailed(sessionKey, st, error, turn, () => settled !== 'pending')
        const late = await write.then(
          (files) => ({ files }),
          (cause) => ({ cause })
        )
        if ('cause' in late) {
          await landingFailed(sessionKey, st, late.cause, turn)
          return null
        }
        return late.files
      } finally {
        draining.delete(sessionKey)
      }
    })
  st.chain = task.catch(() => null)
  return task.catch(() => null)
}

/** Land the current snapshot while the provider is still running. The ordinary
 * turn-end landing remains queued on the same chat chain and sees only later edits. */
export async function landNow(sessionKey: string, message: string): Promise<unknown> {
  const st = states.get(sessionKey)
  if (!st || st.reclaimed) return { error: 'This chat has no active Git worktree.' }
  const landing = afterTurn(sessionKey, message, [], 'success', true)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timed = await Promise.race([
    landing.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), 60_000)
    })
  ])
  if (timer) clearTimeout(timer)
  if (timed)
    return {
      error: 'Landing is still running after 60 seconds. Check workspace_state before publishing.'
    }
  const state = agentWorkspaceState(sessionKey)
  return {
    outcome: state.lastLanding?.outcome ?? state.state,
    files: state.lastLanding?.files ?? state.files,
    ...(state.lastLanding?.error ? { error: state.lastLanding.error } : {}),
    commit: state.lastLanding?.outcome === 'merged' ? await liveHead(st.liveRoot, true) : null,
    preview: previewEvidence(st.liveRoot),
    guidance: state.guidance
  }
}

/** One landing attempt of the chat's cumulative batch. Inside the repository lease. */
async function landBatch(
  sessionKey: string,
  st: ChatState,
  message: string,
  turn: SessionTranscriptEntry[],
  terminal: TurnTerminalOutcome,
  reconcile: boolean,
  recoveryFailure?: string
): Promise<string[] | null> {
  await settleReverted(st)
  const turnNo = ++st.turnNo
  // LKM-403: what landed since this work forked, read here so nothing lands in between.
  // A staged reconciliation moved `baseSha` to the live snapshot it combined with, so the
  // peers it combined with are those since the fork point it recorded.
  const gate = await peerGateRefresh(
    st.liveRoot,
    peerTurn(sessionKey),
    st.resolution?.revisions.base ?? st.wt.baseSha
  )
  // Describes the cumulative diff (parked turns included), never the prompt (LKM-189).
  const described = await turnMessage(sessionKey, st, turnNo, {
    prompt: message,
    reply: finalReply(turn)
  })
  if (await holdForDecision(sessionKey, st, turn, described.text, terminal, gate)) return null
  // A resolved tree is new source: the gate wants its checks passed on exactly that tree.
  let combined = !!st.resolution && terminal === 'success'
  // The answer passed the turn-end check above: the question is settled.
  if (st.decision) {
    st.decision = undefined
    st.decisionShown = false
    st.resolution = undefined
  } else if (terminal !== 'success') st.resolved = undefined
  // Retry has no turn of its own: it may land a stopped resolution, but never vouches for it.
  else if (turn.length || reconcile) noteResolved(st, finalReply(turn), turnNo)
  // LOCAL-WEBKIT-3: only the tree its checks passed on lands (`gatedTurn`).
  let { outcome, verdict } = await gatedTurn(sessionKey, st, described.text, terminal === 'success')
  let reconcileFiles: string[] | null = null
  let replayFailure: string | undefined
  // Live drift: reconcile onto the live tree. A clean result is new source, so it lands
  // only once checks pass on it: the host runs the session's passing checks again on it
  // here, still inside the lease, and the owner lands it only if live has not moved since.
  const drift =
    outcome.outcome === 'parked' ||
    (outcome.outcome === 'held' && outcome.hold?.reason === 'live-changed')
  if (
    reconcile &&
    terminal === 'success' &&
    drift &&
    !(await conflictMarkerFiles(st.wt, outcome.files)).length &&
    (await canReconcileText(st.liveRoot, st.wt, outcome.files))
  ) {
    try {
      const prep = await stageResolve(st.liveRoot, st.wt)
      await noteResolution(sessionKey, st, prep)
      if (prep.clean) {
        const scope = chatGateScope(sessionKey, st)
        await replayChecks(scope)
        replayFailure = lastReplayFailures(scope)[0]
        ;({ outcome, verdict } = await gatedTurn(sessionKey, st, described.text, true))
        combined = true
      } else reconcileFiles = prep.conflicted
    } catch {
      /* preserve the recovery branch and surface the fallback */
    }
  }
  // The normal byte writer deliberately refuses deletions and binary files. A
  // checked, unchanged candidate may still land through the repository owner's
  // gated patch path, which handles those exact-tree changes atomically.
  if (
    terminal === 'success' &&
    outcome.outcome === 'parked' &&
    verdict?.ok &&
    !(await conflictMarkerFiles(st.wt, outcome.files)).length
  ) {
    const applied = await applyParked(st.liveRoot, st.wt, verdict.candidate)
    if (applied.ok)
      outcome = {
        ...outcome,
        outcome: 'merged',
        files: applied.files,
        edits: [],
        newBase: applied.newBase
      }
    else if (applied.hold) outcome = { ...outcome, outcome: 'held', hold: applied.hold }
  }
  logLanding(sessionKey, st.wt.branch, outcome, terminal, reconcileFiles)
  const at = Date.now()
  if (outcome.outcome === 'merged') {
    await landTurn(sessionKey, st, outcome, turnNo, described, !!verdict?.ok)
    const peers = landingPeers(gate, combined, verdict?.candidate ?? null)
    st.lastLanding = { outcome: 'merged', files: outcome.files, at, ...peers }
  } else if (outcome.outcome === 'held' && outcome.hold?.reason !== 'live-changed') {
    holdTurn(sessionKey, st, outcome, verdict, turn, recoveryFailure)
  } else if (outcome.outcome === 'parked' || outcome.outcome === 'held') {
    // A stopped or failed turn holds its work (LKM-151); a drift park (live moved since
    // the fork point) stays a conflict even when a later turn on top of it is stopped.
    st.interrupted = terminal !== 'success' && (!st.parked || st.interrupted)
    st.parked = true
    st.parkedFiles = outcome.files
    // This attempt reached the repository: an earlier landing error is history.
    st.landingError = undefined
    st.landingHold = undefined
    const markers = await conflictMarkerFiles(st.wt, outcome.files)
    st.resolvingFiles = markers.length ? markers : null
    upsertParkRecord(st, outcome.files, turn)
    if (terminal === 'success')
      st.lastLanding = {
        outcome: 'parked',
        files: outcome.files,
        at,
        ...landingPeers(gate, false, null)
      }
    if (!reconcileFiles)
      emitIsolation(
        sessionKey,
        'parked',
        st.wt.branch,
        outcome.files,
        undefined,
        undefined,
        st.interrupted ? 'interrupted' : replayFailure ? 'failed' : undefined,
        replayFailure
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
  turn: SessionTranscriptEntry[] = [],
  superseded: () => boolean = () => false
): Promise<void> {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500)
  logLandingFailed(sessionKey, st.wt.branch, reason)
  // The batch's files, best effort: the checkout itself may be what failed.
  const changed = await gitOut(st.wt.path, ['diff', '--name-only', st.wt.baseSha]).then(
    (out) => out.split('\n').filter(Boolean),
    () => [] as string[]
  )
  // The abandoned batch finished while this was reading: its own outcome stands.
  if (superseded()) return
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
export function retryLanding(
  sessionKey: string
): Promise<{ ok: boolean; state: 'isolated' | 'parked'; error?: string }> {
  return exclusive(
    sessionKey,
    (error) => ({ ok: false, state: 'parked' as const, error }),
    () => retryHeldLanding(sessionKey)
  )
}

async function retryHeldLanding(
  sessionKey: string
): Promise<{ ok: boolean; state: 'isolated' | 'parked'; error?: string }> {
  const st = states.get(sessionKey)
  if (!st) return { ok: false, state: 'isolated', error: 'That chat is no longer open.' }
  if (!st.parked || st.reverted || (st.interrupted && !st.landingError))
    return { ok: true, state: st.parked && !st.reverted ? 'parked' : 'isolated' }
  // LKM-403: only the user's answer moves this work on; retrying would pick a side.
  if (st.decision) return { ok: false, state: 'parked', error: st.landingError }
  // LOCAL-WEBKIT-3: held because the project moved on. Bring the chat up to date with
  // the live tree first; overlapping edits become the usual conflict card (Resolve).
  if (st.landingHold === 'live-changed') {
    const prep = await onChain(st, async () => {
      const staged = await stageResolve(st.liveRoot, st.wt)
      await noteResolution(sessionKey, st, staged)
      return staged
    }).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error)
    }))
    if ('error' in prep) return { ok: false, state: 'parked', error: prep.error }
    if (!prep.clean) {
      st.landingError = undefined
      st.landingHold = undefined
      st.resolvingFiles = prep.conflicted
      emitIsolation(sessionKey, 'parked', st.wt.branch, prep.conflicted)
      return { ok: true, state: 'parked' }
    }
  }
  // The source to land has no passing checks (new after reconciling, or never checked
  // since its last edit): the host runs the session's checks that passed before again.
  const { failures } = await arrangeChecks(chatGateScope(sessionKey, st))
  // Its outcome reaches the chat as the usual isolation event (merged, or the card again).
  await afterTurn(sessionKey, 'Land held chat changes', [], 'success')
  // Still held after Trezi tried to arrange the evidence: say why it is missing.
  if (st.parked && st.landingError && failures.length) {
    st.landingError = `${st.landingError} Trezi's own check did not pass: ${failures.join('; ')}`
    if (st.lastLanding) st.lastLanding.error = st.landingError
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
  return [...states.values()].map((s) => s.wt.id).concat(spareWorktreeIds())
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
  if (!st) {
    return
  }
  states.delete(sessionKey)
  try {
    await st.chain.catch(() => {})
    await enqueueRepoWrite(st.liveRoot, async () => {
      if (st.reclaimed) return // idle cleanup already removed the checkout and branch
      await settleReverted(st)
      if (!st.parked) {
        const turnNo = ++st.turnNo
        const described = await turnMessage(sessionKey, st, turnNo)
        // The session's receipts were released with it; the gate reads the copy it kept.
        const { outcome } = await gatedTurn(
          sessionKey,
          st,
          described.text,
          pendingTerminal === 'success'
        )
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
          await commitLiveTurn(
            st.liveRoot,
            outcome.files,
            {
              title: described.subject,
              body: described.body
            },
            outcome.newBase
          )
        } else if (outcome.outcome === 'parked' || outcome.outcome === 'held') {
          // Unchecked work is kept on its branch for review, never landed on close.
          st.parked = true
          upsertParkRecord(st, outcome.files)
        }
      }
      // A new-chat background install (LKM-182) may still be writing node_modules here.
      await dependencyInstall(st.wt.path)
      await removeWorktree(st.liveRoot, st.wt, {
        keepBranch: st.parked,
        intent: st.parked ? 'release' : 'landed'
      })
    })
  } catch {
    /* teardown never throws */
  } finally {
    dropGateEvidence(sessionKey, st.wt.path)
  }
}

/** Forget every chat's in-memory state on quit — a mirror of the spawns map. The
 *  checkouts stay on disk for the next launch's crash recovery (C4). */
export function dropAll(): void {
  states.clear()
}
