// LKM-600: a user turn Trezi wrote itself (an inspector Apply) carries this explicit
// origin. The chat and History show `summary` as one app-owned row; the full instruction
// stays the entry's `text` (what the agent received), shown on expand and copied whole.
// Never inferred from text: only the app code that writes the instruction sets it.

/** Recorded with a transcript entry and sent with `agent:send` / `agent:spawn-comment`. */
export interface AppAction {
  kind: 'inspector-apply'
  /** One line: the property changes and the element ("font-weight: 400 on <span>"). */
  summary: string
}

/** The row a chat message with an `AppAction` renders (`ChatCommentRow` shape). */
export interface AppActionRow {
  title: string
  line: string
  detail: string
}

const SUMMARY_MAX = 300

/** An `AppAction` from untrusted IPC, or undefined. Only known kinds pass. */
export function appAction(value: unknown): AppAction | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { kind, summary } = value as { kind?: unknown; summary?: unknown }
  if (kind !== 'inspector-apply' || typeof summary !== 'string') return undefined
  const line = summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)
  return line ? { kind, summary: line } : undefined
}

/** The longest backtick run in `text`, plus one: a fence the instruction cannot close. */
function fence(text: string) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(longest + 1)
}

/** The collapsed row: title, summary and, on expand, the exact instruction sent. */
export function appActionRow(action: AppAction, text: string): AppActionRow {
  const marks = fence(text)
  return {
    title: 'Apply Styles draft',
    line: action.summary,
    detail: `Sent by Trezi to the agent:\n\n${marks}text\n${text}\n${marks}`
  }
}

/** A transcript entry as a one-line label: an app-written turn names its change. */
export function entryLine(entry?: { text: string; action?: AppAction }): string | undefined {
  return entry?.action ? `Apply ${entry.action.summary}` : entry?.text
}
