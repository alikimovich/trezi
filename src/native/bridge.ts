import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

/**
 * Where the host's frames come from. In Trezi that is always the Swift service's
 * private pipe (this process's stdin/stdout). Tests that drive a bare `TreziHost`
 * pass the child they spawned (`test/helpers/host-bridge.mjs`).
 */
export interface HostTransport {
  input: Readable
  output: Writable
  child?: ChildProcessWithoutNullStreams
}

export class NativeBridge extends EventEmitter {
  child?: ChildProcessWithoutNullStreams
  private output: Writable
  readonly closed: Promise<void>
  private sequence = 0
  /** Host events held (in order) while startup awaits the service; service frames still flow. */
  private held: [string, unknown][] | null = null
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(transport: HostTransport = { input: process.stdin, output: process.stdout }) {
    super()
    this.child = transport.child
    this.output = transport.output
    const lines = createInterface({ input: transport.input })
    // Under the service EOF is sent only after the host's final events drain.
    this.closed = new Promise((resolve) => {
      if (this.child) this.child.once('close', () => resolve())
      else lines.once('close', () => resolve())
    })
    this.output.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') this.emit('host-error', error)
    })
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        if (message.event === 'reply') {
          const request = this.pending.get(message.id)
          if (!request) return
          clearTimeout(request.timer)
          this.pending.delete(message.id)
          if (message.error) request.reject(new Error(message.error))
          else request.resolve(message.value)
        } else if (message.event === 'service-reply' || message.event === 'service-event')
          this.emit(message.event, message)
        else this.deliver(message.event, message)
      } catch (error) {
        console.error('Invalid native host message:', error)
      }
    })
    this.child?.on('error', (error) => this.emit('host-error', error))
    const disconnected = () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error('Native host closed'))
      }
      this.pending.clear()
      this.deliver('closed')
    }
    if (this.child) this.child.once('exit', disconnected)
    else lines.once('close', disconnected)
  }
  hold() {
    this.held ??= []
  }
  /** Replays held host events once every handler is registered. */
  release() {
    const held = this.held ?? []
    this.held = null
    for (const [event, message] of held)
      this.emit(event, ...(message === undefined ? [] : [message]))
  }
  private deliver(event: string, message?: unknown) {
    if (this.held) this.held.push([event, message])
    else this.emit(event, ...(message === undefined ? [] : [message]))
  }
  send(method: string, data: object = {}) {
    if (this.output.destroyed) return
    this.output.write(`${JSON.stringify({ method, ...data })}\n`)
  }
  /** A frame for the Swift service itself (no `method`, so it never reaches the host). */
  sendService(frame: { service: string }) {
    if (this.output.destroyed) return
    this.output.write(`${JSON.stringify(frame)}\n`)
  }
  request(method: string, data: object = {}, timeout = 30_000): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Native ${method} timed out`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send(method, { ...data, id })
    })
  }
}

let connection: NativeBridge
export function setBridge(value: NativeBridge) {
  connection = value
}
export function bridge() {
  if (!connection) throw new Error('Native host is not connected')
  return connection
}
