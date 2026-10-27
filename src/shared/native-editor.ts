import type { SourceView } from './api'
/** An inclusive 1-based line range to open the editor at (LKM-363). With `code`, the
 *  range is shown only where the editor's text has exactly these lines. */
export interface SourceRange {
  startLine: number
  endLine: number
  code?: string
}
/** One changed region in the new file (LKM-364); `newCount` 0 is a pure deletion after `newStart`. */
export interface BranchDiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}
export interface BranchDiffFile {
  /** Project-relative path; for a rename, the new one. */
  path: string
  /** Renames and copies: the project-relative path it came from. */
  from?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type' | 'untracked'
  /** Line counts; null when binary or not counted. */
  added: number | null
  removed: number | null
  binary: boolean
  hunks: BranchDiffHunk[]
}
export interface BranchDiffSection {
  kind: 'committed' | 'staged' | 'unstaged' | 'untracked'
  label: string
  files: BranchDiffFile[]
  added: number
  removed: number
  /** More files or hunks than shown (bounded large diffs). */
  truncated: boolean
}
/** The read-only current-branch diff (LKM-364): committed since the merge-base with
 *  the default branch, and the uncommitted changes, each listed separately. */
export interface BranchDiff {
  root: string
  /** False for a folder that is not in a Git work tree. */
  git: boolean
  /** The current branch; '' when HEAD is detached or the folder is not in Git. */
  branch: string
  /** HEAD's short SHA; '' before the first commit. */
  head: string
  detached: boolean
  /** The comparison base: `ref` it came from, the merge-base's short `sha`, a visible
   *  `label`; `fallback` when no default branch was found and HEAD stands in. */
  base: { ref: string; sha: string; label: string; fallback: boolean } | null
  sections: BranchDiffSection[]
  /** A visible note: not a Git project, no commits yet, a read failed. */
  message: string
}
export interface NativeEditorState {
  root: string
  visible: boolean
  popped: boolean
  files: string[]
  source: string
  document: SourceView | null
  text: string
  revision: number
  dirty: boolean
  canBack?: boolean
  canForward?: boolean
  reveal?: number
  /** The lines the latest reveal selects and highlights; null shows a caret at the line. */
  range?: { startLine: number; endLine: number } | null
  /** Soft wrap at the visible width (LKM-192); the `trezi:source-wrap` preference. */
  wrap?: boolean
  busy: boolean
  error: string
  conflict: boolean
  /** The sidebar (LKM-364): the file tree or the read-only Changes list. */
  panel?: 'files' | 'changes'
  /** The Changes list; null until it is first read for this project. */
  diff?: BranchDiff | null
  /** A Changes read is in flight. */
  diffBusy?: boolean
}
export type NativeEditorAction = {
  root: string
  action:
    | 'back'
    | 'forward'
    | 'open'
    | 'edit'
    | 'save'
    | 'reload'
    | 'hide'
    | 'popout'
    | 'dock'
    | 'create'
    | 'rename'
    | 'delete'
    | 'component'
    | 'highlight'
    | 'wrap'
    | 'panel'
    | 'diff-refresh'
    | 'diff-open'
  source?: string
  /** `panel` (LKM-364): which sidebar to show. */
  panel?: 'files' | 'changes'
  /** `diff-open`: the listed file (`source`) in this section, at this hunk. */
  section?: BranchDiffSection['kind']
  hunk?: number
  /** `wrap` (LKM-192): the new Wrap Lines state. */
  wrap?: boolean
  text?: string
  name?: string
  revision?: number
  /** `open`: an exact range to select and highlight (LKM-363). */
  range?: SourceRange
  /** `highlight` (LKM-183): visible lines, a replaced text, a dropped stale result. */
  first?: number
  last?: number
  reset?: boolean
  dropped?: number
}

declare global {
  interface Window {
    treziNativeEditor?: { open(source: string): void; close(): void }
  }
}
