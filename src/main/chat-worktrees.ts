import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { editingOwner } from './editing-owner'
import { productLog } from './product-log'
import { repositoryOwner } from './repository-owner'
import { dependenciesInstalling, provisionDependencies } from './worktree-dependencies'
import { createWorktree, type Worktree } from './worktrees'

/**
 * Per-CHAT git-worktree isolation (v9). Generalizes the comment-spawn worktree
 * machinery (`worktrees.ts`) to interactive chats: every chat on a git repo root
 * runs in its own long-lived `trezi/chat-<id>` worktree, and after each completed
 * agent turn its work auto-merges back onto the LIVE checkout so the preview (which
 * always serves the live tree) updates between turns. On mid-turn drift the turn
 * parks on the branch for review instead of clobbering the user's edit.
 *
 * The service's repository owner performs every Git effect here (S07,
 * `RepositoryEffects.swift`); this module keeps the setup helpers and Next
 * dependencies, which stay JS, and the read-only checks `chat-isolation.ts` runs.
 *
 * Base-advance contract: git-state operations that MUST re-point the fork point
 * (`syncFromLive`, `stageResolve`) mutate `wt.baseSha` in place; turn/apply operations
 * return the new base as `newBase` and let the caller (`chat-isolation.ts`) own the
 * mutation, so the advance only happens on a successful merge/apply.
 */

const execFileP = promisify(execFile)

/** Binary-safe `git show <ref>:<path>` — `null` when the path didn't exist at that ref. */
const readBlobAt = async (cwd: string, ref: string, rel: string): Promise<Buffer | null> => {
  try {
    const res = (await execFileP('git', ['show', `${ref}:${rel}`], {
      cwd,
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer'
    })) as unknown as { stdout: Buffer }
    return res.stdout
  } catch {
    return null
  }
}

/** Git-style unresolved markers must never cross from a resolution worktree to live. */
export async function conflictMarkerFiles(wt: Worktree, files: string[]): Promise<string[]> {
  const marked: string[] = []
  for (const rel of files) {
    let text: string
    try {
      text = await readFile(join(wt.path, rel), 'utf8')
    } catch {
      continue
    }
    if (/^<<<<<<< .+$/m.test(text) && /^=======$/m.test(text) && /^>>>>>>> .+$/m.test(text)) {
      marked.push(rel)
    }
  }
  return marked
}

/**
 * Fork a fresh worktree for a chat on branch `trezi/chat-<id>`, forking from the live
 * tree's CURRENT state (uncommitted WIP included) — exactly like comment spawns, only
 * the branch-name scheme differs. A needed dependency install runs in the background
 * (LKM-182): the chat's turn can start and read or edit files meanwhile.
 */
export function createChatWorktree(
  liveRoot: string,
  id: string,
  worktreesDir: string
): Promise<Worktree> {
  return createWorktree(liveRoot, worktreesDir, {
    id,
    branchName: (i) => `chat-${i}`,
    backgroundInstall: true
  })
}

/**
 * Turn-start drift sync (live → worktree). The owner snapshots the live tree; when the
 * worktree's HEAD tree already matches there's no drift, otherwise it resets the clean
 * worktree onto the snapshot (sparing its runtime deps) and refreshes its own
 * node_modules when the synced manifests changed. Advances
 * `wt.baseSha` in place to the new fork point. `backgroundInstall` (a spare taken by a
 * new chat, LKM-182) leaves a needed install running; an install already running in
 * the checkout is never awaited or restarted here.
 */
export async function syncFromLive(
  liveRoot: string,
  wt: Worktree,
  opts: { backgroundInstall?: boolean } = {}
): Promise<{ synced: boolean }> {
  await editingOwner().syncSetupHelpers(liveRoot, wt.path)
  const { synced, baseSha } = await repositoryOwner().syncWorktree({ ...wt, repoRoot: liveRoot })
  if (synced) productLog.info('worktree', 'Worktree synced from the live tree', { worktree: wt.id })
  wt.baseSha = baseSha
  await provisionDependencies(liveRoot, wt.path, undefined, {
    background: opts.backgroundInstall || dependenciesInstalling(wt.path)
  })
  return { synced }
}

export interface TurnOutcome {
  outcome: 'noop' | 'merged' | 'parked'
  files: string[]
  edits: { file: string; before: string; after: string }[]
  /** Worktree HEAD after a merge — the caller advances `wt.baseSha` to it. */
  newBase?: string
}

/**
 * Turn-end commit + merge. The owner squashes the turn's work into one commit off
 * `baseSha` (successive parked turns re-squash into ONE cumulative commit, so the
 * branch is always the full pending diff), then auto-applies onto the live tree:
 *  - nothing committed            → `noop`
 *  - applied onto the live tree   → `merged` (+ `edits` for the undo history, `newBase`)
 *  - refused (live drifted), unresolved markers or `land: false` → `parked`
 *  - already at target (no write) → `noop`
 */
export async function completeTurn(
  liveRoot: string,
  wt: Worktree,
  message: string,
  opts: { land?: boolean; keepHistory?: boolean } = {}
): Promise<TurnOutcome> {
  return repositoryOwner().completeTurn(
    { ...wt, repoRoot: liveRoot },
    message,
    opts.land !== false,
    opts.keepHistory
  )
}

/** Automatic reconciliation only handles existing regular text files. Binary,
 * add/delete and symlink decisions retain the explicit review path. */
export async function canReconcileText(
  liveRoot: string,
  wt: Worktree,
  files: string[]
): Promise<boolean> {
  if (!files.length) return false
  for (const rel of files) {
    const base = await readBlobAt(wt.path, wt.baseSha, rel)
    if (!base || base.includes(0)) return false
    for (const root of [liveRoot, wt.path]) {
      try {
        if (!(await lstat(join(root, rel))).isFile()) return false
        if ((await readFile(join(root, rel))).includes(0)) return false
      } catch {
        return false
      }
    }
  }
  return true
}

export interface ApplyOutcome {
  ok: boolean
  conflict: boolean
  files: string[]
  /** Worktree HEAD when the apply landed cleanly — caller advances `wt.baseSha`. */
  newBase?: string
  error?: string
}

/**
 * Explicit user "Apply" of a PARKED chat: 3-way apply the branch's cumulative diff onto
 * the live tree (tolerates the user's uncommitted WIP; may leave conflict markers, which
 * is acceptable for an explicit action). On a clean apply, return `newBase` so the caller
 * advances the fork point and unparks.
 */
export async function applyParked(liveRoot: string, wt: Worktree): Promise<ApplyOutcome> {
  const result = await repositoryOwner().applyParked({ ...wt, repoRoot: liveRoot })
  const { ok, conflict, error } = result
  productLog.info('parking', 'Parked work applied', {
    worktree: wt.id,
    ok,
    conflict,
    files: result.files.length,
    error
  })
  return result
}

export interface ResolvePrep {
  /** Files left carrying `<<<<<<<` conflict markers — the agent must reconcile these.
   *  Empty ⇒ the two sides merged with no textual overlap (no agent turn needed). */
  conflicted: string[]
  /** Every file the chat's branch touched (the resolution turn's blast radius). */
  files: string[]
  clean: boolean
}

/**
 * Prepare a PARKED chat's worktree for AI (or clean) conflict resolution. A park means
 * the user edited the same files live that the chat edited, so the auto-merge refused.
 * To let the agent reconcile BOTH sides it must SEE both: the owner resets the worktree
 * onto the user's current live tree, then re-lays the chat's own diff on top with a
 * 3-way apply — clean where the two didn't overlap, `<<<<<<<`/`>>>>>>>` markers where
 * they did; a binary file both sides changed keeps the chat's version. Advances
 * `wt.baseSha` to the live snapshot so the eventual merge-back is a clean, driftless
 * apply. Returns the marker-bearing files.
 */
export async function stageResolve(liveRoot: string, wt: Worktree): Promise<ResolvePrep> {
  // Setup helpers live under excluded `.trezi/` paths, so syncing them first never
  // makes the worktree look changed to the service's parked-state check.
  await editingOwner().syncSetupHelpers(liveRoot, wt.path)
  const { conflicted, files, clean, baseSha } = await repositoryOwner().stageResolve({
    ...wt,
    repoRoot: liveRoot
  })
  wt.baseSha = baseSha
  productLog.info('resolve', 'Resolve staged', {
    worktree: wt.id,
    clean,
    conflicted: conflicted.length,
    files: files.length
  })
  return { conflicted, files, clean }
}

/**
 * Explicit user "Discard" of a PARKED chat: reset the worktree back to its fork point
 * and drop any stray files. The branch is intentionally NOT deleted — the chat is still
 * live and its worktree keeps the branch checked out (a `git branch -D` would fail).
 */
export async function discardParked(wt: Worktree): Promise<void> {
  return repositoryOwner()
    .discardParked(wt)
    .then(
      () => productLog.info('parking', 'Parked work discarded', { worktree: wt.id }),
      (error) =>
        productLog.warn('parking', 'Discarding parked work failed', {
          worktree: wt.id,
          error: error instanceof Error ? error.message : String(error)
        })
    )
}
