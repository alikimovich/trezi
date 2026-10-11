/**
 * The compact status lines a recovery shows. They cross the helper protocol as ordinary
 * `status` events, so main's incident tracker parses them back with the functions below;
 * keep the two directions in this one file.
 */
const PROVIDERS: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

export const providerName = (id: string): string => PROVIDERS[id] ?? id

export const RECOVERED_STATUS = 'Recovered'
export const RESTARTING_STATUS = 'Restarting provider…'

export const reconnectingStatus = (provider: string): string =>
  `Reconnecting to ${providerName(provider)}…`

/** The one note for a turn that ran on the other provider. */
export const fallbackNote = (from: string, to: string): string =>
  `${providerName(from)} could not connect; this turn used ${providerName(to)}`

export type RecoveryStatus =
  | { kind: 'reconnecting' }
  | { kind: 'restarting' }
  | { kind: 'recovered' }
  | { kind: 'fallback' }

export function parseRecoveryStatus(text: string): RecoveryStatus | null {
  if (text === RECOVERED_STATUS) return { kind: 'recovered' }
  if (text === RESTARTING_STATUS) return { kind: 'restarting' }
  if (/^Reconnecting to [A-Za-z]+…$/.test(text)) return { kind: 'reconnecting' }
  if (/^[A-Za-z]+ could not connect; this turn used [A-Za-z]+$/.test(text))
    return { kind: 'fallback' }
  return null
}
