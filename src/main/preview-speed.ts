/**
 * The preview session's slow-motion speed (LKM-206). One value for the open project's
 * preview: not persisted, back to 1× when another project opens. The toolbar menu, the
 * ⌃⇧S toggle and the agent's `preview_speed` set it; `src/native/preview-speed.ts` carries
 * each change to the host (badge, toolbar, document-start script) and the open page.
 */

/** The offered speeds; 0 is paused. */
export const PREVIEW_SPEEDS = [1, 0.5, 0.25, 0.1, 0] as const
/** What ⌃⇧S switches to before any other slow speed was picked. */
const DEFAULT_SLOW = 0.25
/** The most frames one Step may advance (10 s of page time). */
export const MAX_STEP_FRAMES = 600
/** One Step of page time; matches `FRAME_MS` in `src/preview/slow-motion.ts`. */
export const STEP_MS = 1000 / 60

export type PreviewSpeedChange = { speed: number } | { step: number }

export const speedLabel = (speed: number) => (speed === 0 ? 'Paused' : `${speed}×`)

/** A known speed from a number, "0.25", "0.25x"/"0.25×" or "paused"; null otherwise. */
export function parseSpeed(value: unknown): number | null {
  const text = typeof value === 'string' ? value.trim() : null
  if (text !== null && /^paused?$/i.test(text)) return 0
  const speed = typeof value === 'number' ? value : text ? Number(text.replace(/[x×]$/i, '')) : NaN
  return (PREVIEW_SPEEDS as readonly number[]).includes(speed) ? speed : null
}

export class PreviewSpeed {
  speed = 1
  /** The last speed between 0 and 1 that was picked: the target of `toggle`. */
  lastSlow = DEFAULT_SLOW
  private key: string | null = null
  private readonly listeners = new Set<(change: PreviewSpeedChange) => void>()
  on(listener: (change: PreviewSpeedChange) => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  private emit(change: PreviewSpeedChange) {
    for (const listener of this.listeners) listener(change)
  }
  /** False for a speed that is not offered. */
  set(speed: number): boolean {
    if (!(PREVIEW_SPEEDS as readonly number[]).includes(speed)) return false
    if (speed > 0 && speed < 1) this.lastSlow = speed
    if (speed === this.speed) return true
    this.speed = speed
    this.emit({ speed })
    return true
  }
  /** ⌃⇧S: 1× ↔ the last slow speed; slowed or paused goes back to 1×. */
  toggle() {
    this.set(this.speed === 1 ? this.lastSlow : 1)
  }
  /** Pauses, then advances the page `frames` frames (1/60 s of page time each). */
  step(frames = 1) {
    const count = Math.max(1, Math.min(MAX_STEP_FRAMES, Math.round(frames) || 1))
    this.set(0)
    this.emit({ step: count })
    return count
  }
  /** The open project; a different one starts at 1× with the default slow speed. */
  scope(key: string | null) {
    if (key === this.key) return
    this.key = key
    this.lastSlow = DEFAULT_SLOW
    this.set(1)
  }
}

export const previewSpeed = new PreviewSpeed()
