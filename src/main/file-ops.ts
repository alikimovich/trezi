import type { FileOpResult } from '../shared/api'
import { sourceOwner } from './source-owner'

/**
 * Create / rename / delete for the pop-out editor's file-tree sidebar — the
 * file-manager half of `file-tree.ts` (which only lists).
 *
 * Every path that crosses IPC is untrusted. The service's source owner performs all
 * three (S08, `SourcePaths.swift` and `SourceOwner.swift`) in the repository's lane:
 * repo-relative POSIX paths only, no traversal, nothing inside `.git`, the trezi
 * sidecars or `node_modules`, symlink containment, files only, no silent clobber
 * (except a case-only rename), and a deleted file goes to the Trash.
 */

/** Create an empty file at `path` (repo-relative); missing parents are created. */
export const createProjectFile = (root: string, path: string): Promise<FileOpResult> =>
  sourceOwner().createFile(root, path)

/** Rename (or move) a file; refuses to overwrite unless only the letter case differs. */
export const renameProjectFile = (root: string, from: string, to: string): Promise<FileOpResult> =>
  sourceOwner().renameFile(root, from, to)

/** Move a file to the Trash. */
export const deleteProjectFile = (root: string, path: string): Promise<FileOpResult> =>
  sourceOwner().deleteFile(root, path)
