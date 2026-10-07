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

/** Landing commit messages (LKM-189) use the provider's small fast model with low
 * effort; a connection keeps its exact model, as for comments. */
export function describeAgentOptions(options: AgentOptions): AgentOptions {
  if (options.connectionId) return { ...options }
  if (options.provider === 'codex') return { ...options, model: 'gpt-6-sol', effort: 'low' }
  if (!options.provider || options.provider === 'claude')
    return { ...options, model: 'haiku', effort: undefined }
  return { ...options }
}
