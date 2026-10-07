import type { SourceView } from './api'
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
  source?: string
  text?: string
  name?: string
  revision?: number
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
