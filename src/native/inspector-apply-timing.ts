// LKM-639: the inspector's side of one Apply's timeline, joined to the backend's
// `Background agent phases` line by `op` (the spawn id the batch holds). Stages:
// `dispatched` (preflight done, the worker has it), `landed` (the worker reported applied
// and the source moved), `visible` (the preview renders it without Trezi's override) and
// `returned` (it did not land). Only ids, counts and durations: never values or paths.
import { productLog } from '../main/product-log'
import type { ApplyBatch } from './inspector-batches'

export type ApplyStage = 'dispatched' | 'landed' | 'visible' | 'returned'

const since = (at: number | undefined, now: number) => (at === undefined ? undefined : now - at)

export function noteApplyStage(batch: ApplyBatch, stage: ApplyStage, now = Date.now()): void {
  const times = batch.times
  if (stage === 'dispatched') times.dispatched = now
  if (stage === 'landed') times.landed = now
  productLog.info('inspector', `Inspector Apply ${stage}`, {
    op: batch.id ?? null,
    fields: batch.drafts.size,
    // Apply pressed → preflight (source hashes, preview freshness) and dispatch.
    ...(stage === 'dispatched' ? { preflightMs: since(times.applied, now) } : {}),
    // Dispatch → the worker's applied report and the source check.
    ...(stage === 'landed' ? { workerMs: since(times.dispatched, now) } : {}),
    // Landed → the preview renders it on its own.
    ...(stage === 'visible' ? { previewMs: since(times.landed, now) } : {}),
    totalMs: since(times.applied, now)
  })
}
