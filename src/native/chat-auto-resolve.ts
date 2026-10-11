import { incidents } from '../main/self-heal/incidents'
import { resolveHeld } from './chat-actions'
import type { NativeChatController } from './chat-controller'
import { needsResolve } from './chat-queue'
import type { Chat } from './chat-state'

const running = new Set<string>()

const report = (chat: Chat, outcome: 'recovered' | 'failed'): void =>
  incidents.report({
    chat: chat.chat,
    code: 'conflict',
    recovery: 'resolve',
    outcome,
    attempts: 1
  })

/**
 * LKM-225: a turn whose changes were parked because the live tree moved is resolved once
 * on its own, the same way the Resolve button does. If the park clears the incident
 * recovered; a second park (or a Resolve that cannot start) leaves the card to the user.
 * Call after every isolation / terminal event of the chat; `parkedAgain` is true for a
 * `parked` isolation event.
 */
export function autoResolve(
  controller: NativeChatController,
  chat: Chat,
  parkedAgain: boolean
): void {
  if (running.has(chat.chat)) return
  if (chat.isolation !== 'parked') {
    if (chat.autoResolved === 'tried') report(chat, 'recovered')
    chat.autoResolved = undefined
    return
  }
  if (chat.autoResolved) {
    // The resolution turn's own `done` still sees the old park: only a new park event is a failure.
    if (chat.autoResolved === 'tried' && parkedAgain) {
      chat.autoResolved = 'failed'
      report(chat, 'failed')
    }
    return
  }
  if (!needsResolve(chat) || chat.isRunning || chat.sending) return
  chat.autoResolved = 'tried'
  running.add(chat.chat)
  void resolveHeld(controller, chat)
    .catch(() => {
      chat.autoResolved = 'failed'
      report(chat, 'failed')
    })
    .finally(() => running.delete(chat.chat))
}
