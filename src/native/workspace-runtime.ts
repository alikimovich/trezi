import type { NativeShellAction } from '../shared/native-shell'
import type { NativeWorkspaceCommand } from '../shared/native-workspace'
import {
  parsePreferredModelState,
  rememberLastUsed,
  resolvePreferredSettings
} from '../shared/preferred-model'
import type { NativeBridge } from './bridge'
import type { NativeChatController } from './chat-controller'
import { dispatchIPC, type NativeView } from './platform'
import type { NativePreferences } from './preferences'
import type { WorkspaceStore } from './workspace'
import { NativeWorkspaceController } from './workspace-controller'

export let nativeWorkspace: NativeWorkspaceController
export function installNativeWorkspace(
  host: NativeBridge,
  view: NativeView,
  store: WorkspaceStore,
  chat: NativeChatController,
  preferences: NativePreferences
) {
  const invoke = (channel: string, ...args: any[]) =>
    dispatchIPC('main', { type: 'invoke', channel, args })
  nativeWorkspace = new NativeWorkspaceController({
    invoke,
    store,
    render: (state) => view.webContents.send('native-workspace:state', state),
    closeChat: (key) => chat.close(key),
    reusableChat: (key) => {
      const value = chat.chats.get(key)
      return !value || (!value.text && !value.messages.length && !value.attachments.length)
    },
    activate: async (entry) => {
      const key = entry?.activeSessionKey ?? ''
      const previous = chat.chats.get(key)?.context
      await chat.command({
        type: 'context',
        context: {
          chat: key,
          root: entry?.root ?? null,
          selection: null,
          turn: {
            projectUi: preferences.get('trezi:project-ui:v1') === 'true',
            projectUiEngine:
              preferences.get('trezi:project-ui-engine:v1') === 'jev' ? 'jev' : 'agent'
          },
          setup: { needed: false, dismissed: false, status: null },
          tokens: { needed: false, dismissed: false },
          notes: [],
          spawns: [],
          ...(previous?.root === entry?.root ? previous : {})
        }
      })
    }
  })
  const originalEffect = chat.services.effect
  chat.services.effect = (effect) => {
    if (effect.type === 'settings') {
      const entry = nativeWorkspace.state.projects.find((p) => p.root === effect.root)
      if (entry) {
        entry.chatSettings = { ...entry.chatSettings, [effect.chat]: effect.settings }
        const remember = (raw: string | null) => {
          let saved: unknown
          try {
            saved = JSON.parse(raw ?? 'null')
          } catch {}
          return rememberLastUsed(parsePreferredModelState(saved), effect.settings)
        }
        // Recomputed from the committed state when sent, so queued changes compose.
        void preferences
          .apply((current) => [
            [
              'trezi:preferred-model',
              JSON.stringify(remember(current['trezi:preferred-model'] ?? null))
            ]
          ])
          .catch((error) => nativeWorkspace.reportError(error))
        nativeWorkspace.preferred = resolvePreferredSettings(
          remember(preferences.get('trezi:preferred-model'))
        )
        nativeWorkspace.changed()
      }
    }
    originalEffect(effect)
  }
  const run = (command: NativeWorkspaceCommand) => {
    void nativeWorkspace.command(command).catch((error) => nativeWorkspace.reportError(error))
  }
  host.on('recent', ({ root }) => run({ type: 'open', root }))
  host.on('menu', ({ action }) => {
    if (action === 'open-project') run({ type: 'open' })
  })
  host.on('shell-action', (action: NativeShellAction) => {
    // Outline selection supplies the destination row ID, not a project field.
    const key = action.id?.startsWith('project:')
      ? action.id.slice(8)
      : (action.project ?? nativeWorkspace.state.activeKey)
    if (!key) return
    if (action.action === 'project-reorder') {
      void nativeWorkspace
        .reorderProject(key, action.value || null)
        .catch((error) => nativeWorkspace.reportError(error))
      return
    }
    if (action.action === 'new-chat') run({ type: 'new-chat', key })
    else if (action.action === 'select' && action.id?.startsWith('project:'))
      run({ type: 'select', key })
    else if (action.action === 'select' && action.id?.startsWith('chat:'))
      run({ type: 'chat', key, session: action.id.slice(5) })
    else if (action.action === 'close' && action.id?.startsWith('project:'))
      run({ type: 'close', key })
    else if (action.action === 'close' && action.id?.startsWith('chat:'))
      run({ type: 'close-chat', key, session: action.id.slice(5) })
  })
  return nativeWorkspace
}
export function workspaceOwnsAction(action: NativeShellAction) {
  return (
    action.action === 'new-chat' ||
    (['select', 'close'].includes(action.action) && /^(project|chat):/.test(action.id ?? ''))
  )
}
