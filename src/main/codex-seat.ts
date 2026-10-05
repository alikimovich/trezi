import type { AgentEvent, AgentOptions } from '../shared/api'
import {
  parseCodexFallback,
  rejectedCodexModels,
  rememberCodexFallback,
  supportedCodexModel
} from './backends/codex-model'
import type { CatalogModel } from './model-catalog'
import { modelCatalog } from './provider-data'

/**
 * Main's side of the Codex seat models this login rejected (LKM-126,
 * `backends/codex-model.ts`): the picker's list without them, the options a new seat
 * session starts with, and what main learns from a session's fallback notice.
 */

export const withoutRejected = (models: CatalogModel[]): CatalogModel[] =>
  models.filter((m) => !rejectedCodexModels().has(m.id))

/** The seat's discovered models in the CLI's order; none before the first probe. */
function codexListed(): string[] {
  try {
    return (
      modelCatalog()
        .get('codex')
        ?.map((m) => m.id) ?? []
    )
  } catch {
    return [] // data dir not resolvable yet
  }
}

/**
 * The options a Codex seat session starts with: a model this login rejected earlier
 * (or the CLI default's rejected pick) is replaced by the fallback that worked, so a
 * later chat, in-process or in a helper, never retries it.
 */
export function supportedSeatOptions(options: AgentOptions): AgentOptions {
  if (options.connectionId) return options
  const model = supportedCodexModel(options.model || undefined, codexListed())
  return model === (options.model || undefined) ? options : { ...options, model }
}

/**
 * Main's record of a fallback a Codex seat session reported in its status line (a
 * helper's memory ends with the helper). The persisted catalog drops the model too, so
 * the picker still omits it after a restart, until the next probe.
 */
export function noteCodexFallback(options: AgentOptions, event: AgentEvent): void {
  if (options.connectionId || event.type !== 'status') return
  const notice = parseCodexFallback(event.text)
  if (!notice) return
  rememberCodexFallback(notice.rejected, notice.fallback, !options.model)
  try {
    const listed = modelCatalog().get('codex')
    if (listed?.some((m) => m.id === notice.rejected))
      modelCatalog().set('codex', withoutRejected(listed))
  } catch {
    /* the in-memory rejection still serves this run */
  }
}
