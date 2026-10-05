import { randomUUID } from 'node:crypto'
import { stampHtml } from '../main/html-source'
import type { DetectedProject, Framework, RunningDevServer } from '../shared/api'
import type { ServiceFailure } from '../shared/service-contract/types'

type Result = { kind: 'succeeded'; payload: any } | { kind: 'failed'; payload: ServiceFailure }
interface ServiceMessage {
  service?: string
  id?: number
  kind?: string
  root?: string
  line?: string
  url?: string
  reason?: string
  path?: string
  html?: string
  reply?: { result: Result }
}
/** Bun's end of the supervised private pipe (see `NativeBridge.sendService`). */
export interface RuntimeLink {
  sendService(frame: object): void
  on(event: 'service-reply' | 'service-event', listener: (message: ServiceMessage) => void): unknown
}

export class RuntimeServiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** The managed project runtime, owned by the Swift service (S06). */
export interface ProjectRuntime {
  detect(root: string): Promise<DetectedProject>
  start(opts: { root: string; command: string; framework?: Framework }): Promise<RunningDevServer>
  stop(root: string): Promise<void>
  info(root: string): Promise<{ running: boolean; server?: RunningDevServer }>
  /** Runs the project's own package manager install; false when there is no package.json. */
  install(root: string): Promise<boolean>
  stopAll(): Promise<void>
  onLog(listener: (root: string, line: string) => void): void
  /** A ready server ended without a stop or restart; `reason` says how (exit or unresponsive). */
  onExit(listener: (root: string, url: string, reason: string) => void): void
}

/** A stamped page larger than this is served unstamped rather than risk the pipe's line limit. */
const MAX_STAMPED = 8 * 1024 * 1024
const TIMEOUTS = {
  detect: 30_000,
  info: 10_000,
  start: 150_000,
  stop: 15_000,
  install: 330_000,
  stopAll: 6_000
}

/**
 * Bun's client for the Swift runtime owner. Bun still chooses what to run (the
 * detected command or the user's custom one); the service runs it, supervises the
 * group, probes readiness, serves static sites and stops everything on quit or
 * crash. A request that times out rejects: Bun never spawns a server itself under
 * the Swift owner. Stamping requests from the static site are answered with the JS
 * helper (parse5), which returns its input on any failure.
 */
export function serviceRuntime(
  link: RuntimeLink,
  options: {
    stamp?: (html: string, path: string) => Promise<string>
    timeouts?: Partial<typeof TIMEOUTS>
  } = {}
): ProjectRuntime {
  const connection = randomUUID()
  const timeouts = { ...TIMEOUTS, ...options.timeouts }
  const stamp = options.stamp ?? stampHtml
  const pending = new Map<
    number,
    {
      resolve: (value: Result) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const logs = new Set<(root: string, line: string) => void>()
  const exits = new Set<(root: string, url: string, reason: string) => void>()
  let sequence = 0

  link.on('service-reply', (message) => {
    if (message.service !== 'runtime' || !message.reply) return
    const request = pending.get(message.id ?? -1)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id ?? -1)
    request.resolve(message.reply.result)
  })
  link.on('service-event', (message) => {
    if (message.service !== 'runtime') return
    if (
      message.kind === 'log' &&
      typeof message.root === 'string' &&
      typeof message.line === 'string'
    ) {
      for (const listener of logs) listener(message.root, message.line)
    } else if (
      message.kind === 'exit' &&
      typeof message.root === 'string' &&
      typeof message.url === 'string'
    ) {
      const reason = typeof message.reason === 'string' ? message.reason : 'The dev server stopped.'
      for (const listener of exits) listener(message.root, message.url, reason)
    } else if (
      message.kind === 'stamp' &&
      typeof message.id === 'number' &&
      typeof message.html === 'string'
    ) {
      const { id, html } = message
      void stamp(html, String(message.path ?? '')).then(
        (stamped) =>
          link.sendService({
            service: 'runtime-helper',
            id,
            html: stamped.length <= MAX_STAMPED ? stamped : null
          }),
        () => link.sendService({ service: 'runtime-helper', id, html: null })
      )
    }
  })

  const request = (method: keyof typeof TIMEOUTS, body: object): Promise<any> => {
    const id = ++sequence
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new RuntimeServiceError(
            'deadlineExceeded',
            `The Trezi service did not answer the project runtime (${method}) in time.`
          )
        )
      }, timeouts[method])
      pending.set(id, { resolve, reject, timer })
      link.sendService({
        service: 'runtime',
        id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID: randomUUID(),
          scope: {},
          mode: method === 'detect' || method === 'info' ? 'read' : 'mutation',
          service: 'runtime',
          method,
          body
        }
      })
    }).then((result) => {
      if (result.kind === 'succeeded') return result.payload
      throw new RuntimeServiceError(result.payload.code, result.payload.message)
    })
  }

  return {
    detect: (root) => request('detect', { root }),
    start: ({ root, command, framework }) =>
      request('start', { root, command, ...(framework ? { framework } : {}) }),
    stop: async (root) => {
      await request('stop', { root })
    },
    info: (root) => request('info', { root }),
    install: async (root) => (await request('install', { root })).installed === true,
    stopAll: async () => {
      await request('stopAll', {})
    },
    onLog: (listener) => {
      logs.add(listener)
    },
    onExit: (listener) => {
      exits.add(listener)
    }
  }
}
