/** What `agent:send` and the conversation owner say when a chat already has a turn. */
export const CHAT_BUSY = 'This chat is already running.'

/** A refusal because the chat is busy: the message waits in the composer queue instead. */
export function isChatBusy(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(CHAT_BUSY)
}

/** The note a turn or landing that stopped making progress leaves in the chat (LKM-165). */
export const STUCK_NOTE =
  'This step stopped making progress, so Trezi ended it. Your messages are safe; send again or choose Retry.'
