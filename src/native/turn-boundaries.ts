import type { AgentEvent } from '../shared/api'

export type TurnBoundary = { kind: 'begin' | 'landed' | 'failed'; turn: string | null }

/**
 * Which turn an agent event begins or ends, for islands and deferred navigation (S12).
 * Events carry their turn (S11), except the landing's `isolation` event, which follows
 * the `done` that asked for it: it is attributed to that turn. A late terminal
 * (`stale`: another turn's) begins and ends nothing, so it can never activate a newer
 * turn's islands or open its navigation.
 */
export class TurnBoundaries {
  private readonly landing = new Map<string, string>()
  private readonly started = new Map<string, string>()

  events(key: string, event: AgentEvent): TurnBoundary[] {
    if (event.stale) return []
    const out: TurnBoundary[] = []
    if (event.turn && this.started.get(key) !== event.turn) {
      this.started.set(key, event.turn)
      out.push({ kind: 'begin', turn: event.turn })
    }
    if (event.type === 'done' && event.landingPending) {
      if (event.turn) this.landing.set(key, event.turn)
    } else if (event.type === 'done') out.push({ kind: 'landed', turn: event.turn ?? null })
    else if (event.type === 'error') out.push({ kind: 'failed', turn: event.turn ?? null })
    else if (event.type === 'isolation' && (event.state === 'merged' || event.state === 'parked')) {
      const turn = this.landing.get(key) ?? null
      this.landing.delete(key)
      out.push({ kind: event.state === 'merged' ? 'landed' : 'failed', turn })
    }
    return out
  }

  forget(key: string) {
    this.landing.delete(key)
    this.started.delete(key)
  }
}
