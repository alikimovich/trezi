import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { AgentEvent, PermissionMode } from '../../shared/api'
import type { ModelProvider, ProviderSession } from './types'

/**
 * The inside of a provider helper (S10): runs one provider session in its own
 * process and speaks the helper protocol with the Swift owner over stdin/stdout, one
 * JSON object per line. It has no other channel: the owner spawns it with only its
 * stdio and a scrubbed environment (`ProviderHelper.swift`), and checks every frame
 * it writes against the session's grant. Trezi's tools are reached only as `tool`
 * frames, which the owner authorizes and Bun runs.
 *
 * owner → helper: open, send, interrupt, permission-result, question-result,
 *   configure, tool-result, tool-error, shutdown; or, alone, diagnose.
 * helper → owner: ready, failed, event, record, permission, question, tool, settled,
 *   phase (cold-start progress, LKM-135); diagnosis (the answer to diagnose, then the
 *   helper exits).
 *
 * While a turn is open (a `send` until its `done` or `error`), the helper sends a
 * `progress` event every `heartbeatMs` (LKM-147): the chat knows the turn is alive
 * through long tool runs and thinking that produce no other event, and shows "No
 * activity" only when these stop. The owner relays it but never counts it as output.
 */
let heartbeatMs = 5000
/** Tests shorten the heartbeat (`test/fixtures/cold-helper.mjs`). */
export function setHelperHeartbeat(ms: number): void {
  heartbeatMs = ms
}

export function runProviderHelper(
  providers: Record<string, ModelProvider>,
  io: { input: Readable; output: Writable; exit: (code: number) => void } = {
    input: process.stdin,
    output: process.stdout,
    exit: (code) => process.exit(code)
  }
): void {
  const write = (frame: object): void => {
    io.output.write(`${JSON.stringify(frame)}\n`)
  }
  let session: ProviderSession | null = null
  let opening = false
  let toolSequence = 0
  const tools = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  // What the provider added to its record, sent before the event that followed it.
  let sentEntries = 0
  const sentFiles = new Set<string>()
  let sentResume: string | undefined
  const flushRecord = (): void => {
    if (!session) return
    const record = session.record
    const entries = record.transcript.slice(sentEntries).filter((entry) => entry.role !== 'user')
    sentEntries = record.transcript.length
    const files = record.filesTouched.filter((file) => !sentFiles.has(file))
    for (const file of files) sentFiles.add(file)
    const resume =
      record.sdkSessionId && record.sdkSessionId !== sentResume ? record.sdkSessionId : undefined
    if (resume) sentResume = resume
    if (entries.length || files.length || resume) {
      write({
        type: 'record',
        entries,
        ...(files.length ? { filesTouched: files } : {}),
        ...(resume ? { sdkSessionId: resume } : {})
      })
    }
  }

  let heartbeat: ReturnType<typeof setInterval> | undefined
  const beat = (on: boolean): void => {
    clearInterval(heartbeat)
    heartbeat = on
      ? setInterval(() => write({ type: 'event', event: { type: 'progress' } }), heartbeatMs)
      : undefined
  }

  const onEvent = (tagged: AgentEvent): void => {
    const { projectKey: _key, sessionId: _spawn, ...event } = tagged
    // A terminal event closes the turn: the record goes first, so Bun has it.
    if (event.type === 'done' || event.type === 'error') {
      beat(false)
      session?.finalize()
    }
    flushRecord()
    if (event.type === 'permission-request') {
      const r = event.request
      write({
        type: 'permission',
        id: r.id,
        tool: r.toolName,
        title: r.title,
        ...(r.detail ? { detail: r.detail } : {})
      })
    } else if (event.type === 'question-request') {
      write({ type: 'question', id: event.request.id, questions: event.request.questions })
    } else {
      write({ type: 'event', event })
    }
  }

  const stop = (code: number): void => {
    beat(false)
    if (session) {
      session.dispose()
      session.shutdown()
    }
    io.output.write('', () => io.exit(code))
  }

  const handle = async (frame: Record<string, any>): Promise<void> => {
    switch (frame.type) {
      case 'open': {
        if (opening || session)
          return write({ type: 'failed', message: 'The helper is already open.' })
        opening = true
        const provider = providers[frame.provider]
        if (!provider)
          return write({
            type: 'failed',
            message: `This helper does not host ${String(frame.provider)}.`
          })
        try {
          session = await provider.startSession(frame.root, frame.options ?? {}, () => null, {
            ...(frame.context ?? {}),
            // The owner's cached Claude CLI choice (LKM-135), and the phases its deadlines follow.
            ...(frame.cli && typeof frame.cli === 'object' ? { claudeCli: frame.cli } : {}),
            onPhase: (phase, detail) => write({ type: 'phase', phase, ...(detail ?? {}) }),
            onEvent,
            tools: {
              invoke: (tool, args) =>
                new Promise((resolve, reject) => {
                  const id = ++toolSequence
                  tools.set(id, { resolve, reject })
                  write({ type: 'tool', id, name: tool, args: args ?? {} })
                })
            }
          })
          write({ type: 'ready' })
        } catch (error) {
          write({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      case 'send':
        if (session) beat(true)
        return session?.send(
          String(frame.text ?? ''),
          Array.isArray(frame.images) ? frame.images : undefined
        )
      case 'interrupt': {
        const s = session
        if (!s) return write({ type: 'settled' })
        // Detached: a graceful stop that never answers must not hold up later frames
        // (the owner's deadline decides, and kills this process).
        void Promise.resolve()
          .then(() => s.interrupt?.())
          .catch(() => undefined)
          .then(() => write({ type: 'settled' }))
        return
      }
      case 'permission-result':
        return session?.pending.get(frame.id)?.settle(frame.behavior === 'allow' ? 'allow' : 'deny')
      case 'question-result':
        return session?.pendingQuestions?.get(frame.id)?.settle(frame.answers ?? null)
      case 'configure':
        if (typeof frame.model === 'string') await session?.setModel?.(frame.model).catch(() => {})
        if (typeof frame.mode === 'string')
          await session?.setPermissionMode?.(frame.mode as PermissionMode).catch(() => {})
        return
      case 'tool-result':
      case 'tool-error': {
        const call = tools.get(frame.id)
        if (!call) return
        tools.delete(frame.id)
        if (frame.type === 'tool-result') call.resolve(frame.result)
        else call.reject(new Error(String(frame.message ?? 'The tool failed.')))
        return
      }
      case 'diagnose': {
        // "Check provider login" (LKM-119): a helper of its own, launched like a chat's.
        if (opening || session) return
        const provider = providers[frame.provider]
        let report: object
        try {
          report = provider?.checkLogin
            ? await provider.checkLogin()
            : {
                loggedIn: null,
                detail: `This helper has no login check for ${String(frame.provider)}.`
              }
        } catch (error) {
          report = {
            loggedIn: null,
            detail: error instanceof Error ? error.message : String(error)
          }
        }
        write({ type: 'diagnosis', report })
        return stop(0)
      }
      case 'shutdown':
        return stop(0)
    }
  }

  let queue: Promise<void> = Promise.resolve()
  const lines = createInterface({ input: io.input, crlfDelay: Number.POSITIVE_INFINITY })
  lines.on('line', (line) => {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    const received = frame as Record<string, any>
    // A tool answer settles at once: the frame waiting on it may be `open` itself (Codex
    // checks its Trezi tool bridge while starting, LKM-131).
    if (received.type === 'tool-result' || received.type === 'tool-error')
      return void handle(received).catch(() => {})
    // In order: a mode change lands before the turn sent after it.
    queue = queue.then(() => handle(received)).catch(() => {})
  })
  // The owner closed our stdin: it is gone or stopping us.
  lines.once('close', () => stop(0))
}
