import { randomUUID } from 'node:crypto'
import type { Revision, ServiceFailure } from '../shared/service-contract/types'
import {
  canonicalPreference,
  type NativePreferences,
  type PreferenceBatch,
  resolveBatch
} from './preferences'

/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface PreferencesLink {
  sendService(frame: object): void
  on(event: 'service-reply' | 'service-event', listener: (message: ServiceMessage) => void): unknown
}
interface Snapshot {
  revision: Revision
  digest: string
  entries: { key: string; value: string | null }[]
}
type Result = { kind: 'succeeded'; payload: unknown } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  name?: string
  snapshot?: Snapshot
  reply: { result: Result }
}

export class PreferencesServiceError extends Error {
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
 * Preferences owned by the Swift service (S03). Reads use the last acknowledged
 * snapshot; each batch is sent with that snapshot's revision and resolves only
 * after the service has committed it. Batches are sent one at a time. A timeout,
 * conflict or failure rejects — there is no local fallback write, ever.
 */
export async function servicePreferences(
  link: PreferencesLink,
  timeout = 30_000
): Promise<NativePreferences> {
  const connection = randomUUID()
  const pending = new Map<
    number,
    {
      resolve: (value: { result: Result }) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const listeners = new Set<() => void>()
  let sequence = 0
  let current: Snapshot | undefined
  let values: Record<string, string | null> = Object.create(null)
  let queue: Promise<unknown> = Promise.resolve()

  const install = (snapshot: Snapshot | undefined) => {
    if (!snapshot || !newer(snapshot.revision, current?.revision)) return false
    current = snapshot
    values = Object.create(null)
    for (const { key, value } of snapshot.entries) values[key] = value
    return true
  }
  // Late replies (after a timeout) and events still move the mirror forward.
  link.on('service-reply', (message) => {
    if (message.service !== 'preferences') return
    install(message.snapshot)
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve({ result: message.reply.result })
  })
  link.on('service-event', (message) => {
    if (message.service !== 'preferences' || message.name !== 'preferences.changed') return
    if (install(message.snapshot)) for (const listener of listeners) listener()
  })

  const request = (method: 'snapshot' | 'set', body: object, expectedRevision?: Revision) => {
    const id = ++sequence
    return new Promise<{ result: Result }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new PreferencesServiceError(
            'deadlineExceeded',
            'Preferences were not saved: the Trezi service did not answer. Nothing was written locally.'
          )
        )
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      link.sendService({
        service: 'preferences',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode: method === 'set' ? 'mutation' : 'read',
          ...(expectedRevision ? { expectedRevision } : {}),
          service: 'preferences',
          method,
          body
        }
      })
    })
  }
  const settled = ({ result }: { result: Result }) => {
    if (result.kind === 'succeeded') return result.payload
    const { code, message } = result.payload
    throw new PreferencesServiceError(
      code,
      code === 'conflict'
        ? `Preferences changed outside Trezi, so this change was not saved. Try again. (${message})`
        : message
    )
  }

  install(settled(await request('snapshot', {})) as Snapshot)
  const store: NativePreferences = {
    snapshot: () => ({ ...values }),
    get: (key) => values[canonicalPreference(key)] ?? null,
    apply(batch: PreferenceBatch) {
      const run = queue.then(async () => {
        const entries = resolveBatch(batch, values)
        settled(
          await request(
            'set',
            { entries: entries.map(([key, value]) => ({ key, value })) },
            current!.revision
          )
        )
      })
      queue = run.catch(() => {})
      return run
    },
    set: (key, value) => store.apply([[key, value]]),
    subscribe: (listener) => {
      listeners.add(listener)
    }
  }
  return store
}
