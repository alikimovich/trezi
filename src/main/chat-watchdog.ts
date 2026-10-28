/**
 * LKM-165: bounded waits for a chat's work. A turn or a landing that stops making
 * progress is ended cleanly, so "This chat is already running." is never a dead end.
 * Pure timers and bookkeeping; `agent.ts` and `chat-isolation.ts` act on the verdicts.
 */

/** No event or heartbeat for this long ends a running turn. */
export const TURN_STUCK_MS = 10 * 60_000
/** A landing (Git work on the chat's worktree) that takes longer than this is ended. */
export const LANDING_STUCK_MS = 3 * 60_000
/** How often the app looks for stuck chats. */
export const WATCHDOG_INTERVAL_MS = 30_000
/** A send to a chat that shows running with nothing in flight settles it after this long. */
export const STALE_SEND_MS = 60_000

/** The landing's own failure when it stalls or is stopped; the work stays held with Retry. */
export class LandingEnded extends Error {}

/** Bounded waits for a chat's queued landings, all ended by the user's Stop. */
export class LandingGuard {
  private active = new Map<string, Set<(reason: string) => void>>()

  constructor(private stuckMs = LANDING_STUCK_MS) {}

  /** Whether a landing for this chat is in flight. */
  has(key: string): boolean {
    return !!this.active.get(key)?.size
  }

  /** Ends the chat's landing waits now (Stop); callers skip queued work at admission. */
  abandon(key: string, reason: string): boolean {
    const ends = this.active.get(key)
    const had = !!ends?.size
    for (const end of [...(ends ?? [])]) end(reason)
    return had
  }

  /** `work` settles as itself, or rejects with `LandingEnded` on a stall or `abandon`. */
  run<T>(key: string, work: Promise<T>, stuckMs = this.stuckMs, onEnd?: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done = (settle: () => void): void => {
        clearTimeout(timer)
        const ends = this.active.get(key)
        ends?.delete(end)
        if (!ends?.size) this.active.delete(key)
        settle()
      }
      const end = (reason: string): void => {
        onEnd?.()
        done(() => reject(new LandingEnded(reason)))
      }
      const timer = setTimeout(
        () =>
          end(
            `The landing made no progress for ${Math.max(1, Math.round(stuckMs / 1000))} seconds, so Trezi ended it.`
          ),
        stuckMs
      )
      timer.unref?.()
      const ends = this.active.get(key) ?? new Set<(reason: string) => void>()
      ends.add(end)
      this.active.set(key, ends)
      work.then(
        (value) => done(() => resolve(value)),
        (error) => done(() => reject(error))
      )
    })
  }
}

/** When each running chat last made progress (an event or heartbeat, a landing step). */
export class TurnWatchdog {
  private seen = new Map<string, number>()

  constructor(
    private stuckMs = TURN_STUCK_MS,
    private now: () => number = Date.now
  ) {}

  touch(key: string): void {
    this.seen.set(key, this.now())
  }

  forget(key: string): void {
    this.seen.delete(key)
  }

  /** How long the chat has shown no progress (0 when it was never seen). */
  quietFor(key: string): number {
    const at = this.seen.get(key)
    return at === undefined ? 0 : this.now() - at
  }

  /** The running chats with no progress for the limit. A running chat never seen starts now. */
  stuck(running: Iterable<string>): string[] {
    const out: string[] = []
    for (const key of running) {
      if (!this.seen.has(key)) this.touch(key)
      else if (this.quietFor(key) >= this.stuckMs) out.push(key)
    }
    return out
  }
}
