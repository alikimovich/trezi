import { type ChildProcess, spawn } from 'node:child_process'

export interface PreviewEntry {
  id: string
  title: string
  kind: string
  width?: number
  height?: number
}

export interface PreviewInputEvent {
  type: 'mousedown' | 'mouseup' | 'mousedrag' | 'keydown' | 'keyup' | 'scroll'
  x?: number
  y?: number
  button?: number
  clickCount?: number
  key?: string
  dx?: number
  dy?: number
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
  meta?: boolean
}

/** One JSON line from the host: the ready banner or a reply to a request id. */
type HostMessage = { [field: string]: unknown; id?: number; ok?: boolean; type?: string }
type Pending = {
  resolve: (value: HostMessage) => void
  reject: (error: Error) => void
  timer: Timer
}
type Timer = ReturnType<typeof setTimeout>

/**
 * One running preview host binary (`PreviewHost.swift`): JSON-line requests on its
 * stdin, replies on its stdout, the component's own output on stderr. Requests are
 * multiplexed by id so input is never queued behind a frame the host is still drawing.
 * Closing stdin ends the host; `stop` also signals it.
 */
export class PreviewHostProcess {
  readonly ready: Promise<PreviewEntry[]>
  private child: ChildProcess
  private pending = new Map<number, Pending>()
  private next = 1
  private buffer = ''
  private exited = false

  constructor(
    binary: string,
    options: {
      cwd: string
      onLog: (line: string) => void
      onExit: (code: number | null, signal: string | null) => void
      readyTimeoutMs?: number
    }
  ) {
    this.child = spawn(binary, [], { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let settleReady: (value: PreviewEntry[]) => void = () => {}
    let failReady: (error: Error) => void = () => {}
    this.ready = new Promise((resolve, reject) => {
      settleReady = resolve
      failReady = reject
    })
    const readyTimer = setTimeout(
      () => failReady(new Error('The preview host did not start in time.')),
      options.readyTimeoutMs ?? 20_000
    )
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk
      let end = this.buffer.indexOf('\n')
      while (end >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        end = this.buffer.indexOf('\n')
        let message: HostMessage
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.type === 'ready') {
          clearTimeout(readyTimer)
          settleReady(Array.isArray(message.previews) ? message.previews : [])
          continue
        }
        const waiter = this.pending.get(Number(message.id))
        if (!waiter) continue
        this.pending.delete(Number(message.id))
        clearTimeout(waiter.timer)
        if (message.ok) waiter.resolve(message)
        else waiter.reject(new Error(String(message.error ?? 'The preview host failed.')))
      }
    })
    let stderr = ''
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      const lines = stderr.split('\n')
      stderr = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) options.onLog(line.trimEnd())
    })
    this.child.stdin?.on('error', () => {})
    this.child.on('error', (error) => failReady(error))
    this.child.on('exit', (code, signal) => {
      this.exited = true
      clearTimeout(readyTimer)
      failReady(new Error(`The preview host exited (code ${code ?? signal}) before it was ready.`))
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('The preview host exited.'))
      }
      this.pending.clear()
      options.onExit(code, signal)
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get alive(): boolean {
    return !this.exited
  }

  request(
    op: string,
    fields: Record<string, unknown> = {},
    timeoutMs = 10_000
  ): Promise<HostMessage> {
    if (this.exited) return Promise.reject(new Error('The preview host is not running.'))
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The preview host did not answer ${op} in time.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin?.write(`${JSON.stringify({ id, op, ...fields })}\n`)
    })
  }

  async frame(preview: string): Promise<{ png: Buffer; width: number; height: number }> {
    const reply = await this.request('frame', { preview })
    return {
      png: Buffer.from(String(reply.png), 'base64'),
      width: Number(reply.width),
      height: Number(reply.height)
    }
  }

  async describe(preview: string): Promise<string[]> {
    const texts = (await this.request('describe', { preview })).texts
    return Array.isArray(texts) ? texts.map(String) : []
  }

  async input(preview: string, event: PreviewInputEvent): Promise<void> {
    await this.request('input', { preview, event })
  }

  /** Ends the host: stdin closes (it exits by itself), then TERM, then KILL. */
  stop(graceMs = 1_000): Promise<void> {
    if (this.exited) return Promise.resolve()
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve())
      this.child.stdin?.end()
      const term = setTimeout(() => this.child.kill('SIGTERM'), graceMs)
      const kill = setTimeout(() => this.child.kill('SIGKILL'), graceMs * 3)
      this.child.once('exit', () => {
        clearTimeout(term)
        clearTimeout(kill)
      })
    })
  }
}
