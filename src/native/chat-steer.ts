import type { AgentEvent, SteerReason } from '../shared/api'
import { quotedPrompt } from '../shared/chat-quotes'
import { STEER_UNCERTAIN, steerProvider, steerReasonText } from '../shared/steer'
import { planAttachments } from './chat-attachments'
import { assistant, type Chat, type Submission } from './chat-state'

/**
 * LKM-709: "Steer now" on a queued owner message: it goes to the turn that is running,
 * through the provider's own mid-turn input (`agent:steer`, Claude only), instead of
 * waiting for the turn to end. The message keeps its place in the queue, marked as on its
 * way, until the provider answers with one `steer` event:
 *  - admitted: it leaves the queue and shows in the transcript where it landed, the reply
 *    continuing below it; it never runs again as a queued turn;
 *  - returned / rejected: it stays queued, unchanged, and the queue's note says why;
 *  - uncertain: it stays queued with the queue paused, so it is never sent twice.
 * A turn that ends with a steer still unanswered leaves it queued (the provider answers
 * before `done`, so this is only a helper that went away).
 */

/** Why this queued message cannot be steered now, or null. */
export function steerBlock(chat: Chat, q: Submission): string | null {
  if (q.action) return 'Trezi’s own Apply runs as its own turn, so it waits in the queue.'
  if (q.chatUiId) return 'An answer to a question goes to the provider as its own turn.'
  if (q.steer) return null
  const provider = steerProvider(chat.settings.provider, chat.settings.connectionId)
  if (provider) return provider
  if (chat.queue.some((other) => other.steer)) return 'Another queued message is being steered in.'
  if (!chat.isRunning || !chat.turn || chat.phase === 'applying' || chat.keepingStopped)
    return 'Steer now works while Claude is working on a turn.'
  if (chat.stopping) return 'The turn is stopping.'
  if (chat.sending) return 'The turn is still starting. Try again in a moment.'
  if (chat.operation) return 'This turn is Trezi’s own, so this waits for it to finish.'
  if (q.turn?.projectUi) return 'Project components mode applies to a whole turn, so this waits.'
  if (q.text.trimStart().startsWith('/')) return 'Slash commands run as their own turn.'
  return null
}

export interface SteerDeps {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  changed: () => void
}

/** "Steer now" on queue row `id` (`queued-<id>`). */
export async function steerQueued(chat: Chat, id: string | undefined, deps: SteerDeps) {
  const q = chat.queue.find((item) => `queued-${item.id}` === id)
  if (!q || q.steer) return
  const block = steerBlock(chat, q)
  if (block) {
    chat.steerNote = `Not steered — ${block}`
    return deps.changed()
  }
  const turn = chat.turn as string
  const request = crypto.randomUUID()
  q.steer = { request, turn }
  chat.steerNote = undefined
  deps.changed()
  // Still this request, still queued: a turn end or a fast answer may have settled it.
  const live = () => chat.queue.includes(q) && q.steer?.request === request
  try {
    const plan = await planAttachments(
      q.attachments,
      (a) =>
        deps.invoke(
          'attachments:save',
          { mediaType: a.type, data: a.data },
          a.name
        ) as Promise<string>
    )
    if (!live()) return
    // Anything that would not reach the turn as it would in its own turn stays queued.
    if (plan.missed || plan.notice) {
      q.steer = undefined
      chat.steerNote =
        'Not steered — some attachments cannot go in mid-turn; it sends next with them as usual'
      return
    }
    const quotes = (q.quotes ?? []).map(({ excerpt, comment }) => ({ excerpt, comment }))
    const prompt = plan.header + (q.selection?.prompt ?? '') + quotedPrompt(quotes, q.text)
    const result = (await deps.invoke(
      'agent:steer',
      chat.chat,
      turn,
      request,
      prompt,
      plan.images.length ? plan.images : undefined
    )) as { ok: boolean; reason?: SteerReason } | undefined
    if (!live() || result?.ok) return
    q.steer = undefined
    chat.steerNote = steerReasonText(result?.reason)
  } catch {
    if (!live()) return
    q.steer = undefined
    chat.steerNote = steerReasonText('unknown')
  } finally {
    deps.changed()
  }
}

/** The provider's answer for a steer. False when no queued message waits for it (late). */
export function steerSettled(chat: Chat, event: Extract<AgentEvent, { type: 'steer' }>) {
  const index = chat.queue.findIndex((q) => q.steer?.request === event.id)
  if (index < 0) return false
  const q = chat.queue[index]
  if (event.state === 'admitted') {
    chat.queue.splice(index, 1)
    chat.steerNote = undefined
    const quotes = (q.quotes ?? []).map(({ excerpt, comment }) => ({ excerpt, comment }))
    chat.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      at: Date.now(),
      text: q.text,
      statuses: [],
      segments: q.text ? [{ kind: 'text', text: q.text }] : [],
      ...(quotes.length ? { quotes } : {}),
      selection: q.selection?.bubble,
      attachments: q.attachments.map((a) => ({
        id: a.id,
        kind: a.type.startsWith('image/') ? 'image' : 'file',
        name: a.name,
        path: a.path,
        ...(a.type.startsWith('image/') ? { url: `data:${a.type};base64,${a.data}` } : {})
      })),
      steered: event.reason === 'continued' ? 'continued' : 'turn'
    })
    // The reply continues below the steer, in a message of its own.
    chat.streamingId = null
    assistant(chat)
    return true
  }
  q.steer = undefined
  if (event.state === 'uncertain') {
    chat.paused = true
    chat.steerNote = STEER_UNCERTAIN
  } else chat.steerNote = steerReasonText(event.reason)
  return true
}

/** The turn ended: a steer still unanswered stays queued, as the queue's next message. */
export function steersEnded(chat: Chat) {
  for (const q of chat.queue)
    if (q.steer) {
      q.steer = undefined
      chat.steerNote = steerReasonText('turn-ended')
    }
}
