import { projectKey } from '../shared/projectKey'
import { productLog } from './product-log'
import { receiptSession, sessionCommandReceipts, sessionReceipts } from './verification-receipts'

/**
 * LKM-639: where one background agent operation (a comment, an inspector Apply) spends
 * its time. The operation id is the spawn id the inspector's batch already holds, so the
 * native log lines and these join on `op`. Marks are wall-clock milestones in the order a
 * spawn passes them; the logged spans are the gaps between consecutive milestones, so no
 * time is counted twice. Checks the agent ran are inside the model span and are reported
 * as `checkMs` (a part of it, not an extra span). Only ids, origins, outcomes, counts and
 * durations are logged: never the instruction, values, file paths or output.
 */

export type SpawnMark =
  /** The IPC request arrived. */
  | 'requested'
  /** The owner admitted it (immediately, or when a slot freed). */
  | 'admitted'
  /** The repository lane started creating its worktree. */
  | 'lane'
  /** Worktree, setup helpers and dependencies ready. */
  | 'worktree'
  /** Project memory read and the provider session started. */
  | 'provider'
  /** Peer registration and context read; the instruction was sent. */
  | 'sent'
  /** The first status event after which the session had touched a file. */
  | 'first-edit'
  /** The provider reported its turn done (or failed). */
  | 'model-done'
  /** Live-change report and peer files read; waiting for the repository lease. */
  | 'landing-queued'
  /** The repository lease was granted for its landing. */
  | 'lease'
  /** Gate, apply, commit and worktree removal done; `spawn-finished` sent. */
  | 'finished'

const ORDER: SpawnMark[] = [
  'requested',
  'admitted',
  'lane',
  'worktree',
  'provider',
  'sent',
  'first-edit',
  'model-done',
  'landing-queued',
  'lease',
  'finished'
]

/** The span that ends at each mark, as logged (`<name>Ms`). */
const SPAN: Partial<Record<SpawnMark, string>> = {
  admitted: 'queue',
  lane: 'laneWait',
  worktree: 'worktree',
  provider: 'provider',
  sent: 'peer',
  'first-edit': 'toFirstEdit',
  'model-done': 'model',
  'landing-queued': 'preLanding',
  lease: 'leaseWait',
  finished: 'landing'
}

export interface SpawnTimeline {
  op: string
  origin: string
  marks: Partial<Record<SpawnMark, number>>
  /** Agent-run checks' own durations (inside the model span). */
  checkMs: number
  checks: number
  /** Landings retried after the agent combined overlapping work. */
  continuations: number
}

const timelines = new Map<string, SpawnTimeline>()
/** The last finished timelines, newest last (tests and diagnostics; bounded). */
const finished: SpawnTimeline[] = []
const KEEP = 20

let clock: () => number = () => Date.now()
/** Tests only: a deterministic clock. */
export function setSpawnPhaseClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now())
}

export function beginSpawnPhases(op: string, origin: string): void {
  timelines.set(op, {
    op,
    origin,
    marks: { requested: clock() },
    checkMs: 0,
    checks: 0,
    continuations: 0
  })
}

/**
 * Records `mark` once (the first time it is reached). A continuation's second finish
 * moves `model-done` and the landing marks on, so the spans cover the final landing; the
 * extra model time stays inside `model`.
 */
export function markSpawn(op: string, mark: SpawnMark, again = false): void {
  const timeline = timelines.get(op)
  if (!timeline) return
  if (timeline.marks[mark] !== undefined && !again) return
  timeline.marks[mark] = clock()
}

/** A landing that sent the agent back to combine overlapping work. */
export function continueSpawn(op: string): void {
  const timeline = timelines.get(op)
  if (!timeline) return
  timeline.continuations++
  delete timeline.marks['landing-queued']
  delete timeline.marks.lease
}

/** The checks the agent ran during this operation (receipt durations). */
export function noteSpawnChecks(op: string, durations: number[]): void {
  const timeline = timelines.get(op)
  if (!timeline) return
  timeline.checks = durations.length
  timeline.checkMs = Math.round(durations.reduce((sum, ms) => sum + Math.max(0, ms), 0))
}

/** The durations of the checks a spawn's tools recorded for its worktree. */
export function spawnCheckDurations(emitKey: string, worktree: string): number[] {
  const session = receiptSession(emitKey, projectKey(worktree))
  return [...sessionReceipts(session), ...sessionCommandReceipts(session)].map((r) => r.ms)
}

/** Spans between consecutive reached milestones; a skipped mark folds into the next span. */
export function spawnSpans(timeline: SpawnTimeline): Record<string, number> {
  const spans: Record<string, number> = {}
  let previous: number | undefined
  for (const mark of ORDER) {
    const at = timeline.marks[mark]
    if (at === undefined) continue
    const name = SPAN[mark]
    if (name && previous !== undefined) spans[`${name}Ms`] = Math.max(0, at - previous)
    previous = at
  }
  const start = timeline.marks.requested
  const end = timeline.marks.finished ?? previous
  if (start !== undefined && end !== undefined) spans.totalMs = Math.max(0, end - start)
  return spans
}

/** Ends the operation's timeline and writes its one summary line. */
export function finishSpawnPhases(op: string, outcome: string): SpawnTimeline | null {
  const timeline = timelines.get(op)
  if (!timeline) return null
  timelines.delete(op)
  timeline.marks.finished ??= clock()
  finished.push(timeline)
  if (finished.length > KEEP) finished.shift()
  productLog.info('spawn', 'Background agent phases', {
    op,
    origin: timeline.origin,
    outcome,
    ...spawnSpans(timeline),
    checkMs: timeline.checkMs,
    checks: timeline.checks,
    continuations: timeline.continuations
  })
  return timeline
}

/** Drops a timeline without logging (a request refused before it started). */
export function dropSpawnPhases(op: string): void {
  timelines.delete(op)
}

/** The timeline of a finished operation (tests and diagnostics). */
export function finishedSpawnPhases(op: string): SpawnTimeline | null {
  return finished.find((timeline) => timeline.op === op) ?? null
}
