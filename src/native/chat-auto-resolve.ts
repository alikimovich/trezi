import { incidents } from '../main/self-heal/incidents'
import type { AgentEvent } from '../shared/api'
import { resolveHeld } from './chat-actions'
import type { NativeChatController } from './chat-controller'
import { needsResolve } from './chat-queue'
import { writeRecoveryReport } from './chat-recovery-report'
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
    chat.autoResolveTurn = undefined
    chat.autoResolveAttempt = undefined
    chat.autoResolveIncarnation = undefined
    chat.acceptedRecoveryFailure = undefined
    return
  }
  if (chat.autoResolved) {
    // The resolution turn's own `done` still sees the old park: only a new park event is a failure.
    if (chat.autoResolved === 'tried' && parkedAgain) {
      chat.autoResolved = 'failed'
      chat.autoResolveTurn = undefined
      chat.autoResolveAttempt = undefined
      report(chat, 'failed')
    }
    return
  }
  if (!needsResolve(chat) || chat.isRunning || chat.sending) return
  chat.autoResolved = 'tried'
  running.add(chat.chat)
  void resolveHeld(controller, chat)
    .catch(() => {
      if (chat.autoResolved === 'tried') {
        chat.autoResolved = 'failed'
        chat.autoResolveTurn = undefined
        chat.autoResolveAttempt = undefined
        report(chat, 'failed')
        controller.changed(chat)
      }
    })
    .finally(() => running.delete(chat.chat))
}

/** An admitted Resolve turn ended without clearing its park. Settle that attempt once. */
export function autoResolveTurnError(
  controller: NativeChatController,
  chat: Chat,
  owner: Extract<AgentEvent, { type: 'owner-terminal' }>['owner']
): void {
  const pending = chat.pendingRecoveryError
  const settled = chat.recoverySettlement
  if (
    chat.autoResolved !== 'tried' ||
    !pending ||
    !settled ||
    settled.outcome !== 'held' ||
    settled.heldOperationId !== owner.heldOperationId ||
    settled.incarnation !== chat.heldOperation?.incarnation ||
    settled.turn !== owner.turn ||
    settled.run !== owner.run ||
    settled.attemptId !== owner.attemptId ||
    owner.turn !== pending.turn ||
    owner.turn !== chat.autoResolveTurn ||
    owner.turn !== chat.turn ||
    owner.attemptId !== chat.autoResolveAttempt ||
    owner.heldOperationId !== chat.heldOperation?.id ||
    (chat.autoResolveIncarnation && owner.incarnation !== chat.autoResolveIncarnation) ||
    chat.isolation !== 'parked' ||
    chat.stopping ||
    !chat.recoveryId
  )
    return
  const { message } = pending
  const turn = owner.turn
  const operation = chat.recoveryId
  const cancellation = chat.cancellation
  chat.autoResolved = 'failed'
  chat.autoResolveTurn = undefined
  chat.autoResolveAttempt = undefined
  chat.autoResolveIncarnation = undefined
  chat.pendingRecoveryError = undefined
  chat.acceptedRecoveryFailure = undefined
  chat.recoverySettlement = undefined
  chat.recoveryProblem = `Problem: ${message}`
  chat.recoveryReport = undefined
  chat.heldIncident = { turn, operation, gate: 'agent-error', attention: 'recording' }
  report(chat, 'failed')
  const current = () =>
    controller.chats.get(chat.chat) === chat &&
    chat.cancellation === cancellation &&
    chat.recoveryId === operation &&
    chat.heldOperation?.id === owner.heldOperationId &&
    chat.isolation === 'parked'
  void writeRecoveryReport(chat, 'automatic resolve turn', message, current).then(
    (path) => {
      if (!current() || chat.heldIncident?.operation !== operation) return
      if (path) chat.recoveryReport = path
      chat.heldIncident.attention = 'terminal'
      controller.changed(chat)
    },
    () => {
      if (!current() || chat.heldIncident?.operation !== operation) return
      chat.recoveryProblem += ' The support report could not be written.'
      chat.heldIncident.attention = 'terminal'
      controller.changed(chat)
    }
  )
}
