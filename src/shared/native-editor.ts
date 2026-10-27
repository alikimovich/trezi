import type { SourceView } from './api'
/** An inclusive 1-based line range to open the editor at (LKM-363). With `code`, the
 *  range is shown only where the editor's text has exactly these lines. */
export interface SourceRange {
  startLine: number
  endLine: number
  code?: string
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
  source?: string
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
