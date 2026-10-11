import type { AgentEvent } from '../../shared/api'
import { productLog } from '../product-log'
import { classifyError, type IncidentClass } from './catalog'
import { parseRecoveryStatus } from './status'

/** How one incident class ended within a turn. */
export type IncidentOutcome = 'recovered' | 'fell-back' | 'failed'

export interface IncidentRecord {
  chat: string
  code: IncidentClass
  recovery: string
  outcome: IncidentOutcome
  /** Retries or restarts the turn spent on it. */
  attempts: number
}

interface Open {
  code: IncidentClass
  recovery: string
  attempts: number
  /** Undefined while a recovery is still running. */
  outcome?: IncidentOutcome
}

const recoveryOf: Partial<Record<IncidentClass, string>> = {
  'provider-network': 'retry',
  'helper-crash': 'restart-helper'
}

/**
 * Dreamer telemetry (LKM-202): one entry per incident class per turn, written when the
 * turn ends, with the class's final outcome: recovered (a retry or restart worked),
 * fell-back (the other provider ran the turn) or failed. A retry that recovers silently
 * and an error that reaches the transcript are the same incident, counted once.
 */
export function createIncidentTracker(write: (record: IncidentRecord) => void) {
  const turns = new Map<string, Map<IncidentClass, Open>>()
  const closing = new Map<string, ReturnType<typeof setTimeout>>()
  const open = (chat: string, code: IncidentClass): Open => {
    const turn = turns.get(chat) ?? new Map<IncidentClass, Open>()
    turns.set(chat, turn)
    const entry = turn.get(code) ?? {
      code,
      recovery: recoveryOf[code] ?? 'doctor',
      attempts: 0
    }
    turn.set(code, entry)
    return entry
  }
  /** The class whose recovery is running (a status line does not name its class). */
  const running = (chat: string, code?: IncidentClass): Open | undefined =>
    [...(turns.get(chat)?.values() ?? [])]
      .reverse()
      .find((e) => !e.outcome && (!code || e.code === code))

  /** Writes the turn's entries and forgets them. Idempotent. */
  const end = (chat: string): void => {
    const turn = turns.get(chat)
    turns.delete(chat)
    clearTimeout(closing.get(chat))
    closing.delete(chat)
    for (const entry of turn?.values() ?? [])
      write({
        chat,
        code: entry.code,
        recovery: entry.recovery,
        // A recovery still running when the turn ended (stopped, closed) did not recover.
        outcome: entry.outcome ?? 'failed',
        attempts: entry.attempts
      })
  }

  return {
    end,
    /** An incident whose whole life is known at once (an automatic Resolve): written now. */
    report(record: IncidentRecord): void {
      write(record)
    },
    observe(chat: string, event: AgentEvent): void {
      if (event.type === 'status') {
        const status = parseRecoveryStatus(event.text)
        if (!status) return
        if (status.kind === 'reconnecting') {
          const entry = open(chat, 'provider-network')
          entry.attempts++
          entry.outcome = undefined
        } else if (status.kind === 'restarting') {
          const entry = open(chat, 'helper-crash')
          entry.attempts++
          entry.outcome = undefined
        } else if (status.kind === 'recovered') {
          const entry = running(chat)
          if (entry) entry.outcome = 'recovered'
        } else open(chat, 'provider-network').outcome = 'fell-back'
      } else if (event.type === 'error') {
        const { class: code, action } = classifyError(event.message)
        const entry = open(chat, code)
        entry.recovery = recoveryOf[code] ?? action
        entry.outcome = 'failed'
        // Some providers end a failed turn with the error alone: close it shortly after.
        clearTimeout(closing.get(chat))
        const timer = setTimeout(() => end(chat), 500)
        timer.unref?.()
        closing.set(chat, timer)
      } else if (event.type === 'done') end(chat)
    }
  }
}

export const incidents = createIncidentTracker((record) => {
  productLog.info('self-heal', 'Incident', {
    chat: record.chat,
    code: record.code,
    recovery: record.recovery,
    outcome: record.outcome,
    attempts: record.attempts
  })
  // An incident nothing recovered gets the doctor's one-line diagnosis for support.
  if (record.outcome === 'failed')
    void import('./doctor')
      .then(({ diagnose }) => diagnose(record.code))
      .then((diagnosis) =>
        productLog.info('self-heal', 'Doctor', {
          chat: record.chat,
          code: record.code,
          fix: diagnosis.fixApplied ?? undefined,
          next: diagnosis.nextStep
        })
      )
      .catch(() => {})
})
