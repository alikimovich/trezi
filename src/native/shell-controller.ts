import { previewLoads } from '../main/preview-loads'
import { previewSpeed } from '../main/preview-speed'
import type { NativeChatEffect } from '../shared/native-chat-controller'
import type { NativeShellAction, NativeShellRow, NativeShellState } from '../shared/native-shell'
import type { NativeProjectStatus } from '../shared/native-workspace'
import type { NativeChatController } from './chat-controller'
import { chatThinking } from './chat-snapshot'
import { displayText, rememberProject } from './display-paths'
import type { NativeGitController } from './git-controller'
import type { NativePreferences } from './preferences'
import { recentChats, shortAgo } from './sidebar-chats'
import type { NativeWorkspaceController } from './workspace-controller'

const title = (text?: string, fallback = 'New chat') =>
  text?.replace(/\s+/g, ' ').trim().slice(0, 70) || fallback
export class NativeShellController {
  hidden = false
  selecting = false
  codeOpen = false
  location: string | null = null
  /** The user turned the select tool off: the page selection goes with it (LKM-344). */
  selectOff: () => void = () => {}
  readonly icons = new Map<string, string | undefined>()
  private signature = ''
  private timer?: ReturnType<typeof setTimeout>
  constructor(
    readonly workspace: NativeWorkspaceController,
    readonly chat: NativeChatController,
    readonly git: NativeGitController,
    readonly preferences: NativePreferences,
    readonly send: (state: NativeShellState) => void,
    readonly project: (value: {
      chatHidden: boolean
      viewport: string
      selectMode: boolean
    }) => void
  ) {
    this.hidden = preferences.get('trezi:chat-hidden') === '1'
    chat.chatHidden = this.hidden
  }
  /** A chat effect that changes what the sidebar rows show: its mirror, or whether its title
   *  shimmers (`chatThinking`, which the mirror lacks). */
  chatEffect(effect: NativeChatEffect) {
    if (effect.type === 'mirror' || effect.type === 'activity') this.schedule()
  }
  schedule() {
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.render()
      }, 16)
  }
  render() {
    const ws = this.workspace.state,
      active = this.workspace.active
    // Slow motion belongs to the open project's preview session (LKM-206).
    previewSpeed.scope(active?.key ?? null)
    for (const entry of ws.projects) rememberProject(entry.root)
    const status: NativeProjectStatus =
      ws.status.kind === 'error'
        ? { ...ws.status, message: displayText(ws.status.message), detail: ws.status.message }
        : ws.status
    for (const entry of ws.projects)
      if (!this.icons.has(entry.root)) {
        this.icons.set(entry.root, undefined)
        void this.workspace.services
          .invoke('project:icon', entry.root)
          .then((icon) => {
            this.icons.set(entry.root, icon?.dataUrl)
            this.schedule()
          })
          .catch(() => {})
      }
    const rows: NativeShellState['rows'] = ws.projects.map((p) => {
      const chats = new Map(
        p.sessionKeys.map((key) => {
          const chat = this.chat.chats.get(key)
          const row: NativeShellRow = {
            id: `chat:${key}`,
            project: p.key,
            session: key,
            kind: 'chat',
            title: chat?.title || title(chat?.messages.find((m) => m.role === 'user')?.text),
            running: chat?.isRunning ?? false,
            thinking: chat ? chatThinking(chat) : false,
            unread: chat?.unreadAnswer ?? false
          }
          return [key, row]
        })
      )
      // LKM-378: only the selected project nests its chats; the others stay compact.
      const recent = p.key === active?.key ? recentChats(p.sessionKeys) : null
      return {
        id: `project:${p.key}`,
        project: p.key,
        title: p.name,
        icon: this.icons.get(p.root),
        kind: 'project' as const,
        ...(recent && { recent: recent.flatMap((key) => chats.get(key) ?? []) }),
        children: [
          ...chats.values(),
          ...(ws.history[p.key] ?? []).map((r) => ({
            id: `history:${r.id}`,
            project: p.key,
            record: r.id,
            kind: 'history' as const,
            detail: shortAgo(r.startedAt),
            title:
              r.title || title(r.transcript.find((m) => m.role === 'user')?.text, 'Previous chat')
          }))
        ]
      }
    })
    let url = active?.url ?? null
    try {
      if (url && this.location && new URL(url).origin === new URL(this.location).origin)
        url = this.location
    } catch {}
    const state = this.git.decorate({
      previewStatus: status,
      previewLoad: status.kind === 'running' && active?.url ? previewLoads.banner : null,
      rows,
      project: active?.key ?? null,
      selection: ws.selection ?? 0,
      chatReady: !!active && ws.loadedKey === active.key && status.kind !== 'error',
      selected: active ? `chat:${active.activeSessionKey}` : null,
      homeState: {
        visible: !active,
        busy: status.kind === 'busy',
        label:
          status.kind === 'busy' ? status.label : status.kind === 'error' ? status.message : '',
        recents: ws.recents
      },
      selectMode: this.selecting,
      previewReady: ws.status.kind === 'running',
      chatWidth: Number(this.preferences.get('trezi:native-chat-width')) || 440,
      chatHidden: this.hidden,
      branch: active?.branch ?? null,
      branches: [],
      publishLabel: 'Publish',
      publishing: false,
      publishCancellable: false,
      publishMode: this.git.mode,
      codeOpen: this.codeOpen,
      previewBase: active?.url ?? null,
      previewURL: url,
      viewport: active?.viewport ?? 'desktop',
      deviceEnabled: !!active?.url && active.previewKind !== 'simulator'
    })
    const signature = JSON.stringify(state)
    if (signature === this.signature) return
    this.signature = signature
    this.send(state)
    this.project({ chatHidden: this.hidden, viewport: state.viewport, selectMode: this.selecting })
  }
  async action(action: NativeShellAction) {
    const entry = this.workspace.active
    if (action.action === 'expand') {
      this.hidden = !this.hidden
      this.chat.chatHidden = this.hidden
      this.render()
      await this.preferences.set('trezi:chat-hidden', this.hidden ? '1' : '0')
      return
    }
    if (!entry) return
    const invoke = this.workspace.services.invoke
    if (action.action === 'select-object') {
      this.selecting = !this.selecting
      // The toolbar shows the new mode at once, not after the preview round trip.
      this.render()
      if (!this.selecting) this.selectOff()
      await invoke('preview:set-select-mode', this.selecting)
    } else if (action.action === 'device' && entry.previewKind !== 'simulator') {
      entry.viewport = entry.viewport === 'mobile' ? 'desktop' : 'mobile'
      this.workspace.changed()
    } else if (action.action === 'address' && entry.url) {
      const origin = new URL(entry.url).origin,
        raw = action.value?.trim() ?? ''
      const url = new URL(
        raw.startsWith('/') || /^https?:\/\//i.test(raw) ? raw : '/' + raw,
        origin
      )
      if (url.origin !== origin)
        throw new Error('The preview address must stay within this project.')
      await invoke('preview:load', url.href)
    } else if (action.action === 'home' && entry.url) await invoke('preview:load', entry.url)
    this.render()
  }
}
