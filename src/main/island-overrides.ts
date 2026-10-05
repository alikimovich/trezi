import type { IslandValue } from '../shared/chat-islands'

/**
 * A Shadow island gesture without per-frame HMR (LKM-140).
 *
 * LKM-133 wrote the source on every throttled drag frame, so each frame was a dev-server
 * HMR update. Here each frame is shown in the preview as a temporary box-shadow override
 * (`src/preview/island-override.ts`) with the same derived string the source would get;
 * the source is written once at the gesture's end (or after `idle` without frames), and
 * the override is removed only after the page's own style shows the written value, so
 * there is no gap frame. All writes of a gesture keep its one Undo group.
 */
export interface IslandPreviewPort {
  /** Show `css` on the elements that show `from` (found once per override); how many carry it. */
  apply(key: string, from: string, css: string): Promise<number>
  /** Remove the override once the page's own style shows `css`; true when nothing is held. */
  settle(key: string, css: string): Promise<boolean | null>
  clear(key: string): Promise<unknown>
}
export interface GestureFrame {
  key: string
  gesture: string
  values: Record<string, IslandValue>
  ended: boolean
  /** The derived box-shadow of the source values now. */
  from: () => string
  /** The derived box-shadow for the gesture's values; throws when they are invalid. */
  css: (values: Record<string, IslandValue>) => string
  /** One serialized source write of the gesture's values, in the gesture's Undo group. */
  write: (values: Record<string, IslandValue>) => Promise<'written' | 'conflict'>
}
interface Gesture {
  id: string
  /** finding: no override yet; shown: the preview shows the frames; live: write each frame (LKM-133). */
  mode: 'finding' | 'shown' | 'live'
  values: Record<string, IslandValue>
  css: string
  frames: number
  chain: Promise<unknown>
  idle?: ReturnType<typeof setTimeout>
}
export type OverrideEvent =
  | {
      type: 'show' | 'write' | 'written' | 'removed' | 'timeout' | 'cleared'
      key: string
      css?: string
      values?: Record<string, IslandValue>
    }
  | { type: 'live'; key: string }

export class IslandOverrides {
  private readonly gestures = new Map<string, Gesture>()
  constructor(
    readonly port: IslandPreviewPort,
    readonly timing = { idle: 600, poll: 50, timeout: 8000 },
    readonly log: (event: OverrideEvent) => void = () => {}
  ) {}

  /**
   * One frame of a gesture. null: the preview shows it and the source write is deferred.
   * Otherwise the values to write now as LKM-133 did, because the preview found no element
   * showing the island's shadow (for example a Tailwind class list it cannot match).
   */
  async frame(f: GestureFrame): Promise<Record<string, IslandValue> | null> {
    let g = this.gestures.get(f.key)
    if (!g || g.id !== f.gesture) {
      if (g?.idle) clearTimeout(g.idle)
      // The previous gesture's override, if still held, is taken over by this one.
      g = {
        id: f.gesture,
        mode: 'finding',
        values: {},
        css: '',
        frames: 0,
        chain: g?.chain ?? Promise.resolve()
      }
      this.gestures.set(f.key, g)
    }
    const values = { ...g.values, ...f.values }
    if (g.mode !== 'live') {
      try {
        g.css = f.css(values)
      } catch (error) {
        if (g.mode === 'shown') throw error
        g.mode = 'live'
      }
    }
    g.values = values
    if (g.mode === 'live') return this.live(f, g)
    const frame = ++g.frames
    if (g.idle) {
      clearTimeout(g.idle)
      g.idle = undefined
    }
    const gesture = g
    const step = g.chain.then(async () => {
      // A newer frame of this gesture shows a later value.
      if (this.gestures.get(f.key) !== gesture || frame !== gesture.frames) return
      const css = gesture.css
      const shown = await this.port.apply(f.key, f.from(), css).catch(() => 0)
      if (shown > 0) {
        gesture.mode = 'shown'
        this.log({ type: 'show', key: f.key, css })
      } else {
        if (gesture.mode === 'shown') void this.port.clear(f.key).catch(() => {})
        gesture.mode = 'live'
      }
    })
    g.chain = step.catch(() => {})
    await step
    // The step above may have found no element showing the shadow.
    if ((gesture.mode as Gesture['mode']) === 'live') return this.live(f, g)
    if (f.ended) await this.flush(f, g)
    else if (this.gestures.get(f.key) === g)
      g.idle = setTimeout(() => void this.flush(f, g).catch(() => {}), this.timing.idle)
    return null
  }
  /** A gesture of this key holds frames (shown or waiting to be written). */
  holds(key: string) {
    return this.gestures.has(key)
  }
  /** Undo, Reset, Reload or a closed chat: show the source again now. */
  async clear(key: string) {
    const g = this.gestures.get(key)
    if (g?.idle) clearTimeout(g.idle)
    this.gestures.delete(key)
    this.log({ type: 'cleared', key })
    await this.port.clear(key).catch(() => {})
  }
  clearAll(prefix: string) {
    for (const key of [...this.gestures.keys()]) if (key.startsWith(prefix)) void this.clear(key)
  }
  private live(f: GestureFrame, g: Gesture) {
    this.log({ type: 'live', key: f.key })
    if (f.ended && this.gestures.get(f.key) === g) this.gestures.delete(f.key)
    return { ...g.values }
  }
  private async flush(f: GestureFrame, g: Gesture) {
    if (g.idle) {
      clearTimeout(g.idle)
      g.idle = undefined
    }
    if (this.gestures.get(f.key) !== g) return
    const css = g.css,
      values = { ...g.values }
    this.log({ type: 'write', key: f.key, css, values })
    let outcome: 'written' | 'conflict'
    try {
      outcome = await f.write(values)
    } catch (error) {
      await this.drop(f.key, g)
      throw error
    }
    // A bound value changed outside the island: the controls and the preview show the source.
    if (outcome === 'conflict') {
      await this.drop(f.key, g)
      return
    }
    this.log({ type: 'written', key: f.key, css })
    void this.settle(f.key, g, css, f.ended)
  }
  /** Poll until the page's own style shows the written value, then remove the override. */
  private async settle(key: string, g: Gesture, css: string, ended: boolean) {
    const deadline = Date.now() + this.timing.timeout
    const current = () => this.gestures.get(key) === g && g.css === css
    while (current()) {
      if (Date.now() > deadline) {
        this.log({ type: 'timeout', key, css })
        await this.drop(key, g)
        return
      }
      const done = await this.port.settle(key, css).catch(() => null)
      // A newer frame or gesture holds the override now; its own write settles it.
      if (!current()) return
      if (done) {
        this.log({ type: 'removed', key, css })
        if (ended) this.gestures.delete(key)
        else g.mode = 'finding'
        return
      }
      await new Promise((resolve) => setTimeout(resolve, this.timing.poll))
    }
  }
  private async drop(key: string, g: Gesture) {
    if (this.gestures.get(key) === g) await this.clear(key)
  }
}
