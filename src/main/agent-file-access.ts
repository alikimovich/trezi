import { realpathSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'

/**
 * Settings → General "Agent file access" (LKM-163), stored by the preferences owner.
 * - `full` (default): the agent reads and writes anywhere the user can, with network
 *   access. Codex runs `danger-full-access`; Claude gets no extra path limits.
 * - `project`: Codex's `workspace-write` sandbox scoped to the chat worktree (LKM-156).
 * Both keep chat worktree isolation: the agent works in its worktree and Trezi lands
 * the result in the live checkout (`live-write-guard.ts`, `live-tree-watch.ts`).
 */
export const AGENT_FILE_ACCESS_KEY = 'trezi:agent-file-access:v1'
export type AgentFileAccess = 'full' | 'project'
export const AGENT_FILE_ACCESS_CHOICES: { value: AgentFileAccess; label: string }[] = [
  { value: 'full', label: 'Full access' },
  { value: 'project', label: 'Project only' }
]
/** Anything but `project` (unset, unknown) is the default, Full access. */
export const agentFileAccess = (value: unknown): AgentFileAccess =>
  value === 'project' ? 'project' : 'full'

let read: () => string | null | undefined = () => null
/** Main reads the preference whenever a provider helper session opens and passes it in its options. */
export function setAgentFileAccessSource(source: () => string | null | undefined): void {
  read = source
}
export const currentAgentFileAccess = (): AgentFileAccess => agentFileAccess(read())

/**
 * `path` with every symlink resolved (`/tmp` → `/private/tmp`, the profile's earlier-name
 * alias that holds every chat worktree, `ProfilePaths.swift`). A path that does not
 * exist yet keeps its missing tail on its nearest existing ancestor's real path.
 */
export function realPath(path: string): string {
  const missing: string[] = []
  let dir = normalize(path)
  for (;;) {
    try {
      return join(realpathSync(dir), ...missing.reverse())
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return normalize(path)
      missing.push(basename(dir))
      dir = parent
    }
  }
}
