/**
 * Preferred default model (last-used vs a Settings-fixed pick). Pure — no DOM,
 * no zustand. The localStorage half is a thin wrapper around these parsers.
 *
 * Run with: bun test/preferred-model.mjs
 */

import { DEFAULT_PROVIDER, defaultChatAgentSettings } from '../src/shared/chat-settings.ts'
import {
  defaultPreferredModelState,
  LAST_USED_VALUE,
  parsePreferredModelState,
  preferredSelectValue,
  rememberLastUsed,
  resolvePreferredSettings,
  setFixedPreference,
  setLastUsedMode,
  settingsFromChoice
} from '../src/shared/preferred-model.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (actual, expected, msg) =>
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`)

{
  const d = defaultPreferredModelState()
  eq(d.mode, 'last-used', 'product default is last-used, not a hardcoded Claude pick')
  eq(d.lastUsed.provider, DEFAULT_PROVIDER, 'until the user picks, last-used is still Claude')
  eq(resolvePreferredSettings(d).provider, DEFAULT_PROVIDER, 'resolve of empty state is Claude')
  eq(preferredSelectValue(d), LAST_USED_VALUE, 'Settings select shows Last used')
}

{
  const used = {
    ...defaultChatAgentSettings(),
    provider: 'codex',
    model: 'codex:gpt-5.4',
    modelId: 'gpt-5.4'
  }
  const remembered = rememberLastUsed(defaultPreferredModelState(), used)
  eq(resolvePreferredSettings(remembered).provider, 'codex', 'last-used follows the picker')
  eq(
    resolvePreferredSettings(remembered).model,
    'codex:gpt-5.4',
    'last-used keeps the choice identity'
  )

  const fixed = setFixedPreference(remembered, {
    ...defaultChatAgentSettings(),
    provider: 'claude',
    model: 'claude:opus',
    modelId: 'opus'
  })
  eq(fixed.mode, 'fixed', 'Settings can pin a specific model')
  eq(resolvePreferredSettings(fixed).model, 'claude:opus', 'fixed outranks last-used')
  eq(fixed.lastUsed.provider, 'codex', 'pinning does not forget last-used')
  eq(preferredSelectValue(fixed), 'claude:opus', 'Settings select shows the pinned choice')

  const back = setLastUsedMode(fixed)
  eq(back.mode, 'last-used', 'switching back to last-used')
  eq(resolvePreferredSettings(back).provider, 'codex', 'last-used is still the Codex pick')
}

{
  const parsed = parsePreferredModelState({
    mode: 'fixed',
    lastUsed: { model: 'x', provider: 'codex', effort: 'high', permissionMode: 'auto' }
  })
  eq(parsed.mode, 'last-used', 'fixed without a valid `fixed` payload degrades to last-used')

  const junk = parsePreferredModelState({ mode: 'nope', lastUsed: 3 })
  eq(junk.mode, 'last-used', 'junk JSON falls back to last-used')
  eq(junk.lastUsed.provider, DEFAULT_PROVIDER, 'junk lastUsed falls back to Claude sentinels')

  const choice = settingsFromChoice({
    value: 'conn:abc:kimi',
    modelId: 'kimi-k2',
    provider: 'codex',
    connectionId: 'abc'
  })
  eq(choice.model, 'conn:abc:kimi', 'choice value is the picker identity')
  eq(choice.modelId, 'kimi-k2', 'choice modelId is what the backend wants')
  eq(choice.connectionId, 'abc', 'choice carries the connection')
  eq(choice.permissionMode, 'auto', 'a Settings pick keeps Auto')
}

if (failed) {
  console.error(`\n${failed} preferred-model assertion(s) failed`)
  process.exit(1)
}
console.log('preferred-model: all assertions passed')
