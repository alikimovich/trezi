import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { currentAgentMergeAllowed } from './agent-merge-setting'
import { states } from './chat-state'
import {
  mergeTarget,
  requestMergeApproval,
  revokeMergeApprovals,
  takeMergeApproval
} from './merge-approval'
import { generatePublishDescription } from './publish-description'
import { defaultBase } from './publish-scope'
import { pullRequestStatus } from './pull-request-status'
import { enqueueRepoWrite } from './repo-write-queue'
import { repositoryOwner } from './repository-owner'
import { workflowOwner } from './workflow-owner'

const exec = promisify(execFile)

/** LKM-203: the publish workflow is polled until this long after the tool call began, so
 * land + push + merge + poll + release lookup always ends inside the bridge and Codex
 * MCP tool timeouts (`SYNC_TOOL_TIMEOUT_SEC`) with the real state, never a timeout. */
export const PUBLISH_WORKFLOW_BUDGET_MS = 180_000

async function publishWorkflow(
  root: string,
  commit: string | undefined,
  startedAt: number
): Promise<unknown> {
  if (!commit) return { state: 'unknown' }
  const deadline = startedAt + PUBLISH_WORKFLOW_BUDGET_MS
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
      if (run.status === 'completed') return run
      if (Date.now() >= deadline)
        return { ...run, state: 'in_progress', ...(run.url ? { url: run.url } : {}) }
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

/** The live checkout's head commit, and whether Publish would commit anything first. */
async function checkout(liveRoot: string): Promise<{ head: string; clean: boolean }> {
  const [head, status] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD'], { cwd: liveRoot }),
    exec('git', ['status', '--porcelain'], { cwd: liveRoot })
  ])
  return { head: head.stdout.trim(), clean: !status.stdout.trim() }
}

const MERGE_OFF =
  'Agent PR merging is off in Settings, so Trezi will not merge this pull request. Tell the user: they can merge it themselves or turn on Agent can merge pull requests.'

const APPROVAL_REASON = {
  changed:
    'The repository, pull request or head changed after the user approved, so that approval was dropped.',
  expired: 'The earlier approval expired.'
} as const

/** Only the active chat's linked worktree may receive an agent Git effect. */
export async function agentGitTool(
  key: string,
  root: string,
  liveRoot: string,
  action: string,
  args: unknown,
  startedAt = Date.now(),
  notify: (channel: string, payload: unknown) => void = () => {}
): Promise<unknown> {
  const st = states.get(key)
  if (!st || st.wt.path !== root || st.liveRoot !== liveRoot || st.reclaimed)
    return { error: 'This chat has no active Git worktree.' }
  // A model-supplied `confirmed` (or any other flag) is ignored: only the host's card approves.
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
  if (action === 'pr_status' || action === 'publish_update' || action === 'publish_merge') {
    if (
      input.number !== undefined &&
      (!Number.isSafeInteger(input.number) || Number(input.number) < 1)
    )
      return { error: 'number must be a positive PR number.' }
    // Merge-off refuses before anything is read or pushed, whatever the arguments say,
    // and drops any approval the chat holds.
    if (action === 'publish_merge' && !currentAgentMergeAllowed()) {
      revokeMergeApprovals(key, notify)
      return { error: MERGE_OFF }
    }
    const number = input.number === undefined ? undefined : String(input.number)
    let status = await pullRequestStatus(liveRoot, root, number ? Number(number) : undefined)
    if (status.error) return { error: status.error }
    if (action === 'pr_status') return status
    const { stdout: branch } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: liveRoot
    })
    if (status.headRefName !== branch.trim())
      return {
        error: `This PR belongs to ${String(status.headRefName)}, but Publish would push ${branch.trim()}.`
      }
    const describe = (base: string, head: string) =>
      generatePublishDescription(liveRoot, base, head)
    let expectedHead: string | undefined
    if (action === 'publish_merge') {
      // The user approves what GitHub shows: bring the PR up to this checkout first,
      // the same push publish_update makes (never a merge).
      let local = await checkout(liveRoot)
      if (!local.clean || local.head !== status.headRefOid) {
        const pushed = await workflowOwner().publish(liveRoot, 'pr', describe)
        if (!pushed.ok) return { ...pushed, pr: status.number }
        status = await pullRequestStatus(liveRoot, root, Number(status.number))
        if (status.error) return { error: status.error }
        local = await checkout(liveRoot)
      }
      const target = mergeTarget(status.url, status.number, status.headRefOid)
      if (!target)
        return { error: "Trezi could not identify the pull request's repository and head." }
      if (!local.clean || local.head !== target.head)
        return {
          error: `The pull request's head ${target.head.slice(0, 12)} is not this checkout's ${local.head.slice(0, 12)}. Call publish_update, then publish_merge.`
        }
      const approval = takeMergeApproval(key, liveRoot, target)
      if (approval !== 'approved') {
        requestMergeApproval(key, liveRoot, target, notify)
        return {
          merged: false,
          approvalRequired: true,
          pr: target.number,
          repo: target.repo,
          head: target.head,
          ...(approval === 'none' ? {} : { reason: APPROVAL_REASON[approval] }),
          guidance:
            'Trezi asked the user to approve this merge in a card on their screen. End your turn now with one short line saying you are waiting for their approval. Do not merge another way. If they approve, call publish_merge once; if they decline, leave the pull request open.'
        }
      }
      // The setting may have been turned off while the card was open (the approval is spent).
      if (!currentAgentMergeAllowed()) return { error: MERGE_OFF }
      expectedHead = target.head
    }
    const result = await workflowOwner().publish(
      liveRoot,
      action === 'publish_merge' ? 'merge' : 'pr',
      describe,
      expectedHead
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
      workflow: await publishWorkflow(liveRoot, merged.mergeCommit?.oid, startedAt),
      release: await releaseState(liveRoot)
    }
  }
  return { error: `Unknown Git tool: ${action}` }
}
