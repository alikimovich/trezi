/**
 * The agent choices that belong to ONE chat (backend, model, effort, permission
 * posture) and the pure mappings between them and the `AgentOptions` main starts
 * a session with.
 *
 * Two copies of this state exist by necessity — the toolbar's (renderer) and the
 * live session's (main, `ProviderSession.options`) — so every session-creating
 * call must hand main the SAME settings the toolbar shows, and every restore must
 * read them back. `agentOptionsFor` / `chatAgentSettingsFromOptions` are the two
 * directions of that round trip; going through them is what keeps the pickers
 * honest (a hand-built options object silently dropped `permissionMode`, so a
 * chat could read "Auto" while main was actually asking for every edit).
 *
 * Pure + dependency-free (no zustand, no window.api) so it can be unit-tested —
 * `store.ts` re-exports the whole surface, so importers can keep using it.
 */
import type { AgentOptions, PermissionMode } from './api'

// Sentinel values mean "use the account/model default" (omit from SDK options).
export const DEFAULT_MODEL = 'default'
export const DEFAULT_EFFORT = 'auto'
/** The default backend (the Claude Agent SDK). */
export const DEFAULT_PROVIDER = 'claude'

/** Agent choices belong to a chat. `useSession` mirrors the active chat so the
 * toolbar stays simple, while `ProjectEntry.chatSettings` retains every chat's
 * choice as the user moves through the rail. */
export interface ChatAgentSettings {
  /**
   * The picker's identity for the chosen model — a `ModelChoice.value` (v10), which
   * for a connection-backed model is NOT the model id the backend wants (two
   * connections can offer the same id). `DEFAULT_MODEL` still means "no model, use
   * the account default".
   */
  model: string
  /**
   * `ModelChoice.modelId` — what actually goes to the backend when it differs from
   * `model`. Stored rather than re-derived from the choice list so a chat restored
   * from localStorage can start its session correctly before that list has loaded.
   */
  modelId?: string
  effort: string
  provider: string
  /** v10: run this chat against a user-added endpoint (`ProviderConnection.id`). */
  connectionId?: string
  /** Tool-permission posture for THIS chat. Persisted per-chat like model/provider
   *  so switching chats restores it (main keeps mode per-session; see usePermissions). */
  permissionMode: PermissionMode
}

/** What the model picker hands back — one `ModelChoice`, flattened. */
export interface ModelSelection {
  model: string
  modelId?: string
  provider: string
  connectionId?: string
}

export const defaultChatAgentSettings = (): ChatAgentSettings => ({
  model: DEFAULT_MODEL,
  effort: 'high',
  provider: DEFAULT_PROVIDER,
  permissionMode: 'auto'
})

/** Compact rail label for the harness/model a chat or child agent actually uses. */
export const chatModelLabel = (
  s: Pick<ChatAgentSettings, 'model' | 'modelId' | 'provider' | 'connectionId'>
): string => {
  const model = s.modelId ?? (s.model === DEFAULT_MODEL ? '' : s.model)
  if (s.connectionId) return model || 'Connection'
  if (s.provider === 'codex') return model || 'Codex'
  if (s.provider === 'gemini') return model || 'Gemini'
  if (!model) return 'Claude'
  return model.toLowerCase().startsWith('claude') ? model : `Claude ${model}`
}

/** This chat's settings out of a project entry (structurally typed so this module
 *  stays free of the store's `ProjectEntry`). Missing entries are legacy workspace
 *  data and safely use `fallback` (Claude sentinels, or the user's preferred
 *  default — last-used / Settings). */
export const chatAgentSettingsFor = (
  entry: { chatSettings?: Record<string, ChatAgentSettings> },
  sessionKey: string,
  fallback: ChatAgentSettings = defaultChatAgentSettings()
): ChatAgentSettings => {
  const stored = entry.chatSettings?.[sessionKey]
  // Optional modelId/connectionId being absent is meaningful: this chat uses its
  // bare model ID / built-in provider. Never inherit another chat's last pick.
  return stored ? { ...defaultChatAgentSettings(), ...stored } : { ...fallback }
}

/**
 * The model id a turn should actually carry, or undefined for "use the account
 * default". A picker value is an IDENTITY (`ModelChoice.value`, namespaced by main
 * as `provider[:connectionId]:modelId`), so the id to send is the choice's
 * `modelId` — never `model`, which would reach the backend as the literal string
 * "claude:opus". Pre-v10 chats persisted the bare id in `model` with no `modelId`,
 * and still resolve through the fallback.
 */
export const agentModelId = (s: { model: string; modelId?: string }): string | undefined => {
  const id = s.modelId ?? s.model
  return id === DEFAULT_MODEL || s.model === DEFAULT_MODEL ? undefined : id
}

/** Convert the UI sentinels into AgentOptions the SDK understands. */
export const toAgentOptions = (s: {
  model: string
  modelId?: string
  effort: string
  provider?: string
  connectionId?: string
}): {
  model?: string
  effort?: string
  provider?: string
  connectionId?: string
} => ({
  model: agentModelId(s),
  effort: s.effort === DEFAULT_EFFORT ? undefined : s.effort,
  // Default Claude is implied — only send a non-default backend.
  ...(s.provider && s.provider !== DEFAULT_PROVIDER ? { provider: s.provider } : {}),
  ...(s.connectionId ? { connectionId: s.connectionId } : {})
})

/** The FULL options a session must be started with — the SDK sentinels plus the
 *  permission posture. Every open/new-chat/restart/resume call site uses this, so
 *  none of them can forget the mode and leave the picker lying about the session. */
export const agentOptionsFor = (s: ChatAgentSettings): AgentOptions => ({
  ...toAgentOptions(s),
  permissionMode: s.permissionMode
})

/**
 * The inverse: what a session started with these options is ACTUALLY running as.
 * The fallbacks are main's, not the UI's — an absent `permissionMode` means
 * `'default'` (ask), the SDK default backends/claude.ts applies, NOT the toolbar's
 * 'auto'. Used to reconcile the pickers with main after a renderer reload.
 */
export const chatAgentSettingsFromOptions = (options: AgentOptions = {}): ChatAgentSettings => ({
  // main knows only the model ID, not the picker's namespaced identity, so it lands
  // in `model` and resolves through `agentModelId`'s pre-v10 fallback. The picker
  // re-matches it against the live choice list (see `resolveChoice`).
  model: options.model ?? DEFAULT_MODEL,
  effort: options.effort ?? DEFAULT_EFFORT,
  provider: options.provider ?? DEFAULT_PROVIDER,
  ...(options.connectionId ? { connectionId: options.connectionId } : {}),
  permissionMode: options.permissionMode ?? 'default'
})

/**
 * Settings for a chat resumed from a history record. Resume is Claude-only (the
 * record's `sdkSessionId` is both the resume id and the "this was Claude" marker),
 * so a resumed chat always runs on Claude — and a model alias picked for another
 * backend ("gpt-5") means nothing to it, hence the account default. Everything
 * else (effort, permission posture) carries over from the visible chat.
 *
 * `connectionId` and `modelId` must be cleared too (v10): a set `connectionId`
 * routes to the Codex harness whatever `provider` says, so leaving one behind would
 * send a "resumed on Claude" chat to a third-party endpoint — and a stale `modelId`
 * would outrank the reset `model` in `agentModelId`.
 */
export const resumeChatSettings = (current: ChatAgentSettings): ChatAgentSettings =>
  current.provider === DEFAULT_PROVIDER && !current.connectionId
    ? current
    : {
        ...current,
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        modelId: undefined,
        connectionId: undefined
      }
