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

const asks = (m: NativeChatMessage, id: string) =>
  m.role === 'user' && m.text.includes(`${CONTROLS_REQUEST_HEADER} ${id}.`)

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

/**
 * Runs a request as a turn in the project's chat and resolves with its answer once that
 * turn ends: its sources reached the live checkout, so the panel can be checked against
 * them. The request may wait behind a running turn; only the turn that begins with it
 * counts, and one that does not land rejects.
 */
export function chatRequests(
  chatFor: (root: string) => string | null,
  messages: (key: string) => NativeChatMessage[] | null,
  submit: (key: string, text: string) => Promise<unknown>,
  boundaries: Set<Boundary>
) {
  return (root: string, prompt: string, id: string) =>
    new Promise<string>((resolve, reject) => {
      const key = chatFor(root)
      if (!key) return reject(new Error('No chat is open for this project.'))
      let turn: string | null | undefined
      const settle = (error: string | null, answer = '') => {
        boundaries.delete(listen)
        if (error) reject(new Error(error))
        else resolve(answer)
      }
      const listen: Boundary = (chat, kind, at) => {
        if (chat !== key) return
        const current = messages(key)
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
      boundaries.add(listen)
      submit(key, prompt).catch((error) => settle(String(error?.message ?? error)))
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
  pending: { root: string; label: string } | null = null
  error: { root: string; message: string } | null = null
  focus = 0
  /** Runs the request turn and resolves with its answer; the runtime assigns the chat. */
  generate: (root: string, prompt: string, id: string) => Promise<string> = async () => {
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
      pending = this.pending?.root === root ? this.pending.label : undefined,
      error = this.error?.root === root ? this.error.message : undefined
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
      enabled: source && !this.pending,
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
          this.error = result && 'error' in result ? { root, message: result.error } : null
          if (this.target?.panel === panel.manifest.id && this.target.param === param.id)
            this.target = null
          await this.host.refresh()
          return
        }
  }

  async request(text: string) {
    const host = this.host,
      root = host.state.root,
      element = host.element,
      words = text.trim()
    if (!words || !root || this.pending) return
    if (!element?.source) {
      this.error = { root, message: 'Select an element with source code to ask for controls.' }
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
    this.pending = {
      root,
      label: target ? `Revising ${target.param?.label ?? target.panel.title}…` : 'Making controls…'
    }
    this.error = null
    this.target = null
    host.publish()
    try {
      const parsed = parseControlsAnswer(await this.generate(root, prompt, id), id)
      if ('error' in parsed) throw new Error(parsed.error)
      const saved = await host.invoke('controls:save', root, parsed.manifest, {
        files,
        ...(target && { panel: target.panel.id }),
        ...(target?.param && { param: target.param.id })
      })
      if (saved && 'error' in saved) throw new Error(saved.error)
    } catch (error) {
      this.error = { root, message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.pending = null
    }
    if (host.state.root === root) await host.refresh()
  }
}
