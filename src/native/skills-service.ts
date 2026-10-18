import { randomUUID } from 'node:crypto'
import type { Revision, ServiceFailure } from '../shared/service-contract/types'
import {
  SKILLS_METHOD_MODES,
  SKILLS_SERVICE,
  type SkillBody,
  type SkillFileChange,
  type SkillFileInput,
  type SkillMutation,
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
  snapshot(session: string): Promise<SkillSnapshot>
  release(session: string): Promise<{ session: string; released: boolean }>
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

  const send = (method: SkillsMethod, body: object, expectedRevision?: Revision) => {
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
      }, timeout)
      pending.set(id, { resolve, timer })
      link.sendService({
        service: SKILLS_SERVICE,
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
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
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job)
    queue = run.catch(() => {})
    return run
  }
  const call = <M extends SkillsMethod>(
    method: M,
    body: SkillsMethods[M]['body']
  ): Promise<SkillsMethods[M]['result']> => serial(async () => settled(await send(method, body)))
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
    snapshot: (session) => call('snapshot', { session }),
    release: (session) => call('release', { session })
  }
}
