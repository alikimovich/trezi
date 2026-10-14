import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BranchStatus } from '../shared/native-shell'
import { defaultBase } from './publish-scope'

const exec = promisify(execFile)
const run = async (file: string, args: string[], root: string) =>
  (await exec(file, args, { cwd: root, timeout: 12000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()

export function deriveSync(
  counts: string,
  base: string
): Pick<BranchStatus, 'ahead' | 'behind' | 'sync'> {
  const [behind, ahead] = counts.trim().split(/\s+/).map(Number)
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind) || ahead < 0 || behind < 0)
    throw new Error('Invalid ahead/behind counts')
  return {
    ahead,
    behind,
    sync: ahead || behind ? `${ahead} ahead · ${behind} behind ${base}` : 'up to date'
  }
}

export function deriveChecks(
  checks: {
    name?: string
    status?: string
    conclusion?: string
    id?: number
    completed_at?: string
  }[]
): Pick<BranchStatus, 'ci' | 'failing'> {
  const latest = new Map<string, (typeof checks)[number]>()
  for (const check of checks) {
    const name = check.name || 'Check'
    const prior = latest.get(name)
    if (!prior || (check.id ?? 0) > (prior.id ?? 0)) latest.set(name, check)
  }
  const current = [...latest.values()]
  const failing = current
    .filter((check) =>
      ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(
        check.conclusion ?? ''
      )
    )
    .map((check) => check.name || 'Check')
  return {
    ci: failing.length
      ? 'failed'
      : current.some((check) => check.status !== 'completed')
        ? 'running'
        : current.length &&
            current.every((check) =>
              ['success', 'neutral', 'skipped'].includes(check.conclusion ?? '')
            )
          ? 'passed'
          : current.length
            ? 'unknown'
            : 'none',
    failing
  }
}

export function cachedGithubApi(
  request: (root: string, args: string[]) => Promise<string>,
  etags = new Map<string, { tag: string; body: unknown }>()
) {
  return async (root: string, path: string): Promise<any> => {
    const key = `${root}:${path}`,
      previous = etags.get(key)
    const args = [
      'api',
      '-i',
      path,
      '-H',
      'Accept: application/vnd.github+json',
      ...(previous ? ['-H', `If-None-Match: ${previous.tag}`] : [])
    ]
    let output: string
    try {
      output = await request(root, args)
    } catch (error) {
      // gh exits nonzero for HTTP 304, but preserves the response headers on stdout.
      const response = (error as { stdout?: string }).stdout ?? ''
      if (/^HTTP\/\S+ 304/m.test(response) && previous) return previous.body
      throw error
    }
    const split = output.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n'
    const boundary = output.indexOf(split)
    if (boundary < 0) throw new Error('GitHub response has no headers')
    const headers = output.slice(0, boundary)
    if (/^HTTP\/\S+ 304/m.test(headers) && previous) return previous.body
    const body = JSON.parse(output.slice(boundary + split.length))
    const tag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim()
    if (tag) etags.set(key, { tag, body })
    return body
  }
}
const api = cachedGithubApi((root, args) => run('gh', args, root))

/** Reads only local refs and GitHub REST. Injectable reads keep fixture tests offline. */
export async function branchStatus(
  root: string,
  reads: { run: typeof run; api: typeof api } = { run, api }
): Promise<BranchStatus> {
  const { run: read, api: request } = reads
  const base = await defaultBase(root)
  const branch = await read('git', ['branch', '--show-current'], root).catch(() => '')
  const head = await read('git', ['rev-parse', 'HEAD'], root).catch(() => '')
  const remote = await read('git', ['remote', 'get-url', 'origin'], root).catch(() => '')
  const baseRef = `refs/remotes/origin/${base}`
  const baseSha = await read('git', ['rev-parse', '--verify', baseRef], root).catch(() => '')
  const localBase = await read('git', ['rev-parse', '--verify', `refs/heads/${base}`], root).catch(
    () => ''
  )
  const compareRef = baseSha ? baseRef : localBase ? `refs/heads/${base}` : ''
  let counts = '0 0'
  try {
    if (compareRef)
      counts = await read(
        'git',
        ['rev-list', '--left-right', '--count', `${compareRef}...HEAD`],
        root
      )
  } catch {}
  const sync = deriveSync(counts, base)
  const dirty = !!(await read(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    root
  ).catch(() => ''))
  const unpublished = compareRef
    ? !(await read('git', ['diff', '--quiet', compareRef], root).then(
        () => true,
        () => false
      ))
    : dirty
  const upstream = await read(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    root
  ).catch(() => '')
  const unpushed = upstream
    ? Number(
        await read('git', ['rev-list', '--count', `${upstream}..HEAD`], root).catch(() => 'NaN')
      )
    : null
  const status: BranchStatus = {
    base,
    branch,
    ...sync,
    dirty,
    unpublished: unpublished || dirty,
    unpushed: Number.isSafeInteger(unpushed) ? unpushed : null,
    upstream: upstream || undefined,
    remote: remote || undefined,
    ci: 'unknown',
    failing: [],
    deployment: { state: 'unknown' }
  }
  try {
    const repo = JSON.parse(await read('gh', ['repo', 'view', '--json', 'nameWithOwner'], root))
      .nameWithOwner as string
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return status
    // gh's current repo must be the origin whose refs were used above.
    if (
      !new RegExp(`[:/]${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(
        remote.replace(/\.git$/, '')
      )
    )
      return status
    const remoteBase = await request(root, `repos/${repo}/branches/${encodeURIComponent(base)}`)
    const currentBaseSha = remoteBase?.commit?.sha as string | undefined
    status.stale = !!baseSha && !!currentBaseSha && baseSha !== currentBaseSha
    const prs = await request(
      root,
      `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}&per_page=20`
    )
    const pr = Array.isArray(prs)
      ? (prs.find(
          (item) =>
            item.head?.sha === head &&
            item.base?.ref === base &&
            (!item.merged_at || !status.unpublished)
        ) ??
        prs.find((item) => item.state === 'open' && item.base?.ref === base) ??
        (!status.unpublished && baseSha
          ? prs.find((item) => item.merged_at && item.base?.ref === base)
          : undefined))
      : undefined
    if (pr)
      status.pr = {
        number: pr.number,
        state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        url: pr.html_url
      }
    const sha =
      status.pr?.state === 'merged' && !status.unpublished && currentBaseSha ? currentBaseSha : head
    status.commit = sha
    status.checksUrl = `https://github.com/${repo}/commit/${sha}/checks`
    if (sha === head && (status.unpushed ?? 0) > 0) {
      status.ci = 'unknown'
    } else {
      const checks = await request(root, `repos/${repo}/commits/${sha}/check-runs?per_page=100`)
      Object.assign(status, deriveChecks(Array.isArray(checks.check_runs) ? checks.check_runs : []))
    }
    // GitHub deployment statuses are revision-bound. A deployment of an older SHA
    // remains visible as stale rather than being credited to the selected commit.
    try {
      const deployments = await request(
        root,
        `repos/${repo}/deployments?environment=production&per_page=1`
      )
      const deployment = Array.isArray(deployments) ? deployments[0] : undefined
      if (deployment?.sha) {
        const response = await request(
          root,
          `repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`
        )
        const latest = Array.isArray(response) ? response[0] : undefined
        const state =
          latest?.state === 'success'
            ? 'passed'
            : ['failure', 'error'].includes(latest?.state)
              ? 'failed'
              : ['pending', 'in_progress', 'queued'].includes(latest?.state)
                ? 'pending'
                : 'unknown'
        status.deployment = {
          state: deployment.sha === sha ? state : 'stale',
          revision: deployment.sha,
          url: latest?.target_url || latest?.log_url || deployment?.html_url
        }
      } else status.deployment = { state: 'none' }
    } catch {
      status.deployment = { state: 'error' }
    }
  } catch {
    status.ci = 'error'
    status.failing = []
  }
  return status
}

/** Material for one repair turn; logs and diffs are bounded before entering model context. */
export async function failureContext(
  root: string,
  commit: string,
  prNumber?: number
): Promise<{ log: string; diff: string }> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid commit')
  const runs = JSON.parse(
    await run(
      'gh',
      ['run', 'list', '--commit', commit, '--json', 'databaseId,conclusion', '--limit', '10'],
      root
    )
  ) as { databaseId: number; conclusion: string }[]
  const failed = runs.find((item) => item.conclusion === 'failure')
  const log = failed
    ? await run('gh', ['run', 'view', String(failed.databaseId), '--log-failed'], root).catch(
        () => ''
      )
    : ''
  const localDiff = await run(
    'git',
    ['show', '--format=medium', '--no-ext-diff', commit],
    root
  ).catch(() => '')
  const diff =
    localDiff ||
    (prNumber !== undefined && Number.isSafeInteger(prNumber) && prNumber > 0
      ? await run('gh', ['pr', 'diff', String(prNumber)], root).catch(() => '')
      : '')
  return { log: log.slice(-24_000), diff: diff.slice(0, 24_000) }
}
