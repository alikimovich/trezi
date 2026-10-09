import { randomUUID } from 'node:crypto'
import type { NativeSheetAction, NativeSheetState, NativeToastState } from '../shared/native-sheet'
import type { NativeBridge } from './bridge'
import type { NativeChatController } from './chat-controller'
import { dispatchIPC } from './platform'
import { SheetAutosave } from './sheet-autosave'
import type { NativeWorkspaceController } from './workspace-controller'

type ToastAction = { label: string; run: () => Promise<unknown> }

/** Trusted app sheets use fixed operations, never renderer-supplied IPC names. */
export class NativeSheetController {
  generation = 0
  current: {
    state: NativeSheetState
    autosave?: SheetAutosave
    handle(action: NativeSheetAction): Promise<void>
    select?(section: string): void
  } | null = null
  constructor(
    readonly host: Pick<NativeBridge, 'send'>,
    readonly workspace: NativeWorkspaceController,
    readonly chat: NativeChatController,
    readonly invoke = (channel: string, ...args: any[]) =>
      dispatchIPC('main', { type: 'invoke', channel, args })
  ) {}
  /** `select` hears sidebar selections of a sectioned window (`state.sections`). */
  present(
    state: Omit<NativeSheetState, 'id' | 'busy'>,
    handle: (action: NativeSheetAction) => Promise<void>,
    select?: (section: string) => void
  ) {
    this.generation++
    if (this.current) this.host.send('sheetClose', { id: this.current.state.id })
    const alert = state.alert ?? (!state.sections && !state.autosave && state.fields.length === 0)
    const value: NonNullable<NativeSheetController['current']> = {
      state: {
        ...state,
        alert,
        dismissible: state.dismissible ?? (state.actions.length > 0 || !!state.autosave),
        // A form window closes with its traffic light; an alert sheet has none, so it keeps Close.
        actions: alert
          ? state.actions
          : state.actions.filter((action) => !(action.id === 'cancel' && action.label === 'Close')),
        id: randomUUID(),
        busy: false
      },
      handle,
      select
    }
    if (state.autosave)
      value.autosave = new SheetAutosave(
        Object.fromEntries(
          state.fields.filter((field) => !field.draft).map((field) => [field.id, field.value])
        ),
        (values) => handle({ id: value.state.id, action: 'save', values }),
        (message) => {
          if (this.current === value) {
            value.state.message = message
            this.host.send('sheetState', { state: value.state })
          }
        }
      )
    this.current = value
    this.host.send('sheetState', { state: value.state })
  }
  close() {
    this.generation++
    if (this.current) this.host.send('sheetClose', { id: this.current.state.id })
    this.current = null
  }
  toastCurrent: { id: string; runs: (() => Promise<unknown>)[] } | null = null
  /** A non-blocking confirmation in the main window, with up to two actions; a newer one replaces it. */
  toast(message: string, action?: ToastAction | ToastAction[], seconds = 6) {
    const id = randomUUID()
    const actions = (Array.isArray(action) ? action : action ? [action] : []).slice(0, 2)
    this.toastCurrent = { id, runs: actions.map((a) => a.run) }
    const labels = actions.map((a) => a.label)
    const state: NativeToastState = {
      id,
      message,
      action: labels[0],
      ...(labels.length > 1 ? { actions: labels } : {}),
      seconds
    }
    this.host.send('toastState', { state })
  }
  async toastAction(action: { id: string; index?: number }) {
    const toast = this.toastCurrent
    if (!toast || toast.id !== action.id) return
    this.toastCurrent = null
    await toast.runs[action.index ?? 0]?.()
  }
  /** Re-send the open sheet after its state changed in place (same window and ID). */
  refresh() {
    if (this.current) this.host.send('sheetState', { state: this.current.state })
  }
  async action(action: NativeSheetAction) {
    const sheet = this.current
    if (!sheet || action.id !== sheet.state.id) return
    if (
      action.section &&
      action.section !== sheet.state.section &&
      sheet.state.sections?.some((s) => s.id === action.section)
    ) {
      sheet.state.section = action.section
      sheet.select?.(action.section)
    }
    if (action.action === 'section') return
    if (sheet.autosave) {
      if (
        !['change', 'save', 'cancel'].includes(action.action) &&
        !sheet.state.actions.some((a) => a.id === action.action)
      )
        return
      // Draft fields (a provider form) are sent with their own action, never autosaved.
      const drafts = new Set(
        sheet.state.fields.filter((field) => field.draft).map((field) => field.id)
      )
      const saved = await sheet.autosave.enqueue(
        Object.fromEntries(Object.entries(action.values).filter(([key]) => !drafts.has(key)))
      )
      if (
        this.current !== sheet ||
        !saved ||
        action.action === 'change' ||
        action.action === 'save'
      )
        return
    }
    if (action.action === 'cancel') {
      if (sheet.state.dismissible) this.close()
      return
    }
    if (sheet.state.busy) return
    if (!sheet.state.actions.some((a) => a.id === action.action)) return
    sheet.state.busy = true
    sheet.state.message = undefined
    this.host.send('sheetState', { state: sheet.state })
    try {
      await sheet.handle(action)
    } catch (error) {
      sheet.state.message = error instanceof Error ? error.message : String(error)
    } finally {
      if (this.current === sheet) {
        sheet.state.busy = false
        this.host.send('sheetState', { state: sheet.state })
      }
    }
  }
  renameChat(id: string, key: string) {
    const entry = this.workspace.state.projects.find((p) => p.key === key)
    if (!entry) return
    const live = id.startsWith('chat:'),
      session = id.slice(live ? 5 : 8)
    const title = live
      ? this.chat.chats.get(session)?.title
      : this.workspace.state.history[key]?.find((r) => r.id === session)?.title
    this.present(
      {
        title: 'Rename chat',
        detail: '',
        fields: [{ id: 'title', label: 'Name', kind: 'text', value: title || 'New chat' }],
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'rename', label: 'Rename', primary: true }
        ]
      },
      async (action) => {
        const result = await this.invoke(
          live ? 'agent:rename-chat' : 'sessions:rename',
          session,
          action.values.title
        )
        if (!result.ok) throw new Error(result.error || 'Could not rename chat.')
        if (live) {
          const chat = this.chat.chats.get(session)
          if (chat) chat.title = result.title
        }
        this.workspace.state.history[key] = await this.invoke('sessions:list', entry.root)
        this.workspace.changed()
        if (this.current?.state.id === action.id) this.close()
      }
    )
  }
  async memory(key: string) {
    const project = this.workspace.state.projects.find((p) => p.key === key)
    if (!project) return
    const generation = this.generation
    const memory = await this.invoke('project-memory:get', project.root)
    if (generation !== this.generation) return
    this.present(
      {
        title: 'Project memory — ' + project.name,
        detail:
          'Add preferences and decisions Trezi should remember for this project. Changes save automatically and take effect with the next message.',
        fields: [
          {
            id: 'content',
            label: 'What should Trezi remember?',
            kind: 'multiline',
            value: memory.content
          }
        ],
        autosave: true,
        actions: []
      },
      async (action) => {
        const content = action.values.content ?? ''
        if (content.length > 16000)
          throw new Error('Project memory is limited to 16,000 characters.')
        await this.invoke('project-memory:set', project.root, content)
        if (this.current?.state.id === action.id)
          this.current.state.message = 'Saved. Open chats receive the update on their next turn.'
      }
    )
  }
  newProject() {
    if (this.current?.state.busy) return
    this.present(
      {
        title: 'New project',
        detail:
          'Start with a React app, or plan a project with Trezi. Next, choose where to save it.',
        fields: [
          {
            id: 'setup',
            label: 'Starting point',
            kind: 'choice',
            value: 'react',
            choices: [
              { value: 'react', label: 'React starter app' },
              { value: 'next', label: 'Plan with Next.js' },
              { value: 'svelte', label: 'Plan with Svelte' },
              { value: 'custom', label: 'Help me choose' }
            ]
          },
          {
            id: 'details',
            label: 'What would you like to build? (optional)',
            kind: 'multiline',
            value: ''
          }
        ],
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'create', label: 'Choose folder…', primary: true }
        ]
      },
      async (action) => {
        const setup = action.values.setup
        if (!['react', 'next', 'svelte', 'custom'].includes(setup))
          throw new Error('Choose a starting point.')
        const destination = await this.invoke('project:pick-new')
        if (!destination || this.current?.state.id !== action.id) return
        const result = await this.invoke('project:create', destination, {
          template: setup === 'react' ? 'react' : 'empty'
        })
        if (this.current?.state.id !== action.id) return
        if (!result.ok || !result.root) throw new Error(result.error || 'Could not create project')
        this.close()
        await this.workspace.command({ type: 'open', root: result.root })
        const project = this.workspace.active
        if (!project || project.root !== result.root) return
        const text = action.values.details?.trim() ?? ''
        if (setup === 'react') {
          if (text) await this.chat.command({ type: 'seed', chat: project.activeSessionKey, text })
        } else {
          const preference =
            setup === 'custom'
              ? 'Let’s plan a new project and choose the environment together.'
              : `Let’s plan a new ${setup === 'next' ? 'Next.js' : 'Svelte'} project.`
          await this.chat.command({
            type: 'submit',
            chat: project.activeSessionKey,
            text:
              preference +
              ' Please ask me what I want to build and help me decide any remaining setup choices before creating the app.\n' +
              text
          })
        }
        if (result.warning) this.workspace.reportError(result.warning)
      }
    )
  }
}
