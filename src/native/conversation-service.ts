import { randomUUID } from 'node:crypto'
import { ConversationError, type ConversationOwner } from '../main/conversation-owner'
import type { ServiceFailure } from '../shared/service-contract/types'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  reply?: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface ConversationLink {
  sendService(frame: object): void
  on(event: 'service-reply', listener: (message: ServiceMessage) => void): unknown
}

/**
 * Bun's client for the Swift conversation coordinator (S11). Requests are decided in
 * the order they are written. Every call that carries a chat's record also carries a
 * per-chat sequence number, so the owner never lets an older record replace a newer
 * one. A failure rejects with the owner's code; Bun never decides a transition itself.
 */
export function serviceConversation(
  link: ConversationLink,
  options: { timeout?: number } = {}
): ConversationOwner {
  const connection = randomUUID()
  const timeout = options.timeout ?? 60_000
  const pending = new Map<
    number,
    { resolve: (value: Result) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const sequences = new Map<string, number>()
  let sequence = 0

  link.on('service-reply', (message) => {
    if (message.service !== 'conversation' || !message.reply) return
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message.reply.result)
  })

  const call = (
    method: string,
    body: Record<string, unknown>,
    mode: 'read' | 'mutation' = 'mutation'
  ): Promise<any> => {
    const id = ++sequence
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new ConversationError(
            'deadlineExceeded',
            `The Trezi service did not answer the conversation request (${method}) in time.`
          )
        )
      }, timeout)
      pending.set(id, { resolve, timer })
      link.sendService({
        service: 'conversation',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode,
          service: 'conversation',
          method,
          body
        }
      })
    }).then((result) => {
      if (result.kind === 'succeeded') return result.payload
      throw new ConversationError(result.payload.code, result.payload.message)
    })
  }
  /** The next record version of a chat (fresh on open). */
  const next = (chat: string, fresh = false) => {
    const value = (fresh ? 0 : (sequences.get(chat) ?? 0)) + 1
    sequences.set(chat, value)
    return value
  }
  // JSON drops `undefined`, as the pipe does; records travel as plain data.
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))

  return {
    kind: 'swift',
    save: async (record, current = false) => {
      await call('save', current ? { record: plain(record), current } : { record: plain(record) })
    },
    remove: async (id) => {
      await call('remove', { id })
    },
    rename: (id, title) => call('rename', { id, title }),
    open: async (chat, project, record, agentOptions, active) => {
      await call('open', {
        chat,
        project,
        root: record.projectRoot,
        record: plain(record),
        options: plain(agentOptions),
        active,
        sequence: next(chat, true)
      })
    },
    activate: async (chat) => {
      await call('activate', { chat })
    },
    checkpoint: async (chat, record) =>
      (await call('checkpoint', { chat, record: plain(record), sequence: next(chat) })).accepted,
    close: async (chat, persist, record) => {
      const result = await call('close', {
        chat,
        persist,
        record: plain(record),
        sequence: next(chat)
      })
      sequences.delete(chat)
      return result
    },
    configure: async (chat, agentOptions) => {
      await call('configure', { chat, options: plain(agentOptions) })
    },
    handoff: async (chat, agentOptions, record, reason) => {
      await call('handoff', {
        chat,
        options: plain(agentOptions),
        record: plain(record),
        sequence: next(chat),
        reason
      })
    },
    begin: async (chat, turn) => {
      await call('begin', { chat, turn })
    },
    send: (chat, turn, entry) => call('send', { chat, turn, entry: plain(entry) }),
    abort: async (chat, turn) => (await call('abort', { chat, turn })).aborted,
    cancel: (chat) => call('cancel', { chat }),
    terminal: (chat, turn, run, kind, record) =>
      call('terminal', { chat, turn, run, kind, record: plain(record), sequence: next(chat) }),
    continueTurn: async (chat, turn, run) =>
      (await call('continue', { chat, turn, run })).continued,
    landed: (chat, turn, at) => call('landed', { chat, turn, at }),
    title: (chat, title, source) => call('title', { chat, title, source }),
    register: async (chat, id, kind, tool) => {
      await call('register', { chat, id, kind, tool })
    },
    resolve: async (id, kind) => (await call('resolve', { id, kind })).chat,
    mode: async (chat, mode) => (await call('mode', { chat, mode })).allow,
    release: async (chat) => (await call('release', { chat })).release,
    spawn: async (id, project) => (await call('spawn', { id, project })).start,
    spawnDone: async (id) => (await call('spawnDone', { id })).start,
    spawnCancel: async (id) => (await call('spawnCancel', { id })).queued,
    snapshot: () => call('snapshot', {}, 'read'),
    status: () => call('status', {}, 'read')
  }
}
