import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { OwnedWorktree, RepositoryOwner } from '../main/repository-owner'
import type { ServiceFailure } from '../shared/service-contract/types'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  reply?: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface RepositoryLink {
  sendService(frame: object): void
  on(event: 'service-reply', listener: (message: ServiceMessage) => void): unknown
}

export class RepositoryServiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** A lease this async call chain holds. */
interface Held {
  id: string
  root: string
}

/**
 * Bun's client for the Swift repository coordinator (S07). Every Git effect goes to
 * the service, which runs it in the repository's FIFO lane. `withLease` is the
 * service form of `enqueueRepoWrite`: the lane stays held while Bun's own steps run,
 * and requests made inside it (tracked per async chain) run in that lease instead of
 * queueing behind it. A nested lease on the same repository is re-entrant.
 *
 * Operations may wait behind a long install in their lane, so their timeout is long;
 * an acquire never times out (a lease granted after Bun gave up would hold the lane
 * forever). A timeout or failure rejects: Bun never runs the Git effect itself.
 */
export function serviceRepository(
  link: RepositoryLink,
  options: { timeout?: number } = {}
): RepositoryOwner {
  const connection = randomUUID()
  const timeout = options.timeout ?? 15 * 60_000
  const held = new AsyncLocalStorage<Held[]>()
  const pending = new Map<
    number,
    { resolve: (value: Result) => void; timer?: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0

  link.on('service-reply', (message) => {
    if (message.service !== 'repository' || !message.reply) return
    const request = pending.get(message.id ?? -1)
    if (!request) return
    if (request.timer) clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message.reply.result)
  })

  const call = (
    method: string,
    body: Record<string, unknown>,
    mode: 'read' | 'mutation' = 'mutation',
    limit: number | null = timeout
  ): Promise<any> => {
    const id = ++sequence
    return new Promise<Result>((resolve, reject) => {
      const timer =
        limit === null
          ? undefined
          : setTimeout(() => {
              pending.delete(id)
              reject(
                new RepositoryServiceError(
                  'deadlineExceeded',
                  `The Trezi service did not answer the repository request (${method}) in time.`
                )
              )
            }, limit)
      pending.set(id, { resolve, timer })
      link.sendService({
        service: 'repository',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode,
          service: 'repository',
          method,
          body
        }
      })
    }).then((result) => {
      if (result.kind === 'succeeded') return result.payload
      throw new RepositoryServiceError(result.payload.code, result.payload.message)
    })
  }
  /** A lane operation; runs inside a lease this chain holds on the same repository. */
  const effect = (method: string, body: Record<string, unknown>) => {
    const leases = (held.getStore() ?? []).map((lease) => lease.id)
    return call(method, leases.length ? { ...body, leases } : body)
  }
  const tree = (wt: OwnedWorktree): OwnedWorktree => ({
    id: wt.id,
    repoRoot: wt.repoRoot,
    path: wt.path,
    branch: wt.branch,
    baseSha: wt.baseSha
  })
  const on = (wt: OwnedWorktree) => ({ root: wt.repoRoot, worktree: tree(wt) })

  return {
    async withLease(root, operation) {
      const chain = held.getStore() ?? []
      const grant = await call(
        'acquire',
        chain.length ? { root, held: chain.map((lease) => lease.id) } : { root },
        'mutation',
        null
      )
      if (grant.reentrant) return operation()
      try {
        return await held.run([...chain, { id: grant.lease, root }], operation)
      } finally {
        // A stopping service releases every lease itself; the operation's own outcome wins.
        await call('release', { lease: grant.lease }).catch(() => {})
      }
    },
    heldLeases: () => (held.getStore() ?? []).map((lease) => lease.id),
    createWorktree: (root, worktreesDir, opts) =>
      effect('createWorktree', { root, worktreesDir, ...opts }),
    syncWorktree: (wt) => effect('syncWorktree', on(wt)),
    attachBranch: async (wt) => {
      await effect('attachBranch', on(wt))
    },
    retireBranch: async (wt) => {
      await effect('retireBranch', on(wt))
    },
    commitWorktree: (wt, message) => effect('commitWorktree', { ...on(wt), message }),
    autoApply: (wt, files) => effect('autoApply', { ...on(wt), files, intent: 'land' }),
    completeTurn: (wt, message, land, keepHistory) =>
      effect('completeTurn', {
        ...on(wt),
        message,
        intent: land ? 'land' : 'park',
        ...(keepHistory ? { keepHistory } : {})
      }),
    applyParked: (wt) => effect('applyParked', { ...on(wt), intent: 'land' }),
    applyBranch: (root, branch) => effect('applyBranch', { root, branch, intent: 'land' }),
    stageResolve: (wt) => effect('stageResolve', { ...on(wt), intent: 'reconcile' }),
    gitSyncBase: (wt, ref) => effect('gitSyncBase', { ...on(wt), ref, intent: 'sync' }),
    gitMergeContinue: (wt) => effect('gitMergeContinue', { ...on(wt), intent: 'continue' }),
    gitMergeAbort: (wt) => effect('gitMergeAbort', { ...on(wt), intent: 'abort' }),
    discardParked: async (wt) => {
      await effect('discardParked', { ...on(wt), intent: 'discard' })
    },
    removeWorktree: async (wt, keepBranch, intent) => {
      await effect('removeWorktree', { ...on(wt), keepBranch, intent })
    },
    reclaimWorktree: (wt) => effect('reclaimWorktree', { ...on(wt), intent: 'idle' }),
    deleteBranch: async (root, branch, intent) => {
      await effect('deleteBranch', { root, branch, intent })
    },
    pruneOrphans: (root, worktreesDir, skip, parked) =>
      effect('pruneOrphans', { root, worktreesDir, skip, parked, intent: 'recover' }),
    pruneBranches: (root, protectedIds) =>
      effect('pruneBranches', { root, protected: protectedIds, intent: 'integrated' }),
    removeLegacyFolder: async (directory) =>
      (await effect('removeLegacyFolder', { root: directory, intent: 'legacy' })).removed,
    commitLive: (root, files, title, body, mergeParent) =>
      effect('commitLive', {
        root,
        files,
        title,
        ...(body ? { body } : {}),
        ...(mergeParent ? { mergeParent } : {})
      }),
    checkout: (root, branch) => effect('checkout', { root, branch }),
    switchBranch: (root, branch) => effect('switchBranch', { root, branch }),
    strandedLandings: (root) => call('strandedLandings', { root }, 'read', 60_000),
    restoreLandings: (root, branch, tip) =>
      effect('restoreLandings', { root, branch, tip, intent: 'restore' }),
    status: () => call('status', {}, 'read', 30_000),
    recoveryRefs: (roots) => call('recoveryRefs', { roots }, 'read', 60_000),
    deleteRecoveryRefs: (root, refs) =>
      effect('deleteRecoveryRefs', {
        root,
        refs: refs.map((item) => item.ref),
        shas: refs.map((item) => item.sha),
        intent: 'discard'
      })
  }
}
