import type { Chat, Submission } from './chat-state'

/**
 * LKM-169: what keeps a message from sending now. A message sent meanwhile goes to the
 * composer queue (LKM-151) with the reason, and the queue drains once the block clears;
 * it is never refused, so there is no error turn and no duplicate.
 *  - running: a turn is streaming;
 *  - landing: the model finished and its changes are landing;
 *  - resolve: the last landing drift-parked (the backend's `sendRefusal`);
 *  - login: the provider is not signed in (the login card's Retry clears it).
 */
export type SendBlock = 'running' | 'landing' | 'resolve' | 'login'

/** A drift park waiting for Resolve. A stopped turn's hold and a failed landing are not:
 *  the next message continues on top of them (the backend agrees). */
export const needsResolve = (chat: Chat) =>
  chat.isolation === 'parked' && chat.stopped !== 'held' && !chat.landingError

export function sendBlock(chat: Chat): SendBlock | null {
  if (chat.signingIn) return 'login'
  if (chat.keepingStopped) return 'landing'
  if (chat.isRunning || chat.sending) return chat.phase === 'applying' ? 'landing' : 'running'
  if (needsResolve(chat)) return 'resolve'
  if (chat.login) return 'login'
  return null
}

/** LKM-191: a running turn or a landing is the normal wait, so it gets no note (and the
 *  queue no header row); only blocks that need the user's action are named. */
const BLOCK_NOTES: Record<SendBlock, string> = {
  running: '',
  landing: '',
  resolve: 'Waiting for Resolve — sends once the held changes land',
  login: 'Waiting for sign-in — sends after Retry on the login card'
}

/** Why the queue is not sending, in words, and whether "Send now" can. Resolve and
 *  sign-in come first (their actions also resume a paused queue); a pause outlasts a
 *  running turn, so it is named before one. */
export function queueNote(chat: Chat): { queueNote: string; queueCanSend: boolean } {
  if (chat.keepingStopped)
    return {
      queueNote: 'Checking held changes — not sent until the check finishes',
      queueCanSend: false
    }
  const block = sendBlock(chat)
  const waiting = needsResolve(chat) ? 'resolve' : chat.login || chat.signingIn ? 'login' : null
  if (waiting) return { queueNote: BLOCK_NOTES[waiting], queueCanSend: false }
  if (!chat.paused) {
    const answerQueued = chat.queue.some((q) => q.chatUiId)
    const answerNote =
      block === 'running'
        ? 'Answer accepted — queued until the current provider turn finishes'
        : block === 'landing'
          ? chat.operation === 'waiting'
            ? 'Answer accepted — queued until the previous provider turn finishes'
            : 'Answer accepted — queued until current changes finish landing'
          : ''
    return {
      queueNote: answerQueued ? answerNote : block ? BLOCK_NOTES[block] : '',
      queueCanSend: !block
    }
  }
  if (chat.isolation === 'parked' && chat.landingError)
    return {
      queueNote: chat.decision
        ? 'Waiting — answer the decision or discard the held changes to send these'
        : 'Waiting — retry, resolve or discard the held changes to send these',
      queueCanSend: false
    }
  if (chat.stopped === 'held')
    return {
      queueNote: 'Paused after Stop — not sent; Send now continues the held work',
      queueCanSend: true
    }
  return { queueNote: 'Paused — these won’t send until you choose', queueCanSend: true }
}

/** "Edit": the queued message goes back into the composer (ahead of any draft) with its
 *  attachments, quote cards and selection, and leaves the queue. Sending it queues it again. */
export function editQueued(chat: Chat, id?: string): boolean {
  const index = chat.queue.findIndex((q) => `queued-${q.id}` === id)
  if (index < 0) return false
  const [submission] = chat.queue.splice(index, 1)
  const draft = chat.text.trim()
  chat.text = draft ? `${submission.text}\n\n${draft}` : submission.text
  chat.caret = submission.text.length
  chat.attachments = [...submission.attachments, ...chat.attachments]
  // LKM-555: its quote cards come back as cards, ahead of any in the draft.
  if (submission.quotes?.length) chat.quotes = [...submission.quotes, ...(chat.quotes ?? [])]
  if (submission.selection && !chat.context?.selection) chat.draftSelection = submission.selection
  chat.dismissed = true
  return true
}

/** A queued message as its row shows it: a reply with quote cards says how many it carries. */
export function queuedText(submission: Submission): string {
  const count = submission.quotes?.length ?? 0
  if (!count) return submission.text
  const replies = count === 1 ? '1 quoted reply' : `${count} quoted replies`
  return submission.text ? `${replies} · ${submission.text}` : replies
}
