/**
 * The user's preferred default for a chat that has no stored settings of its own
 * (first project of a session, or a chat with nothing persisted yet).
 *
 * Two modes:
 * - `last-used` (the product default) — whatever model the user last picked in
 *   any chat, so switching away from Claude once sticks across relaunch.
 * - `fixed` — a specific model chosen in Settings, so new chats ignore the
 *   last picker change.
 *
 * Pure resolve + parse live here so they unit-test without zustand or a DOM;
 * localStorage is the persistence half, matching workspace/recents.
 */
import type { ModelChoice } from './api'
import { type ChatAgentSettings, defaultChatAgentSettings } from './chat-settings'

export const PREFERRED_MODEL_KEY = 'trezi:preferred-model'
/** Sentinel value for the Settings <select> — not a ModelChoice.value. */
export const LAST_USED_VALUE = 'last-used'

export type PreferredModelMode = 'last-used' | 'fixed'

export interface PreferredModelState {
  mode: PreferredModelMode
  /** Last picker selection the user made (any chat). Used when mode is last-used. */
  lastUsed: ChatAgentSettings
  /** Explicit default when mode is 'fixed'. */
  fixed?: ChatAgentSettings
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const parseSettings = (v: unknown): ChatAgentSettings | null => {
  if (!isRecord(v) || typeof v.model !== 'string' || typeof v.provider !== 'string') return null
  const base = defaultChatAgentSettings()
  return {
    ...base,
    model: v.model,
    ...(typeof v.modelId === 'string' ? { modelId: v.modelId } : {}),
    effort: typeof v.effort === 'string' ? v.effort : base.effort,
    provider: v.provider,
    ...(typeof v.connectionId === 'string' ? { connectionId: v.connectionId } : {}),
    permissionMode:
      v.permissionMode === 'auto' ||
      v.permissionMode === 'default' ||
      v.permissionMode === 'acceptEdits' ||
      v.permissionMode === 'bypassPermissions'
        ? v.permissionMode
        : base.permissionMode
  }
}

export const defaultPreferredModelState = (): PreferredModelState => ({
  mode: 'last-used',
  lastUsed: defaultChatAgentSettings()
})

/** Accept unknown JSON (localStorage, tests) and fall back to last-used Claude. */
export const parsePreferredModelState = (raw: unknown): PreferredModelState => {
  const fallback = defaultPreferredModelState()
  if (!isRecord(raw)) return fallback
  const lastUsed = parseSettings(raw.lastUsed) ?? fallback.lastUsed
  const fixed = parseSettings(raw.fixed)
  const mode: PreferredModelMode = raw.mode === 'fixed' && fixed ? 'fixed' : 'last-used'
  return { mode, lastUsed, ...(fixed ? { fixed } : {}) }
}

/** What a chat with no stored settings should start as. */
export const resolvePreferredSettings = (state: PreferredModelState): ChatAgentSettings => {
  if (state.mode === 'fixed' && state.fixed) {
    return { ...defaultChatAgentSettings(), ...state.fixed }
  }
  return { ...defaultChatAgentSettings(), ...state.lastUsed }
}

export const rememberLastUsed = (
  state: PreferredModelState,
  used: ChatAgentSettings
): PreferredModelState => ({ ...state, lastUsed: { ...used } })

export const setFixedPreference = (
  state: PreferredModelState,
  fixed: ChatAgentSettings
): PreferredModelState => ({ ...state, mode: 'fixed', fixed: { ...fixed } })

export const setLastUsedMode = (state: PreferredModelState): PreferredModelState => ({
  ...state,
  mode: 'last-used'
})

/** Flatten a picker choice into chat settings (effort/mode stay at the UI defaults). */
export const settingsFromChoice = (
  choice: Pick<ModelChoice, 'value' | 'modelId' | 'provider' | 'connectionId'>
): ChatAgentSettings => ({
  ...defaultChatAgentSettings(),
  model: choice.value,
  ...(choice.modelId ? { modelId: choice.modelId } : {}),
  provider: choice.provider,
  ...(choice.connectionId ? { connectionId: choice.connectionId } : {})
})

/** The Settings <select> value for a stored preference. */
export const preferredSelectValue = (state: PreferredModelState): string =>
  state.mode === 'fixed' && state.fixed ? state.fixed.model : LAST_USED_VALUE
