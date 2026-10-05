import { gitOut } from './chat-park'
import { type LandingResult, states } from './chat-state'
import { previewEvidence } from './preview-evidence'

/**
 * Read-only views of a chat's isolation state (`chat-isolation.ts` owns the state):
 * the renderer's reattach snapshot, the `agent:send` guard and what the chat's Trezi
 * MCP tools report to the agent.
 */

/** The isolation status of a live chat for `agent:workspace-snapshot` (renderer
 *  reload reattach). Undefined for a non-isolated chat (the renderer treats that as
 *  live). */
export function isolationSnapshot(sessionKey: string):
  | {
      state: 'live' | 'isolated' | 'parked'
      branch?: string
      reason?: 'interrupted' | 'failed'
      error?: string
    }
  | undefined {
  const st = states.get(sessionKey)
  if (!st) return undefined
  const parked = st.parked && !st.reverted
  return {
    state: parked ? 'parked' : 'isolated',
    ...(st.wt.branch ? { branch: st.wt.branch } : {}),
    ...(parked && st.landingError
      ? { reason: 'failed' as const, error: st.landingError }
      : parked && st.interrupted
        ? { reason: 'interrupted' as const }
        : {})
  }
}

/**
 * Why `agent:send` must not start a turn now, or null. Only a drift park with no
 * resolution staged refuses: a stopped or failed-landing hold continues on top (the
 * next landing carries it), and once "Resolve" staged the markers the resolution
 * turn itself must run (LKM-165: it was refused, so a parked chat could never land).
 */
export function sendRefusal(sessionKey: string): string | null {
  const st = states.get(sessionKey)
  if (!st?.parked || st.reverted || st.interrupted || st.landingError || st.resolvingFiles)
    return null
  return 'This chat’s last changes didn’t land because the project changed under them. Choose Resolve, Retry or Discard on the card first.'
}

/** Authoritative state exposed to the chat's Trezi MCP tools. Unlike `git status`
 *  inside the private checkout, this reports whether the landing coordinator has
 *  accepted, parked, or staged the cumulative batch. Paths stay out of the result:
 *  the model already runs in its own worktree and should never target the live one. */
export function agentWorkspaceState(sessionKey: string): {
  state: 'live' | 'isolated' | 'parked' | 'resolving' | 'failed'
  branch?: string
  files: string[]
  guidance: string
  lastLanding?: LandingResult
  error?: string
} {
  const st = states.get(sessionKey)
  if (!st) {
    return {
      state: 'live',
      files: [],
      guidance: 'This chat edits the live folder directly; no Trezi worktree landing is active.'
    }
  }
  // LKM-165: the agent reports the last landing as it happened, never as "pending".
  const last = st.lastLanding ? { lastLanding: st.lastLanding } : {}
  if (st.landingError && !st.reverted) {
    return {
      state: 'failed',
      branch: st.wt.branch,
      files: st.parkedFiles,
      error: st.landingError,
      ...last,
      guidance:
        'Trezi could not land this chat’s changes; they are held, not applied, and the project does not have them. Tell the user exactly that, with the error, and point them to Retry or Resolve on the chat card. Do not say the changes are pending or applied.'
    }
  }
  if (st.resolvingFiles) {
    return {
      state: 'resolving',
      branch: st.wt.branch,
      files: st.resolvingFiles,
      ...last,
      guidance:
        'Both sides are staged in this worktree. Resolve every conflict marker in the listed files; Trezi will land the result when the turn completes.'
    }
  }
  if (st.parked && !st.reverted) {
    return {
      state: 'parked',
      branch: st.wt.branch,
      files: st.parkedFiles,
      ...last,
      guidance: st.interrupted
        ? 'An earlier stopped or failed turn’s changes are held, not applied. Edits in this turn build on them, and Trezi tries to land everything when this turn completes.'
        : 'Trezi refused to land this cumulative batch safely; the project does not have these changes. Call prepare_conflict_resolution before editing or giving the user terminal instructions.'
    }
  }
  return {
    state: 'isolated',
    branch: st.wt.branch,
    files: [],
    ...last,
    guidance:
      'This chat is healthy and isolated. Edits made in this turn land when it completes. Earlier turns are settled: lastLanding says what the last one did (merged = in the project). Never describe earlier changes as pending.'
  }
}

/** Git state and preview observations are distinct: a reachable preview is not
 * proof that a just-landed revision finished compiling. */
export async function agentWorkspaceEvidence(sessionKey: string, root: string) {
  const state = agentWorkspaceState(sessionKey)
  const st = states.get(sessionKey)
  const liveRoot = st?.liveRoot ?? root
  return {
    ...state,
    liveRoot,
    checkout: st?.wt.path ?? root,
    worktreeBaseRevision: st?.wt.baseSha ?? null,
    liveRevision: await gitOut(liveRoot, ['rev-parse', 'HEAD']).then(
      (s) => s.trim(),
      () => null
    ),
    liveDirty: await gitOut(liveRoot, ['status', '--porcelain']).then(
      (s) => Boolean(s.trim()),
      () => null
    ),
    preview: previewEvidence(liveRoot)
  }
}
