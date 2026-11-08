/**
 * LKM-453: what the opt-in chat recovery acceptance (`bun run acceptance:chat-recovery`,
 * docs/TESTING.md "Chat recovery acceptance") requires of the shipping conflict card while
 * its Try applying again or Combine request is held and after each outcome. Pure, so the unit tier runs
 * every rule against GREEN and RED inputs; `smoke-chat-recovery-acceptance.ts` applies them
 * to the real card, its real buttons and the real support report.
 */

/** RED runs the shipping check with the card's busy state held back until the reply. */
export const CHAT_RECOVERY_RED_MODES = ['delay-busy'] as const
/** The failure every RED run must stop at: no busy card while the request was held. */
export const BUSY_MARKER = 'busy state before the reply'
/** A click must show the busy card this soon, while its request is still held. */
export const BUSY_WITHIN_MS = 1000
/** Every outcome the acceptance captures, in run order. */
export const CHAT_RECOVERY_OUTCOMES = [
  'held-busy',
  'still-held',
  'clean',
  'handover',
  'failure',
  'isolation',
  'terminal-clear'
] as const
/** Planted in the failing reply; the written report must redact each one. */
export const PLANTED = {
  key: 'sk-fixture-secret-4530000000',
  token: 'fixture-token-453'
} as const

/** `recoveryMeasure` from src/native/ChatRecoveryAcceptance.swift, with the host's state. */
export interface RecoveryMeasure {
  present: boolean
  title: string
  detail: string
  busy: boolean
  actions: string[]
  disabled: boolean[]
  /** LKM-590: the card's More menu labels and its one-line hint. */
  menu: string[]
  hint?: string
  buttons: { label: string; action: string; disabled: boolean; frame: number[] }[]
  problem: string | null
  spinners: number[][]
  reading: number[]
  cards: string[]
  foreground?: boolean
  firstResponder?: string
}

export type RecoveryKind = 'retry' | 'resolve'
/** LKM-590: the held card's one primary action for each recovery, and its working title. */
export const RECOVERY_LABEL: Record<RecoveryKind, string> = {
  retry: 'Try applying again',
  resolve: 'Combine with project edits'
}
const BUSY_TITLE: Record<RecoveryKind, string> = {
  retry: 'Trying to apply again…',
  resolve: 'Combining with project edits…'
}
const MUTATIONS = ['discard', 'landing-retry', 'resolve']
const DISCARD = 'Discard held changes…'

const inside = (frame: number[], area: number[]) =>
  frame[0] >= area[0] - 0.5 &&
  frame[1] >= area[1] - 0.5 &&
  frame[0] + frame[2] <= area[0] + area[2] + 0.5 &&
  frame[1] + frame[3] <= area[1] + area[3] + 0.5

/** The card as drawn: found, every drawn button inside the reading area. */
function drawnProblems(m: RecoveryMeasure): string[] {
  if (!m.present) return ['the conflict card is not shown']
  if (m.problem) return [`its buttons were not found: ${m.problem}`]
  const problems: string[] = []
  for (const b of m.buttons)
    if (!inside(b.frame, m.reading)) problems.push(`${b.label} is outside the reading area`)
  return problems
}

/** The card while `kind`'s request is held: its working title and a spinner, and no
 *  recovery row at all (LKM-590: no disabled cluster while Trezi owns the hold). */
export function busyProblems(m: RecoveryMeasure, kind: RecoveryKind): string[] {
  const problems = drawnProblems(m)
  if (!m.present) return problems
  if (m.title !== BUSY_TITLE[kind] || m.detail.startsWith('Problem:'))
    problems.push(`the owned failure does not show ${BUSY_TITLE[kind]} status`)
  if (!m.busy) problems.push('the card is not busy')
  if (!m.spinners.length) problems.push('no spinner')
  if (m.buttons.some((b) => MUTATIONS.includes(b.action)) || m.actions.length)
    problems.push(`recovery actions are drawn: ${m.actions.join(', ')}`)
  if (m.menu.includes(DISCARD)) problems.push('Discard is offered while Trezi works')
  return problems
}

/** The card with no request in flight: one enabled primary recovery, no spinner, and
 *  Discard behind More. */
export function idleProblems(m: RecoveryMeasure): string[] {
  const problems = drawnProblems(m)
  if (!m.present) return problems
  if (m.busy) problems.push('the card is still busy')
  if (m.title.endsWith('…')) problems.push('a working title remains')
  if (m.spinners.length) problems.push('a spinner remains')
  const drawn = m.buttons.filter((b) => MUTATIONS.includes(b.action))
  if (drawn.length !== 1 || m.actions.length !== 1)
    problems.push(`${m.actions.length} actions drawn (${m.actions.join(', ')}), wanted one`)
  for (const b of drawn) if (b.disabled) problems.push(`${b.label} is disabled`)
  if (!m.menu.includes(DISCARD)) problems.push('Discard is not in More')
  if (m.cards.includes('error')) problems.push('a second, error card is shown')
  return problems
}

/** A Retry that ended still held: one concise line on the same card, nothing else. */
export function stillHeldProblems(m: RecoveryMeasure): string[] {
  const problems = idleProblems(m)
  if (!m.present) return problems
  if (!/still held/i.test(m.detail))
    problems.push('the card does not say the changes are still held')
  if (m.detail.includes('\n'))
    problems.push(`the outcome is not one line: ${JSON.stringify(m.detail)}`)
  return problems
}

/** A failed request: the same card says Problem and offers the written report in More. */
export function failureProblems(m: RecoveryMeasure): string[] {
  const problems = idleProblems(m)
  if (!m.present) return problems
  if (m.title !== 'Problem' || !m.detail.startsWith('Problem:'))
    problems.push('the card does not state the Problem')
  if (!m.menu.includes('Copy support report')) problems.push('no Copy support report')
  return problems
}

/** The written support report: private, readable JSON for this chat only, with no secret. */
export function reportProblems(
  content: string | null,
  mode: number | null,
  scope: { chat: string; others: string[] }
): string[] {
  if (content === null) return ['no readable support report']
  const problems: string[] = []
  if (mode !== 0o600) problems.push(`report mode ${mode?.toString(8) ?? 'unknown'}, wanted 600`)
  let parsed: { chat?: unknown } = {}
  try {
    parsed = JSON.parse(content)
  } catch {
    problems.push('the report is not JSON')
  }
  if (parsed.chat !== scope.chat) problems.push('the report names another chat')
  for (const other of scope.others)
    if (content.includes(other)) problems.push('the report mentions another chat')
  for (const value of Object.values(PLANTED))
    if (content.includes(value)) problems.push('the report keeps a planted secret')
  if (!content.includes('[redacted]')) problems.push('the report redacted nothing')
  return problems
}

/** Render seam of the chat controller (`NativeChatController.services.render`). */
interface Renders {
  render: (state: never) => void
}

/**
 * RED `delay-busy`: holds back every render while `held()` is true, then publishes the
 * latest once released. The card's busy state can then appear only after the reply, so
 * the acceptance must fail at {@link BUSY_MARKER}. Test-internal: shipping code is unchanged.
 */
export function delayRenders(services: Renders, held: () => boolean) {
  const original = services.render
  let pending: [never] | null = null
  services.render = ((state: never) => {
    if (held()) pending = [state]
    else original(state)
  }) as Renders['render']
  return {
    flush() {
      const next = pending
      pending = null
      if (next) original(...next)
    },
    restore() {
      services.render = original
    }
  }
}
