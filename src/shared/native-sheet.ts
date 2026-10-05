export interface NativeSheetField {
  id: string
  label: string
  help?: string
  visibleWhen?: { field: string; value: string }
  kind: 'text' | 'multiline' | 'secure' | 'choice' | 'multichoice' | 'readonly' | 'image'
  value: string
  choices?: { value: string; label: string }[]
  /** Sectioned windows: the sidebar section this field belongs to. */
  section?: string
  /** Not autosaved: submitted only with an explicit action (provider forms). */
  draft?: boolean
  /** Sectioned windows: the prompt an empty text or secure row shows. */
  placeholder?: string
}
/** A sidebar entry of a sectioned window (Settings); `symbol` is an SF Symbol name. */
export interface NativeSheetSection {
  id: string
  label: string
  symbol: string
  detail?: string
}
export interface NativeSheetState {
  id: string
  title: string
  detail: string
  fields: NativeSheetField[]
  actions: {
    id: string
    label: string
    primary?: boolean
    destructive?: boolean
    section?: string
  }[]
  /** Present: a source-list sidebar window; fields and actions render in their section's pane. */
  sections?: NativeSheetSection[]
  /** The section shown when the window opens. */
  section?: string
  autosave?: boolean
  dismissible?: boolean
  busy: boolean
  message?: string
}
/** `section` is the pane selected when the action was sent; `section` alone just selects it. */
export interface NativeSheetAction {
  id: string
  action: string
  values: Record<string, string>
  section?: string
}

export interface NativeSheetsBridge {
  open(
    kind: 'new-project' | 'memory' | 'settings' | 'review' | 'feedback' | 'diagnose',
    key?: string
  ): void
}
declare global {
  interface Window {
    treziNativeSheets?: NativeSheetsBridge
  }
}

declare global {
  interface Window {
    treziNativeActivity?: { append(text: string, kind: string): void; action(action: string): void }
  }
}

declare global {
  interface Window {
    treziNativeGit?: {
      action(
        action: 'publish' | 'branch' | 'new-branch' | 'git-updates' | 'connect',
        value?: string
      ): void
    }
  }
}
