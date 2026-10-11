import { productLog } from '../product-log'
import { repositoryOwner, type StaleLockResult } from '../repository-owner'
import { classifyError } from './catalog'

/** A lock younger than this may belong to a Git that is still starting. */
export const STALE_LOCK_SECONDS = 30

/**
 * Asks the Swift repository owner to remove a stale `index.lock` in `root`. The owner
 * removes it only when it is older than `STALE_LOCK_SECONDS` and no Git process works in
 * the checkout; Bun never touches the file itself.
 */
export async function clearStaleGitLock(root: string): Promise<StaleLockResult | null> {
  try {
    const result = await repositoryOwner().clearStaleLock(root, STALE_LOCK_SECONDS)
    productLog.info('self-heal', 'Git lock checked', {
      code: 'git-lock',
      outcome: result.removed ? 'recovered' : result.reason,
      age: result.age ?? undefined
    })
    return result
  } catch {
    return null
  }
}

/**
 * Runs a Git effect; when it fails on a Git lock, clears a stale lock in any of `roots`
 * (the live checkout and the chat's worktree have separate indexes) and runs it once
 * more. A fresh lock or a live Git process leaves the original error untouched.
 * `declined` marks a result that is a silent refusal (the service's live commit reports
 * a Git failure as `committed: false`): its lock is checked the same way.
 */
export async function withGitLockRecovery<T>(
  roots: string[],
  run: () => Promise<T>,
  declined?: (result: T) => boolean
): Promise<T> {
  const clear = async (): Promise<boolean> => {
    let removed = false
    for (const root of roots)
      removed = ((await clearStaleGitLock(root))?.removed ?? false) || removed
    return removed
  }
  let result: T
  try {
    result = await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (classifyError(message).class !== 'git-lock' || !(await clear())) throw error
    return run()
  }
  return declined?.(result) && (await clear()) ? run() : result
}
