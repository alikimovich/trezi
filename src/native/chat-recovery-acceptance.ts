/**
 * LKM-453: what the opt-in chat recovery acceptance (`bun run acceptance:chat-recovery`,
 * docs/TESTING.md "Chat recovery acceptance") requires of the shipping conflict card while
 * its Retry or Resolve request is held and after each outcome. Pure, so the unit tier runs
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
  buttons: { label: string; action: string; disabled: boolean; frame: number[] }[]
  problem: string | null
  spinners: number[][]
  reading: number[]
  cards: string[]
  foreground?: boolean
}

export type RecoveryKind = 'retry' | 'resolve'
const BUSY_LABEL: Record<RecoveryKind, string> = { retry: 'Retrying…', resolve: 'Resolving…' }
const MUTATIONS = ['discard', 'landing-retry', 'resolve']

const inside = (frame: number[], area: number[]) =>
  frame[0] >= area[0] - 0.5 &&
  frame[1] >= area[1] - 0.5 &&
  frame[0] + frame[2] <= area[0] + area[2] + 0.5 &&
  frame[1] + frame[3] <= area[1] + area[3] + 0.5

/** The card's mutation buttons as drawn: found, in one row, inside the reading area. */
function drawnProblems(m: RecoveryMeasure): string[] {
  if (!m.present) return ['the conflict card is not shown']
  if (m.problem) return [`its buttons were not found: ${m.problem}`]
  const problems: string[] = []
  const drawn = m.buttons.filter((b) => MUTATIONS.includes(b.action))
  if (drawn.length !== 3) problems.push(`${drawn.length} of Discard, Retry and Resolve drawn`)
  for (const b of m.buttons)
    if (!inside(b.frame, m.reading)) problems.push(`${b.label} is outside the reading area`)
  return problems
}

/** The card while `kind`'s request is held: its busy label, a spinner, every mutation disabled. */
export function busyProblems(m: RecoveryMeasure, kind: RecoveryKind): string[] {
  const problems = drawnProblems(m)
  if (!m.present) return problems
  if (!m.busy) problems.push('the card is not busy')
  if (!m.actions.includes(BUSY_LABEL[kind])) problems.push(`no ${BUSY_LABEL[kind]} label`)
  if (!m.spinners.length) problems.push('no spinner')
  for (const b of m.buttons)
    if (MUTATIONS.includes(b.action) && !b.disabled) problems.push(`${b.label} is enabled`)
  return problems
}

/** The card with no request in flight: plain labels, no spinner, every mutation enabled. */
export function idleProblems(m: RecoveryMeasure): string[] {
  const problems = drawnProblems(m)
  if (!m.present) return problems
  if (m.busy) problems.push('the card is still busy')
  if (m.actions.some((label) => label.endsWith('…'))) problems.push('a busy label remains')
  if (m.spinners.length) problems.push('a spinner remains')
  for (const b of m.buttons)
    if (MUTATIONS.includes(b.action) && b.disabled) problems.push(`${b.label} is disabled`)
  if (m.cards.includes('error')) problems.push('a second, error card is shown')
  return problems
}

/** A Retry that ended still held: one concise line on the same card, nothing else. */
export function stillHeldProblems(m: RecoveryMeasure): string[] {
  const problems = idleProblems(m)
  if (!m.present) return problems
  if (!/still held/.test(m.detail))
    problems.push('the card does not say the changes are still held')
  if (m.detail.includes('\n') || m.detail.length > 120)
    problems.push(`the outcome is not one concise line: ${JSON.stringify(m.detail)}`)
  return problems
}

/** A failed request: the same card says Problem and offers the written report. */
export function failureProblems(m: RecoveryMeasure): string[] {
  const problems = idleProblems(m)
  if (!m.present) return problems
  if (m.title !== 'Problem' || !m.detail.startsWith('Problem:'))
    problems.push('the card does not state the Problem')
  if (!m.actions.includes('Copy support report')) problems.push('no Copy support report')
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
