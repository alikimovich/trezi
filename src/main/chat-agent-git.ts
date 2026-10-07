import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { states } from './chat-state'
import { generatePublishDescription } from './publish-description'
import { defaultBase } from './publish-scope'
import { enqueueRepoWrite } from './repo-write-queue'
import { repositoryOwner } from './repository-owner'
import { workflowOwner } from './workflow-owner'

const exec = promisify(execFile)
const pendingPublish = new Set<string>()

/** Only the active chat's linked worktree may receive an agent Git effect. */
export async function agentGitTool(
  key: string,
  root: string,
  liveRoot: string,
  action: string,
  args: unknown
): Promise<unknown> {
  const st = states.get(key)
  if (!st || st.wt.path !== root || st.liveRoot !== liveRoot || st.reclaimed)
    return { error: 'This chat has no active Git worktree.' }
  const input = (args ?? {}) as { ref?: unknown; number?: unknown }
  if (action === 'git_sync_base') {
    const ref = input.ref === undefined ? `origin/${await defaultBase(liveRoot)}` : input.ref
    if (typeof ref !== 'string') return { error: 'ref must name an origin branch.' }
    return enqueueRepoWrite(liveRoot, () => repositoryOwner().gitSyncBase(st.wt, ref))
  }
  if (action === 'git_merge_continue')
    return enqueueRepoWrite(liveRoot, () => repositoryOwner().gitMergeContinue(st.wt))
  if (action === 'git_merge_abort')
    return enqueueRepoWrite(liveRoot, () => repositoryOwner().gitMergeAbort(st.wt))
  if (action === 'pr_status' || action === 'publish_update') {
    if (
      input.number !== undefined &&
      (!Number.isSafeInteger(input.number) || Number(input.number) < 1)
    )
      return { error: 'number must be a positive PR number.' }
    const number = input.number === undefined ? undefined : String(input.number)
    const parameters = [
      'pr',
      'view',
      ...(number ? [number] : []),
      '--json',
      'number,url,mergeable,baseRefName,headRefName,statusCheckRollup'
    ]
    let status: Record<string, unknown>
    try {
      const { stdout } = await exec('gh', parameters, { cwd: liveRoot, timeout: 30_000 })
      status = JSON.parse(stdout) as Record<string, unknown>
    } catch (error) {
      return {
        error: `Could not read the existing pull request: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (action === 'pr_status') {
      const base = status.baseRefName
      let conflictingFiles: string[] = []
      if (typeof base === 'string' && /^[A-Za-z0-9._/-]+$/.test(base)) {
        try {
          await exec('git', ['merge-tree', '--write-tree', `refs/remotes/origin/${base}`, 'HEAD'], {
            cwd: root,
            timeout: 15_000
          })
        } catch (error) {
          const output = (error as { stdout?: string }).stdout ?? ''
          conflictingFiles = [...output.matchAll(/^CONFLICT .* in (.+)$/gm)].map(
            (match) => match[1]
          )
        }
      }
      return { ...status, conflictingFiles: [...new Set(conflictingFiles)] }
    }
    const { stdout: branch } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: liveRoot
    })
    if (status.headRefName !== branch.trim())
      return {
        error: `This PR belongs to ${String(status.headRefName)}, but Publish would push ${branch.trim()}.`
      }
    pendingPublish.add(key)
    return {
      scheduled: true,
      pr: status.number,
      guidance:
        'Finish this turn. Trezi will update the existing PR after the resolved merge lands.'
    }
  }
  return { error: `Unknown Git tool: ${action}` }
}

/** Called only after a successful landing. The workflow owner is the only pusher. */
export async function publishAfterAgentLanding(key: string, liveRoot: string): Promise<void> {
  if (!pendingPublish.has(key)) return
  const result = await workflowOwner().publish(liveRoot, 'pr', (base, head) =>
    generatePublishDescription(liveRoot, base, head)
  )
  if (!result.ok) throw new Error(result.error ?? 'Could not update the pull request.')
  pendingPublish.delete(key)
}
