import type { AgentEvent, AgentOptions } from '../shared/api'
import { productLog, truncate } from './product-log'
import { turnTimings } from './turn-timing'

/**
 * LKM-168: a chat turn's lifecycle in the product log — start, end and failure, with
 * the provider, the requested model and the model the provider resolved. Never the
 * prompt or the reply: only ids, names and timings.
 */
const resolved = new Map<string, string>()
const running = new Map<string, { at: number; provider: string; model: string }>()

const providerName = (options: AgentOptions) =>
  options.provider ?? (options.connectionId ? 'connection' : 'claude')

export function logTurnStart(chat: string, turn: string, options: AgentOptions) {
  const provider = providerName(options)
  const model = options.model || 'default'
  running.set(chat, { at: Date.now(), provider, model })
  turnTimings.sent(chat, turn)
  productLog.info('chat', 'Turn started', {
    chat,
    turn,
    provider,
    model,
    resolved: resolved.get(chat)
  })
}

/** A turn that never reached the provider (cancelled, refused or failed to send). */
export function logTurnNotSent(chat: string, turn: string, error: unknown) {
  running.delete(chat)
  const message = error instanceof Error ? error.message : String(error)
  productLog.warn('chat', 'Turn not sent', { chat, turn, reason: truncate(message, 300) })
  turnTimings.completed(chat, turn)
}

/** One landing attempt and what Git did: merged onto the live tree, parked or nothing. */
export function logLanding(
  chat: string,
  branch: string,
  result: { outcome: string; files: string[] },
  terminal: string,
  resolve: string[] | null
) {
  turnTimings.landed(chat, result.outcome, result.files.length)
  productLog.info('landing', 'Landing', {
    chat,
    outcome: result.outcome,
    files: result.files.length,
    terminal,
    resolve: resolve?.length,
    branch
  })
}

export function logLandingFailed(chat: string, branch: string, reason: string) {
  productLog.error('landing', 'Landing failed; work held on the chat branch', {
    chat,
    branch,
    error: truncate(reason, 300)
  })
}

/** Records the resolved model and the end of a turn from the provider's events. */
export function logTurnEvent(chat: string, event: AgentEvent) {
  if (event.type === 'model') {
    if (event.model && resolved.get(chat) !== event.model) {
      resolved.set(chat, event.model)
      productLog.info('chat', 'Model resolved', { chat, model: event.model })
    }
    return
  }
  if (event.type !== 'done' && event.type !== 'error') return
  if (event.type === 'done' && event.stale) return
  const start = running.get(chat)
  if (event.type === 'done') running.delete(chat)
  turnTimings.providerEnded(chat, event.turn, event.type)
  const fields = {
    chat,
    turn: event.turn,
    provider: start?.provider,
    model: resolved.get(chat) ?? start?.model,
    ms: start ? Date.now() - start.at : undefined
  }
  if (event.type === 'done') productLog.info('chat', 'Turn ended', fields)
  else
    productLog.error('chat', 'Turn failed', {
      ...fields,
      code: event.code,
      error: truncate(event.message, 300)
    })
}
