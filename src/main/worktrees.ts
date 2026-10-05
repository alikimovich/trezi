import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { readdir } from 'fs/promises'
import { promisify } from 'util'
import { editingOwner } from './editing-owner'
import { normalizeBranchName } from './git'
import { type RemoveIntent, repositoryOwner } from './repository-owner'
import { provisionDependencies } from './worktree-dependencies'

/**
 * Git-worktree management for F1 (comment → parallel agent session). Each spawned
 * comment agent runs in its OWN `git worktree` on a `trezi/comment-<id>` branch — a
 * private on-disk checkout that shares the repo's object store — so N comments edit
 * the repo truly in parallel with zero cross-writes, and the user's live preview
 * (which stays on the main working tree) is undisturbed until they accept one.
 *
 * The service's repository owner performs every Git effect (S07, `RepositoryGit.swift`
 * and `RepositoryEffects.swift`): snapshots, `worktree add`/`remove`, commits, applies
 * and prunes, each in the repository's lane. This module keeps the reads, the setup
 * helpers and dependencies a new worktree needs, and the path rules.
 */

const execFileP = promisify(execFile)
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const SAFE_ENV_TEMPLATES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.defaults'
])

/** Paths that belong to the machine/tooling, not to an agent turn. */
export function excludedWorktreePath(raw: string): boolean {
  const rel = raw.replaceAll('\\', '/').replace(/^\.\//, '')
  const parts = rel.split('/').filter(Boolean)
  if (parts.includes('node_modules')) return true
  if (parts[0] === '.trezi' || parts[0] === '.praxis' || parts[0] === '.dsgn') return true
  const name = parts.at(-1) ?? ''
  if (name.endsWith('.tsbuildinfo')) return true
  if (name === '.env') return true
  return name.startsWith('.env.') && !SAFE_ENV_TEMPLATES.has(name)
}

const git = (
  cwd: string,
  args: string[],
  timeout = 15000
): Promise<{ stdout: string; stderr: string }> =>
  execFileP('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }) as Promise<{
    stdout: string
    stderr: string
  }>

export interface Worktree {
  /** Short unique id; also the worktree directory name and the branch suffix. */
  id: string
  repoRoot: string
  /** The on-disk checkout (under worktreesDir). */
  path: string
  /** `trezi/comment-<id>`. */
  branch: string
  /** The commit the worktree forked from (main-tree HEAD + any uncommitted WIP). */
  baseSha: string
}

/**
 * Create a fresh worktree forked from the main tree's CURRENT state — including the
 * interactive agent's uncommitted WIP (tracked + untracked). The service snapshots and
 * adds the worktree in the repository's lane and links .env; node_modules is the
 * worktree's own (a copy-on-write clone or an install, `provisionDependencies`).
 */
export async function createWorktree(
  repoRoot: string,
  worktreesDir: string,
  opts: { label?: string; id?: string; branchName?: (id: string) => string } = {}
): Promise<Worktree> {
  const owner = repositoryOwner()
  // The id may be assigned up front (so a queued spawn's rail row keeps a stable id
  // before its worktree exists); otherwise generate one.
  const id = opts.id ?? randomUUID().slice(0, 8)
  const branch = normalizeBranchName((opts.branchName ?? ((i) => `comment-${i}`))(id))
  // Never a link to the live node_modules: an install in the chat would change it (LKM-146).
  const wt = await owner.createWorktree(repoRoot, worktreesDir, {
    id,
    branch,
    linkNodeModules: false
  })
  try {
    await editingOwner().syncSetupHelpers(repoRoot, wt.path)
    await provisionDependencies(repoRoot, wt.path)
  } catch (error) {
    await owner.removeWorktree(wt, false, 'abandon').catch(() => {})
    throw error
  }
  return wt
}

/**
 * Stage + commit everything the spawn changed in its worktree as one commit off the
 * fork point (commits the agent made itself are squashed in), so the run leaves a
 * durable branch. Returns whether anything was committed (an empty diff → no commit)
 * and the authoritative list of files it touched (from git, not a tool heuristic).
 */
export function commitWorktree(
  wt: Worktree,
  message: string
): Promise<{ committed: boolean; files: string[] }> {
  return repositoryOwner().commitWorktree(wt, message)
}

/**
 * The spawn's net change read back from its branch AFTER the worktree is gone (v8 F1
 * Phase 2 — Apply/PR). A spawn makes exactly one commit on top of its WIP-snapshot
 * base, so `<branch>^..<branch>` is precisely the spawn's edits (excluding the base
 * WIP, which is already in the live tree). Empty if the branch is missing.
 */
export async function branchPatch(repoRoot: string, branch: string): Promise<string> {
  try {
    return (await git(repoRoot, ['diff', '--full-index', '--binary', `${branch}^..${branch}`]))
      .stdout
  } catch {
    return ''
  }
}

/** Delete a spawn's branch (v8 F1 Phase 2 — Discard). Never throws. `integrated`
 *  means the caller verified the branch's change is already live; a `discard` keeps
 *  a recovery ref. */
export async function deleteBranch(
  repoRoot: string,
  branch: string,
  intent: 'discard' | 'integrated' = 'discard'
): Promise<void> {
  try {
    await repositoryOwner().deleteBranch(repoRoot, branch, intent)
  } catch {
    /* never throws */
  }
}

export interface ChatBranchPruneResult {
  deleted: string[]
  preserved: string[]
}

/**
 * Remove redundant branch-only leftovers from completed chat turns: local
 * `trezi/chat-*` refs whose tip is already on the live branch (a chat's live commit
 * has a different SHA, so the service compares patch ids). Parked refs named by
 * `isProtected`, refs checked out in any worktree and unique tips are kept; no age or
 * name heuristic can delete work. Complements `pruneOrphans`, which recovers checkout
 * directories. Never throws.
 */
export async function pruneIntegratedChatBranches(
  repoRoot: string,
  isProtected: (id: string) => boolean = () => false
): Promise<ChatBranchPruneResult> {
  // The ids are read here only to evaluate `isProtected`; the service decides and deletes.
  const refs = await git(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/trezi/chat-*',
    'refs/heads/praxis/chat-*'
  ]).then(
    ({ stdout }) =>
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    () => [] as string[]
  )
  const protectedIds = refs
    .map((branch) => branch.replace(/^(trezi|praxis)\/chat-/, ''))
    .filter((id) => id && isProtected(id))
  try {
    return await repositoryOwner().pruneBranches(repoRoot, protectedIds)
  } catch {
    return { deleted: [], preserved: [] }
  }
}

/**
 * Re-create and attach a chat's ephemeral branch before a turn can edit its worktree.
 * Successful turns retire the branch immediately; attaching at the next turn boundary
 * keeps crash recovery durable while avoiding one permanent branch per idle chat.
 */
export function attachWorktreeBranch(wt: Worktree): Promise<void> {
  return repositoryOwner().attachBranch(wt)
}

/**
 * Detach a clean/landed worktree and delete its now-redundant branch. The worktree
 * remains available as the session cwd; `attachWorktreeBranch` recreates the branch
 * before the next turn. Parked branches never call this helper.
 */
export function retireWorktreeBranch(wt: Worktree): Promise<void> {
  return repositoryOwner().retireBranch(wt)
}

/** Does this branch exist locally? */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Explicitly apply a spawn branch's own change (`branch^..branch`) onto the live
 * checkout: a plain apply, else a 3-way apply that may leave conflict markers for the
 * user to resolve. `empty` when the branch holds no change.
 */
export async function applyBranchToWorkingTree(
  repoRoot: string,
  branch: string
): Promise<{ ok: boolean; conflict: boolean; empty?: boolean; error?: string }> {
  try {
    return await repositoryOwner().applyBranch(repoRoot, branch)
  } catch (e) {
    return { ok: false, conflict: false, error: msg(e) }
  }
}

/**
 * Auto-apply a finished spawn's change straight onto the LIVE working tree as plain
 * file writes (v8 F1 redesign) — so a comment lands on the branch the user works in,
 * with no separate branch / PR / manual Apply, and is undoable via Cmd+Z. Each live
 * file must be unchanged since the spawn forked or already at the target; otherwise
 * the WHOLE batch is refused so nothing is clobbered, and the caller keeps the branch
 * for the manual review fallback. Text only. Returns the before/after pairs for the
 * undo history.
 */
export function autoApplyWorktree(
  parentRoot: string,
  wt: Worktree,
  files: string[]
): Promise<{ applied: boolean; edits: { file: string; before: string; after: string }[] }> {
  return repositoryOwner().autoApply({ ...wt, repoRoot: parentRoot }, files)
}

/**
 * Tear down a worktree: remove its checkout and (unless `keepBranch`) delete its
 * branch. Never throws — teardown runs in finalizers. `keepBranch` is set when the
 * spawn committed real work (the branch is the durable record for PR/Apply/Discard).
 * `intent` says why: `landed` (HEAD's change is on the live tree), `release` (the
 * kept branch holds the work) or `abandon` (the default). Any dirty or unlanded work
 * gets a recovery ref before the checkout goes.
 */
export async function removeWorktree(
  repoRoot: string,
  wt: Worktree,
  opts: { keepBranch?: boolean; intent?: RemoveIntent } = {}
): Promise<void> {
  try {
    await repositoryOwner().removeWorktree(
      { ...wt, repoRoot },
      !!opts.keepBranch,
      opts.intent ?? (opts.keepBranch ? 'release' : 'abandon')
    )
  } catch {
    /* never throws */
  }
}

/**
 * Idle cleanup (LKM-136): removes a clean, idle chat checkout and retires its branch.
 * A checkout with meaningful uncommitted work stays where it is; the service copies
 * that work to an `idle-<id>` recovery ref (once per distinct tree). Never throws.
 */
export async function reclaimWorktree(
  repoRoot: string,
  wt: Worktree
): Promise<{ removed: boolean; dirty: boolean; ref: string | null }> {
  try {
    return await repositoryOwner().reclaimWorktree({ ...wt, repoRoot })
  } catch {
    return { removed: false, dirty: false, ref: null }
  }
}

/** Removes an old-name worktree folder that orphan recovery emptied (and its empty
 *  old-name parent). False when anything is left in it or the service refused. */
export async function removeLegacyFolder(directory: string): Promise<boolean> {
  try {
    return await repositoryOwner().removeLegacyFolder(directory)
  } catch {
    return false
  }
}

/**
 * Startup recovery: a crash/quit can leave checkouts in worktreesDir whose admin
 * entries git no longer tracks. The service prunes stale entries, commits any dirty
 * work of each leftover to its branch (folded into the parked squash when the chat was
 * PARKED, so `branch^..branch` stays the full pending diff) and removes the checkout.
 * `skip` names ids that are CURRENTLY ACTIVE — never touched. Returns each reclaimed id
 * with `dirty`, its `branch` and owning `repoRoot` (for the crash-recovery records).
 * Never throws.
 */
export async function pruneOrphans(
  repoRoot: string,
  worktreesDir: string,
  skip: Set<string> = new Set(),
  /** True when a persisted `chatpark-<id>` record exists for this worktree id. */
  isParked: (id: string) => boolean = () => false
): Promise<Array<{ id: string; dirty: boolean; branch: string | null; repoRoot: string | null }>> {
  const ids = await readdir(worktreesDir).catch(() => [] as string[])
  try {
    return await repositoryOwner().pruneOrphans(
      repoRoot,
      worktreesDir,
      [...skip],
      ids.filter((id) => !skip.has(id) && isParked(id))
    )
  } catch {
    return []
  }
}
