import { randomUUID } from 'node:crypto'
import type { Revision, ServiceFailure } from '../shared/service-contract/types'
import type { WorkspaceStore } from './workspace'
import { validateOperation, type WorkspaceOperation, type WorkspaceView } from './workspace-model'

interface Snapshot extends WorkspaceView {
  revision: Revision
  digest: string
}
type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  name?: string
  snapshot?: Snapshot
  reply: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface WorkspaceLink {
  sendService(frame: object): void
  on(event: 'service-reply' | 'service-event', listener: (message: ServiceMessage) => void): unknown
}

export class WorkspaceServiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

const newer = (next: Revision, current?: Revision) =>
  !current || next.epoch !== current.epoch || BigInt(next.counter) > BigInt(current.counter)

/**
 * The workspace owned by the Swift service (S04). Reads use the last acknowledged
 * snapshot. Operations go one at a time, each against the revision the previous
 * one committed, and resolve only once persisted. They are intents (open this
 * root, select this key), so a conflict from an adopted external edit is retried
 * as a new operation on the newer revision. A timeout or failure rejects: Bun
 * never writes workspace.json itself under the Swift owner.
 */
export async function serviceWorkspace(
  link: WorkspaceLink,
  timeout = 30_000
): Promise<WorkspaceStore> {
  const connection = randomUUID()
  const pending = new Map<
    number,
    {
      resolve: (value: Result) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const listeners = new Set<() => void>()
  let sequence = 0
  let current: Snapshot | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const install = (snapshot: Snapshot | undefined) => {
    if (!snapshot || !newer(snapshot.revision, current?.revision)) return false
    current = snapshot
    return true
  }
  // Late replies (after a timeout) and events still move the mirror forward.
  link.on('service-reply', (message) => {
    if (message.service !== 'workspace') return
    install(message.snapshot)
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message.reply.result)
  })
  link.on('service-event', (message) => {
    if (message.service !== 'workspace' || message.name !== 'workspace.changed') return
    if (install(message.snapshot)) for (const listener of listeners) listener()
  })

  const request = (method: string, body: object, expectedRevision?: Revision) => {
    const id = ++sequence
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new WorkspaceServiceError(
            'deadlineExceeded',
            'The workspace was not saved: the Trezi service did not answer. Nothing was written locally.'
          )
        )
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      link.sendService({
        service: 'workspace',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode: method === 'snapshot' ? 'read' : 'mutation',
          ...(expectedRevision ? { expectedRevision } : {}),
          service: 'workspace',
          method,
          body
        }
      })
    })
  }
  const settled = (result: Result) => {
    if (result.kind === 'succeeded') return result.payload
    throw new WorkspaceServiceError(result.payload.code, result.payload.message)
  }
  const run = (op: WorkspaceOperation) => {
    validateOperation(op)
    const { method, ...body } = op
    const job = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const result = await request(method, body, current!.revision)
        // An adopted external edit moved the revision; the intent still applies.
        if (result.kind === 'failed' && result.payload.code === 'conflict' && attempt < 2) continue
        return settled(result)
      }
    })
    queue = job.catch(() => {})
    return job
  }

  install(settled(await request('snapshot', {})))
  const view = (): WorkspaceView =>
    structuredClone({
      projects: current!.projects,
      activeKey: current!.activeKey,
      recents: current!.recents
    })
  return {
    snapshot: view,
    open: async (root, chatSettings) => {
      const result = await run({ method: 'open', root, ...(chatSettings ? { chatSettings } : {}) })
      return { key: result.key, created: result.created }
    },
    select: async (key) => {
      await run({ method: 'select', key })
    },
    close: async (key) => {
      await run({ method: 'close', key })
    },
    reorder: async (key, before) => {
      await run({ method: 'reorder', key, before })
    },
    update: async (projects) => {
      await run({ method: 'update', projects })
    },
    recent: async (root, name) => {
      await run({ method: 'recent', root, name })
    },
    subscribe: (listener) => {
      listeners.add(listener)
    }
  }
}
