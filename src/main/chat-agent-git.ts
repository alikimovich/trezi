import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { currentAgentMergeAllowed } from './agent-merge-setting'
import { states } from './chat-state'
import { generatePublishDescription } from './publish-description'
import { defaultBase } from './publish-scope'
import { pullRequestStatus } from './pull-request-status'
import { enqueueRepoWrite } from './repo-write-queue'
import { repositoryOwner } from './repository-owner'
import { workflowOwner } from './workflow-owner'

const exec = promisify(execFile)

async function publishWorkflow(root: string, commit: string | undefined): Promise<unknown> {
  if (!commit) return { state: 'unknown' }
  const deadline = Date.now() + 180_000
  for (;;) {
    try {
      const { stdout } = await exec(
        'gh',
        [
          'run',
          'list',
          '--commit',
          commit,
          '--limit',
          '10',
          '--json',
          'name,status,conclusion,url'
        ],
        { cwd: root, timeout: 30_000 }
      )
      const runs = JSON.parse(stdout) as Array<{
        name: string
        status: string
        conclusion?: string
        url?: string
      }>
      const run = runs.find((item) => /publish|release/i.test(item.name))
      if (!run) return { state: 'not_found' }
      if (run.status === 'completed' || Date.now() >= deadline) return run
    } catch (error) {
      return { state: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(10_000, Math.max(0, deadline - Date.now())))
    )
  }
}

async function releaseState(root: string): Promise<unknown> {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version))
      return { state: 'not_applicable' }
    const tag = `v${manifest.version}`
    const { stdout } = await exec(
      'gh',
      ['release', 'view', tag, '--json', 'tagName,url,isDraft,publishedAt'],
      {
        cwd: root,
        timeout: 15_000
      }
    )
    return { state: 'published', ...JSON.parse(stdout) }
  } catch {
    return { state: 'not_observed' }
  }
}

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
  const input = (args ?? {}) as { ref?: unknown; number?: unknown; confirmed?: unknown }
  if (action === 'git_sync_base') {
    const ref = input.ref === undefined ? `origin/${await defaultBase(liveRoot)}` : input.ref
    if (typeof ref !== 'string') return { error: 'ref must name an origin branch.' }
    return enqueueRepoWrite(liveRoot, () => repositoryOwner().gitSyncBase(st.wt, ref))
  }
  if (action === 'git_merge_continue')
    return enqueueRepoWrite(liveRoot, () => repositoryOwner().gitMergeContinue(st.wt))
  if (action === 'git_merge_abort')
    return enqueueRepoWrite(liveRoot, () => repositoryOwner().gitMergeAbort(st.wt))
  if (action === 'pr_status' || action === 'publish_update' || action === 'publish_merge') {
    if (
      input.number !== undefined &&
      (!Number.isSafeInteger(input.number) || Number(input.number) < 1)
    )
      return { error: 'number must be a positive PR number.' }
    const number = input.number === undefined ? undefined : String(input.number)
    const status = await pullRequestStatus(liveRoot, root, number ? Number(number) : undefined)
    if (status.error) return { error: status.error }
    if (action === 'pr_status') return status
    const { stdout: branch } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: liveRoot
    })
    if (status.headRefName !== branch.trim())
      return {
        error: `This PR belongs to ${String(status.headRefName)}, but Publish would push ${branch.trim()}.`
      }
    if (action === 'publish_merge' && !currentAgentMergeAllowed() && input.confirmed !== true)
      return {
        error:
          'Agent PR merging is off. Ask the user for confirmation in chat, then call publish_merge with confirmed: true only after they agree.'
      }
    const result = await workflowOwner().publish(
      liveRoot,
      action === 'publish_merge' ? 'merge' : 'pr',
      (base, head) => generatePublishDescription(liveRoot, base, head)
    )
    if (!result.ok) return { ...result, pr: status.number }
    const updated = await pullRequestStatus(liveRoot, root, Number(status.number))
    if (action === 'publish_update')
      return {
        ...result,
        pr: status.number,
        pushed: true,
        mergeable: updated.mergeable,
        checks: updated.statusCheckRollup
      }
    const { stdout } = await exec(
      'gh',
      ['pr', 'view', String(status.number), '--json', 'state,mergeCommit'],
      { cwd: liveRoot, timeout: 30_000 }
    )
    const merged = JSON.parse(stdout) as { state?: string; mergeCommit?: { oid?: string } }
    return {
      ...result,
      pr: status.number,
      pushed: true,
      merged: merged.state === 'MERGED',
      mergeCommit: merged.mergeCommit?.oid ?? null,
      workflow: await publishWorkflow(liveRoot, merged.mergeCommit?.oid),
      release: await releaseState(liveRoot)
    }
  }
  return { error: `Unknown Git tool: ${action}` }
}
