import { repositoryOwner } from './repository-owner'
import { excludedWorktreePath } from './worktrees'

/**
 * Per-turn commits on the LIVE checkout.
 *
 * A chat's work is committed on its own `trezi/chat-<id>` worktree branch, but the
 * merge back onto the live tree is a plain file WRITE (`autoApplyWorktree`) — so
 * without this the user's own checkout just accumulated one giant uncommitted diff
 * until Publish. That makes a single turn impossible to review or roll back with git.
 * After every turn that actually changed something, `commitLiveTurn` lands those exact
 * files as one commit on whatever branch the live checkout is on, so `git log` reads as
 * the session's progress and any turn can be undone with `git revert`.
 *
 * Deliberately narrow, because this writes into the user's repo:
 *  - only the files the turn itself touched are staged (never `add -A`), so concurrent
 *    hand edits elsewhere stay uncommitted and a revert can't take them with it;
 *  - the commit is a PATHSPEC (partial) commit, so anything the user had staged for
 *    their own commit is left staged and untouched;
 *  - the trezi-managed `.trezi/` sidecar is never committed (same rule as
 *    `commitWorktree`);
 *  - only inside a git repo ROOT — for a subdirectory project, committing would sweep
 *    up the enclosing repo, which is exactly the surprise `isRepoRoot` exists to avoid;
 *  - best-effort: any git failure (mid-merge partial commit, hooks, missing identity)
 *    returns `committed: false` and never throws. A failed commit just leaves the
 *    change in the working tree.
 *
 * The service's repository owner makes the commit (S07); this module shapes it.
 */

/** Longest commit SUBJECT we write — keeps `git log --oneline` readable. */
const MAX_TITLE = 72

/** One line, collapsed whitespace, capped. A chat landing's subject describes the
 *  change (`chat-commit.ts`, LKM-189), never the user's prompt. */
export function commitTitle(message: string): string {
  const line = (message ?? '').split('\n')[0].replace(/\s+/g, ' ').trim()
  if (!line) return 'Trezi chat edit'
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line
}

/** Repo-relative paths this module is willing to commit: no trezi sidecar, no dupes. */
export function committableFiles(files: string[]): string[] {
  const seen = new Set<string>()
  for (const raw of files) {
    const rel = (raw ?? '').trim()
    if (!rel || excludedWorktreePath(rel)) continue
    seen.add(rel)
  }
  return [...seen]
}

export interface LiveCommit {
  committed: boolean
  /** The new HEAD when we committed. */
  sha?: string
  /** The files that actually went into the commit (empty when nothing was committed). */
  files: string[]
}

/**
 * Commit the files a finished turn changed onto the live checkout. `files` are
 * repo-relative (git's own staged list from `commitWorktree`, not a tool heuristic).
 * Returns `committed: false` — never throws — when there's nothing to commit, the
 * project isn't a git repo root, or git refuses.
 */
export async function commitLiveTurn(
  root: string,
  files: string[],
  message: { title: string; body?: string }
): Promise<LiveCommit> {
  const paths = committableFiles(files)
  if (!paths.length) return { committed: false, files: [] }
  // A pathspec commit in the repository's lane; the service re-checks the paths.
  return repositoryOwner()
    .commitLive(root, paths, commitTitle(message.title), message.body)
    .catch(() => ({ committed: false, files: [] }))
}
