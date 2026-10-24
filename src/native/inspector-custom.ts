import { parseControlsAnswer } from '../main/control-requests'
import type { PropInspection, ResolvedControlPanel, SelectedElement } from '../shared/api'
import { CONTROLS_REQUEST_HEADER, controlsPrompt } from '../shared/controls-prompt'
import type { NativeChatMessage } from '../shared/native-chat'
import type { NativeInspectorCustom, NativeInspectorState } from '../shared/native-inspector'

/** What the Custom tab needs from the inspector controller. */
export interface CustomHost {
  readonly state: NativeInspectorState
  readonly element: SelectedElement | null
  readonly inspection: PropInspection | null
  readonly controls: ResolvedControlPanel[]
  invoke(channel: string, ...args: any[]): Promise<any>
  refresh(): Promise<void>
  publish(): void
}

/** The selection's repo-relative files: its own source and its owning component's. */
export const selectionFiles = (element: SelectedElement | null) => [
  ...new Set(
    [element?.source, element?.componentSource]
      .filter((v): v is string => !!v)
      .map((v) => v.replace(/:\d+(?::\d+)?$/, ''))
  )
]

const mentions = (text: string, id: string) => text.includes(`${CONTROLS_REQUEST_HEADER} ${id}.`)
const asks = (m: NativeChatMessage, id: string) => m.role === 'user' && mentions(m.text, id)

/** Whether request `id` is the chat's latest user message: the turn now beginning is its. */
export function requestRunning(messages: NativeChatMessage[], id: string) {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  return !!last && asks(last, id)
}

/**
 * The answer to request `id` in a chat: null before its turn has answered (it may still
 * be queued behind another turn), else the text of every assistant message after it.
 */
export function requestAnswer(messages: NativeChatMessage[], id: string): string | null {
  const asked = messages.findIndex((m) => asks(m, id))
  if (asked === -1) return null
  const answers = messages.slice(asked + 1).filter((m) => m.role === 'assistant')
  if (!answers.length) return null
  return answers
    .map((m) => m.text || m.segments.map((s) => (s.kind === 'text' ? s.text : '')).join('\n'))
    .join('\n')
}

type Boundary = (key: string, kind: 'begin' | 'landed' | 'failed', turn: string | null) => void

/** What a request needs to know of its chat: its messages, queued texts and activity. */
export interface RequestChat {
  messages: NativeChatMessage[]
  /** The texts waiting in the chat's queue. */
  queued: string[]
  /** A turn is sending, streaming or landing. */
  running: boolean
  /** Stop held the queue: nothing queued sends until the user chooses. */
  paused: boolean
}

export interface RequestChats {
  chatFor(root: string): string | null
  /** Null once the chat is closed. */
  state(key: string): RequestChat | null
  submit(key: string, text: string): Promise<unknown>
  /** Takes request `id` out of the chat's queue. */
  dequeue(key: string, id: string): void
  boundaries: Set<Boundary>
  /** Called with the chat's key whenever its state changed. */
  changes: Set<(key: string) => void>
}

/**
 * Runs a request as a turn in the project's chat and resolves with its answer once that
 * turn ends: its sources reached the live checkout, so the panel can be checked against
 * them. The request may wait behind a running turn; only the turn that begins with it
 * counts, and one that does not land rejects. A request whose turn can no longer begin
 * (the send failed or was refused, it was stopped in the queue or discarded) rejects
 * too, and aborting the signal withdraws it, so a request never waits forever.
 */
export function chatRequests(chats: RequestChats) {
  return (root: string, prompt: string, id: string, signal?: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const key = chats.chatFor(root)
      if (!key) return reject(new Error('No chat is open for this project.'))
      let turn: string | null | undefined,
        sent = false,
        done = false
      const settle = (error: string | null, answer = '') => {
        if (done) return
        done = true
        chats.boundaries.delete(onBoundary)
        chats.changes.delete(onChange)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(new Error(error))
        else resolve(answer)
      }
      // Settle first: dequeuing changes the chat, which would re-enter `onChange`.
      const withdraw = (error: string) => {
        settle(error)
        chats.dequeue(key, id)
      }
      const onAbort = () => withdraw('The request was cancelled.')
      // After the send was accepted, the request is queued or its message is in the chat;
      // a chat that is neither running it nor holding it will never answer.
      const onChange = (changed: string) => {
        if (changed !== key || !sent || turn !== undefined) return
        const chat = chats.state(key)
        if (!chat) return settle('The chat closed before the agent answered.')
        if (chat.messages.some((m) => asks(m, id))) {
          if (chat.running) return
          // A failed send or a Stop pauses the chat (chat-controller.ts run/stop).
          if (chat.paused) return settle('The agent did not run this request. Try again.')
          const answer = requestAnswer(chat.messages, id)
          if (answer !== null) return settle(null, answer)
          return settle('The agent did not start this request. Try again.')
        }
        if (!chat.queued.some((text) => mentions(text, id)))
          return settle('The request was not sent to the agent.')
        if (chat.paused && !chat.running)
          withdraw('The chat is stopped, so the request was not sent.')
      }
      const onBoundary: Boundary = (chat, kind, at) => {
        if (chat !== key) return
        const current = chats.state(key)?.messages
        if (!current) return settle('The chat closed before the agent answered.')
        if (kind === 'begin') {
          if (turn === undefined && requestRunning(current, id)) turn = at
          return
        }
        // A turnless failure is the chat closing (chat-runtime.ts).
        if (kind === 'failed' && at === null && turn === undefined)
          return settle('The chat closed before the agent answered.')
        if (turn === undefined || (at !== null && at !== turn)) return
        if (kind === 'failed')
          return settle("The agent's turn did not land, so its controls were not saved.")
        settle(null, requestAnswer(current, id) ?? '')
      }
      if (signal?.aborted) return reject(new Error('The request was cancelled.'))
      chats.boundaries.add(onBoundary)
      chats.changes.add(onChange)
      signal?.addEventListener('abort', onAbort)
      chats.submit(key, prompt).then(
        () => {
          sent = true
          onChange(key)
        },
        (error) => settle(String(error?.message ?? error))
      )
    })
}

/**
 * The Inspector Custom tab's requests (LKM-323): the user asks for controls in text, or
 * comments on a panel or one control; the agent's answer is saved as a panel (or its next
 * revision) through `controls:save`, which validates it and checks it against the source.
 * One request runs at a time; the field shows its progress and any error.
 */
export class InspectorCustom {
  /** What the next request comments on; null asks for a new panel. */
  target: { panel: string; param?: string } | null = null
  /** The request running in each project: one at a time per project, never across them. */
  readonly pending = new Map<string, { label: string; abort: AbortController }>()
  readonly errors = new Map<string, string>()
  focus = 0
  /** Runs the request turn and resolves with its answer; the runtime assigns the chat. */
  generate: (root: string, prompt: string, id: string, signal?: AbortSignal) => Promise<string> =
    async () => {
      throw new Error('No chat is open for this project.')
    }
  private sequence = 0
  constructor(private readonly host: CustomHost) {}

  private targetPanel() {
    const panel = this.host.controls.find((p) => p.manifest.id === this.target?.panel)?.manifest
    const param = this.target?.param
      ? panel?.params.find((p) => p.id === this.target!.param)
      : undefined
    if (!panel || (this.target?.param && !param)) return null
    return { panel, param }
  }

  view(): NativeInspectorCustom {
    const root = this.host.state.root,
      target = this.targetPanel(),
      pending = this.pending.get(root)?.label,
      error = this.errors.get(root)
    const source = !!this.host.element?.source
    return {
      placeholder: !source
        ? 'Select an element to ask for controls'
        : target
          ? `Comment on ${target.param?.label ?? target.panel.title}…`
          : 'Ask for controls…',
      ...(target && {
        target: target.param ? `${target.panel.title} › ${target.param.label}` : target.panel.title
      }),
      ...(pending && { pending }),
      ...(error && { error }),
      enabled: source && !pending,
      focus: this.focus
    }
  }

  /** The next request comments on a panel or one of its controls (`custom:<panel>:<param>`). */
  comment(panel: string, field?: string) {
    const resolved = this.host.controls.find((p) => p.manifest.id === panel)
    const param = field
      ? resolved?.params.find((p) => `custom:${panel}:${p.id}` === field)?.id
      : undefined
    if (!resolved || (field && !param)) return
    this.target = { panel, ...(param && { param }) }
    this.focus++
    this.host.publish()
  }

  clearTarget() {
    this.target = null
    this.host.publish()
  }

  focusField() {
    this.focus++
    this.host.publish()
  }

  async removeControl(field: string) {
    const root = this.host.state.root
    for (const panel of this.host.controls)
      for (const param of panel.params)
        if (`custom:${panel.manifest.id}:${param.id}` === field) {
          const result = await this.host.invoke(
            'controls:remove-param',
            root,
            panel.manifest.id,
            param.id
          )
          this.setError(root, result && 'error' in result ? result.error : null)
          if (this.target?.panel === panel.manifest.id && this.target.param === param.id)
            this.target = null
          await this.host.refresh()
          return
        }
  }

  private setError(root: string, message: string | null) {
    if (message) this.errors.set(root, message)
    else this.errors.delete(root)
  }

  /** Withdraws the project's running request: it stops waiting and nothing is saved. */
  cancel(root = this.host.state.root) {
    this.pending.get(root)?.abort.abort()
  }

  async request(text: string) {
    const host = this.host,
      root = host.state.root,
      element = host.element,
      words = text.trim()
    if (!words || !root || this.pending.has(root)) return
    if (!element?.source) {
      this.setError(root, 'Select an element with source code to ask for controls.')
      host.publish()
      return
    }
    const target = this.targetPanel(),
      files = selectionFiles(element),
      id = `r${Date.now().toString(36)}${(++this.sequence).toString(36)}`
    const prompt = controlsPrompt(element, root, host.inspection, words, {
      id,
      files,
      ...(target && { panel: JSON.stringify(target.panel) }),
      ...(target?.param && { param: { id: target.param.id, label: target.param.label } })
    })
    const abort = new AbortController()
    this.pending.set(root, {
      label: target ? `Revising ${target.param?.label ?? target.panel.title}…` : 'Making controls…',
      abort
    })
    this.setError(root, null)
    this.target = null
    host.publish()
    try {
      const answer = await this.generate(root, prompt, id, abort.signal)
      if (abort.signal.aborted) throw new Error('The request was cancelled.')
      const parsed = parseControlsAnswer(answer, id)
      if ('error' in parsed) throw new Error(parsed.error)
      const saved = await host.invoke('controls:save', root, parsed.manifest, {
        files,
        ...(target && { panel: target.panel.id }),
        ...(target?.param && { param: target.param.id })
      })
      if (saved && 'error' in saved) throw new Error(saved.error)
    } catch (error) {
      // A request the user cancelled is not a failure.
      if (!abort.signal.aborted)
        this.setError(root, error instanceof Error ? error.message : String(error))
    } finally {
      this.pending.delete(root)
    }
    if (host.state.root === root) await host.refresh()
    else host.publish()
  }
}
