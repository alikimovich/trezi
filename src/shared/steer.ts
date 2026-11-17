import type { SteerReason } from './api'

/**
 * LKM-709: "Steer now" gives a queued owner message to the turn that is running, through
 * the provider's own mid-turn input. Only Claude has one: the Agent SDK's streaming input
 * takes a uuid-stamped `priority: 'next'` user message, the CLI folds it into the running
 * turn between tool rounds and names it in `user_message_uuids`, and `cancelAsyncMessage`
 * withdraws one the turn ended without. Codex runs each turn as one `codex exec` request
 * and the Gemini CLI one prompt per turn: neither takes input mid-turn, so their queue
 * only waits, and the menu says why.
 */
export function steerProvider(provider?: string, connectionId?: string): string | null {
  if (connectionId) return 'Custom endpoints take one request per turn, so this waits in the queue.'
  const id = provider ?? 'claude'
  if (id === 'claude') return null
  if (id === 'codex')
    return 'Codex takes one request per turn, so this waits for the turn to finish.'
  if (id === 'gemini')
    return 'Gemini takes one prompt per turn, so this waits for the turn to finish.'
  return 'This provider cannot take a message mid-turn, so this waits in the queue.'
}

/** Why a steer came back without reaching the turn, for the queue's note. */
export function steerReasonText(reason: SteerReason | undefined): string {
  switch (reason) {
    case 'idle':
      return 'Not steered — no turn was running; it sends next as usual'
    case 'starting':
      return 'Not steered — the turn was still starting; it sends next as usual'
    case 'unsupported':
      return 'Not steered — this provider cannot take a message mid-turn; it sends next as usual'
    case 'unconfirmed':
      return 'Not steered — Claude has not confirmed a message in this session yet; try again in a moment'
    case 'command':
      return 'Not steered — slash commands run as their own turn; it sends next as usual'
    case 'busy':
      return 'Not steered — another steer is still on its way'
    case 'turn-ended':
      return 'Not steered — the turn finished first; it sends next as usual'
    case 'stopped':
      return 'Not steered — the turn stopped first; it stays queued'
    default:
      return 'Not steered — it stays queued'
  }
}

export const STEER_UNCERTAIN =
  'Steer unconfirmed — Claude did not say whether it took this message. Check the reply; it stays here paused so it never sends twice'
