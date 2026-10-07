/** Optional macOS shell transport. Electron continues to use the React rail. */
export interface NativeShellRow {
  id: string
  title: string
  icon?: string
  kind: 'project' | 'chat' | 'history'
  project: string
  session?: string
  record?: string
  running?: boolean
  children?: NativeShellRow[]
}
export interface NativeShellState {
  previewStatus?: import('./native-workspace').NativeProjectStatus
  /** The pill over the running preview: loading, or the page answered an HTTP error (LKM-196). */
  previewLoad?:
    | { kind: 'loading'; path: string }
    | { kind: 'error'; path: string; status: number; message: string }
    | null
  homeState: {
    visible: boolean
    busy: boolean
    label: string
    recents: { root: string; name: string }[]
    blocked?: boolean
  }
  rows: NativeShellRow[]
  selected: string | null
  project: string | null
  /** The selected project finished opening: only then are the chat column and its toolbar actions shown. */
  chatReady: boolean
  selectMode: boolean
  previewReady: boolean
  chatWidth: number
  chatHidden: boolean
  branch: string | null
  branches: string[]
  publishLabel: string
  publishing: boolean
  /** The publish's current step can still be cancelled (LKM-187). */
  publishCancellable: boolean
  publishMode: string
  codeOpen: boolean
  previewBase: string | null
  previewURL: string | null
  viewport: string
  deviceEnabled: boolean
}
export interface NativeShellAction {
  action:
    | 'rename-chat'
    | 'project-reorder'
    | 'chat-resize'
    | 'select'
    | 'new-chat'
    | 'close'
    | 'memory'
    | 'branch'
    | 'new-branch'
    | 'git-updates'
    | 'publish'
    | 'publish-cancel'
    | 'publish-mode'
    | 'code'
    | 'layers'
    | 'expand'
    | 'address'
    | 'home'
    | 'device'
    | 'select-object'
    | 'reload-hard'
    | 'restart-clean'
  id?: string
  value?: string
  project?: string
}
export interface NativeShellBridge {
  readWorkspace: () => Promise<string | null>
  writeWorkspace: (raw: string) => void
  update: (state: NativeShellState) => void
  onAction: (callback: (action: NativeShellAction) => void) => () => void
}
declare global {
  interface Window {
    treziNativeShell?: NativeShellBridge
  }
}
