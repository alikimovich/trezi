import type { ModelChoice } from '../shared/api'
import type { ChatAgentSettings } from '../shared/chat-settings'
import type { NativeChatAction, NativeChatStart } from '../shared/native-chat'
import {
  defaultChoiceFor,
  type ProviderOption,
  providerKeyFor,
  providerOptions
} from '../shared/provider-choices'
import type { ProviderReadinessMap } from '../shared/provider-readiness'
import type { NativeChatController } from './chat-controller'
import { startLoginCard } from './chat-login'
import { recoveryCards } from './chat-recovery'
import type { Chat } from './chat-state'

/**
 * LKM-232: the centered start composer. A new, empty chat shows one wide composer under
 * "What do you want to create?"; its first accepted message moves the same chat to the
 * left column and reveals the preview. The state is derived from the chat on every
 * snapshot. The no-project chat (`HOME`, key '') keeps its draft until a project is
 * chosen, then the draft moves into that project's new chat and is sent exactly once.
 */
export const HOME = ''
export const START_HEADING = 'What do you want to create?'
const SEAT = { claude: 'Claude', codex: 'Codex' } as const

export interface StartWorkspace {
  /** The active project's name, null when none is chosen yet. */
  project(): string | null
  recents(): { root: string; name: string }[]
  /** The workspace's own progress line ("Opening Site…"), empty when idle. */
  busy(): string
  /** The model new projects open with; the no-project draft starts from it. */
  preferred(): ChatAgentSettings
}

/** Providers a message can be sent with now: a signed-in seat or a saved connection. */
export function usableProviders(
  choices: ModelChoice[],
  readiness: ProviderReadinessMap
): ProviderOption[] {
  return providerOptions(choices).filter(
    (option) => !!option.connectionId || readiness[option.provider].status === 'ready'
  )
}

/** The chat's selected provider is among the usable ones. */
const selectable = (chat: Chat, usable: ProviderOption[]) =>
  usable.some((option) => option.key === providerKeyFor(chat.settings))

const checking = (readiness: ProviderReadinessMap) =>
  readiness.claude.status === 'checking' || readiness.codex.status === 'checking'

/** Anything the transcript must show stays in the left layout (a card, a question). */
function blocked(chat: Chat) {
  const context = chat.context
  return (
    !!chat.pendingModel ||
    chat.permissions.length > 0 ||
    chat.questions.length > 0 ||
    chat.isolation === 'parked' ||
    (!!context?.setup.needed && !context.setup.dismissed) ||
    (context?.spawns.length ?? 0) > 0 ||
    recoveryCards(chat).length > 0
  )
}

const sameModel = (a: ChatAgentSettings, b: ChatAgentSettings) =>
  a.model === b.model &&
  a.provider === b.provider &&
  a.connectionId === b.connectionId &&
  a.permissionMode === b.permissionMode

export class StartFlow {
  /** Off in the smoke suite until a check opts in, so other groups keep their layout. */
  enabled = false
  /** A send from the no-project draft waits for a destination. */
  pending = false
  /** The chat whose draft follows the next chat switch (a project picked from it). */
  carry: string | null = null
  /** The chat that received a carried draft, until it is ready to take it. */
  target: string | null = null
  /** The model picked for the carried draft, applied to its new chat. */
  settings?: ChatAgentSettings
  /** The no-project draft's model was picked by the user, not seeded. */
  picked = false
  /** New project: the sheet's planning text, sent ahead of the carried draft. */
  prefix?: { text: string; send: boolean }
  workspace?: StartWorkspace

  /** The no-project draft starts from the preferred model until the user picks one, or
   *  from the first provider that can answer when the preferred one cannot. */
  seed(chat: Chat, choices: ModelChoice[], readiness: ProviderReadinessMap) {
    if (chat.chat !== HOME || this.picked || !this.workspace) return
    const preferred = this.workspace.preferred()
    const usable = usableProviders(choices, readiness)
    const fallback = usable.some((option) => option.key === providerKeyFor(preferred))
      ? undefined
      : usable[0] && defaultChoiceFor(usable[0])
    chat.settings = fallback
      ? {
          ...preferred,
          model: fallback.value,
          modelId: fallback.modelId,
          provider: fallback.provider,
          connectionId: fallback.connectionId
        }
      : preferred
  }

  hasDraft(chat: Chat | undefined) {
    return !!chat && (!!chat.text.trim() || chat.attachments.length > 0)
  }

  state(chat: Chat, choices: ModelChoice[], readiness: ProviderReadinessMap): NativeChatStart {
    const home = chat.chat === HOME
    const usable = usableProviders(choices, readiness)
    const empty =
      !chat.messages.length &&
      !chat.queue.length &&
      !chat.isRunning &&
      !chat.sending &&
      !chat.login &&
      !blocked(chat)
    const centered =
      this.enabled &&
      empty &&
      (home ||
        ((chat.ready || this.target === chat.chat) && (usable.length > 0 || checking(readiness))))
    return {
      centered,
      home,
      ready: selectable(chat, usable),
      heading: START_HEADING,
      notice: centered ? this.notice(chat, usable, readiness) : undefined,
      project: {
        title: home ? null : (this.workspace?.project() ?? null),
        recents: (this.workspace?.recents() ?? []).slice(0, 8)
      }
    }
  }

  private notice(
    chat: Chat,
    usable: ProviderOption[],
    readiness: ProviderReadinessMap
  ): NativeChatStart['notice'] {
    if (chat.error)
      return { text: chat.error, actions: [{ label: 'Dismiss', action: 'error-dismiss' }] }
    const busy = chat.chat === HOME ? (this.workspace?.busy() ?? '') : ''
    if (busy) return { text: busy, progress: true, actions: [] }
    // No provider can answer: LKM-231's own sign-in card, here under the composer.
    const start = usable.length ? null : startLoginCard(chat, readiness)
    if (start && !checking(readiness))
      return { text: start.detail ?? start.title, actions: start.actions }
    if (chat.signingIn || chat.signInMessage)
      return {
        text: chat.signInMessage ?? '',
        progress: !!chat.signingIn,
        actions: chat.signingIn ? [{ label: 'Cancel sign-in', action: 'sign-in-cancel' }] : []
      }
    if (this.pending && chat.chat === HOME)
      return {
        text: 'Choose a project for this message. It is sent once the project opens.',
        actions: [
          { label: 'Open Project…', action: 'start-open' },
          { label: 'New Project…', action: 'start-new' },
          { label: 'Cancel', action: 'start-cancel' }
        ]
      }
    // The selected provider stopped answering while another still can: keep the draft.
    const lost = usable.length > 0 && !selectable(chat, usable)
    if (lost && !checking(readiness)) {
      const provider = chat.settings.provider
      const seat =
        !chat.settings.connectionId && (provider === 'claude' || provider === 'codex')
          ? provider
          : null
      const label = seat ? SEAT[seat] : 'This connection'
      const other = usable[0]
      return {
        text: `${label} is not signed in. Your draft is kept.`,
        actions: [
          ...(seat ? [{ label: `Sign in to ${SEAT[seat]}`, action: `sign-in-${seat}` }] : []),
          { label: `Use ${other.label}`, action: 'start-provider', value: other.key }
        ]
      }
    }
    if (!usable.length) return { text: 'Checking provider sign-in…', progress: true, actions: [] }
    return undefined
  }

  /** A send from the no-project draft: an empty one stays put, any other waits for a
   *  project. Without a provider that can answer it stays a draft (Send is disabled too). */
  request(controller: NativeChatController, chat: Chat, raw: string) {
    if (!raw.trim() && !chat.attachments.length) return
    if (!selectable(chat, usableProviders(controller.choices, controller.readiness))) return
    chat.text = raw
    this.pending = true
    controller.changed(chat)
  }

  /** A centered chat whose selected provider cannot answer keeps its draft unsent. */
  holds(controller: NativeChatController, chat: Chat) {
    const state = this.state(chat, controller.choices, controller.readiness)
    return state.centered && !state.ready
  }

  /** The start surface's own actions; false leaves the action to the chat's cards. */
  async action(controller: NativeChatController, chat: Chat, action: NativeChatAction) {
    switch (action.action) {
      case 'start-open':
      case 'start-recent':
      case 'start-new':
        if (this.hasDraft(chat) || this.pending) this.carry = chat.chat
        controller.services.effect({
          type: 'start-project',
          ...(action.action === 'start-new' ? { create: true } : {}),
          ...(action.action === 'start-recent' && action.value ? { root: action.value } : {})
        })
        return true
      case 'start-cancel':
        this.pending = false
        this.carry = null
        return true
      case 'start-provider':
        if (action.value) await controller.choice(chat, 'Provider', action.value)
        return true
    }
    return false
  }

  /** The active chat changed. A draft from the no-project chat (or one carried from a
   *  chat whose project menu was used) moves into the new chat, never over its own draft. */
  arrive(controller: NativeChatController, from: string, chat: Chat) {
    const source = controller.chats.get(from)
    const carrying = from === HOME || from === this.carry
    this.carry = null
    if (!carrying || !source || source === chat) return
    if (!this.hasDraft(source) && !this.pending) return
    if (this.hasDraft(chat)) return
    chat.text = source.text
    chat.caret = source.caret
    chat.attachments = source.attachments
    chat.dismissed = true
    source.text = ''
    source.caret = 0
    source.attachments = []
    source.revision++
    this.settings = source.settings
    this.target = chat.chat
  }

  /** The carried draft's chat is ready: its model, then the one send a pending draft owes. */
  async settle(controller: NativeChatController, chat: Chat) {
    if (this.target !== chat.chat || !chat.ready) return
    this.target = null
    // An existing conversation keeps its history: the draft starts a new chat beside it.
    if (chat.messages.length) {
      this.carry = chat.chat
      controller.services.effect({ type: 'start-chat', root: chat.root })
      return
    }
    const settings = this.settings
    this.settings = undefined
    this.picked = false
    if (settings && !sameModel(settings, chat.settings))
      await controller.changeModel(chat, settings).catch((error) => {
        chat.error = String(error)
      })
    const prefix = this.prefix
    this.prefix = undefined
    if (prefix?.text) chat.text = chat.text.trim() ? `${prefix.text}\n\n${chat.text}` : prefix.text
    chat.caret = chat.text.length
    const send = this.pending || !!prefix?.send
    this.pending = false
    controller.changed(chat)
    if (send) await controller.submit(chat)
  }
}
