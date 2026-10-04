import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { SessionRecord, SessionTranscriptEntry } from '../shared/api'
import { projectKey } from '../shared/projectKey'
import { type ChatState, chatDeps } from './chat-state'
import { branchPatch, deleteBranch } from './worktrees'

/**
 * Park records of isolated chats: the `chatpark-<wtId>` `SessionRecord` a parked chat
 * surfaces in the sidebar for review, the one place a chat leaves its park
 * (`clearPark`), and crash recovery of reclaimed chat worktrees.
 */

const execFileP = promisify(execFile)
export const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (
    (await execFileP('git', args, { cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024 })) as {
      stdout: string
    }
  ).stdout

/**
 * Persist (or refresh) a park `SessionRecord` keyed `chatpark-<wtId>` under its OWNING
 * repo (`repoRoot`, which for crash recovery may differ from the project being opened).
 * Reuses an existing record's `startedAt`/`title` — and its `filesTouched`/`transcript`
 * when the caller has none — so successive parked turns update ONE record. Deliberately
 * carries NO `sdkSessionId` (that would light up Resume on a still-live chat). Returns
 * the record id, or null if history is unavailable. Shared by live-chat parks and
 * crash-recovery records.
 */
function saveParkRecord(opts: {
  wtId: string
  repoRoot: string
  branch: string
  files: string[]
  transcript?: SessionTranscriptEntry[]
  title: string
}): string | null {
  const deps = chatDeps()
  if (!deps) return null
  const id = `chatpark-${opts.wtId}`
  try {
    const store = deps.store()
    const existing = store.get(id)
    const rec: SessionRecord = {
      id,
      projectKey: projectKey(opts.repoRoot),
      projectRoot: opts.repoRoot,
      projectName: basename(opts.repoRoot) || opts.repoRoot,
      startedAt: existing?.startedAt ?? Date.now(),
      endedAt: Date.now(),
      branch: opts.branch,
      filesTouched: opts.files.length ? opts.files : (existing?.filesTouched ?? []),
      transcript: opts.transcript?.length ? opts.transcript : (existing?.transcript ?? []),
      kind: 'comment',
      title: existing?.title ?? opts.title
    }
    store.save(rec)
    return id
  } catch {
    return null // history is non-critical
  }
}

/** Persist (or refresh) the park record a live PARKED chat surfaces in the sidebar,
 *  carrying the last turn's transcript into the review UI. */
export function upsertParkRecord(
  st: ChatState,
  files: string[],
  transcript: SessionTranscriptEntry[] = []
): void {
  const id = saveParkRecord({
    wtId: st.wt.id,
    repoRoot: st.liveRoot,
    branch: st.wt.branch,
    files,
    transcript,
    title: 'Unmerged chat changes'
  })
  if (id) st.parkRecordId = id
}

/** Drop a chat's park record once its work merges (or on discard). */
export function dropParkRecord(st: ChatState): void {
  const deps = chatDeps()
  if (!deps || !st.parkRecordId) return
  try {
    deps.store().remove(st.parkRecordId)
  } catch {
    /* history is non-critical */
  }
  st.parkRecordId = null
}

/**
 * Leave the park: the chat holds no unlanded, interrupted, reverted or resolving work
 * any more, and its park record is dropped. The only place `parked` becomes false.
 * A record exists only while parked, so dropping it is a no-op for a chat that was not.
 */
export function clearPark(st: ChatState): void {
  st.parked = false
  st.interrupted = false
  st.reverted = false
  st.parkedFiles = []
  st.resolvingFiles = null
  dropParkRecord(st)
}

/** Persist a recovery park record for a chat worktree reclaimed after a crash (the
 *  chat is no longer live). `filesTouched` is read from the branch's cumulative diff. */
async function recoveryParkRecord(repoRoot: string, wtId: string, branch: string): Promise<void> {
  const files = await gitOut(repoRoot, ['diff', '--name-only', `${branch}^..${branch}`])
    .then((o) =>
      o
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    )
    .catch(() => [] as string[])
  saveParkRecord({ wtId, repoRoot, branch, files, title: 'Recovered chat changes' })
}

/**
 * Does a persisted `chatpark-<id>` record exist for this worktree id? Passed to
 * `pruneOrphans` so its recovery fold only fires on branches that were actually PARKED
 * (tip = cumulative parked squash). A branch whose tip is instead a previously-MERGED
 * turn (baseSha having advanced to it) has NO park record, so it isn't folded — folding
 * there would splice already-live content into the recovery commit, making the record's
 * Apply re-apply merged changes and surface spurious 3-way conflicts.
 */
export function hasParkRecord(wtId: string): boolean {
  const deps = chatDeps()
  if (!deps) return false
  try {
    return !!deps.store().get(`chatpark-${wtId}`)
  } catch {
    return false
  }
}

/** Is every file a branch changed already identical in the live tree? True means the
 *  turn was merged before the crash (safe to drop the leftover branch); false means it
 *  holds genuinely unmerged work that must be recovered, not deleted. */
async function branchAlreadyLive(repoRoot: string, branch: string): Promise<boolean> {
  const patch = await branchPatch(repoRoot, branch)
  if (!patch.trim()) return true // no pending diff — nothing to lose
  let names: string[]
  try {
    names = (await gitOut(repoRoot, ['diff', '--name-only', `${branch}^..${branch}`]))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return false
  }
  for (const rel of names) {
    let want: string
    try {
      want = await gitOut(repoRoot, ['show', `${branch}:${rel}`])
    } catch {
      return false // deleted/renamed by the turn — treat as unmerged
    }
    let live = ''
    try {
      live = await readFile(join(repoRoot, rel), 'utf8')
    } catch {
      live = '' // not on disk — unmerged new file
    }
    if (live !== want) return false
  }
  return true
}

/**
 * Crash recovery for chat worktrees reclaimed by `pruneOrphans` (called from
 * `agent:open-project`). For each reclaimed `trezi/chat-*` or legacy `praxis/chat-*`
 * orphan, keyed to its OWN repo
 * (which may differ from the project being opened — the worktrees dir is shared):
 *  - dirty → a crashed-mid-turn chat: surface its work via a recovery park record.
 *  - clean + already recorded → a persisted park: keep its record + branch untouched.
 *  - clean + unrecorded → usually a merged chat's leftover branch (delete it), BUT a
 *    crash between commit and merge leaves a clean branch holding a real unmerged turn;
 *    only delete when its diff is already live, else recover it (never eat the work).
 * Comment-spawn orphans are ignored here (their pre-existing prune behavior stands).
 */
export async function handleReclaimed(
  reclaimed: Array<{ id: string; dirty: boolean; branch: string | null; repoRoot: string | null }>
): Promise<void> {
  const deps = chatDeps()
  if (!deps) return
  for (const r of reclaimed) {
    if (!r.branch || !/^(trezi|praxis)\/chat-/.test(r.branch) || !r.repoRoot) continue
    if (r.dirty) {
      await recoveryParkRecord(r.repoRoot, r.id, r.branch)
      continue
    }
    if (deps.store().get(`chatpark-${r.id}`)) continue // a persisted park — leave it
    if (await branchAlreadyLive(r.repoRoot, r.branch)) {
      await deleteBranch(r.repoRoot, r.branch, 'integrated')
    } else {
      await recoveryParkRecord(r.repoRoot, r.id, r.branch)
    }
  }
}
