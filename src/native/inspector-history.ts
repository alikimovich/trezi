// LKM-644: the Styles draft's incremental Undo/Redo (Edit → Undo ⌘Z, Redo ⇧⌘Z and the
// island's Undo draft). Each step is a snapshot of the whole editable draft (B) taken before
// one logical edit: one committed field value, one finished scrub or spacing-handle drag, one
// token choice. Previews (each slider or drag move, each arrow step before Return) are never
// steps. Snapshots hold the draft entries themselves, so a step restores the exact earlier
// value, unit and token choice, or the property's absence (no entry: the preview override
// goes and the page's own value shows again). Submitted Apply batches (A) are never in here:
// a step only moves B, so A's layer keeps showing beneath it. Memory only, bounded, never
// logged or persisted.
import type { StyleDraft } from './inspector-batches'

export type DraftStep = Map<string, StyleDraft>
/** Steps kept per element draft; the oldest goes first. */
export const DRAFT_STEP_LIMIT = 100

export class DraftSteps {
  constructor(
    public past: DraftStep[] = [],
    public future: DraftStep[] = []
  ) {}
  /** The draft before a new edit. A new edit after Undo drops the redo branch. */
  record(current: ReadonlyMap<string, StyleDraft>) {
    this.past.push(new Map(current))
    if (this.past.length > DRAFT_STEP_LIMIT) this.past.shift()
    this.future = []
  }
  /** The draft one step back (`undo`) or forward, without moving. */
  peek(undo: boolean): DraftStep | undefined {
    return (undo ? this.past : this.future).at(-1)
  }
  /** Moves one step, keeping `current` for the opposite direction; the draft to show. */
  step(undo: boolean, current: ReadonlyMap<string, StyleDraft>): DraftStep | undefined {
    const next = (undo ? this.past : this.future).pop()
    if (next) (undo ? this.future : this.past).push(new Map(current))
    return next
  }
  copy() {
    return new DraftSteps(
      this.past.map((step) => new Map(step)),
      this.future.map((step) => new Map(step))
    )
  }
  get empty() {
    return !this.past.length && !this.future.length
  }
}

export type HistoryRoute =
  /** The selected element's draft moved one step. */
  | { kind: 'stepped' }
  /** Visual editing owns the key but cannot step; `reason` says why (nothing else runs). */
  | { kind: 'blocked'; reason: string }
  /** No visual edit is in play: the project's source edit history may answer. */
  | { kind: 'none' }
