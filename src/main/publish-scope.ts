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

/** History only; prefer the fetched remote tip over a potentially stale local base. */
export async function aheadOfBase(root: string, base: string): Promise<number> {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    try {
      const n = Number(await git(root, ['rev-list', '--count', `${ref}..HEAD`]))
      if (Number.isFinite(n)) return n
    } catch {
      /* ref doesn't exist here — try the next one */
    }
  }
  return 0
}

/** Files introduced since the fork whose current content is absent from the base tip.
 * Intersecting both diffs excludes later changes made only on main and files whose
 * branch changes were already integrated by squash or cherry-pick. */
export async function changedSince(root: string): Promise<string[]> {
  const flags = ['-c', 'core.quotePath=false', 'diff', '--name-only']
  const base = await defaultBase(root)
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`, 'HEAD']) {
    try {
      const fork = await git(root, ['merge-base', ref, 'HEAD'])
      const changed = await git(root, [...flags, fork])
      const stillDifferent = new Set((await git(root, [...flags, ref])).split('\n'))
      return changed
        .split('\n')
        .map((l) => l.trim())
        .filter((path) => path && stillDifferent.has(path))
    } catch {
      /* Try the next available ref. */
    }
  }
  return []
}
