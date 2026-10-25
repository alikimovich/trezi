import type { NativeChatSnapshot } from '../shared/native-chat-controller'

/** A `chatState` frame: `messages` is left out when the host already has them. */
export type NativeChatFrame = Omit<NativeChatSnapshot, 'messages'> &
  Partial<Pick<NativeChatSnapshot, 'messages'>>

/**
 * LKM-165: the host decoded the whole transcript on its main thread for every frame,
 * so on a long chat each keystroke, attachment or card change stalled the window (and
 * the preview mode switch queued behind it). A frame now carries `messages` only when
 * they differ from the last frame sent for the same chat; the host keeps its own.
 * One instance per host connection.
 */
export function chatFrames(): (state: NativeChatSnapshot) => NativeChatFrame {
  let sent: { chat: string; messages: string } | null = null
  let imageIds = new Set<string>()
  return (state) => {
    if (sent?.chat !== state.chat) imageIds = new Set()
    // Image bytes are immutable for an attachment ID. Compare the transcript
    // without repeatedly stringifying them, then send each URL once per chat.
    const messages = JSON.stringify(state.messages, (key, value) =>
      key === 'url' && typeof value === 'string' && value.startsWith('data:image/')
        ? '[image data]'
        : value
    )
    if (sent?.chat === state.chat && sent.messages === messages) {
      const { messages: _, ...frame } = state
      return frame
    }
    sent = { chat: state.chat, messages }
    const priorImageIds = imageIds
    const nextImageIds = new Set<string>()
    const frame: NativeChatFrame = {
      ...state,
      messages: state.messages.map((message) => ({
        ...message,
        attachments: message.attachments?.map((attachment) => {
          if (!attachment.url?.startsWith('data:image/')) return attachment
          const known = priorImageIds.has(attachment.id)
          nextImageIds.add(attachment.id)
          if (!known) return attachment
          const { url: _, ...reference } = attachment
          return reference
        })
      }))
    }
    imageIds = nextImageIds
    return frame
  }
}
