import { basename } from 'node:path'
import { runningAgentWork } from '../main/agent'
import type { NativeBridge } from './bridge'
import type { NativeChatController } from './chat-controller'
import type { NativeDreamerController } from './dreamer-controller'
import type { NativeGitController } from './git-controller'
import type { NativePreferences } from './preferences'
import { QUIT_DONT_ASK_KEY, QuitGuard, type QuitGuardServices, type QuitWork } from './quit-guard'
import type { NativeWorkspaceController } from './workspace-controller'

/** Extra work sources the native smoke adds (a landing fixture); empty in the app. */
export const quitWorkSources = new Set<() => QuitWork[]>()
/** The running app's guard and its preference, for the native smoke. */
export const nativeQuit: {
  current: QuitGuard | null
  setDontAsk: (value: boolean) => Promise<void>
} = { current: null, setDontAsk: async () => {} }

/**
 * LKM-221: the host sends `quit-request` on a user quit and `quit-answer` from its alert
 * or note; the guard answers with `quitAsk`, `quitNote` and `quitProceed`.
 */
export function installQuitGuard(options: {
  host: NativeBridge
  workspace: NativeWorkspaceController
  chat: NativeChatController
  git: NativeGitController
  dreamer: NativeDreamerController
  preferences: NativePreferences
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  overrides?: Partial<QuitGuardServices>
}) {
  const { host, workspace, chat, git, dreamer, preferences, invoke } = options
  const name = (project: string, root: string) =>
    workspace.state.projects.find((p) => p.key === project || p.root === root)?.name ??
    (root ? basename(root) : undefined)
  const guard = new QuitGuard({
    work: () => [
      ...runningAgentWork().map((w) => ({ kind: w.kind, project: name(w.project, w.root) })),
      ...[...git.runs.keys()].map((root) => ({
        kind: 'publish' as const,
        project: name('', root)
      })),
      ...(dreamer.isRunning ? [{ kind: 'dreamer' as const }] : []),
      ...[...quitWorkSources].flatMap((source) => source())
    ],
    // Stop as the chat's Stop button does: the turn's work is held in the chat's copy.
    stop: async () => {
      await Promise.all(
        runningAgentWork().map(async (w) => {
          if (w.kind === 'landing') return
          if (w.kind === 'background') return invoke('agent:spawn-interrupt', w.id)
          const running = chat.chats.get(w.id)
          return running ? chat.stop(running) : invoke('agent:interrupt', w.id)
        })
      )
    },
    dontAsk: () => preferences.get(QUIT_DONT_ASK_KEY) === 'true',
    setDontAsk: () => preferences.set(QUIT_DONT_ASK_KEY, 'true'),
    send: (command, payload) => host.send(command, payload),
    ...options.overrides
  })
  nativeQuit.current = guard
  nativeQuit.setDontAsk = (value) => preferences.set(QUIT_DONT_ASK_KEY, String(value))
  host.on('quit-request', () => guard.request())
  host.on('quit-answer', (message?: { choice?: unknown; dontAsk?: unknown }) => {
    const choice = typeof message?.choice === 'string' ? message.choice : 'cancel'
    void guard.answer(choice, message?.dontAsk === true).catch(console.error)
  })
  return guard
}
