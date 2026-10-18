import { randomUUID } from 'node:crypto'
import type { Revision, ServiceFailure } from '../shared/service-contract/types'
import {
  SKILLS_GITHUB_LIMITS,
  SKILLS_METHOD_MODES,
  SKILLS_SERVICE,
  type SkillBody,
  type SkillFileChange,
  type SkillFileInput,
  type SkillGitHubImport,
  type SkillGitHubInput,
  type SkillMutation,
  type SkillProjection,
  type SkillProviderName,
  type SkillProviders,
  type SkillReference,
  type SkillSnapshot,
  type SkillsList,
  type SkillsMethod,
  type SkillsMethods
} from '../shared/skills-registry'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  snapshot?: SkillsList
  reply: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface SkillsLink {
  sendService(frame: object): void
  on(event: 'service-reply', listener: (message: ServiceMessage) => void): unknown
}

export class SkillsError extends Error {
  constructor(
    readonly code: ServiceFailure['code'],
    message: string
  ) {
    super(message)
    this.name = 'SkillsError'
  }
}

/** A mutation's answer with the registry as committed after it. */
export interface SkillsChange extends SkillMutation {
  list: SkillsList | null
}

/**
 * A session start's bounds for one call. `admit`: how long it may wait for its turn in
 * the queue; when that passes first it is dropped unsent and rejects `busy`. `wait`:
 * how long the service has to answer once it is sent (the client's default otherwise).
 */
export interface SkillsCallOptions {
  admit?: number
  wait?: number
}

/** The registry as Bun sees it: every call is answered by the Swift service. */
export interface SkillsRegistry {
  list(): Promise<SkillsList>
  read(skill: string, options?: { revision?: string; session?: string }): Promise<SkillBody>
  reference(skill: string, revision: string, path: string): Promise<SkillReference>
  pins(session: string): Promise<SkillSnapshot>
  create(files: SkillFileInput[]): Promise<SkillsChange>
  importFolder(folder: string): Promise<SkillsChange>
  edit(skill: string, base: string, changes: SkillFileChange[]): Promise<SkillsChange>
  setEnabled(skill: string, enabled: boolean): Promise<SkillsChange>
  setProviders(skill: string, providers: SkillProviders): Promise<SkillsChange>
  remove(skill: string): Promise<SkillsChange>
  restore(skill: string): Promise<SkillsChange>
  purge(skill: string): Promise<SkillsChange>
  snapshot(session: string, options?: SkillsCallOptions): Promise<SkillSnapshot>
  release(session: string): Promise<{ session: string; released: boolean }>
  /** LKM-287: the session's pins (created once) laid out read-only for `provider`. */
  project(
    session: string,
    provider: SkillProviderName,
    options?: SkillsCallOptions
  ): Promise<SkillProjection>
  /** GitHub import (LKM-285): resolves, downloads and checks in the service, then installs. */
  importGitHub(
    input: SkillGitHubInput,
    options?: { signal?: AbortSignal }
  ): Promise<SkillGitHubImport & { list: SkillsList | null }>
}

/**
 * The Skills registry owned by the Swift service (LKM-284). Bun holds no copy and
 * writes nothing: a timeout or failure rejects with the service's code. Requests go
 * one at a time. A ledger mutation is an intent: when another change advanced the
 * registry revision in between (`conflict` naming `currentRevision`), it is sent
 * again on that revision, at most twice. Any other `conflict` (an edit whose base is
 * no longer the skill's revision, a taken name) is the caller's to resolve.
 */
export function serviceSkills(link: SkillsLink, timeout = 30_000): SkillsRegistry {
  const connection = randomUUID()
  const pending = new Map<
    number,
    { resolve: (value: ServiceMessage) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0
  let queue: Promise<unknown> = Promise.resolve()
  let known: Revision | null = null

  link.on('service-reply', (message) => {
    if (message.service !== SKILLS_SERVICE) return
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message)
  })

  const send = (
    method: SkillsMethod,
    body: object,
    expectedRevision?: Revision,
    { operationID = randomUUID(), wait = timeout } = {}
  ) => {
    const id = ++sequence
    return new Promise<ServiceMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new SkillsError(
            'deadlineExceeded',
            'Skills did not answer: the Trezi service did not reply. Nothing was changed locally.'
          )
        )
      }, wait)
      pending.set(id, { resolve, timer })
      link.sendService({
        service: SKILLS_SERVICE,
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID,
          scope: {},
          mode: SKILLS_METHOD_MODES[method] === 'read' ? 'read' : 'mutation',
          ...(expectedRevision ? { expectedRevision } : {}),
          service: SKILLS_SERVICE,
          method,
          body
        }
      })
    })
  }
  const settled = ({ reply: { result } }: ServiceMessage) => {
    if (result.kind === 'succeeded') return result.payload
    throw new SkillsError(result.payload.code, result.payload.message)
  }
  /**
   * One request in flight, first come first served (the Swift owner is serial too). A
   * job given `admit` that is still waiting for its turn after that long rejects `busy`
   * and is skipped when its turn comes: it is never sent, and the jobs behind it keep
   * their order. An idle queue admits at once, whatever `admit` is.
   */
  const serial = <T>(job: () => Promise<T>, admit?: number): Promise<T> => {
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const turn = queue.then(() => {
      clearTimeout(timer)
      return expired ? undefined : job()
    })
    queue = turn.catch(() => {})
    if (admit === undefined) return turn as Promise<T>
    return new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true
        reject(
          new SkillsError('busy', 'Skills were busy with earlier requests; this one was not sent.')
        )
      }, admit)
      turn.then((value) => resolve(value as T), reject)
    })
  }
  const call = <M extends SkillsMethod>(
    method: M,
    body: SkillsMethods[M]['body'],
    { admit, wait = timeout }: SkillsCallOptions = {}
  ): Promise<SkillsMethods[M]['result']> =>
    serial(async () => settled(await send(method, body, undefined, { wait })), admit)
  const list = async (): Promise<SkillsList> => {
    const value = settled(await send('list', {})) as SkillsList
    known = value.revision
    return value
  }
  const mutate = <M extends SkillsMethod>(method: M, body: SkillsMethods[M]['body']) =>
    serial(async (): Promise<SkillsChange> => {
      let revision = known ?? (await list()).revision
      for (let attempt = 0; ; attempt++) {
        const message = await send(method, body, revision)
        const { result } = message.reply
        const current = result.kind === 'failed' ? result.payload.currentRevision : undefined
        if (current && result.payload.code === 'conflict' && attempt < 2) {
          revision = current
          continue
        }
        const payload = settled(message) as SkillMutation
        known = message.snapshot?.revision ?? payload.revision
        return { ...payload, list: message.snapshot ?? null }
      }
    })
  // Not queued: a fetch can take minutes and the service answers it out of order, so
  // reads and edits keep flowing. Aborting sends `cancel`; the import still answers
  // (`cancelled`, or its result when it was already committing).
  const importGitHub = async (
    input: SkillGitHubInput,
    { signal }: { signal?: AbortSignal } = {}
  ): Promise<SkillGitHubImport & { list: SkillsList | null }> => {
    const operation = randomUUID()
    const abort = () => {
      send('cancel', { operation }).catch(() => {})
    }
    if (signal?.aborted)
      throw new SkillsError('cancelled', 'The import was cancelled. Nothing was installed.')
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const message = await send('github', input, undefined, {
        operationID: operation,
        wait: Math.max(timeout, (SKILLS_GITHUB_LIMITS.deadlineSeconds + 30) * 1000)
      })
      const payload = settled(message) as SkillGitHubImport
      if (message.snapshot) known = message.snapshot.revision
      return { ...payload, list: message.snapshot ?? null }
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  return {
    list: () => serial(list),
    read: (skill, options = {}) => call('read', { skill, ...options }),
    reference: (skill, revision, path) => call('reference', { skill, revision, path }),
    pins: (session) => call('pins', { session }),
    create: (files) => mutate('create', { files }),
    importFolder: (folder) => mutate('import', { folder }),
    edit: (skill, base, changes) => mutate('edit', { skill, base, changes }),
    setEnabled: (skill, enabled) => mutate('enable', { skill, enabled }),
    setProviders: (skill, providers) => mutate('providers', { skill, providers }),
    remove: (skill) => mutate('remove', { skill }),
    restore: (skill) => mutate('restore', { skill }),
    purge: (skill) => mutate('purge', { skill }),
    snapshot: (session, options) => call('snapshot', { session }, options),
    release: (session) => call('release', { session }),
    project: (session, provider, options) => call('project', { session, provider }, options),
    importGitHub
  }
}
