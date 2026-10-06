import { randomUUID } from 'node:crypto'
import { EditingError, type EditingOwner } from '../main/editing-owner'
import type { ServiceFailure } from '../shared/service-contract/types'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  reply?: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface EditingLink {
  sendService(frame: object): void
  on(event: 'service-reply', listener: (message: ServiceMessage) => void): unknown
}

/**
 * Bun's client for the Swift editing coordinator (S12). Requests are decided in the
 * order they are written. A sidecar commit runs in the repository's lane, inside the
 * leases this async chain holds (`leases`), and carries its deadline so the service
 * never starts one Bun gave up on. A failure rejects with the owner's code: Bun never
 * decides or writes itself.
 */
export function serviceEditing(
  link: EditingLink,
  options: { timeout?: number; leases?: () => string[] } = {}
): EditingOwner {
  const connection = randomUUID()
  const timeout = options.timeout ?? 60_000
  const pending = new Map<
    number,
    { resolve: (value: Result) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0

  link.on('service-reply', (message) => {
    if (message.service !== 'editing' || !message.reply) return
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message.reply.result)
  })

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
            new EditingError(
              'deadlineExceeded',
              `The Trezi service did not answer the editing request (${method}) in time.`
            )
          )
        },
        deadline ? timeout + grace : timeout
      )
      pending.set(id, { resolve, timer })
      link.sendService({
        service: 'editing',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode,
          service: 'editing',
          method,
          body,
          ...(deadline ? { timeoutMilliseconds: timeout } : {})
        }
      })
    }).then((result) => {
      if (result.kind === 'succeeded') return result.payload
      throw new EditingError(result.payload.code, result.payload.message)
    })
  }
  /** A project-file request runs in the leases this async chain holds. */
  const held = (body: Record<string, unknown>) => {
    const leases = options.leases?.() ?? []
    return leases.length ? { ...body, leases } : body
  }
  const present = (values: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null))
  // JSON drops `undefined`, as the pipe does; definitions travel as plain data.
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))

  return {
    kind: 'swift',
    islandsOpen: async (chat, root, record) =>
      (await call('islandsOpen', { chat, root, record })).records,
    islandsClose: async (chat) => {
      await call('islandsClose', { chat })
    },
    islands: async (chat) => (await call('islands', { chat }, 'read')).records,
    islandDefine: (chat, turn, origin, id, revision) =>
      call('islandDefine', present({ chat, turn, origin, id, revision })),
    islandCommit: async (chat, token, definition, engine, initial, fallback, name) =>
      (
        await call(
          'islandCommit',
          present({
            chat,
            token,
            definition: plain({ manifest: definition.manifest, blocks: definition.blocks }),
            engine,
            initial: plain(initial),
            fallback,
            name
          })
        )
      ).records,
    islandAbort: async (chat, token) => {
      await call('islandAbort', { chat, token })
    },
    // An absent `user` clears the user's state (Enable/Show).
    islandMark: async (chat, id, user) =>
      (await call('islandMark', present({ chat, id, user }))).records,
    islandHealth: async (chat, id, revision, health, reason, reasons) =>
      (
        await call(
          'islandHealth',
          present({ chat, id, revision, health, reason, reasons: reasons && plain(reasons) })
        )
      ).records,
    islandShow: async (chat, id, turn, origin) =>
      (await call('islandShow', present({ chat, id, turn, origin }))).records,
    islandSettle: (chat, turn, successful) =>
      call('islandSettle', present({ chat, turn, successful })),
    islandCommand: (chat, id, revision, action, sourceRevision) =>
      call('islandCommand', { chat, id, revision, action, sourceRevision }),
    islandFinish: async (chat, ticket, outcome, last) => {
      await call(
        'islandFinish',
        present({
          chat,
          ticket,
          ok: outcome.ok,
          group: outcome.group,
          revision: outcome.revision,
          last
        })
      )
    },
    navigate: async (chat, root, path, turn) =>
      (await call('navigate', present({ chat, root, path, turn }))).ready,
    navigation: async (chat, kind, turn) =>
      (await call('navigation', present({ chat, kind, turn }))).ready,
    navigationTake: async (chat) => {
      const taken = await call('navigationTake', { chat })
      return taken.path === null ? null : taken
    },
    navigationState: () => call('navigationState', {}, 'read'),
    sidecar: (root, name, expectedHash, content) => {
      const leases = options.leases?.() ?? []
      return call(
        'sidecar',
        { root, name, expectedHash, content, ...(leases.length ? { leases } : {}) },
        'mutation',
        true
      )
    },
    migrateSidecar: async (root) =>
      (await call('migrateSidecar', held({ root }), 'mutation', true)).collisions,
    legacyNames: (root) => call('legacyNames', held({ root }), 'mutation', true),
    migrateNames: (root, confirmed) =>
      call('migrateNames', held({ root, confirmed }), 'mutation', true),
    syncSetupHelpers: async (root, worktree) => {
      await call('syncSetupHelpers', held({ root, worktree }), 'mutation', true)
    },
    dependencyState: async (root, checkout) =>
      (await call('dependencyState', held({ root, checkout }), 'mutation', true)).install,
    markDependencies: async (root, checkout) => {
      await call('markDependencies', held({ root, checkout }), 'mutation', true)
    }
  }
}
