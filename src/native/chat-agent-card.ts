import type { AgentEvent } from '../shared/api'
import type { NativeAgentCard, NativeChatCard } from '../shared/native-chat'
import type { NativeSpawn } from '../shared/native-chat-controller'

/** Collapsed request length; longer requests end at the last whole word before it. */
const PREVIEW_CHARS = 140
const STATUS_LABELS: Record<NativeAgentCard['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for your answer'
}
// A `path/file.ext:line[:column]` the request names (selections and text edits stamp one).
const TARGET = /(?:^|[\s(“"'`])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z]\w*):(\d+)(?::(\d+))?/

/** The request cut at a word boundary, never mid-word (LKM-193). */
export function requestPreview(request: string, max = PREVIEW_CHARS): string {
  const text = request.trim()
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const head = chars.slice(0, max).join('')
  // The head ends a word when the next character is a space; else drop the partial word
  // (a single word longer than the preview is the only thing ever cut).
  const cut = /\s/.test(chars[max]) ? head.length : head.search(/\s\S*$/)
  return `${(cut > 0 ? head.slice(0, cut) : head).replace(/[\s,.;:]+$/, '')}…`
}

/** The file:line a request targets, for the card's editor link. */
export function requestTarget(request: string): NativeAgentCard['target'] {
  const match = TARGET.exec(request)
  if (!match) return undefined
  const [, file, line, column] = match
  return {
    label: `${file}:${line}`,
    source: column ? `${file}:${line}:${column}` : `${file}:${line}`
  }
}

/** The Activity line for a background agent's question, the one spawn event that needs
 *  the user (needs-action, LKM-152 rules). The question text stays on the card. */
export function agentAttention(event: AgentEvent): string | null {
  return event.type === 'question-request' && event.sessionId
    ? 'A background agent needs your answer in the chat.'
    : null
}

/** A background agent's card: its request, target and status, and the question it waits
 *  on, answered in place like a chat question. Cancel always cancels. */
export function agentCard(spawn: NativeSpawn): NativeChatCard {
  const status: NativeAgentCard['status'] = spawn.question
    ? 'waiting'
    : spawn.status === 'queued'
      ? 'queued'
      : 'running'
  const target = requestTarget(spawn.label)
  return {
    id: spawn.id,
    title: status === 'waiting' ? 'Background agent needs your answer' : 'Background agent',
    // What the agent is doing now; a pending question replaces it.
    ...(spawn.activity && !spawn.question ? { detail: spawn.activity } : {}),
    actions: [{ label: 'Cancel', action: 'spawn-stop' }],
    agent: {
      status,
      statusLabel: STATUS_LABELS[status],
      request: spawn.label,
      preview: requestPreview(spawn.label),
      ...(target ? { target } : {}),
      ...(spawn.question ? { question: spawn.question } : {})
    }
  }
}
