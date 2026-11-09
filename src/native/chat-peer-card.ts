import type { PeerFeedbackLine } from '../shared/api'
import type { NativeChatCard } from '../shared/native-chat'
import type { Chat } from './chat-state'
import { decisionMenu, discardConfirmCard, recoveryBlocked } from './held-card'

const ORIGINS: Record<PeerFeedbackLine['origin'], string> = {
  chat: 'another chat',
  comment: 'a comment agent',
  background: 'a background agent',
  'text-edit': 'a text edit'
}
const who = (line: PeerFeedbackLine) =>
  line.goal ? `${ORIGINS[line.origin]} (“${line.goal}”)` : ORIGINS[line.origin]
const capital = (text: string) => text[0].toUpperCase() + text.slice(1)

/** One state in words. An uncertain overlap says so: it never reads as safe, or as certain. */
export function peerLine(line: PeerFeedbackLine): string {
  if (line.kind === 'waiting') return `Waiting for ${who(line)}, for up to ${line.seconds} seconds.`
  if (line.kind === 'reconciling')
    return line.self
      ? 'Combining this work with changes that landed first.'
      : `${capital(who(line))} is combining its work with changes that landed first.`
  const files = line.files?.join(', ')
  if (line.certainty === 'known')
    return files
      ? `${capital(who(line))} is also changing ${files}.`
      : `${capital(who(line))} is changing the same element.`
  return files
    ? `${capital(who(line))} may also change ${files}. Not confirmed either way.`
    : `${capital(who(line))} may overlap with this work. Not confirmed either way.`
}

/** The most urgent state, for one heading. The feed sends lines most urgent first. */
function title(lines: PeerFeedbackLine[]): string {
  const [line] = lines
  if (line.kind === 'waiting') return 'Waiting for other work'
  if (line.kind === 'reconciling') return 'Combining with other work'
  return line.certainty === 'known' ? 'Overlaps with other work' : 'Possible overlap'
}

/** The chat's one card for peer state: replaced in place, gone when the peers are. */
export function peerCard(lines: PeerFeedbackLine[] | undefined): NativeChatCard | null {
  if (!lines?.length) return null
  return {
    id: 'peer-work',
    title: title(lines),
    detail: lines.map(peerLine).join('\n'),
    actions: []
  }
}

/** Two goals that cannot both hold: the question, where the work is, and the ways on. */
export function decisionCard(chat: Chat, decision: NonNullable<Chat['decision']>): NativeChatCard {
  // LKM-590: the answer is the way on; Discard sits in More and asks first.
  if (chat.confirmingDiscard && !recoveryBlocked(chat))
    return discardConfirmCard(chat, decision.branch)
  return {
    id: 'conflict',
    title: 'Decision needed',
    detail: [
      decision.question,
      decision.branch
        ? `Nothing landed. This chat’s work is kept on ${decision.branch}.`
        : 'Nothing landed. This chat’s work is kept.',
      'Answer in this chat to continue.',
      ...(chat.isolationFiles ?? [])
    ].join('\n'),
    busy: !!chat.recovery && !chat.recoveryTimedOut,
    actions: [],
    menu: decisionMenu(chat)
  }
}
