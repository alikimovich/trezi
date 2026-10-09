import { createHash, randomUUID } from 'node:crypto'
import { type MediaGrant, PlatformError, type PlatformOwner } from '../main/platform-owner'
import type { ImageAttachment, SimElementPick } from '../shared/api'
import { FRAME_ASPECT, FRAME_DATA_URI, FRAME_INSET } from '../shared/iphone-frame'
import type { ServiceFailure } from '../shared/service-contract/types'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  kind?: string
  line?: string
  source?: string | null
  tag?: string
  reply?: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface PlatformLink {
  sendService(frame: object): void
  on(event: 'service-reply' | 'service-event', listener: (message: ServiceMessage) => void): unknown
}

const TIMEOUTS: Record<string, number> = {
  status: 10_000,
  simulatorPreflight: 90_000,
  simulatorStart: 10 * 60_000,
  simulatorStop: 30_000,
  simulatorSelect: 10_000,
  mediaGrant: 60_000,
  mediaResolve: 15_000,
  attachmentOpen: 15_000,
  attachmentChunk: 15_000,
  attachmentCommit: 30_000,
  servers: 120_000,
  serverStop: 60_000,
  openLink: 45_000,
  openFile: 45_000,
  openInEditor: 60_000
}
const READS = new Set(['status', 'simulatorPreflight', 'mediaResolve', 'servers'])
/** The service's cap on a pasted image, as the legacy writer's. */
const MAX_ATTACHMENT = 25 * 1024 * 1024
/** Raw bytes per upload chunk; far below the pipe's line limit once base64-encoded. */
const CHUNK = 1024 * 1024
/** Grants the editor refreshed, so later renders of the same document use the new token. */
const MAX_ALIASES = 200

/**
 * Bun's client for the Swift platform owner (S14). Bun never runs the simulator tools,
 * serves the bridge, reads a media file for the editor, writes an attachment or
 * signals a server itself under the Swift launch: a request that fails or times out
 * rejects (or, for an attachment, answers '' as the legacy writer did).
 */
export function servicePlatform(
  link: PlatformLink,
  options: { timeouts?: Partial<typeof TIMEOUTS> } = {}
): PlatformOwner {
  const connection = randomUUID()
  const timeouts = { ...TIMEOUTS, ...options.timeouts }
  const pending = new Map<
    number,
    { resolve: (value: Result) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const logs = new Set<(line: string) => void>()
  const picks = new Set<(pick: SimElementPick) => void>()
  const aliases = new Map<string, string>()
  let sequence = 0

  link.on('service-reply', (message) => {
    if (message.service !== 'platform' || !message.reply) return
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message.reply.result)
  })
  link.on('service-event', (message) => {
    if (message.service !== 'platform') return
    if (message.kind === 'simulator-log' && typeof message.line === 'string')
      for (const listener of logs) listener(message.line)
    if (message.kind === 'simulator-picked' && typeof message.tag === 'string') {
      const pick = {
        source: typeof message.source === 'string' ? message.source : null,
        tag: message.tag
      }
      for (const listener of picks) listener(pick)
    }
  })

  const call = (method: string, body: object): Promise<any> => {
    const id = ++sequence
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new PlatformError(
            'deadlineExceeded',
            `The Trezi service did not answer the ${method} request in time.`
          )
        )
      }, timeouts[method] ?? 30_000)
      pending.set(id, { resolve, timer })
      link.sendService({
        service: 'platform',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode: READS.has(method) ? 'read' : 'mutation',
          service: 'platform',
          method,
          body
        }
      })
    }).then((result) => {
      if (result.kind === 'succeeded') return result.payload
      throw new PlatformError(result.payload.code, result.payload.message)
    })
  }

  const grantMedia = (root: string, file: string): Promise<MediaGrant> =>
    call('mediaGrant', { root, path: file, view: 'source' })
  const token = (url: string) => /^trezi-media:\/\/f\/([0-9a-f]{16,128})$/.exec(url)?.[1] ?? null
  const resolve = async (url: string) => {
    const value = token(url)
    if (!value) throw new PlatformError('invalidRequest', 'Not a media link.')
    return (await call('mediaResolve', { token: value, view: 'source' })).path as string
  }

  return {
    kind: 'swift',
    simulatorPreflight: () => call('simulatorPreflight', {}),
    simulatorStart: ({ root, command, udid }) =>
      call('simulatorStart', {
        root,
        intent: 'start',
        frame: { uri: FRAME_DATA_URI, inset: FRAME_INSET, aspect: FRAME_ASPECT },
        ...(typeof command === 'string' ? { command } : {}),
        ...(udid ? { udid } : {})
      }),
    simulatorStop: async () => {
      await call('simulatorStop', { intent: 'stop' })
    },
    simulatorSelect: async (active) => {
      await call('simulatorSelect', { active })
    },
    onSimulatorLog: (listener) => {
      logs.add(listener)
    },
    onSimulatorPick: (listener) => {
      picks.add(listener)
    },
    grantMedia,
    async mediaPath(url, root, file) {
      const current = aliases.get(url) ?? url
      try {
        return await resolve(current)
      } catch (error) {
        // An expired, revoked or changed grant: authorize the file again (new size, hash, token).
        if (
          !(error instanceof PlatformError) ||
          !['notFound', 'deadlineExceeded', 'conflict'].includes(error.code)
        )
          return undefined
        try {
          const grant = await grantMedia(root, file)
          aliases.delete(url)
          aliases.set(url, grant.url)
          while (aliases.size > MAX_ALIASES) aliases.delete(aliases.keys().next().value!)
          return await resolve(grant.url)
        } catch {
          return undefined
        }
      }
    },
    async saveAttachment(image: ImageAttachment, name?: string) {
      try {
        if (
          !image ||
          typeof image.data !== 'string' ||
          !image.data ||
          !String(image.mediaType ?? '').startsWith('image/')
        )
          return ''
        const bytes = Buffer.from(image.data, 'base64')
        if (!bytes.length || bytes.length > MAX_ATTACHMENT) return ''
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const { upload } = await call('attachmentOpen', {
          mediaType: image.mediaType,
          bytes: bytes.length,
          sha256,
          ...(typeof name === 'string' ? { name: name.slice(0, 1024) } : {})
        })
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          await call('attachmentChunk', {
            upload,
            offset,
            data: bytes.subarray(offset, offset + CHUNK).toString('base64')
          })
        }
        return (await call('attachmentCommit', { upload })).path as string
      } catch {
        return ''
      }
    },
    findServers: (root) => call('servers', { root }),
    async stopServer(server) {
      await call('serverStop', { server: JSON.parse(JSON.stringify(server)), intent: 'stop' })
    },
    status: () => call('status', {}),
    openLink: async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only HTTP(S) external links are supported')
      await call('openLink', { url })
    },
    openFile: async (path) => (await call('openFile', { path })).error as string,
    openInEditor: (root, file, line, column) =>
      call('openInEditor', { root, path: file, line, ...(column != null ? { column } : {}) })
  }
}
