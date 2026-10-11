/** Built-in seats only. Connections to custom endpoints have their own status. */
export type BuiltinProvider = 'claude' | 'codex'
export type ProviderReadinessStatus = 'ready' | 'checking' | 'signed_out' | 'failed'
export interface ProviderReadiness {
  status: ProviderReadinessStatus
  /** Fixed, user-facing recovery text. Never a CLI's raw output or an OAuth URL. */
  detail?: string
}
export type ProviderReadinessMap = Record<BuiltinProvider, ProviderReadiness>

export const initialProviderReadiness = (): ProviderReadinessMap => ({
  claude: { status: 'checking' },
  codex: { status: 'checking' }
})

export function readinessFromLogin(loggedIn: boolean | null): ProviderReadiness {
  return loggedIn === true
    ? { status: 'ready' }
    : loggedIn === false
      ? { status: 'signed_out' }
      : { status: 'failed', detail: 'Unable to check sign-in. Check your connection and retry.' }
}

export const anyProviderReady = (state: ProviderReadinessMap): boolean =>
  state.claude.status === 'ready' || state.codex.status === 'ready'
