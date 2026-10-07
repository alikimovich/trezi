import { execFileSync } from 'node:child_process'
import { gitCommandRefusal } from '../../bin/trezi-git-policy.mjs'

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
export function rawGitWrite(
  tool: string,
  input: unknown,
  access: AgentGitAccess,
  liveRoot = '',
  workRoot = ''
): string | null {
  if (tool !== 'Bash' && tool !== 'exec_command') return null
  const value = input as { command?: unknown; cmd?: unknown } | null
  const command = value?.command ?? value?.cmd
  if (typeof command !== 'string') return null
  let liveBranch = ''
  if (liveRoot) {
    try {
      liveBranch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: liveRoot,
        encoding: 'utf8'
      }).trim()
    } catch {}
  }
  return gitCommandRefusal(command, access, liveRoot, workRoot, liveBranch)
}
