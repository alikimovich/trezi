/**
 * LKM-226: is the running build the published code on GitHub main? Pure parts: the
 * build stamp (`scripts/version.mjs` `buildInfo`), the one state derived from it and
 * a comparison with origin main, and the texts the sidebar badge, its tooltip, About
 * Trezi, Copy Logs for Support and the feedback diagnostics show. The check itself is
 * `src/main/build-status.ts`; the badge `src/native/BuildBadge.swift`.
 */

export const MAIN_BRANCH = 'main'

/** What the build stamps. `branch` is '' for a detached HEAD, `tag` '' when HEAD is no release tag. */
export interface BuildStamp {
  version: string
  build: string
  commit: string
  sha: string
  branch: string
  dirty: boolean
  tag: string
}

export type BuildState = 'on-main' | 'behind' | 'not-on-main' | 'local-changes' | 'unknown'
export type BuildTone = 'green' | 'yellow' | 'orange' | 'blue' | 'gray'

/**
 * The build's commit against origin main. `contained`: main contains the build (null
 * when that could not be learned); `behind`: commits on main after the build (null
 * when unknown).
 */
export interface MainComparison {
  main: string
  contained: boolean | null
  behind: number | null
}

export interface BuildCheckInput {
  /** The Settings switch; off never touches the network. */
  enabled: boolean
  /** False when the Mac has no network: Unknown, with no network call. */
  online: boolean
  /** Null when origin main could not be read (offline, no remote, timeout). */
  comparison: MainComparison | null
  checkedAt: number | null
}

export interface BuildStatus {
  state: BuildState
  tone: BuildTone
  /** The badge's short text, e.g. "0.1.0 · main ✓". */
  text: string
  /** One sentence, e.g. "Behind main by 3 commits". */
  label: string
  behind: number | null
  /** Why the state is Unknown: 'unbuilt' | 'off' | 'offline' | 'unreachable' | 'pending'. */
  reason: string | null
  version: string
  build: string
  commit: string
  branch: string
  tag: string
  dirty: boolean
  /** Short sha of origin main at the check, '' when unknown. */
  main: string
  checkedAt: number | null
}

const SHA = /^[0-9a-f]{7,40}$/

/** The stamp the build defines (`TREZI_BUILD`), or null when it is missing or malformed. */
export function parseBuildStamp(text: string): BuildStamp | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || typeof raw.version !== 'string') return null
  const str = (value: unknown) => (typeof value === 'string' ? value : '')
  return {
    version: raw.version,
    build: str(raw.build) || '0',
    commit: str(raw.commit) || 'unknown',
    sha: str(raw.sha),
    branch: str(raw.branch),
    dirty: raw.dirty === true,
    tag: str(raw.tag)
  }
}

/** The sha of `refs/heads/main` in `git ls-remote` output, or null. */
export function remoteMain(output: string, branch = MAIN_BRANCH): string | null {
  for (const line of output.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (ref === `refs/heads/${branch}` && /^[0-9a-f]{40}$/.test(sha ?? '')) return sha
  }
  return null
}

/** "owner/repo" of a GitHub remote URL (https, ssh or scp form), else null. */
export function githubRepo(url: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    )
  return match ? `${match[1]}/${match[2]}` : null
}

/** A GitHub `compare/{main}...{build}` answer as a comparison; null for anything unexpected. */
export function fromGitHubCompare(main: string, body: unknown): MainComparison | null {
  if (!body || typeof body !== 'object') return null
  const { status, behind_by } = body as { status?: unknown; behind_by?: unknown }
  if (status === 'identical') return { main, contained: true, behind: 0 }
  if (status === 'behind')
    return { main, contained: true, behind: typeof behind_by === 'number' ? behind_by : null }
  if (status === 'ahead' || status === 'diverged') return { main, contained: false, behind: null }
  return null
}

/** True when `full` (a full sha) is the commit `sha` names (full or abbreviated). */
export const sameCommit = (sha: string, full: string) =>
  SHA.test(sha) && SHA.test(full) && (full.startsWith(sha) || sha.startsWith(full))

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The one state of a build. A dirty build is Local changes; a build from another branch
 * (candidate, a feature branch) is Not on main without asking the network; otherwise
 * the comparison decides: the same commit is On main, an ancestor is Behind main by N,
 * a commit main does not contain is Not on main. No answer is Unknown.
 */
export function deriveBuildStatus(stamp: BuildStamp | null, input: BuildCheckInput): BuildStatus {
  const base = {
    version: stamp?.version ?? '',
    build: stamp?.build ?? '',
    commit: stamp?.commit ?? '',
    branch: stamp?.branch ?? '',
    tag: stamp?.tag ?? '',
    dirty: stamp?.dirty ?? false,
    main: input.comparison?.main.slice(0, 7) ?? '',
    checkedAt: input.checkedAt,
    behind: null as number | null,
    reason: null as string | null
  }
  const version = base.version || 'dev'
  const unknown = (reason: string, label: string, text = `${version} · unknown`): BuildStatus => ({
    ...base,
    state: 'unknown',
    tone: 'gray',
    text,
    label,
    reason
  })
  if (!stamp) return unknown('unbuilt', 'Unbuilt development source', 'dev · unbuilt')
  if (stamp.dirty)
    return {
      ...base,
      state: 'local-changes',
      tone: 'blue',
      text: `${version} · local changes`,
      label: 'Local changes: built from a tree with uncommitted changes'
    }
  if (stamp.branch && stamp.branch !== MAIN_BRANCH)
    return {
      ...base,
      state: 'not-on-main',
      tone: 'orange',
      text: `${stamp.branch} · not on main`,
      label: `Not on main: built from the ${stamp.branch} branch`
    }
  if (!input.enabled) return unknown('off', 'Main check is off in Settings', version)
  if (!input.online) return unknown('offline', 'Unknown: offline', `${version} · offline`)
  const comparison = input.comparison
  if (!comparison)
    return input.checkedAt === null
      ? unknown('pending', 'Checking GitHub main…', version)
      : unknown('unreachable', 'Unknown: GitHub main could not be read')
  const same = sameCommit(stamp.sha || stamp.commit, comparison.main)
  if (same || (comparison.contained && comparison.behind === 0))
    return {
      ...base,
      behind: 0,
      state: 'on-main',
      tone: 'green',
      text: `${version} · main ✓`,
      label: 'On main: this is the published code'
    }
  if (comparison.contained === false)
    return {
      ...base,
      state: 'not-on-main',
      tone: 'orange',
      text: `${version} · not on main`,
      label: 'Not on main: main does not contain this commit'
    }
  if (comparison.contained)
    return {
      ...base,
      behind: comparison.behind,
      state: 'behind',
      tone: 'yellow',
      text: comparison.behind ? `${version} · ${comparison.behind} behind` : `${version} · behind`,
      label: comparison.behind
        ? `Behind main by ${plural(comparison.behind, 'commit')}: an update is available`
        : 'Behind main: an update is available'
    }
  return unknown('unreachable', 'Unknown: could not compare this commit with main')
}

/** Local time of a check, e.g. "Oct 10, 2026, 12:30 PM". */
export const checkedText = (at: number | null) =>
  at === null
    ? 'not checked yet'
    : new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/** The details the tooltip, About Trezi and the details sheet list, one per line. */
export function buildDetails(status: BuildStatus): string[] {
  return [
    `Status: ${status.label}`,
    `Version: ${status.version || 'unbuilt'}`,
    `Build: ${status.build || '-'}`,
    `Commit: ${status.commit || '-'}`,
    `Branch: ${status.branch || (status.version ? 'detached HEAD' : '-')}`,
    `Release tag: ${status.tag || 'none'}`,
    ...(status.main ? [`Main: ${status.main}`] : []),
    `Checked: ${checkedText(status.checkedAt)}`
  ]
}

/** One line for logs and diagnostics (ISO time, no locale). */
export function buildStatusLine(status: BuildStatus): string {
  return `Build: ${status.label} (version ${status.version || 'unbuilt'}, build ${status.build || '-'}, commit ${status.commit || '-'}, branch ${status.branch || '-'}, tag ${status.tag || 'none'}, dirty ${status.dirty}, main ${status.main || 'unknown'}, checked ${status.checkedAt === null ? 'never' : new Date(status.checkedAt).toISOString()})`
}

export const UPDATE_STEPS =
  'In Terminal, in your Trezi folder:\n  git pull\n  bun run build\nThen quit and reopen Trezi.'
