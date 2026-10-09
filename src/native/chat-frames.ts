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
  return (state) => {
    const messages = JSON.stringify(state.messages)
    if (sent?.chat === state.chat && sent.messages === messages) {
      const { messages: _, ...frame } = state
      return frame
    }
    sent = { chat: state.chat, messages }
    return state
  }
}
