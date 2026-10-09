import { treziLiveEffect } from './live-change-watch'
import { repositoryOwner } from './repository-owner'

/**
 * One live checkout has one git index and one HEAD, even when many Trezi chats have
 * private worktrees. All operations that snapshot or mutate that live checkout must
 * therefore pass through one repository-scoped queue. Per-chat queues are not enough:
 * two different chats can otherwise both stage/commit through the same live index.
 *
 * The queue is the service's repository lane (S07): one FIFO per repository common
 * directory, shared by the live checkout and all its worktrees, and the same lane the
 * service's own Git effects run in.
 *
 * What an operation changes in the live checkout is Trezi's own effect, never reported
 * as an outside change by a running turn's watch (`live-change-watch.ts`, LKM-215).
 */
export function enqueueRepoWrite<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  return repositoryOwner().withLease(repoRoot, () => treziLiveEffect(repoRoot, operation))
}
