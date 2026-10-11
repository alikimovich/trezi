import type { NativeChatController } from './chat-controller'
import { HOME } from './chat-start'
import type { NativeWorkspaceController } from './workspace-controller'

/**
 * LKM-232: connects the start composer to the workspace. Its project menu opens a recent
 * or the Open panel, or the New Project sheet; a carried draft whose project reopened an
 * existing conversation gets a new chat there. Never writes anywhere on its own.
 */
export function installNativeStart(
  chat: NativeChatController,
  workspace: NativeWorkspaceController,
  newProject: () => void
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
      if (value.create) newProject()
      else
        void workspace
          .command({ type: 'open', ...(value.root ? { root: value.root } : {}) })
          .catch(fail)
    } else if (value.type === 'start-chat') {
      const entry = workspace.state.projects.find((p) => p.root === value.root)
      if (entry) void workspace.command({ type: 'new-chat', key: entry.key }).catch(fail)
    } else effect(value)
  }
  // The no-project screen shows the workspace's own progress ("Opening Site…") and recents.
  const render = workspace.services.render
  workspace.services.render = (state) => {
    render(state)
    if (chat.active === HOME) chat.changed()
  }
}
