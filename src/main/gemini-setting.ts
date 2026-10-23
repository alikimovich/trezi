/**
 * LKM-315: Settings → AI Providers → Gemini, on or off. Gemini is optional: off (the
 * default), its models are not in the picker, a `provider: 'gemini'` turn runs on Claude
 * and no Gemini helper starts. Stored as 'true' / 'false' in the service's preferences,
 * so it survives relaunches. With no stored choice, the older development opt-in
 * `TREZI_EXPERIMENTAL_GEMINI=1` still turns it on.
 */
export const GEMINI_ENABLED_KEY = 'trezi:gemini-enabled:v1'

let read: () => string | null | undefined = () => null
export function setGeminiEnabledSource(source: () => string | null | undefined): void {
  read = source
}

export function geminiEnabled(): boolean {
  const stored = read()
  if (stored === 'true' || stored === 'false') return stored === 'true'
  const v = process.env.TREZI_EXPERIMENTAL_GEMINI
  return v === '1' || v === 'true'
}

/** The report Check login gives while Gemini is off: no helper is started for it. */
export const GEMINI_OFF = 'Gemini is off. Turn it on in Settings → AI Providers.'
