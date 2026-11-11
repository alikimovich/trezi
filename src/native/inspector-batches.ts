// LKM-638: an inspector Apply hands an immutable batch of Styles drafts to its background
// worker and leaves the inspector editable. The submitted batch (A) and the next draft (B)
// are separate layers over one element's preview: A's values stay visible until the
// preview itself renders them, and B composes above A. These helpers are the pure part:
// which CSS properties a draft field drives, how layers compose, and how a batch that did
// not land returns beneath the newer draft without overwriting it.
import type { SelectedElement } from '../shared/api'
import { STYLE_PROP_META, toCssText } from '../shared/css-values'

export type StyleDraft = {
  field: string
  value: string
  file: string
  hash: string
  tokenChoice?: string
  /** Batches (by key) that were writing this file when the draft was staged. */
  during?: ReadonlySet<number>
}
/**
 * starting: preflight (source hashes, preview freshness) and the worker's dispatch.
 * queued: waits for an earlier batch on the same file to report its result.
 * running: the worker has it. landed: the worker reported applied and the source moved;
 * its values stay on the preview until the preview renders them itself.
 */
export type ApplyBatchStatus = 'starting' | 'queued' | 'running' | 'landed'
export type ApplyBatch = {
  readonly key: number
  /** The operation id (background Apply id or chat turn), once dispatched. */
  id?: string
  readonly root: string
  /** The element identity the batch belongs to (follows a same-element reattach). */
  target: string
  element: SelectedElement
  readonly drafts: ReadonlyMap<string, StyleDraft>
  /** The draft's Undo steps at Apply, restored with it if it comes back. */
  readonly history: readonly ReadonlyMap<string, StyleDraft>[]
  /** Token labels chosen when the batch was captured, by field. */
  readonly tokens: ReadonlyMap<string, string>
  status: ApplyBatchStatus
  /** Queued until its element is selected: its preview needs a refresh (LKM-600). */
  needsElement?: boolean
  /** The inspector's page-update count when it landed (later updates may render it). */
  landedAt?: number
  /** LKM-639: wall-clock stages for the Apply timeline (`inspector-apply-timing.ts`). */
  readonly times: { applied: number; dispatched?: number; landed?: number }
}

const PAIR = /^style:(padding|margin)-(horizontal|vertical)$/

/** The CSS longhands a Styles draft field drives (a compact pair drives two sides). */
export function draftProps(field: string): string[] {
  const pair = PAIR.exec(field)
  if (pair)
    return (pair[2] === 'horizontal' ? ['left', 'right'] : ['top', 'bottom']).map(
      (side) => `${pair[1]}-${side}`
    )
  return field.startsWith('style:') ? [field.slice(6)] : []
}

/** The value previewed for `prop`: a bare number gets the field's unit, as typing does. */
export function previewValue(prop: string, value: string): string {
  return STYLE_PROP_META[prop]?.control === 'number' && /^-?\d+(\.\d+)?$/.test(value.trim())
    ? toCssText(prop, Number(value))
    : value
}

/** Property → previewed value; a later layer wins over an earlier one. */
export function composeLayers(
  layers: Iterable<ReadonlyMap<string, StyleDraft>>
): Map<string, string> {
  const composed = new Map<string, string>()
  for (const layer of layers)
    for (const draft of layer.values())
      for (const prop of draftProps(draft.field))
        composed.set(prop, previewValue(prop, draft.value))
  return composed
}

/** Whether two draft fields drive any of the same properties. */
export function overlaps(a: string, b: string): boolean {
  const props = new Set(draftProps(a))
  return a === b || draftProps(b).some((prop) => props.has(prop))
}

/**
 * A batch that did not land returns to the editable draft beneath what the user has
 * staged since: a field the newer draft (or a later batch) already drives keeps the newer
 * value, so the preview does not move. Returns a new map; neither input is changed.
 */
export function restoreUnder(
  returned: ReadonlyMap<string, StyleDraft>,
  upper: ReadonlyMap<string, StyleDraft>,
  later: ReadonlyMap<string, StyleDraft>[]
): Map<string, StyleDraft> {
  const covered = (field: string) =>
    [upper, ...later].some((layer) => [...layer.keys()].some((other) => overlaps(field, other)))
  const merged = new Map<string, StyleDraft>()
  for (const [field, draft] of returned) if (!covered(field)) merged.set(field, draft)
  for (const [field, draft] of upper) merged.set(field, draft)
  return merged
}

/** The footer's one line for this element's submitted batches; '' when there are none. */
export function batchesLabel(batches: readonly ApplyBatch[]): string {
  if (!batches.length) return ''
  const count = (status: ApplyBatchStatus) =>
    batches.filter((batch) => batch.status === status).length
  const values = (n: number) => `${n} value${n === 1 ? '' : 's'}`
  const parts: string[] = []
  const active = batches.filter((b) => b.status === 'starting' || b.status === 'running')
  if (active.length)
    parts.push(
      `Applying ${values(active.reduce((sum, b) => sum + b.drafts.size, 0))} in the background`
    )
  if (count('queued')) parts.push(`${count('queued')} queued`)
  if (batches.some((b) => b.needsElement && b.status === 'queued'))
    parts.push('the preview refreshes before the next one starts')
  if (count('landed')) parts.push('applied to source, waiting for the preview')
  const line = parts.join(' · ')
  return line[0].toUpperCase() + line.slice(1)
}
