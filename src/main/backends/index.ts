import type { AgentOptions } from '../../shared/api'
import { codexProvider } from './codex'
import { helperProvider } from './helper-session'
import { withSkillMenu } from './skill-menu'
import type { ModelProvider } from './types'

const codexWithSkills = withSkillMenu(codexProvider)

export type { ModelProvider, PendingPrompt, ProviderSession } from './types'

/**
 * Pick the backend for a session from `options.provider` (the renderer sets it;
 * default = Claude).
 *
 * HARNESS AND ENDPOINT ARE ORTHOGONAL (v10). `provider` names the HARNESS — who runs
 * the agent loop — while `connectionId` names an ENDPOINT the user added (an
 * OpenAI-compatible host: Vercel AI Gateway, Groq, a custom deployment) that supplies
 * the base URL, the key and the model. Only the Codex harness can drive such an
 * endpoint today, so a set `connectionId` routes to Codex **regardless of what
 * `provider` says** — the model picker builds its entries from `ModelChoice`, and an
 * entry carrying a `connectionId` is by construction a Codex-harness entry, but a
 * stale renderer state or a resumed session could still pair one with `provider:
 * 'claude'`. Routing to Claude there would run the turn on the Claude subscription
 * and silently ignore the endpoint the user picked.
 *
 * WHERE THE ADAPTER RUNS (LKM-111). The built-in seats (Claude, Codex, Gemini) run in
 * a provider helper: a separate process the Swift service spawns with only its stdio
 * and a scrubbed environment, and holds to the session's grant
 * (`src/service/ProviderHelper.swift`, `helper-session.ts`). A v10 connection stays
 * in Bun: its key is resolved here and never crosses into another process. Bun only
 * runs under the service (`src/native/index.ts` refuses otherwise), so there is no
 * in-process fallback for a built-in seat.
 *
 * Auth follows the same split: the two built-in seats log in with the user's own
 * subscription (Claude `setup-token`, Codex "sign in with ChatGPT"), while a
 * connection uses the user's own API key — encrypted at rest and confined to Bun and
 * the service. No key is ever committed in-repo.
 *
 * Gemini is EXPERIMENTAL and UNWIRED: unlike Claude/Codex it has NO SDK in
 * package.json (it shells out to an external `gemini` CLI that most installs
 * lack), so selecting it by default is a runtime trap. It is therefore gated
 * behind an explicit opt-in — set TREZI_EXPERIMENTAL_GEMINI=1 (or `true`) to
 * enable `provider: 'gemini'`. Without the flag a 'gemini' request falls back to
 * Claude, exactly like an unknown provider. Claude and Codex are unaffected.
 */
function geminiEnabled(): boolean {
  const v = process.env.TREZI_EXPERIMENTAL_GEMINI
  return v === '1' || v === 'true'
}

export function pickProvider(options: AgentOptions): ModelProvider {
  if (options.connectionId) return codexWithSkills
  // A helper never routes again: its own sessions are the adapters themselves (`provider-helper-entry.ts`).
  if (process.env.TREZI_PROVIDER_HELPER === '1')
    throw new Error('A provider helper does not pick providers.')
  if (process.env.TREZI_SERVICE_SUPERVISED !== '1')
    throw new Error(
      'Built-in providers run in helpers of the Trezi service; start Trezi with open -a Trezi or trezi.'
    )
  switch (options.provider) {
    case 'codex':
      return helperProvider('codex')
    case 'gemini':
      return helperProvider(geminiEnabled() ? 'gemini' : 'claude')
    default:
      return helperProvider('claude')
  }
}
