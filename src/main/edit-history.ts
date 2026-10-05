import { sourceOwner, type UndoResult } from './source-owner'

export type { UndoResult }

/**
 * Undo/redo for ALL trezi source edits (v8 F3b) — props, inline text, token swaps,
 * React + Svelte. Edits committed through `proposeEdit` enter the history as they are
 * written; writes made elsewhere (a merged chat turn, an applied comment) are recorded
 * with `recordEdit`. `undo(root)`/`redo(root)` revert/re-apply against the file's
 * CURRENT content, refusing to clobber if the user changed it in their own editor since.
 *
 * History is scoped per project root — trezi keeps several projects open in the rail
 * (v5-C), so Cmd+Z in project B must never revert a file in project A. The edits
 * write straight to source, so the dev server's HMR refreshes the preview on undo
 * just like apply.
 *
 * The service's source owner keeps the history (S08, `SourceHistory.swift`); every
 * export here dispatches to it.
 */

/** Record a source write made outside `proposeEdit`. A no-op write is ignored. */
export function recordEdit(
  root: string,
  file: string,
  before: string,
  after: string,
  key?: string,
  group?: string
): void {
  if (before === after) return
  // Ordered with later Undo requests by the pipe; a failure (or no service) only loses
  // this Undo step, never the edit that was already made.
  try {
    void sourceOwner()
      .record(root, [{ path: file, before, after }], { key, group })
      .catch(() => {})
  } catch {}
}

/** Revert the last edit in `root` (writes its `before`), unless it changed on disk. */
export const undo = (root: string): Promise<UndoResult> => sourceOwner().undo(root)
/** Re-apply the last undone edit in `root` (writes its `after`), unless it changed. */
export const redo = (root: string): Promise<UndoResult> => sourceOwner().redo(root)
/** Whether `root` has a step to undo and to redo. */
export const editAvailability = (root: string): Promise<{ undo: boolean; redo: boolean }> =>
  sourceOwner().history(root)

/**
 * Can the turn recorded under `group` be reverted right now? True iff its entries are
 * still on `root`'s undo stack AND every file it touched still holds exactly the text
 * that turn last wrote. A cheap pre-check so the UI can grey out a Revert button that
 * would only conflict; `revertGroup` re-validates the same guard before it writes.
 */
export const canRevertGroup = (root: string, group: string): Promise<boolean> =>
  sourceOwner().canRevert(root, group)

/**
 * Addressable revert of ONE recorded group (a chat turn: `chat:<wtId>:<turnNo>`),
 * not necessarily the top of the undo stack. Restores every file's `before`,
 * all-or-nothing, refusing (conflict) if any file drifted from the `after` that turn
 * wrote. Revert is one-way: nothing is pushed onto the redo stack.
 */
export const revertGroup = (root: string, group: string): Promise<UndoResult> =>
  sourceOwner().revert(root, group)

/** Drop a project's history (e.g. when it's closed in the rail). */
export const clearHistory = (root: string): void => {
  void sourceOwner()
    .clearHistory(root)
    .catch(() => {})
}
