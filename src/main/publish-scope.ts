import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * "What has this session changed, and is there anything to publish?" — the git
 * questions `annotations.ts`'s publish paths ask.
 *
 * Split out of `annotations.ts` purely so it's unit-testable: that module imports
 * `electron`, which a bun test can't load. Pure (child_process + git only).
 *
 * The answers stopped being "diff vs HEAD" when Trezi started committing every turn
 * on the live checkout (`live-commit.ts`): a session whose turns all landed has a
 * SPOTLESS working tree and all its work in commits, so a HEAD-relative diff reports
 * nothing changed and publish would refuse. Scope is measured against the default
 * branch instead.
 */

const execFileP = promisify(execFile)

const git = async (root: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileP('git', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}

/** The repo's default branch (main/master) from origin/HEAD; `main` when it isn't set. */
export async function defaultBase(root: string): Promise<string> {
  try {
    return (
      (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(
        /^origin\//,
        ''
      ) || 'main'
    )
  } catch {
    return 'main' // origin/HEAD not set — assume main
  }
}

/** How many commits HEAD is ahead of the default branch (local ref first, then the
 *  remote-tracking one). 0 when neither resolves — e.g. a repo never pushed anywhere. */
export async function aheadOfBase(root: string, base: string): Promise<number> {
  for (const ref of [base, `origin/${base}`]) {
    try {
      const n = Number(await git(root, ['rev-list', '--count', `${ref}..HEAD`]))
      if (Number.isFinite(n)) return n
    } catch {
      /* ref doesn't exist here — try the next one */
    }
  }
  return 0
}

/**
 * Tracked files this branch changed — COMMITTED work included. Diffs against the merge
 * base with the default branch, two-dot (i.e. vs the WORKING TREE) so uncommitted edits
 * still count, and falls back to HEAD when there's no base to compare against (no
 * origin, unborn branch, or the checkout IS the base branch). Clean paths — no porcelain
 * quoting or rename arrows.
 */
export async function changedSince(root: string): Promise<string[]> {
  const flags = ['-c', 'core.quotePath=false', 'diff', '--name-only']
  let out: string
  try {
    const mergeBase = await git(root, ['merge-base', 'HEAD', await defaultBase(root)])
    out = await git(root, [...flags, mergeBase])
  } catch {
    out = await git(root, [...flags, 'HEAD'])
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}
