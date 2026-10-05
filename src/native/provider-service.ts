import { randomUUID } from 'node:crypto'
import { parseCodexModels } from '../main/model-catalog'
import type { ProviderDataOwner } from '../main/provider-data'
import { type HelperHandlers, ProviderError, type ProviderOwner } from '../main/provider-owner'
import { LIMITS, MESSAGES, permissionTarget, validImages } from '../main/provider-policy'
import type { ServiceFailure } from '../shared/service-contract/types'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  reply?: { result: Result }
  kind?: string
  session?: string
  [field: string]: unknown
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface ProviderLink {
  sendService(frame: object): void
  on(event: 'service-reply' | 'service-event', listener: (message: ServiceMessage) => void): unknown
}

/** A tool result larger than this is answered with an error rather than risk the pipe's line limit. */
const MAX_TOOL_RESULT = 16 * 1024 * 1024

/**
 * Bun's client for the Swift provider owner (S10). Requests are decided in the order
 * they are written. For a helper-hosted session the owner also pushes `service-event`
 * frames: validated events, record snapshots, the helper's exit, and Trezi tool calls
 * it already authorized, which Bun runs and answers (`provider-helper` frames).
 * `data` is the same connection's provider data client (`main/provider-data.ts`).
 */
export function serviceProvider(
  link: ProviderLink,
  options: { timeout?: number } = {}
): ProviderOwner & { data: ProviderDataOwner } {
  const connection = randomUUID()
  const timeout = options.timeout ?? 60_000
  const pending = new Map<
    number,
    { resolve: (value: Result) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const helpers = new Map<string, HelperHandlers>()
  let sequence = 0

  link.on('service-reply', (message) => {
    if (message.service !== 'provider' || !message.reply) return
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message.reply.result)
  })

  link.on('service-event', (message) => {
    if (message.service !== 'provider' || typeof message.session !== 'string') return
    const handlers = helpers.get(message.session)
    if (message.kind === 'tool' && typeof message.id === 'number') {
      const id = message.id
      const answer = (frame: { result?: unknown; error?: string }) =>
        link.sendService({ service: 'provider-helper', id, ...frame })
      if (!handlers || typeof message.tool !== 'string')
        return answer({ error: 'The provider session is closed.' })
      void Promise.resolve()
        .then(() => handlers.tool(message.tool as string, message.args))
        .then(
          (result) => {
            const size = JSON.stringify(result ?? null).length
            answer(
              size <= MAX_TOOL_RESULT
                ? { result: result ?? null }
                : { error: 'The tool result is too large.' }
            )
          },
          (error) => answer({ error: error instanceof Error ? error.message : String(error) })
        )
      return
    }
    if (!handlers) return
    if (message.kind === 'event' && message.value && typeof message.value === 'object')
      handlers.event(message.value as never)
    else if (message.kind === 'record' && message.record && typeof message.record === 'object')
      handlers.record(message.record as never)
    else if (message.kind === 'exit') {
      helpers.delete(message.session)
      handlers.exit(typeof message.reason === 'string' ? message.reason : 'stopped')
    }
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
          new ProviderError(
            'deadlineExceeded',
            `The Trezi service did not answer the provider request (${method}) in time.`
          )
        )
      }, timeout)
      pending.set(id, { resolve, timer })
      link.sendService({
        service: 'provider',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode,
          service: 'provider',
          method,
          body
        }
      })
    }).then((result) => {
      if (result.kind === 'succeeded') return result.payload
      throw new ProviderError(result.payload.code, result.payload.message)
    })
  }
  // JSON drops `undefined`, as the pipe does.
  const plain = <T>(value: T): T =>
    value === undefined ? value : JSON.parse(JSON.stringify(value))

  return {
    kind: 'swift',
    open: (grant) => call('open', { ...plain(grant) }),
    openHelper: async (grant, start, handlers) => {
      // Registered first: the helper may emit (its slash commands) before it is ready.
      helpers.set(grant.session, handlers)
      try {
        return await call('openHelper', {
          ...plain(grant),
          options: plain(start.options),
          context: plain(start.context)
        })
      } catch (error) {
        helpers.delete(grant.session)
        throw error
      }
    },
    // Only what the policy reads crosses the pipe (an edit's path, a command): a Write's
    // input carries the whole file. One too large to check is denied, never sent.
    permission: async (session, tool, input) => {
      const target = permissionTarget(tool, input)
      if (target !== undefined && target.length > LIMITS.permissionTarget)
        return { decision: 'deny', message: MESSAGES.targetTooLarge }
      return call(
        'permission',
        target === undefined ? { session, tool } : { session, tool, target }
      )
    },
    authorize: async (session, tool, args) => {
      await call('authorize', {
        session,
        tool,
        bytes: Buffer.byteLength(JSON.stringify(args ?? {}) ?? '')
      })
    },
    turn: async (session) => {
      await call('turn', { session })
    },
    send: async (session, text, images) => {
      // Checked here too: an oversized line would fail the private pipe closed.
      if (images?.length && !validImages(images))
        throw new ProviderError(
          'invalidRequest',
          'The pasted images are not supported or too large.'
        )
      if (text.length > LIMITS.sendText)
        throw new ProviderError('invalidRequest', 'The message is too long.')
      await call(
        'send',
        images?.length ? { session, text, images: plain(images) } : { session, text }
      )
    },
    cancel: (session) => call('cancel', { session }),
    settled: async (session) => {
      await call('settled', { session })
    },
    terminal: async (session, kind) => {
      await call('terminal', { session, kind })
    },
    resume: async (session, id, record) => {
      await call('resume', { session, id, record })
    },
    recover: async (record) => (await call('recover', { record }, 'read')).recovered ?? null,
    answer: async (session, id, kind, value) => {
      await call('answer', { session, id, kind, value: plain(value) ?? null })
    },
    configure: async (session, change) => {
      await call('configure', { session, ...plain(change) })
    },
    close: async (session) => {
      helpers.delete(session)
      await call('close', { session })
    },
    snapshot: () => call('snapshot', {}, 'read'),
    status: () => call('status', {}, 'read'),
    data: {
      kind: 'swift',
      save: async (input) => (await call('connectionSave', { input: plain(input) })).connection,
      remove: async (id) => {
        await call('connectionRemove', { id })
      },
      // An id the store could never hold has no key (and is not worth a round trip).
      secretFor: async (id) =>
        SAFE_ID.test(id) ? ((await call('connectionSecret', { id }, 'read')).secret ?? null) : null,
      saveCatalog: async (backend, models) =>
        (
          await call('catalogSave', {
            backend,
            models: models.map(({ id, label }) => ({ id, label }))
          })
        ).saved === true,
      codexModels: async () => {
        const { stdout } = await call('codexModels', {}, 'read')
        try {
          return typeof stdout === 'string' ? parseCodexModels(JSON.parse(stdout)) : []
        } catch {
          return []
        }
      },
      saveSeatToken: async (provider, token) =>
        (await call('seatTokenSave', { provider, token })).hasToken === true,
      seatTokenStatus: () => call('seatTokenStatus', {}, 'read'),
      checkLogin: async (provider, root) =>
        (await call('diagnose', { provider, root }, 'read')).report
    }
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
