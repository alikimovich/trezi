import type { WorkspacePatch, WorkspaceView } from './workspace-model'

/**
 * Project identity, order, selection and recents: the S04 workspace domain.
 * Reads come from the last acknowledged state; every mutation resolves only
 * once it is persisted, so a dependent command (starting a session or server
 * for a project) never runs against an identity that was not saved.
 */
export interface WorkspaceStore {
  snapshot(): WorkspaceView
  /** An existing project (same key, or the same folder by real path) is returned, not duplicated. */
  open(
    root: string,
    chatSettings?: Record<string, unknown>
  ): Promise<{ key: string; created: boolean }>
  select(key: string): Promise<void>
  close(key: string): Promise<void>
  reorder(key: string, before: string | null): Promise<void>
  /** The typed adapter for the legacy-owned metadata slice (sessions, servers, Git, display). */
  update(projects: WorkspacePatch[]): Promise<void>
  recent(root: string, name: string): Promise<void>
  /** Called when the stored workspace changes without a local operation (an adopted external edit). */
  subscribe(listener: () => void): void
}
