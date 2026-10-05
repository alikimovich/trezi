import { createHash } from 'node:crypto'
import type { FileOpResult } from '../shared/api'

/**
 * The source owner seam (S08/S09). Under the Swift launch the service's source
 * transaction service is the only writer of a user's source files for Trezi's own
 * edits: every parser (props, text, styles, moves, islands, content, controls) hands
 * it a *proposal* — the file, the SHA-256 of the bytes the edit was computed from,
 * and the new text — and it commits the proposal only if the file still holds those
 * bytes, in the repository's lane, as a journaled transaction that enters the
 * grouped Undo history. File-tree operations, Undo/redo/revert and the editor's
 * drafts go through it too. There is no other writer (LKM-111 removed the TS twin).
 */

/** SHA-256 hex of the exact bytes (a string is hashed as UTF-8, as it is written). */
export const contentHash = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex')

/** A parser's edit proposal. `expectedHash` is `contentHash` of the text it parsed. */
export interface SourceProposal {
  path: string
  expectedHash: string
  content: string
}

export type SourceCommit =
  | { ok: true; files: string[]; hashes: string[] }
  | { ok: false; conflict: true; file: string }

export interface UndoResult {
  ok: boolean
  /** The file reverted/re-applied (relative or absolute as recorded). */
  file?: string
  /** The stack was empty. */
  empty?: boolean
  /** The file changed on disk since the edit — refused to clobber. */
  conflict?: boolean
}

export interface SourceRead {
  /** Repo-relative path. */
  path: string
  size: number
  binary: boolean
  /** SHA-256 of the file's bytes (absent only for an oversized file). */
  hash?: string
  /** Present for text that round-trips exactly as UTF-8. */
  content?: string
}

/** An unsaved editor draft, with the hash of the file it was typed against. */
export interface SourceDraft {
  path: string
  base: string
  text: string
  /** The file's current hash (null when it is gone). */
  current: string | null
}

/** A transaction a previous service left unfinished, and what recovery did with it. */
export interface SourceRecovery {
  operationID: string
  kind: string
  root: string
  started: string
  restored: string[]
  unchanged: string[]
  kept: string[]
  copies: string[]
}

export interface SourceOwner {
  read(root: string, path: string): Promise<SourceRead>
  commit(
    root: string,
    edits: SourceProposal[],
    options?: { key?: string; group?: string; gesture?: boolean }
  ): Promise<SourceCommit>
  /** Edits another owner already wrote (a landed chat turn), for Undo/revert. */
  record(
    root: string,
    edits: Array<{ path: string; before: string; after: string }>,
    options?: { key?: string; group?: string }
  ): Promise<void>
  undo(root: string): Promise<UndoResult>
  redo(root: string): Promise<UndoResult>
  revert(root: string, group: string): Promise<UndoResult>
  canRevert(root: string, group: string): Promise<boolean>
  history(root: string): Promise<{ undo: boolean; redo: boolean }>
  clearHistory(root: string): Promise<void>
  createFile(root: string, path: string): Promise<FileOpResult>
  renameFile(root: string, from: string, to: string): Promise<FileOpResult>
  deleteFile(root: string, path: string): Promise<FileOpResult>
  drafts(root: string): Promise<SourceDraft[]>
  saveDraft(root: string, path: string, base: string, text: string): Promise<void>
  clearDraft(root: string, path: string): Promise<void>
  status(): Promise<{ interrupted: SourceRecovery[]; journal?: string }>
}

let owner: SourceOwner | null = null

/** Installed once by the native entry point when the Swift service is supervising Bun. */
export function setSourceOwner(next: SourceOwner | null): void {
  owner = next
}

export function sourceOwner(): SourceOwner {
  if (!owner) throw new Error('Trezi’s service is not running, so the source cannot be changed.')
  return owner
}
