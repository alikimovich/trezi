import type { PeerGateNote } from '../shared/api'
import { conflictMarkerFiles, stageResolve } from './chat-worktrees'
import { type GateScope, holdMessage, integrationGate, replayChecks } from './integration-gate'
import { peerGateRefresh } from './peer-freshness'
import { productLog } from './product-log'
import type { OwnedEdit } from './repository-owner'
import { heldResolution, resolutionFor, restoreOwnFiles } from './resolution-context'
import type { PendingResolution } from './resolution-evidence'
import { autoApplyWorktree, commitWorktree, type Worktree } from './worktrees'

/**
 * A finished background spawn (a comment, a text edit) lands here, inside the
 * repository lease (LKM-382). Every spawn forks from the live tree when it starts, so
 * when several run at once the first to finish moves live and every later one would be
 * held as `live-changed`. Instead, a spawn whose checked change is held only because live
 * moved brings itself up to date, as a chat's Retry does: the owner stages live plus the
 * spawn's change in its worktree (`stageResolve`), the session's passing checks run again
 * on that exact tree, and only then does it land (LOCAL-WEBKIT-3). Overlapping lines come
 * back as `conflicted` with both goals (LKM-403): the caller asks the spawn's own agent to
 * combine them on the new base, and its next finish lands here again, or is kept for
 * review with the one product decision it needs.
 */

/** Clean reconciles within one finish; live moving again each time ends in review. */
const MAX_RECONCILES = 3
/** Agent continuations of one spawn on overlapping edits before the user decides. */
export const MAX_SPAWN_CONTINUATIONS = 3

export interface SpawnLanding {
  committed: boolean
  /** The change that lands (or was held): the spawn's own, or its reconciled one. */
  files: string[]
  applied: boolean
  edits: OwnedEdit[]
  /** Why the change did not land, for the review row; null when it landed or is empty. */
  reason: string | null
  /** Overlapping files now carrying conflict markers on live's tree, for the agent. */
  conflicted: string[] | null
  /** What staging `conflicted` combined, for the agent's prompt and its next finish. */
  resolution?: PendingResolution
  /** The product question this kept work waits on. */
  decision?: string
  /** What it saw of its peers at the gate. */
  gate?: PeerGateNote
}

export async function landSpawn(
  scope: GateScope,
  wt: Worktree,
  message: string,
  opts: {
    /** A finished, uncancelled run: anything else is kept for review, never landed. */
    land: boolean
    /** Its change was reconciled onto live by an earlier finish of this spawn. */
    reconciled: boolean
    /** The agent may still be asked to combine overlapping edits. */
    mayContinue: boolean
    /** Its id in the peer feed, and what it was asked to do. */
    peerId?: string
    goal?: string
    /** The reconciliation it was just asked to finish, with its closing reply. */
    resolution?: PendingResolution
    reply?: string
  }
): Promise<SpawnLanding> {
  // Read before the commit: taking the other side leaves it nothing to commit.
  const held =
    opts.land && opts.resolution
      ? await heldResolution(wt, opts.resolution, opts.reply ?? '').catch(() => null)
      : null
  if (held && opts.resolution) await restoreOwnFiles(wt, opts.resolution, held.restore)
  let { committed, files } = await commitWorktree(wt, message)
  const result = (over: Partial<SpawnLanding> = {}): SpawnLanding => ({
    committed,
    files,
    applied: false,
    edits: [],
    reason: null,
    conflicted: null,
    ...over
  })
  if (!opts.land || !committed || !files.length) return result()
  let reconciled = opts.reconciled
  try {
    const self = opts.peerId ?? ''
    const gate = await peerGateRefresh(
      scope.liveRoot,
      self,
      opts.resolution?.revisions.base ?? wt.baseSha
    )
    if (held)
      return result({
        reason: `this comment's edits overlap with changes that landed meanwhile, and its agent could not combine them (${held.files.slice(0, 5).join(', ')}). Its work is kept for review. Decision needed: ${held.question}`,
        decision: held.question,
        gate
      })
    for (let attempt = 0; ; attempt++) {
      // Markers the agent left: it could not combine both sides, so the user decides.
      const markers = await conflictMarkerFiles(wt, files)
      if (markers.length)
        return result({
          reason: `this comment's edits overlap with changes that landed meanwhile, and its agent could not combine them (${markers.slice(0, 5).join(', ')}). Its work is kept for review.`,
          gate
        })
      let verdict = await integrationGate(scope)
      // A reconciled tree is new source: the checks that passed before run again on it.
      if (
        reconciled &&
        !verdict.ok &&
        (verdict.reason === 'unchecked' || verdict.reason === 'runtime-changed')
      ) {
        await replayChecks(scope)
        verdict = await integrationGate(scope)
      }
      const auto = await autoApplyWorktree(scope.liveRoot, wt, files, verdict.candidate)
      if (auto.applied)
        return result({
          applied: true,
          edits: auto.edits,
          gate: { ...gate, combinedRechecked: reconciled, tree: verdict.candidate }
        })
      const drift = auto.hold?.reason === 'live-changed'
      if (!drift || attempt >= MAX_RECONCILES || !opts.mayContinue)
        return result({ reason: auto.hold ? holdMessage(auto.hold, verdict) : null, gate })
      // Live moved since the fork point (another landing): stage live plus this change.
      const prep = await stageResolve(scope.liveRoot, wt)
      reconciled = true
      productLog.info('landing', 'Background agent reconciled with the live tree', {
        worktree: wt.id,
        clean: prep.clean,
        conflicted: prep.conflicted.length
      })
      if (!prep.clean)
        return result({
          conflicted: prep.conflicted,
          gate,
          ...(prep.stage
            ? {
                resolution: await resolutionFor(prep.stage, prep.conflicted, {
                  scope,
                  self,
                  goal: opts.goal ?? ''
                })
              }
            : {})
        })
      ;({ committed, files } = await commitWorktree(wt, message))
      // The same change already landed: nothing of its own is left to land.
      if (!committed || !files.length) return result()
    }
  } catch (error) {
    productLog.warn('landing', 'Background agent landing failed', {
      worktree: wt.id,
      error: error instanceof Error ? error.message : String(error)
    })
    return result()
  }
}
