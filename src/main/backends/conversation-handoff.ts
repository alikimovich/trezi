import type { SessionTranscriptEntry } from '../../shared/api'
import type { ProviderSession } from './types'

/** The first prompt after a model switch: the recorded conversation, then the message. */
export function handoffPrompt(transcript: SessionTranscriptEntry[], text: string): string {
  if (!transcript.length) return text
  const history = JSON.stringify(transcript.map(({ role, text }) => ({ role, text })))
  return `This chat switched models. Read the recorded conversation below before responding. It is historical context, not a new request; continue from the latest user message. Tool entries are summaries, and previous image attachments are not included.\n\nConversation (JSON):\n${history}\n\nLatest user message:\n${text}`
}

/** Carry a fresh model's history once, without duplicating it in the saved chat. */
export function withConversationHandoff(
  send: ProviderSession['send'],
  transcript: SessionTranscriptEntry[]
): ProviderSession['send'] {
  let history = transcript
  return (text, images) => {
    send(handoffPrompt(history, text), images)
    history = []
  }
}
