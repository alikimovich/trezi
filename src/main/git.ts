import { execFile } from 'child_process'
import { realpath } from 'fs/promises'
import { promisify } from 'util'
import type { BranchResult } from '../shared/api'
import { enqueueRepoWrite } from './repo-write-queue'
import { repositoryOwner } from './repository-owner'

/**
 * Branch management for the opened project: trezi does its work on a `trezi/<…>`
 * branch so the user's main branch stays clean. Reads run Git here; every switch goes
 * through the service's repository owner (S07).
 */

const execFileP = promisify(execFile)
const TREZI_PREFIX = 'trezi/'
// Work branches created before the dsgn→trezi rename (2026-07). Recognized as
// ours (keep working on them, allow publish) but never created anymore.
const LEGACY_PREFIX = 'dsgn/'

/** Is this branch a Trezi work branch (current or legacy prefix)? */
export function isWorkBranch(branch: string): boolean {
  return (
    branch.startsWith('praxis/') ||
    branch.startsWith(TREZI_PREFIX) ||
    branch.startsWith(LEGACY_PREFIX)
  )
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const git = (root: string, args: string[], timeout = 8000): Promise<{ stdout: string }> =>
  execFileP('git', args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024 }) as Promise<{
    stdout: string
  }>

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const { stdout } = await git(root, ['rev-parse', '--is-inside-work-tree'])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Only manage the branch when the opened folder is the repo's TOP LEVEL — not a
 * subdirectory of a larger repo (e.g. a fixture inside this repo, or a package
 * in a monorepo), where switching the whole repo's branch would be surprising.
 */
export async function isRepoRoot(root: string): Promise<boolean> {
  // '' means "this folder IS the top level"; a path or null both mean it isn't.
  return (await enclosingRepoRoot(root)) === ''
}

/**
 * Which repository this folder actually belongs to, for explaining a refusal.
 *
 * Returns `''` when the folder IS the top level, the enclosing repo's path when
 * it's a subdirectory of one, and `null` when git can't see a repo at all. The
 * three cases need three different pieces of advice, and telling them apart is
 * the difference between "open the repo's top-level folder" (useless when the
 * user has never heard of that repo) and naming the path they should open — or
 * telling them there's no repo here and `git init` is the answer.
 */
export async function enclosingRepoRoot(root: string): Promise<string | null> {
  try {
    const { stdout } = await git(root, ['rev-parse', '--show-toplevel'])
    const top = stdout.trim()
    if (!top) return null
    return (await realpath(top)) === (await realpath(root)) ? '' : top
  } catch {
    return null
  }
}

/** Check out an EXISTING branch by its exact name (no trezi/ coercion) — for the
 *  titlebar branch switcher. Carries uncommitted changes across like git does. */
export async function checkoutBranch(root: string, branch: string): Promise<BranchResult> {
  // Only an existing local branch; the service refuses anything Git could read as a path.
  return repositoryOwner()
    .checkout(root, branch)
    .catch((e) => ({ isRepo: true, branch, created: false, error: msg(e) }))
}

/** Local branches (current first, then trezi/* newest-active, then the rest). */
export async function listBranches(
  root: string
): Promise<{ branches: string[]; current: string | null }> {
  try {
    const { stdout } = await git(root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads'
    ])
    const all = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const current = await getCurrentBranch(root)
    // Current first, then trezi/* (recent), then everything else.
    const rank = (b: string): number => (b === current ? 0 : isWorkBranch(b) ? 1 : 2)
    const branches = [...all].sort((a, b) => rank(a) - rank(b))
    return { branches, current }
  } catch {
    return { branches: [], current: null }
  }
}

export async function getCurrentBranch(root: string): Promise<string | null> {
  try {
    const { stdout } = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const b = stdout.trim()
    return b && b !== 'HEAD' ? b : null // null = detached HEAD
  } catch {
    return null
  }
}

/** Make a git-ref-safe `trezi/<…>` branch name from a requested name or bare suffix. */
export function normalizeBranchName(requested: string): string {
  const raw = requested.trim()
  const withPrefix = raw.startsWith(TREZI_PREFIX) ? raw : TREZI_PREFIX + raw
  const suffix = withPrefix
    .slice(TREZI_PREFIX.length)
    .replace(/[\s~^:?*[\]\\@{}]+/g, '-') // git-forbidden chars + whitespace → -
    .replace(/\.{2,}/g, '-') // no ".."
    .replace(/\/{2,}/g, '/') // collapse //
    .replace(/^[/.-]+|[/.-]+$/g, '') // trim leading/trailing / . -
  return TREZI_PREFIX + (suffix || 'work')
}

/** Switch to (creating if needed) a specific trezi/* branch. */
export async function switchBranch(root: string, requested: string): Promise<BranchResult> {
  const name = normalizeBranchName(requested)
  return repositoryOwner()
    .switchBranch(root, name)
    .catch(async (e) => ({
      isRepo: true,
      branch: await getCurrentBranch(root),
      created: false,
      error: msg(e)
    }))
}

/**
 * Ensure work happens on a `trezi/*` branch. If already on one, keep it; else
 * create `trezi/<current-branch>` (or `trezi/work` when detached) off HEAD.
 */
export async function ensureBranch(root: string): Promise<BranchResult> {
  // The read and the switch share one lease on the repository's lane.
  return enqueueRepoWrite(root, async () => {
    if (!(await isRepoRoot(root))) return { isRepo: false, branch: null, created: false }
    const cur = await getCurrentBranch(root)
    if (cur && isWorkBranch(cur)) return { isRepo: true, branch: cur, created: false }
    return switchBranch(root, TREZI_PREFIX + (cur ?? 'work'))
  })
}
