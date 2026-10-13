import type { NativeChatController } from './chat-controller'
import { HOME } from './chat-start'
import type { NativeWorkspaceController } from './workspace-controller'

/**
 * Connects an explicit Send or direct start-surface navigation to the workspace. A
 * carried draft whose project reopened an
 * existing conversation gets a new chat there. Never writes anywhere on its own.
 */
export function installNativeStart(
  chat: NativeChatController,
  workspace: NativeWorkspaceController
) {
  chat.start.workspace = {
    project: () => workspace.active?.name ?? null,
    recents: () => workspace.state.recents.map(({ root, name }) => ({ root, name })),
    busy: () => (workspace.state.status.kind === 'busy' ? workspace.state.status.label : ''),
    preferred: () => ({ ...workspace.preferred })
  }
  const fail = (error: unknown) => workspace.reportError(error)
  const effect = chat.services.effect
  chat.services.effect = (value) => {
    if (value.type === 'start-project') {
      if (value.create) void chat.beginPlanning(false)
      else
        void workspace
          .command({ type: 'open', ...(value.root ? { root: value.root } : {}) })
          .then(() => {
            if (
              chat.start.pending &&
              (workspace.active?.root !== value.root || workspace.state.status.kind === 'error')
            ) {
              chat.start.pending = false
              chat.start.carry = null
              chat.changed(chat.get(HOME))
            }
          })
          .catch((error) => {
            chat.start.pending = false
            chat.start.carry = null
            fail(error)
            chat.changed(chat.get(HOME))
          })
    } else if (value.type === 'start-chat') {
      const entry = workspace.state.projects.find((p) => p.root === value.root)
      if (entry) void workspace.command({ type: 'new-chat', key: entry.key }).catch(fail)
    } else if (value.type === 'planning-created') {
      const planning = chat.start.planningKey ? chat.chats.get(chat.start.planningKey) : undefined
      const preferred = workspace.preferred
      if (planning) workspace.preferred = { ...planning.settings }
      void workspace
        .command({ type: 'open', root: value.root })
        .then(async () => {
          chat.start.planningKey = null
          chat.start.returnChat = null
          const active = workspace.active
          if (active)
            await chat.command({
              type: 'submit',
              chat: active.activeSessionKey,
              text: 'Continue implementing the project we planned in this conversation.'
            })
        })
        .catch(fail)
        .finally(() => {
          workspace.preferred = preferred
        })
    } else effect(value)
  }
  // The no-project screen shows the workspace's own progress ("Opening Site…") and recents.
  const render = workspace.services.render
  workspace.services.render = (state) => {
    render(state)
    if (chat.active === HOME) chat.changed()
  }
}
