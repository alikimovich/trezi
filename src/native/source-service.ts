import { randomUUID } from 'node:crypto'
import type { SourceOwner } from '../main/source-owner'
import type { ServiceFailure } from '../shared/service-contract/types'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  reply?: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface SourceLink {
  sendService(frame: object): void
  on(event: 'service-reply', listener: (message: ServiceMessage) => void): unknown
}

export class SourceServiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/**
 * Bun's client for the Swift source transaction service (S08/S09). Writes run in the
 * repository's lane; `leases` names the repository leases this async chain holds
 * (from the repository client), so a write made inside `enqueueRepoWrite` runs in
 * that lease instead of queueing behind it. A timeout or failure rejects: Bun never
 * writes the file itself.
 */
export function serviceSource(
  link: SourceLink,
  options: { timeout?: number; leases?: () => string[] } = {}
): SourceOwner {
  const connection = randomUUID()
  const timeout = options.timeout ?? 15 * 60_000
  const pending = new Map<
    number,
    { resolve: (value: Result) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0

  link.on('service-reply', (message) => {
    if (message.service !== 'source' || !message.reply) return
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message.reply.result)
  })

  // A lane write carries its deadline, so the service never starts one Bun gave up on;
  // Bun waits a little longer than that for the service's own refusal.
  const grace = 5_000
  const call = (
    method: string,
    body: Record<string, unknown>,
    mode: 'read' | 'mutation' = 'mutation',
    deadline = false
  ): Promise<any> => {
    const id = ++sequence
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id)
          reject(
            new SourceServiceError(
              'deadlineExceeded',
              `The Trezi service did not answer the source request (${method}) in time.`
            )
          )
        },
        deadline ? timeout + grace : timeout
      )
      pending.set(id, { resolve, timer })
      link.sendService({
        service: 'source',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode,
          service: 'source',
          method,
          body,
          ...(deadline ? { timeoutMilliseconds: timeout } : {})
        }
      })
    }).then((result) => {
      if (result.kind === 'succeeded') return result.payload
      throw new SourceServiceError(result.payload.code, result.payload.message)
    })
  }
  /** A write in the repository's lane, or inside a lease this chain holds. */
  const effect = (method: string, body: Record<string, unknown>) => {
    const leases = options.leases?.() ?? []
    return call(method, leases.length ? { ...body, leases } : body, 'mutation', true)
  }
  const optional = (values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined && value !== false)
    )

  return {
    read: (root, path) => call('read', { root, path }, 'read'),
    commit: (root, edits, opts = {}) => effect('commit', { root, edits, ...optional(opts) }),
    record: async (root, edits, opts = {}) => {
      await call('record', { root, edits, ...optional(opts) })
    },
    undo: (root) => effect('undo', { root }),
    redo: (root) => effect('redo', { root }),
    revert: (root, group) => effect('revert', { root, group, intent: 'revert' }),
    canRevert: async (root, group) => (await call('canRevert', { root, group }, 'read')).revertable,
    history: (root) => call('history', { root }, 'read'),
    clearHistory: async (root) => {
      await call('clearHistory', { root })
    },
    createFile: (root, path) => effect('createFile', { root, path }),
    renameFile: (root, from, to) => effect('renameFile', { root, path: from, to }),
    deleteFile: (root, path) => effect('deleteFile', { root, path, intent: 'trash' }),
    drafts: (root) => call('drafts', { root }, 'read'),
    saveDraft: async (root, path, base, text) => {
      await call('saveDraft', { root, path, base, text })
    },
    clearDraft: async (root, path) => {
      await call('clearDraft', { root, path })
    },
    status: () => call('status', {}, 'read')
  }
}
