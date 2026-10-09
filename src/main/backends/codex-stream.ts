/**
 * Pure half of the Codex backend's stream bookkeeping, split out of `codex.ts` so
 * it can be unit-tested without loading provider sessions.
 *
 * Codex streams whole `ThreadItem`s (started → updated → completed), not raw
 * deltas, so trezi has to remember how much of each item it has already emitted
 * and turn the next reading into a suffix. The subtlety that bit us: the CLI
 * numbers items PER TURN (`item_0`, `item_1`, …, restarting each turn), so that
 * bookkeeping has to be per-turn too. Kept for the whole session instead, turn 2's
 * `item_0` inherited turn 1's length and its first N characters were sliced off —
 * users saw assistant replies beginning mid-word ("ve reliable visibility…",
 * "ing else?"). Tool steps had the mirror bug: an id already marked as surfaced
 * was silently dropped, so later turns lost steps entirely.
 */

export interface ItemTracker {
  /** Start a new turn — forget every id from the previous one. */
  reset: () => void
  /**
   * The not-yet-emitted suffix of this item's text, or '' when there's nothing
   * new. Shrinking text (a provider re-reporting less) yields '' rather than
   * clawing anything back.
   */
  delta: (id: string, text: string | undefined) => string
  /** True the FIRST time this id is offered in the current turn; false after. */
  first: (id: string) => boolean
}

export function createItemTracker(): ItemTracker {
  let emitted = new Map<string, number>()
  let seen = new Set<string>()
  return {
    reset: () => {
      emitted = new Map()
      seen = new Set()
    },
    delta: (id, text) => {
      const full = text ?? ''
      const prev = emitted.get(id) ?? 0
      if (full.length <= prev) return ''
      emitted.set(id, full.length)
      return full.slice(prev)
    },
    first: (id) => {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    }
  }
}

/** Routine SDK context-budget advice is not a chat activity or a turn failure. */
export function codexItemWarning(message: string): string | null {
  const text = message.trim()
  if (text.startsWith('Skill descriptions were shortened to fit the skills context budget.'))
    return null
  // The disclosure label can elide visually; its expanded detail must stay intact.
  return text ? `⚠ ${text}` : null
}
