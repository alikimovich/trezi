import type { BranchResult } from '../shared/api'

/**
 * The repository owner seam (S07). Under the Swift launch the service's repository
 * coordinator performs every Git effect Trezi makes in a user's repository, one FIFO
 * lane per repository common directory, with journaled intent and recovery refs;
 * the mutating functions in `worktrees.ts`, `chat-worktrees.ts`, `live-commit.ts` and
 * `git.ts` dispatch here. There is no other owner (LKM-111 removed the TS twin): without
 * the service a Git effect fails rather than running Git locally.
 */

/** Same shape as `Worktree` in worktrees.ts (kept here to avoid an import cycle). */
export interface OwnedWorktree {
  id: string
  repoRoot: string
  path: string
  branch: string
  baseSha: string
}

export interface OwnedEdit {
  file: string
  before: string
  after: string
}

/** Why a worktree is removed: its HEAD landed, its branch keeps the work, or it is abandoned. */
export type RemoveIntent = 'landed' | 'release' | 'abandon'

export interface RepositoryOwner {
  /** `enqueueRepoWrite` under the owner: holds the repository's lane for `operation`. */
  withLease<T>(root: string, operation: () => Promise<T>): Promise<T>
  /** The leases the calling async chain holds (S08 source writes run inside them). */
  heldLeases(): string[]
  createWorktree(
    root: string,
    worktreesDir: string,
    opts: { id: string; branch: string; linkNodeModules: boolean }
  ): Promise<OwnedWorktree>
  syncWorktree(wt: OwnedWorktree): Promise<{ synced: boolean; baseSha: string }>
  attachBranch(wt: OwnedWorktree): Promise<void>
  retireBranch(wt: OwnedWorktree): Promise<void>
  commitWorktree(
    wt: OwnedWorktree,
    message: string
  ): Promise<{ committed: boolean; files: string[] }>
  autoApply(wt: OwnedWorktree, files: string[]): Promise<{ applied: boolean; edits: OwnedEdit[] }>
  completeTurn(
    wt: OwnedWorktree,
    message: string,
    land: boolean,
    keepHistory?: boolean
  ): Promise<{
    outcome: 'noop' | 'merged' | 'parked'
    files: string[]
    edits: OwnedEdit[]
    newBase?: string
  }>
  applyParked(
    wt: OwnedWorktree
  ): Promise<{ ok: boolean; conflict: boolean; files: string[]; newBase?: string; error?: string }>
  applyBranch(
    root: string,
    branch: string
  ): Promise<{ ok: boolean; conflict: boolean; empty?: boolean; error?: string }>
  stageResolve(
    wt: OwnedWorktree
  ): Promise<{ conflicted: string[]; files: string[]; clean: boolean; baseSha: string }>
  /** Merge a fetched publish base into this chat branch, keeping both parents. */
  gitSyncBase(
    wt: OwnedWorktree,
    ref: string
  ): Promise<{ merged: boolean; conflicted: string[]; head: string }>
  gitMergeContinue(wt: OwnedWorktree): Promise<{ head: string }>
  gitMergeAbort(wt: OwnedWorktree): Promise<{ head: string }>
  discardParked(wt: OwnedWorktree): Promise<void>
  removeWorktree(wt: OwnedWorktree, keepBranch: boolean, intent: RemoveIntent): Promise<void>
  /** Idle cleanup: removes a clean checkout; a dirty one stays, its work at a recovery ref. */
  reclaimWorktree(
    wt: OwnedWorktree
  ): Promise<{ removed: boolean; dirty: boolean; ref: string | null }>
  deleteBranch(root: string, branch: string, intent: 'discard' | 'integrated'): Promise<void>
  pruneOrphans(
    root: string,
    worktreesDir: string,
    skip: string[],
    parked: string[]
  ): Promise<Array<{ id: string; dirty: boolean; branch: string | null; repoRoot: string | null }>>
  pruneBranches(
    root: string,
    protectedIds: string[]
  ): Promise<{ deleted: string[]; preserved: string[] }>
  /** An emptied old-name worktree folder (and its empty old-name parent); false when anything is left. */
  removeLegacyFolder(directory: string): Promise<boolean>
  commitLive(
    root: string,
    files: string[],
    title: string,
    body?: string,
    mergeParent?: string
  ): Promise<{ committed: boolean; sha?: string; files: string[] }>
  checkout(root: string, branch: string): Promise<BranchResult>
  switchBranch(root: string, branch: string): Promise<BranchResult>
  /** Other local branches holding landed chat commits the checkout lacks (LKM-185, read only). */
  strandedLandings(root: string): Promise<StrandedLandings>
  /** Explicit user intent: merges `branch`, still at `tip`, into the checked-out branch. */
  restoreLandings(root: string, branch: string, tip: string): Promise<RestoredLandings>
  /** Operations a previous service left unfinished, with the recovery refs that hold their work. */
  status(): Promise<RepositoryStatus>
  /** The recovery refs in `roots` and in the journal's repositories (read only). */
  recoveryRefs(roots: string[]): Promise<RecoveryRepository[]>
  /** Explicit user intent: deletes refs still at the commit the user saw. */
  deleteRecoveryRefs(
    root: string,
    refs: { ref: string; sha: string }[]
  ): Promise<{ deleted: string[]; kept: string[] }>
}

export interface RepositoryJournalEntry {
  operationID: string
  kind: string
  intent: string
  lane: string
  root: string
  worktree?: string
  branch?: string
  refs: string[]
  started: string
  /** When a launch closed (reported) this interrupted entry. */
  resolved?: string
}

export interface RepositoryStatus {
  active: RepositoryJournalEntry[]
  interrupted: RepositoryJournalEntry[]
  /** Closed at this launch and reported only now: journaled refs not in the repository are `missing`. */
  recovered: Array<RepositoryJournalEntry & { missing: string[]; unreadable?: boolean }>
  /** Open entries of an older journal, closed without a new report (they were reported at every earlier launch). */
  closedEarlier: number
  journal?: string
}

export interface StrandedLandings {
  current: string | null
  branches: Array<{ branch: string; tip: string; count: number }>
}

export interface RestoredLandings {
  merged: boolean
  files: string[]
  conflictFiles: string[]
  recoveryRefs: string[]
}

export interface RecoveryRepository {
  root: string
  refs: Array<{ ref: string; sha: string; date: string; subject: string }>
}

let owner: RepositoryOwner | null = null

/** Installed once by the native entry point when the Swift service is supervising Bun. */
export function setRepositoryOwner(next: RepositoryOwner | null): void {
  owner = next
}

/** The installed Swift owner; without the service there is none, and no Git effect runs. */
export function repositoryOwner(): RepositoryOwner {
  if (!owner)
    throw new Error('Trezi’s service is not running, so the repository cannot be changed.')
  return owner
}
