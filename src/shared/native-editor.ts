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
  source?: string
  text?: string
  name?: string
  revision?: number
}

declare global {
  interface Window {
    treziNativeEditor?: { open(source: string): void; close(): void }
  }
}
