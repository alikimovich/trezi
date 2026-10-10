import type { AgentEvent, ImageAttachment } from '../../shared/api'
import { classifyError } from '../self-heal/catalog'
import { RECOVERED_STATUS, RESTARTING_STATUS } from '../self-heal/status'

/** A turn's helper may be restarted this many times before its error is shown. */
export const MAX_HELPER_RESTARTS = 2
/** A failed turn's `done` normally follows its `error` at once; a provider without one is not waited for. */
const DONE_WAIT_MS = 1000

export const CONTINUE_PROMPT =
  'The provider helper restarted while you were working. Continue the previous request from where you left off; do not repeat work that is already done.'

export interface TurnRecoveryHost {
  /** The session's own emit: it reaches the chat. */
  emit(event: AgentEvent): void
  /** Background spawns and fallback sessions are never restarted or moved. */
  interactive: boolean
  /** True when the setting and the provider pair allow moving a failed turn (sync part). */
  canFallback(): boolean
  /** Resolves once the crashed helper's exit was reported, or soon after. */
  exited(): Promise<void>
  /** False once the helper broke its grant (or the turn runs on the fallback provider). */
  canRestart(): boolean
  /** Starts a new helper on the same conversation and sends `text` to it. Rejects on failure. */
  restart(text: string, images?: ImageAttachment[]): Promise<void>
  /** Runs the turn on the other provider and says so; false (nothing emitted) when none is configured. */
  fallback(text: string, images?: ImageAttachment[]): Promise<boolean>
}

interface Turn {
  text: string
  images?: ImageAttachment[]
  /** The model produced visible output: resending the prompt would repeat it. */
  produced: boolean
  restarts: number
  fellBack: boolean
  stopped: boolean
  /** A restart ran: say "Recovered" when the turn ends without an error. */
  restarted: boolean
}

interface Held {
  kind: 'restart' | 'fallback'
  error: AgentEvent
}

/**
 * LKM-225: recovers a failed turn inside its helper session. A helper that crashed is
 * restarted and the turn resumed (at most twice); a provider that could not connect
 * (after the adapter's own retries) hands the turn to the other provider. The failed
 * turn's `error` and `done` are held back until the outcome is known, so the chat sees
 * one compact status line, then either the answer or the one error that remains.
 */
export function createTurnRecovery(host: TurnRecoveryHost) {
  let turn: Turn | null = null
  let held: Held | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const release = (hold: Held): void => {
    host.emit(hold.error)
    host.emit({ type: 'done' })
  }

  const proceed = async (hold: Held): Promise<void> => {
    const current = turn
    if (!current || current.stopped) return release(hold)
    try {
      if (hold.kind === 'restart') {
        await host.exited()
        // A helper that broke its grant, or a fallback turn's, stays down.
        if (!host.canRestart()) return release(hold)
        current.restarts++
        host.emit({ type: 'status', text: RESTARTING_STATUS })
        current.restarted = true
        await host.restart(
          current.produced ? CONTINUE_PROMPT : current.text,
          current.produced ? undefined : current.images
        )
        return
      }
      current.fellBack = true
      if (!(await host.fallback(current.text, current.images))) release(hold)
    } catch {
      release(hold)
    }
  }

  const hold = (next: Held): void => {
    held = next
    clearTimeout(timer)
    timer = setTimeout(() => finish(), DONE_WAIT_MS)
    timer.unref?.()
  }
  const finish = (): void => {
    clearTimeout(timer)
    const next = held
    held = null
    if (next) void proceed(next)
  }

  return {
    /** A new user turn. */
    begin(text: string, images?: ImageAttachment[]): void {
      clearTimeout(timer)
      held = null
      turn = {
        text,
        images,
        produced: false,
        restarts: 0,
        fellBack: false,
        stopped: false,
        restarted: false
      }
    },
    /** The user pressed Stop: whatever ends the turn now is not a failure to recover from. */
    stop(): void {
      if (turn) turn.stopped = true
    },
    /** Looks at an event from the helper; true means it was held back. */
    event(event: AgentEvent): boolean {
      if (!turn) return false
      if (held) {
        if (event.type === 'done') finish()
        return true
      }
      if (
        event.type === 'delta' ||
        event.type === 'chat-ui' ||
        event.type === 'permission-request' ||
        event.type === 'question-request'
      )
        turn.produced = true
      else if (event.type === 'done') {
        if (turn.restarted) host.emit({ type: 'status', text: RECOVERED_STATUS })
        turn.restarted = false
      } else if (event.type === 'error') {
        turn.restarted = false
        if (turn.stopped || !host.interactive) return false
        const { class: kind } = classifyError(event.message)
        if (kind === 'helper-crash' && turn.restarts < MAX_HELPER_RESTARTS) {
          hold({ kind: 'restart', error: event })
          return true
        }
        if (kind === 'provider-network' && !turn.produced && !turn.fellBack && host.canFallback()) {
          hold({ kind: 'fallback', error: event })
          return true
        }
      }
      return false
    }
  }
}
