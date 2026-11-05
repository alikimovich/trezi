import type { EffectPath } from './live-change-watch'
import { contentHash, type SourceOwner } from './source-owner'

type SourceEffect = <T>(
  root: string,
  operation: () => Promise<T>,
  affected: (result: T) => EffectPath[]
) => Promise<T>

/**
 * LKM-216: one in-process signal for "the live checkout changed", so every cache in the
 * visual editing loop (docs/CACHES.md) can drop what it read. Sources: the source
 * owner's own writes (island/inspector edits, editor saves, Undo, file operations),
 * landings, the live-tree watch and the dependency watch. Listeners must be cheap and
 * never throw into the writer.
 */
export type SourceChangeReason = 'source-edit' | 'landing' | 'file-change' | 'dependency'
export interface SourceChange {
  root: string
  /** Changed paths as reported (absolute or root-relative); empty when unknown. */
  files: string[]
  reason: SourceChangeReason
}

const listeners = new Set<(change: SourceChange) => void>()

export function onSourceChange(listener: (change: SourceChange) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function noteSourceChange(root: string, files: string[], reason: SourceChangeReason) {
  for (const listener of listeners) {
    try {
      listener({ root, files, reason })
    } catch {}
  }
}

/** The owner, reporting each successful write of its own. Reads pass through. */
export function observedSourceOwner(owner: SourceOwner, effect?: SourceEffect): SourceOwner {
  const run: SourceEffect = effect ?? ((_root, operation) => operation())
  const edited = (root: string, files: (string | undefined)[]) =>
    noteSourceChange(
      root,
      files.filter((file): file is string => !!file),
      'source-edit'
    )
  return {
    read: (root, path) => owner.read(root, path),
    // A landed chat turn: its files are already in the live tree.
    async record(root, edits, options) {
      await owner.record(root, edits, options)
      noteSourceChange(
        root,
        edits.map((edit) => edit.path),
        'landing'
      )
    },
    canRevert: (root, group) => owner.canRevert(root, group),
    history: (root) => owner.history(root),
    clearHistory: (root) => owner.clearHistory(root),
    drafts: (root) => owner.drafts(root),
    saveDraft: (root, path, base, text) => owner.saveDraft(root, path, base, text),
    clearDraft: (root, path) => owner.clearDraft(root, path),
    status: () => owner.status(),
    async commit(root, edits, options) {
      const result = await run(
        root,
        () => owner.commit(root, edits, options),
        (result) =>
          result.ok
            ? edits.map((edit) => ({ path: edit.path, hash: contentHash(edit.content) }))
            : []
      )
      if (result.ok)
        edited(
          root,
          edits.map((edit) => edit.path)
        )
      return result
    },
    async undo(root) {
      const result = await run(
        root,
        () => owner.undo(root),
        (result) => (result.ok ? (result.effects ?? []) : [])
      )
      if (result.ok) edited(root, [result.file])
      return result
    },
    async redo(root) {
      const result = await run(
        root,
        () => owner.redo(root),
        (result) => (result.ok ? (result.effects ?? []) : [])
      )
      if (result.ok) edited(root, [result.file])
      return result
    },
    async revert(root, group) {
      const result = await run(
        root,
        () => owner.revert(root, group),
        (result) => (result.ok ? (result.effects ?? []) : [])
      )
      if (result.ok) edited(root, [result.file])
      return result
    },
    async createFile(root, path) {
      const result = await run(
        root,
        () => owner.createFile(root, path),
        (result) => (result.ok ? (result.effects ?? []) : [])
      )
      if (result.ok) edited(root, [result.path ?? path])
      return result
    },
    async renameFile(root, from, to) {
      const result = await run(
        root,
        () => owner.renameFile(root, from, to),
        (result) => (result.ok ? (result.effects ?? []) : [])
      )
      if (result.ok) edited(root, [from, result.path ?? to])
      return result
    },
    async deleteFile(root, path) {
      const result = await run(
        root,
        () => owner.deleteFile(root, path),
        (result) => (result.ok ? (result.effects ?? []) : [])
      )
      if (result.ok) edited(root, [path])
      return result
    }
  }
}
