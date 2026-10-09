import { randomUUID } from 'node:crypto'
import {
  MAX_PROJECT_MEMORY_CHARS,
  normalizeProjectMemory,
  type ProjectMemory,
  ProjectMemoryError,
  type ProjectMemoryStore
} from '../main/project-memory'
import type { Revision, ServiceFailure } from '../shared/service-contract/types'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface Snapshot {
  revision: Revision
  digest: string
  content: string
  updatedAt: number
}
interface ServiceMessage {
  service?: string
  id?: number
  snapshot?: Snapshot
  reply: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface ProjectMemoryLink {
  sendService(frame: object): void
  on(event: 'service-reply', listener: (message: ServiceMessage) => void): unknown
}

/** A request body the service would refuse; checked before anything leaves Bun. */
const MAX_BODY = 64_000

/**
 * Project memory owned by the Swift service (S05). Every read asks the service,
 * so an edit made by another owner or outside Trezi is never shadowed by a cache.
 * Requests go one at a time. A manual `save` is an intent (the user's text), so a
 * `conflict` from an evaluation or adopted edit committed in between is retried on
 * the newer revision, at most twice. A `propose` names the revision it was
 * evaluated against and resolves `null` when that is stale. A timeout or failure
 * rejects: Bun never writes a memory file itself under the Swift owner.
 */
export function serviceProjectMemory(
  link: ProjectMemoryLink,
  timeout = 30_000
): ProjectMemoryStore {
  const connection = randomUUID()
  const pending = new Map<
    number,
    {
      resolve: (value: ServiceMessage) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let sequence = 0
  let queue: Promise<unknown> = Promise.resolve()

  link.on('service-reply', (message) => {
    if (message.service !== 'memory') return
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message)
  })

  const request = (
    method: 'read' | 'save' | 'propose',
    body: object,
    expectedRevision?: Revision
  ) => {
    const id = ++sequence
    return new Promise<ServiceMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new ProjectMemoryError(
            'deadlineExceeded',
            'Project memory was not saved: the Trezi service did not answer. Nothing was written locally.'
          )
        )
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      link.sendService({
        service: 'memory',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode: method === 'read' ? 'read' : 'mutation',
          ...(expectedRevision ? { expectedRevision } : {}),
          service: 'memory',
          method,
          body
        }
      })
    })
  }
  const settled = ({ reply: { result } }: ServiceMessage) => {
    if (result.kind === 'succeeded') return result.payload
    throw new ProjectMemoryError(result.payload.code, result.payload.message)
  }
  const conflict = ({ reply: { result } }: ServiceMessage) =>
    result.kind === 'failed' && result.payload.code === 'conflict'
  const memory = (value: Snapshot): ProjectMemory => ({
    content: value.content,
    updatedAt: value.updatedAt,
    digest: value.digest,
    revision: value.revision
  })
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job)
    queue = run.catch(() => {})
    return run
  }
  const valid = (root: string, content?: string) => {
    if (typeof root !== 'string' || !root.startsWith('/') || root.length > 4096)
      throw new ProjectMemoryError(
        'invalidRequest',
        'Project memory needs an absolute project root.'
      )
    if (content !== undefined && (typeof content !== 'string' || content.length > MAX_BODY)) {
      throw new ProjectMemoryError(
        'invalidRequest',
        `Project memory is limited to ${MAX_PROJECT_MEMORY_CHARS.toLocaleString('en-US')} characters.`
      )
    }
  }
  const read = async (root: string): Promise<ProjectMemory> =>
    memory(settled(await request('read', { root })))
  /** The reply carries the committed record; it is read back only if it could not. */
  const committed = async (root: string, message: ServiceMessage): Promise<ProjectMemory> => {
    const payload = settled(message),
      snapshot = message.snapshot
    return snapshot && snapshot.digest === payload.digest ? memory(snapshot) : read(root)
  }

  return {
    get: async (root) => {
      valid(root)
      return serial(() => read(root))
    },
    save: async (root, content) => {
      valid(root, content)
      return serial(async () => {
        for (let attempt = 0; ; attempt++) {
          const base = await read(root)
          const result = await request('save', { root, content }, base.revision)
          // An evaluation or adopted edit moved the revision; the user's text still wins.
          if (conflict(result) && attempt < 2) continue
          return committed(root, result)
        }
      })
    },
    propose: async (root, base, content) => {
      valid(root, content)
      if (!normalizeProjectMemory(content))
        throw new ProjectMemoryError('invalidRequest', 'A proposal cannot erase project memory.')
      if (!base.revision)
        throw new ProjectMemoryError(
          'invalidRequest',
          'A proposal needs the revision it was evaluated against.'
        )
      return serial(async () => {
        const result = await request('propose', { root, content }, base.revision)
        return conflict(result) ? null : committed(root, result)
      })
    },
    // Undo is a save on the update's own revision, never retried: once anything
    // else moved memory on, there is nothing left to undo.
    restore: async (root, after, content) => {
      valid(root, content)
      if (!after.revision)
        throw new ProjectMemoryError('invalidRequest', 'Undo needs the revision it reverts.')
      return serial(async () => {
        const result = await request('save', { root, content }, after.revision)
        return conflict(result) ? null : committed(root, result)
      })
    }
  }
}
