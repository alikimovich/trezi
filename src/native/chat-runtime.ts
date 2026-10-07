import { currentTurn } from '../main/agent'
import { IslandBindingError, islandProblem } from '../main/chat-island-bindings'
import { ChatIslands, installChatIslands } from '../main/chat-islands'
import { IslandOverrides } from '../main/island-overrides'
import { previewServers } from '../main/preview-evidence'
import type { AgentEvent } from '../shared/api'
import { chatAgentSettingsFromOptions } from '../shared/chat-settings'
import type { NativeLandingCheck } from '../shared/native-chat'
import type { NativeChatSnapshot } from '../shared/native-chat-controller'
import { projectKey } from '../shared/projectKey'
import type { NativeBridge } from './bridge'
import { type ChatServices, NativeChatController } from './chat-controller'
import { chatFrames } from './chat-frames'
import { addReference, setIslandDirectory } from './chat-island-refs'
import { islandLocator, islandRestorer } from './chat-island-session'
import { islandPreviewPort } from './island-preview'
import { LandingChecks, landingCheckMessage, previewLandingHost } from './landing-check'
import { dispatchIPC, type NativeView, serviceEvents, views } from './platform'
import { TurnBoundaries } from './turn-boundaries'

export let nativeIslands: ChatIslands
const boundaries = new TurnBoundaries()
/** Turn boundaries per chat (begin, landed, failed), for deferred preview navigation. */
export const turnBoundaries = new Set<
  (key: string, kind: 'begin' | 'landed' | 'failed', turn: string | null) => void
>()
export let nativeChat: NativeChatController
/** LKM-195: the post-landing preview check, one row in the chat that landed. */
export function postLandingCheck(key: string, check: NativeLandingCheck, afterId?: string) {
  const chat = nativeChat.chats.get(key)
  if (!chat || nativeChat.closed.has(key)) return
  const row = landingCheckMessage(check, Date.now())
  // Under the landed turn's reply, even when a queued turn has started since.
  const index = chat.messages.findIndex((m) => m.id === afterId)
  if (index >= 0) chat.messages.splice(index + 1, 0, row)
  else chat.messages.push(row)
  nativeChat.changed(chat)
}
export let landingChecks: LandingChecks
export function installNativeChat(
  host: NativeBridge,
  view: NativeView,
  notice?: ChatServices['notice'],
  /** Off in the smoke suite, whose landings are fixtures; `landing-check` drives its own. */
  checkLandings = true
) {
  landingChecks = new LandingChecks(
    previewLandingHost((root) => previewServers.get(projectKey(root))?.url ?? null),
    postLandingCheck
  )
  const turnOf = (key: string) =>
    nativeChat.get(key).messages.filter((m) => m.role === 'user').length
  const islands = new ChatIslands(
    (key) => {
      const chat = nativeChat.chats.get(key)
      if (chat) nativeChat.changed(chat)
    },
    undefined,
    {
      origin: currentTurn,
      overrides: new IslandOverrides(islandPreviewPort()),
      locate: islandLocator(
        (channel, ...args) => dispatchIPC('main', { type: 'invoke', channel, args }),
        turnOf,
        (key) => nativeChat.closed.has(key)
      )
    }
  )
  nativeIslands = islands
  installChatIslands(islands)
  const renderIslands = (state: NativeChatSnapshot) => {
    const messages = state.messages.map((message) => ({
      ...message,
      segments: [...message.segments]
    }))
    for (const attachment of islands.attachments(state.chat)) {
      let turn = 0
      const message = messages.find((message) => {
        if (message.role === 'user') turn++
        return message.role === 'assistant' && turn === attachment.turn
      })
      if (message && attachment.view)
        message.segments.push({ kind: 'island', island: attachment.view })
    }
    return { ...state, messages }
  }
  const frame = chatFrames()
  nativeChat = new NativeChatController({
    restoreIslands: islandRestorer(islands, turnOf),
    invoke: (channel, ...args) => dispatchIPC('main', { type: 'invoke', channel, args }),
    render: (state) => host.send('chatState', { state: frame(renderIslands(state)) }),
    effect: (effect) => {
      if (effect.type === 'focus') host.send('composerFocus')
    },
    notice
  })
  // The composer's "#" picker lists the chat's islands (LKM-181).
  setIslandDirectory((key) =>
    [...(islands.sessions.get(key)?.views.values() ?? [])].map(({ id, name, title, status }) => ({
      id,
      name,
      title,
      status
    }))
  )
  host.on('island-action', (command) => {
    if (command.chat !== nativeChat.active || !nativeChat.chats.has(command.chat)) return
    const chat = nativeChat.get(command.chat)
    void (async () => {
      try {
        if (command.action === 'reference' || command.action === 'recreate') {
          const view = islands.sessions.get(command.chat)?.views.get(command.id)
          if (!view) throw new IslandBindingError('This island is no longer in this chat.')
          if (command.action === 'reference') addReference(chat, view.name)
          else {
            // Recreate with agent: a message the user can edit before sending.
            const line = `Recreate ${view.name} with the current code.`
            chat.text = chat.text.trim() ? `${line} ${chat.text}` : line
            chat.caret = chat.text.length
            chat.dismissed = true
          }
          nativeChat.changed(chat)
          host.send('composerFocus')
        } else if (command.action === 'replay') {
          const record = islands.sessions
            .get(command.chat)
            ?.records.find(
              (r) => r.id === command.id && r.revision === command.revision && r.status === 'ready'
            )
          if (!record?.manifest.replay) throw new Error('Replay is unavailable.')
          views
            .get('preview')
            ?.webContents.send('preview:animation-replay', record.manifest.component)
        } else await islands.interact(command)
      } catch (error) {
        // One plain line, never exception text (LKM-181).
        chat.error = islandProblem(error)
        nativeChat.changed(chat)
      }
    })()
  })
  // A file change reaches the preview as a DOM change: check the active chat's bindings again.
  let recheck: ReturnType<typeof setTimeout> | undefined
  serviceEvents.on('event', (channel: string) => {
    if (channel !== 'layers:changed') return
    clearTimeout(recheck)
    recheck = setTimeout(() => {
      if (nativeChat.active) void islands.refresh(nativeChat.active).catch(() => {})
    }, 400)
  })
  const stop = nativeChat.stop.bind(nativeChat)
  nativeChat.stop = async (chat) => {
    try {
      await islands.settle(chat.chat, false, currentTurn(chat.chat))
    } finally {
      await stop(chat)
    }
  }
  const close = nativeChat.close.bind(nativeChat)
  nativeChat.close = (key) => {
    islands.close(key)
    landingChecks.cancel(key)
    boundaries.forget(key)
    for (const listener of turnBoundaries) listener(key, 'failed', null)
    close(key)
  }
  host.on('composer-action', (action) => {
    void nativeChat.composer(action)
  })
  host.on('chat-action', (action) => {
    void nativeChat.action(action)
  })
  serviceEvents.on('event', (channel: string, event: AgentEvent) => {
    if (channel === 'agent:event') {
      nativeChat.event(event)
      const key = event.projectKey
      // A turn's work reached the live checkout after the agent finished: check the preview.
      if (
        checkLandings &&
        key &&
        !event.sessionId &&
        event.type === 'isolation' &&
        event.state === 'merged'
      ) {
        const chat = nativeChat.chats.get(key)
        if (chat)
          void landingChecks
            .landed(key, chat.root, event.files ?? [], chat.messages.at(-1)?.id)
            .catch(() => {})
      }
      if (key && !event.sessionId)
        for (const { kind, turn } of boundaries.events(key, event)) {
          for (const listener of turnBoundaries) listener(key, kind, turn)
          // A chat's workspace is ready once a turn runs: its islands must be too (LKM-199).
          if (kind === 'begin' && !islands.sessions.has(key)) void islands.ensure(key)
          // Only the islands the ending turn defined are activated (or made unavailable).
          if (kind !== 'begin')
            void islands.settle(key, kind === 'landed', turn).catch((error) => {
              const chat = nativeChat.chats.get(key)
              if (chat) {
                chat.error = islandProblem(error)
                nativeChat.changed(chat)
              }
            })
        }
    }
  })
  serviceEvents.on('command', (channel: string, args: any[], result: any) => {
    if (channel === 'agent:close-chat' && result.ok) nativeChat.close(args[1])
    else if (channel === 'agent:close-project') {
      for (const [key, chat] of nativeChat.chats) if (chat.root === args[0]) nativeChat.close(key)
    } else if (channel === 'agent:rename-chat' && result.ok) {
      const chat = nativeChat.get(args[0])
      chat.title = result.title
      nativeChat.changed(chat)
    } else if (channel === 'agent:restart-chat' && result.ok) {
      const chat = nativeChat.chats.get(args[1])
      if (chat) {
        chat.settings = chatAgentSettingsFromOptions(args[2])
        nativeChat.changed(chat)
        // A provider switch keeps the record; a chat without islands gets them here.
        void islands.ensure(args[1])
      }
    } else if (
      channel === 'agent:open-project' ||
      channel === 'agent:new-chat' ||
      channel === 'agent:resume-session'
    ) {
      // The shell may publish context before the session-creation reply arrives.
      for (const chat of nativeChat.chats.values())
        if (!chat.ready && chat.context?.root === args[0]) void nativeChat.initialize(chat)
    } else if (
      channel.startsWith('providers:') &&
      channel !== 'providers:choices' &&
      channel !== 'providers:list'
    ) {
      void nativeChat.refreshChoices()
    }
  })
  void nativeChat.refreshChoices()
  return nativeChat
}
