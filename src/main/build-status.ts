import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import {
  type BuildStatus,
  buildStatusLine,
  fromGitHubCompare,
  githubRepo,
  MAIN_BRANCH,
  type MainComparison,
  remoteMain,
  sameCommit
} from '../shared/build-status'

/**
 * LKM-226: compares the running build's commit with origin main of Trezi's own
 * checkout (`app.getAppPath()`), read-only: `git ls-remote` for main's sha, then local
 * objects for ancestry and the commit count, then GitHub's unauthenticated compare API
 * when main's newest commits were never fetched. Nothing is fetched or written. The
 * derivation is pure (`src/shared/build-status.ts`); the schedule and the badge are
 * `src/native/build-status-controller.ts`.
 */

export interface RunResult {
  code: number
  stdout: string
}
export type Run = (command: string, args: string[], timeoutMs: number) => Promise<RunResult>
export type Fetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export const REMOTE_TIMEOUT_MS = 15_000
const LOCAL_TIMEOUT_MS = 5_000

/** git with no terminal prompt; a non-zero exit is a result, not a throw. */
export const runGit: Run = (command, args, timeoutMs) =>
  new Promise((resolve) =>
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
      },
      (error, stdout) =>
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout: String(stdout ?? '')
        })
    )
  )

/**
 * Whether the Mac has a usable network interface (not loopback or link-local). False
 * means offline: the check then makes no network call at all.
 */
export function hasNetwork(interfaces = networkInterfaces()): boolean {
  return Object.values(interfaces).some((list) =>
    (list ?? []).some(
      (entry) =>
        !entry.internal &&
        !(entry.family === 'IPv4'
          ? entry.address.startsWith('169.254.')
          : /^fe80:/i.test(entry.address))
    )
  )
}

/**
 * The build's commit against origin main, or null when main could not be read. `sha`
 * is the full stamped sha when there is one, else the short one.
 */
export async function compareWithMain(
  root: string,
  sha: string,
  { run = runGit, fetch = globalThis.fetch as unknown as Fetch } = {}
): Promise<MainComparison | null> {
  const git = (args: string[], timeout = LOCAL_TIMEOUT_MS) =>
    run('git', ['-C', root, ...args], timeout)
  const listed = await git(
    ['ls-remote', '--heads', 'origin', `refs/heads/${MAIN_BRANCH}`],
    REMOTE_TIMEOUT_MS
  )
  const main = listed.code === 0 ? remoteMain(listed.stdout) : null
  if (!main) return null
  if (sameCommit(sha, main)) return { main, contained: true, behind: 0 }
  // Main's commit is here already (an earlier fetch or pull): ask Git.
  if ((await git(['cat-file', '-e', `${main}^{commit}`])).code === 0) {
    const ancestor = await git(['merge-base', '--is-ancestor', sha, main])
    if (ancestor.code === 1) return { main, contained: false, behind: null }
    if (ancestor.code !== 0) return { main, contained: null, behind: null }
    const count = await git(['rev-list', '--count', `${sha}..${main}`])
    const behind = Number.parseInt(count.stdout.trim(), 10)
    return {
      main,
      contained: true,
      behind: count.code === 0 && Number.isFinite(behind) ? behind : null
    }
  }
  // Not fetched yet: GitHub's compare API (public repos, no auth) knows the count.
  const url = await git(['remote', 'get-url', 'origin'])
  const repo = url.code === 0 ? githubRepo(url.stdout) : null
  if (repo && /^[0-9a-f]{7,40}$/.test(sha)) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), REMOTE_TIMEOUT_MS)
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/compare/${main}...${sha}`,
        {
          signal: abort.signal,
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Trezi' }
        }
      )
      const compared = response.ok ? fromGitHubCompare(main, await response.json()) : null
      if (compared) return compared
    } catch {
      // Offline, rate limited or a private repo: fall through.
    } finally {
      clearTimeout(timer)
    }
  }
  // The last fetched origin/main already contains the build: main only moves forward.
  const fetched = await git([
    'merge-base',
    '--is-ancestor',
    sha,
    `refs/remotes/origin/${MAIN_BRANCH}`
  ])
  return { main, contained: fetched.code === 0 ? true : null, behind: null }
}

let latest: BuildStatus | null = null

/** The badge's latest state, for Copy Logs for Support and the feedback diagnostics. */
export const currentBuildStatus = () => latest
export const setCurrentBuildStatus = (status: BuildStatus) => {
  latest = status
}
export const currentBuildLine = () => (latest ? buildStatusLine(latest) : 'Build: not checked yet')
