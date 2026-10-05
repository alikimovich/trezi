import type { AgentOptions, BackgroundSpawnOrigin } from './api'

/** Comments use a focused coding model on built-in subscriptions. Connections
 * keep their exact model: provider names describe the harness, not the endpoint.
 * Visual-edit agents continue to inherit their parent chat's model. */
export function backgroundAgentOptions(
  options: AgentOptions,
  origin: BackgroundSpawnOrigin = 'comment'
): AgentOptions {
  if (origin !== 'comment' || options.connectionId) return { ...options }
  if (options.provider === 'codex') return { ...options, model: 'gpt-6-sol' }
  if (!options.provider || options.provider === 'claude') return { ...options, model: 'sonnet' }
  return { ...options }
}
