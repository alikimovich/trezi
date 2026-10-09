import type { ModelChoice } from './api'
import { DEFAULT_MODEL } from './chat-settings'

/**
 * Which choice a chat's stored settings point at.
 *
 * A v10 pick stores `ModelChoice.value` outright. Anything persisted BEFORE v10
 * stored the bare model id ('opus', 'gpt-5-codex', 'default') alongside its
 * harness, so fall back to matching on `modelId` + harness + endpoint — otherwise
 * every pre-existing chat would open with a blank/duplicated picker. Undefined
 * when nothing matches (choices not loaded yet, a deleted connection, or a model
 * id the harness has since retired — see `resolveSelection`, which is what the
 * picker actually calls).
 */
export const resolveChoice = (
  choices: ModelChoice[],
  s: { model: string; provider?: string; connectionId?: string }
): ModelChoice | undefined =>
  choices.find((c) => c.value === s.model) ??
  choices.find(
    (c) =>
      (c.modelId ?? c.value) === s.model &&
      c.provider === (s.provider ?? 'claude') &&
      c.connectionId === s.connectionId
  )

/**
 * One row of the chat's PROVIDER dropdown: a built-in seat (Claude / Codex) or a
 * saved connection, with the models it offers. The picker is two dropdowns —
 * provider, then that provider's models — so this is the first-level grouping of
 * the single flat `ModelChoice[]` main hands over. `key` is the dropdown's value:
 * the harness for a built-in seat, `conn:<id>` for a connection (namespaced so a
 * connection id can never be mistaken for a harness name).
 */
export interface ProviderOption {
  key: string
  /** "Claude", "Codex", or the connection's own label (`ModelChoice.group`). */
  label: string
  provider: 'claude' | 'codex'
  connectionId?: string
  /** This provider's models, in main's order. Never empty (the option only
   *  exists because a choice created it). */
  models: ModelChoice[]
}

/** The provider dropdown value for a choice or a chat's stored settings. */
export const providerKeyFor = (s: { provider?: string; connectionId?: string }): string =>
  s.connectionId ? `conn:${s.connectionId}` : (s.provider ?? 'claude')

/**
 * The provider dropdown, derived from main's flat list: the built-in seats first,
 * then one row per connection — main's own order (see providers.ts#choices), which
 * is exactly the order the user asked for.
 */
export const providerOptions = (choices: ModelChoice[]): ProviderOption[] => {
  const out: ProviderOption[] = []
  const byKey = new Map<string, ProviderOption>()
  for (const c of choices) {
    const key = providerKeyFor(c)
    const existing = byKey.get(key)
    if (existing) {
      existing.models.push(c)
      continue
    }
    const option: ProviderOption = {
      key,
      label: c.group,
      provider: c.provider,
      ...(c.connectionId ? { connectionId: c.connectionId } : {}),
      models: [c]
    }
    byKey.set(key, option)
    out.push(option)
  }
  return out
}

/**
 * What a provider falls back to when the chat's stored model doesn't name one of
 * its models: its "Default" entry (built-in seats always carry one) or, for a
 * connection (which has no such sentinel), its first model.
 */
export const defaultChoiceFor = (option: ProviderOption): ModelChoice | undefined =>
  option.models.find((c) => c.modelId === DEFAULT_MODEL) ?? option.models[0]

/**
 * What the two dropdowns should SHOW for a chat's stored settings — without ever
 * rewriting them.
 *
 * Both halves degrade instead of rendering something dead, because both can go
 * stale under the user: model ids are discovered now (`main/model-catalog.ts`),
 * so a chat persisted against a retired id ('opus', 'gpt-5-codex') matches
 * nothing, and a connection can be deleted while a chat still points at it.
 *
 * - provider: the exact match, else — for a vanished connection — the harness
 *   that actually runs it (a connection rides the Codex harness).
 * - model: the exact match (v10 value, or a pre-v10 bare id), else that
 *   provider's Default entry.
 *
 * `choice` is undefined only while main's choices haven't landed yet; the caller
 * renders its own placeholder option for that beat.
 */
export const resolveSelection = (
  options: ProviderOption[],
  s: { model: string; provider?: string; connectionId?: string }
): { providerKey: string; option?: ProviderOption; choice?: ModelChoice } => {
  const wanted = providerKeyFor(s)
  const option =
    options.find((o) => o.key === wanted) ??
    (s.connectionId ? options.find((o) => o.key === (s.provider ?? 'claude')) : undefined)
  if (!option) return { providerKey: wanted }
  return {
    providerKey: option.key,
    option,
    // Scoped to the option, so a stale id can only ever fall back WITHIN the
    // provider the chat is actually on.
    choice: resolveChoice(option.models, s) ?? defaultChoiceFor(option)
  }
}
