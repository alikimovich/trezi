import type { SessionRecord } from './api'
import type { ChatAgentSettings } from './chat-settings'
import type { ProjectEntry } from './workspace'

export type NativeProjectStatus =
  | { kind: 'idle' }
  | { kind: 'setup'; name: string }
  | { kind: 'busy'; label: string }
  | { kind: 'running'; name: string; url: string }
  // `detail`: the message with full paths when the shell sends `message` collapsed.
  // `restart`: a running server ended; the preview offers Restart (LKM-146).
  | { kind: 'error'; message: string; detail?: string; restart?: boolean }
export interface NativeWorkspaceSnapshot {
  error?: string
  revision: number
  projects: ProjectEntry[]
  activeKey: string | null
  status: NativeProjectStatus
  /** The project whose open finished (running or setup); the chat shows only for it.
   *  A later preview error or a restart of the same project keeps it. */
  loadedKey?: string | null
  /** The newest sidebar pick generation applied to `activeKey` (LKM-204). */
  selection?: number
  history: Record<string, SessionRecord[]>
  recents: { root: string; name: string; at: number }[]
}
export type NativeWorkspaceCommand =
  | { type: 'attach'; preferred?: ChatAgentSettings }
  | { type: 'open'; root?: string; command?: string }
  | { type: 'close' | 'new-chat'; key: string }
  /** `generation`: the sidebar pick that asked for it, echoed as `selection`. */
  | { type: 'select'; key: string; generation?: number }
  | { type: 'chat'; key: string; session: string }
  | { type: 'close-chat'; key: string; session: string }
  | { type: 'resume'; key: string; record: string }
  /** `cleanCache` (LKM-197): drop the dependency caches and reload the preview past WebKit's;
   *  'dependencies' when a dependency change caused it (the preview says so). */
  | { type: 'restart'; key: string; command?: string; cleanCache?: boolean | 'dependencies' }
export interface NativeWorkspaceBridge {
  command(command: NativeWorkspaceCommand): Promise<void>
  onProjection(
    callback: (value: { chatHidden: boolean; viewport: string; selectMode: boolean }) => void
  ): () => void
  onState(callback: (state: NativeWorkspaceSnapshot) => void): () => void
}
declare global {
  interface Window {
    treziNativeWorkspace?: NativeWorkspaceBridge
  }
}
