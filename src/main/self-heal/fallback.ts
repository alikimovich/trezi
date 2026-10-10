import type { AgentOptions } from '../../shared/api'
import { seatLogin } from '../provider-data'

/** Settings → AI Providers → "Automatic provider fallback". Absent means on. */
export const PROVIDER_FALLBACK_KEY = 'trezi:provider-fallback:v1'

let read: () => string | null | undefined = () => null
export function setProviderFallbackSource(source: () => string | null | undefined): void {
  read = source
}

export const providerFallbackAllowed = (): boolean => read() !== 'false'

const other: Record<string, string> = { claude: 'codex', codex: 'claude' }

/** The provider that could run a turn `from` could not, or null: the setting is off, the chat
 *  uses its own endpoint (a connection) or `from` has no counterpart. */
export function fallbackCandidate(from: string, options: AgentOptions): string | null {
  if (!providerFallbackAllowed() || options.connectionId) return null
  return other[from] ?? null
}

/** Whether `provider` is signed in, as its helper sees it; tests replace it. */
type LoginProbe = (provider: string, root: string) => Promise<boolean>
const seatSignedIn: LoginProbe = async (provider, root) =>
  (await seatLogin.check(provider, root).catch(() => null))?.loggedIn === true
let signedIn = seatSignedIn
export function setFallbackLoginProbe(probe: LoginProbe | null): void {
  signedIn = probe ?? seatSignedIn
}

/** The other built-in provider when it is configured (signed in), else null. */
export async function fallbackProvider(
  from: string,
  options: AgentOptions,
  root: string
): Promise<string | null> {
  const to = fallbackCandidate(from, options)
  return to && (await signedIn(to, root)) ? to : null
}

/** The options the fallback provider starts with: the chat's own model/effort belong to the
 *  provider that failed. The chat's picker keeps what the user chose. */
export function fallbackOptions(options: AgentOptions, to: string): AgentOptions {
  return { ...options, provider: to, model: undefined, effort: undefined }
}
