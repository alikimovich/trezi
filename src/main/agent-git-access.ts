/** Raw Git mutations in a chat worktree are opt-in. Trezi's Git tools are available in both modes. */
export const AGENT_GIT_ACCESS_KEY = 'trezi:agent-git-access:v1'
export type AgentGitAccess = 'managed' | 'full'
export const AGENT_GIT_ACCESS_CHOICES: { value: AgentGitAccess; label: string }[] = [
  { value: 'managed', label: 'Managed' },
  { value: 'full', label: 'Full' }
]
export const agentGitAccess = (value: unknown): AgentGitAccess =>
  value === 'full' ? 'full' : 'managed'

let read: () => string | null | undefined = () => null
export function setAgentGitAccessSource(source: () => string | null | undefined): void {
  read = source
}
export const currentAgentGitAccess = (): AgentGitAccess => agentGitAccess(read())

/** Refuse direct shell Git writes in Managed mode, including bypass permission mode. */
export function rawGitWrite(tool: string, input: unknown, access: AgentGitAccess): string | null {
  if (access === 'full' || (tool !== 'Bash' && tool !== 'exec_command')) return null
  const value = input as { command?: unknown; cmd?: unknown } | null
  const command = value?.command ?? value?.cmd
  if (typeof command !== 'string') return null
  const match = command.match(
    /(?:^|[;&|\n(]\s*|\s)(?:\S*\/)?git\s+(?:(?:-C|--git-dir|--work-tree)\s+\S+\s+)*(add|am|apply|bisect|branch|checkout|cherry-pick|clean|commit|fetch|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag|update-ref|worktree)\b/i
  )
  if (!match) return null
  const verb = match[1].toLowerCase()
  const replacement =
    verb === 'push'
      ? 'publish_update'
      : verb === 'commit'
        ? 'git_merge_continue'
        : verb === 'merge' || verb === 'fetch' || verb === 'pull'
          ? 'git_sync_base'
          : 'the Trezi Git tools'
  return `Agent Git access is Managed. Raw git ${verb} is refused; use ${replacement} in this chat worktree.`
}
