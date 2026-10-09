// Preview-only IPC transport, injected exclusively into the isolated WKContentWorld.
import { PREVIEW_PICKED, PREVIEW_TIMING_ACK } from '../shared/preview-channels'

type Listener = (event: object, ...args: any[]) => void
const listeners = new Map<string, Set<Listener>>()
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()
const documentId = `${Date.now()}-${Math.random()}`
let sequence = 0
const timingStarts = new Map<number, number>()
type TimingTrace = {
  id: number
  pageAt: number
  hostAt?: number
  serviceAt?: number
  bunAt?: number
  bunDoneAt?: number
  hostReturnAt?: number
}
type Delivery =
  | { type: 'reply'; id: number; document: string; error?: string; value?: unknown }
  | { type: 'event'; channel: string; args: unknown[] }
const nativeGlobal = globalThis as unknown as {
  webkit: { messageHandlers: { trezi: { postMessage: (value: unknown) => void } } }
  __treziNativeDispatch: (message: Delivery) => void
}
const host = nativeGlobal.webkit.messageHandlers.trezi
nativeGlobal.__treziNativeDispatch = (message: Delivery) => {
  if (message.type === 'reply') {
    if (message.document !== documentId) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error))
    else request.resolve(message.value)
  } else {
    if (message.channel === PREVIEW_TIMING_ACK) {
      const trace = message.args[0] as TimingTrace
      const start = timingStarts.get(trace.id)
      timingStarts.delete(trace.id)
      const metrics = (
        globalThis as typeof globalThis & {
          __treziPreviewTimings?: { roundTrip: number[]; hops: TimingTrace[] }
        }
      ).__treziPreviewTimings
      if (start !== undefined && metrics) {
        metrics.roundTrip.push(performance.now() - start)
        metrics.hops.push(trace)
      }
    }
    for (const listener of listeners.get(message.channel) ?? []) listener({}, ...message.args)
  }
}
export const ipcRenderer = {
  send(channel: string, ...args: unknown[]) {
    const enabled = (
      globalThis as typeof globalThis & { __treziPreviewTimings?: { enabled: boolean } }
    ).__treziPreviewTimings?.enabled
    const trace =
      channel === PREVIEW_PICKED && enabled ? { id: ++sequence, pageAt: Date.now() } : undefined
    if (trace) timingStarts.set(trace.id, performance.now())
    host.postMessage({
      type: 'send',
      channel,
      args,
      undefinedArgs: args.flatMap((value, index) => (value === undefined ? [index] : [])),
      document: documentId,
      ...(trace ? { trace } : {})
    })
  },
  invoke(channel: string, ...args: unknown[]) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      host.postMessage({
        type: 'invoke',
        id,
        channel,
        args,
        undefinedArgs: args.flatMap((value, index) => (value === undefined ? [index] : [])),
        document: documentId
      })
    })
  },
  on(channel: string, listener: Listener) {
    const set = listeners.get(channel) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(channel, set)
  },
  removeListener(channel: string, listener: Listener) {
    listeners.get(channel)?.delete(listener)
  }
}
