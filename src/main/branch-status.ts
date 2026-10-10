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
  checks: { name?: string; status?: string; conclusion?: string }[]
): Pick<BranchStatus, 'ci' | 'failing'> {
  const failing = checks
    .filter((check) => ['failure', 'timed_out', 'action_required'].includes(check.conclusion ?? ''))
    .map((check) => check.name || 'Check')
  return {
    ci: failing.length
      ? 'failed'
      : checks.some((check) => check.status !== 'completed')
        ? 'running'
        : checks.length
          ? 'passed'
          : 'none',
    failing
  }
}

const etags = new Map<string, { tag: string; body: unknown }>()
async function api(root: string, path: string): Promise<any> {
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
  const output = await run('gh', args, root)
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

/** Reads only local refs and GitHub REST. A disconnected/offline project becomes unknown. */
export async function branchStatus(root: string): Promise<BranchStatus> {
  const base = await defaultBase(root)
  let counts = '0 0'
  try {
    counts = await run(
      'git',
      ['rev-list', '--left-right', '--count', `origin/${base}...HEAD`],
      root
    )
  } catch {}
  const sync = deriveSync(counts, base)
  const status: BranchStatus = { base, ...sync, ci: 'unknown', failing: [] }
  try {
    const branch = await run('git', ['branch', '--show-current'], root)
    const repo = JSON.parse(await run('gh', ['repo', 'view', '--json', 'nameWithOwner'], root))
      .nameWithOwner as string
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return status
    const prs = await api(
      root,
      `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}&per_page=1`
    )
    const pr = Array.isArray(prs) ? prs[0] : undefined
    if (pr)
      status.pr = { number: pr.number, state: pr.merged_at ? 'merged' : 'open', url: pr.html_url }
    try {
      const comparison = await api(
        root,
        `repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`
      )
      if (Number.isSafeInteger(comparison.ahead_by) && Number.isSafeInteger(comparison.behind_by))
        Object.assign(status, deriveSync(`${comparison.behind_by} ${comparison.ahead_by}`, base))
    } catch {}
    const sha =
      status.pr?.state === 'merged'
        ? (await api(root, `repos/${repo}/branches/${encodeURIComponent(base)}`)).commit.sha
        : (pr?.head?.sha ?? (await run('git', ['rev-parse', 'HEAD'], root)))
    status.commit = sha
    status.checksUrl = `https://github.com/${repo}/commit/${sha}/checks`
    const checks = await api(root, `repos/${repo}/commits/${sha}/check-runs?per_page=100`)
    Object.assign(status, deriveChecks(Array.isArray(checks.check_runs) ? checks.check_runs : []))
  } catch {
    status.ci = 'unknown'
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
