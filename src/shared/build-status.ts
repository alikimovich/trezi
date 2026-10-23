/**
 * LKM-226: is the running build the published code on GitHub main? Pure parts: the
 * build stamp (`scripts/version.mjs` `buildInfo`), the one state derived from it and
 * a comparison with origin main, and the texts the sidebar badge, its tooltip, About
 * Trezi, Copy Logs for Support and the feedback diagnostics show. The check itself is
 * `src/main/build-status.ts`; the badge `src/native/BuildBadge.swift`.
 */

export const MAIN_BRANCH = 'main'

/**
 * What the build stamps. `branch` is '' for a detached HEAD, `tag` '' when HEAD is no
 * release tag. LKM-301: `git` is false for a build outside a Git checkout, `dirty` null
 * when Git could not tell, `builtAt` the build's ISO time ('' in older stamps).
 */
export interface BuildStamp {
  version: string
  build: string
  commit: string
  sha: string
  branch: string
  dirty: boolean | null
  tag: string
  git: boolean
  builtAt: string
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
  /** The badge's short text: `identity`, then ` · context` when there is one. */
  text: string
  /** LKM-301: version, build number and commit, e.g. "0.1.0 (1234, 1a2b3c4)". */
  identity: string
  /** LKM-301: branch (never main) and state, e.g. "candidate · modified"; '' on a clean main build. */
  context: string
  /** One sentence, e.g. "Behind main by 3 commits". */
  label: string
  /** LKM-301: what VoiceOver reads: version, build, commit, branch, clean or not. */
  spoken: string
  behind: number | null
  /**
   * Why the state is Unknown: 'unbuilt' | 'no-git' | 'metadata' | 'off' | 'offline' |
   * 'unreachable' | 'pending'.
   */
  reason: string | null
  version: string
  build: string
  commit: string
  branch: string
  tag: string
  dirty: boolean | null
  git: boolean
  builtAt: string
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
    dirty: typeof raw.dirty === 'boolean' ? raw.dirty : null,
    tag: str(raw.tag),
    git: raw.git !== false,
    builtAt: str(raw.builtAt)
  }
}

/** True when a Git stamp names its commit, build number and tree state (LKM-301). */
const completeStamp = (stamp: BuildStamp) =>
  SHA.test(stamp.commit) && /^[1-9]\d*$/.test(stamp.build) && stamp.dirty !== null

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

/** "clean", "uncommitted changes" or, when Git could not tell, "unknown". */
const treeText = (dirty: boolean | null) =>
  dirty === null ? 'unknown' : dirty ? 'uncommitted changes' : 'clean'

/** The branch the badge names: never main, "detached" for a detached HEAD, none outside Git. */
const branchContext = (stamp: BuildStamp) =>
  stamp.branch === MAIN_BRANCH ? [] : [stamp.branch || 'detached']

/**
 * The one state of a build. A dirty build is Local changes; a build from another branch
 * (candidate, a feature branch) is Not on main without asking the network; otherwise
 * the comparison decides: the same commit is On main, an ancestor is Behind main by N,
 * a commit main does not contain is Not on main. No answer is Unknown, as is a build
 * outside Git or with an incomplete stamp (LKM-301), which never asks the network.
 *
 * LKM-301: the badge always shows the build's identity (version, build number, commit;
 * the package version alone does not change between commits), then the branch unless it
 * is main, then the state in words ("modified", "3 behind"). There is no checkmark: a
 * clean main build has no context, and its green dot and `spoken` text say On main.
 */
export function deriveBuildStatus(stamp: BuildStamp | null, input: BuildCheckInput): BuildStatus {
  // Outside Git or with a placeholder ("0", "unknown"), there is no build or commit to show or copy.
  const git = stamp?.git ?? false
  const base = {
    version: stamp?.version ?? '',
    build: git && /^[1-9]\d*$/.test(stamp?.build ?? '') ? (stamp?.build ?? '') : '',
    commit: git && SHA.test(stamp?.commit ?? '') ? (stamp?.commit ?? '') : '',
    branch: stamp?.branch ?? '',
    tag: stamp?.tag ?? '',
    dirty: stamp ? stamp.dirty : false,
    git,
    builtAt: stamp?.builtAt ?? '',
    main: input.comparison?.main.slice(0, 7) ?? '',
    checkedAt: input.checkedAt,
    behind: null as number | null,
    reason: null as string | null
  }
  const version = base.version || 'dev'
  const complete = !!stamp && stamp.git && completeStamp(stamp)
  const identity = complete ? `${version} (${base.build}, ${base.commit})` : version
  const branch = stamp && complete ? branchContext(stamp) : []
  const spokenIdentity = !stamp
    ? 'Unbuilt development source'
    : !stamp.git
      ? `Version ${version}, not built from a Git checkout`
      : !complete
        ? `Version ${version}, build metadata missing`
        : `Version ${version}, build ${base.build}, commit ${base.commit}, ${base.branch ? `branch ${base.branch}` : 'detached HEAD'}, ${treeText(base.dirty)}`
  const status = (
    over: Pick<BuildStatus, 'state' | 'tone' | 'label'> & Partial<BuildStatus>,
    context: string[]
  ): BuildStatus => ({
    ...base,
    ...over,
    identity,
    context: context.join(' · '),
    text: [identity, ...context].join(' · '),
    spoken: `${spokenIdentity}. ${over.label}`
  })
  const unknown = (reason: string, label: string, context: string[]) =>
    status({ state: 'unknown', tone: 'gray', label, reason }, context)
  if (!stamp) return unknown('unbuilt', 'Unbuilt development source', ['unbuilt'])
  if (!stamp.git)
    return unknown('no-git', 'Unknown: built outside a Git checkout, so it has no commit', [
      'no Git'
    ])
  if (!complete)
    return unknown('metadata', 'Unknown: the build stamp is incomplete; rebuild Trezi', [
      'no build info'
    ])
  if (stamp.dirty)
    return status(
      {
        state: 'local-changes',
        tone: 'blue',
        label: 'Local changes: built from a tree with uncommitted changes'
      },
      [...branch, 'modified']
    )
  if (stamp.branch && stamp.branch !== MAIN_BRANCH)
    return status(
      {
        state: 'not-on-main',
        tone: 'orange',
        label: `Not on main: built from the ${stamp.branch} branch`
      },
      branch
    )
  if (!input.enabled) return unknown('off', 'Main check is off in Settings', branch)
  if (!input.online) return unknown('offline', 'Unknown: offline', [...branch, 'offline'])
  const comparison = input.comparison
  if (!comparison)
    return input.checkedAt === null
      ? unknown('pending', 'Checking GitHub main…', branch)
      : unknown('unreachable', 'Unknown: GitHub main could not be read', [...branch, 'unknown'])
  const same = sameCommit(stamp.sha || stamp.commit, comparison.main)
  if (same || (comparison.contained && comparison.behind === 0))
    return status(
      { behind: 0, state: 'on-main', tone: 'green', label: 'On main: this is the published code' },
      branch
    )
  if (comparison.contained === false)
    return status(
      {
        state: 'not-on-main',
        tone: 'orange',
        label: 'Not on main: main does not contain this commit'
      },
      [...branch, 'not on main']
    )
  if (comparison.contained)
    return status(
      {
        behind: comparison.behind,
        state: 'behind',
        tone: 'yellow',
        label: comparison.behind
          ? `Behind main by ${plural(comparison.behind, 'commit')}: an update is available`
          : 'Behind main: an update is available'
      },
      [...branch, comparison.behind ? `${comparison.behind} behind` : 'behind']
    )
  return unknown('unreachable', 'Unknown: could not compare this commit with main', [
    ...branch,
    'unknown'
  ])
}

/** Local time of a check, e.g. "Oct 10, 2026, 12:30 PM". */
export const checkedText = (at: number | null) =>
  at === null
    ? 'not checked yet'
    : new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/** Local time of the build (LKM-301), "unknown" for a stamp without one. */
const builtText = (at: string) => {
  const time = Date.parse(at)
  return Number.isNaN(time)
    ? 'unknown'
    : new Date(time).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' })
}

/** The details the tooltip, About Trezi and the details sheet list, one per line. */
export function buildDetails(status: BuildStatus): string[] {
  const branch = status.branch || (!status.version ? '-' : status.git ? 'detached HEAD' : 'no Git')
  return [
    `Status: ${status.label}`,
    `Version: ${status.version || 'unbuilt'}`,
    `Build: ${status.build || '-'}`,
    `Commit: ${status.commit || '-'}`,
    `Branch: ${branch}`,
    `Tree: ${status.version && status.git ? treeText(status.dirty) : '-'}`,
    `Release tag: ${status.tag || 'none'}`,
    `Built: ${status.version ? builtText(status.builtAt) : '-'}`,
    ...(status.main ? [`Main: ${status.main}`] : []),
    `Checked: ${checkedText(status.checkedAt)}`
  ]
}

/** One line for logs and diagnostics (ISO time, no locale). */
export function buildStatusLine(status: BuildStatus): string {
  return `Build: ${status.label} (version ${status.version || 'unbuilt'}, build ${status.build || '-'}, commit ${status.commit || '-'}, branch ${status.branch || '-'}, tag ${status.tag || 'none'}, dirty ${status.dirty ?? 'unknown'}, main ${status.main || 'unknown'}, checked ${status.checkedAt === null ? 'never' : new Date(status.checkedAt).toISOString()}, git ${status.git}, built ${status.builtAt || 'unknown'})`
}

export const UPDATE_STEPS =
  'In Terminal, in your Trezi folder:\n  git pull\n  bun run build\nThen quit and reopen Trezi.'
