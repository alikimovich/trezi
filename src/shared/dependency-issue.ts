/**
 * LKM-194: a chat turn never waits on, or is refused for, its dependencies. When the
 * synced checkout carries unresolved Git conflict markers, or the install fails, the
 * turn starts anyway; the chat shows a card and the agent is told why.
 */

/** A `"version"` conflict where both sides bumped package.json. */
export interface VersionConflict {
  ours: string
  theirs: string
  /** The higher SemVer of the two: the obvious resolution. */
  keep: string
}

export interface MarkerConflict {
  /** Files carrying unresolved markers, manifests first. */
  files: string[]
  /** 1-based line of the first `<<<<<<<` in `files[0]`, for Show conflict. */
  line: number
  /** A dependency manifest or lockfile has markers, so no install ran. */
  manifests: boolean
  version?: VersionConflict
}

export interface DependencyIssue {
  /** Unresolved conflict markers in the synced files. */
  conflict?: MarkerConflict
  /** Why dependencies are not installed in the checkout, when they are not. */
  install?: string
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** SemVer precedence: negative when `a` < `b`, null when either is not SemVer. */
export function compareSemver(a: string, b: string): number | null {
  const x = SEMVER.exec(a.trim()),
    y = SEMVER.exec(b.trim())
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d) return d
  }
  // A pre-release ranks below its release; identifiers compare numerically or lexically.
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0
  const p = x[4].split('.'),
    q = y[4].split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1
    if (q[i] === undefined) return 1
    const m = /^\d+$/.test(p[i]),
      n = /^\d+$/.test(q[i])
    if (m && n && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i])
    if (m !== n) return m ? -1 : 1
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1
  }
  return 0
}

/** Both sides bumped `version`: keep the higher. Null unless both are SemVer and differ. */
export function versionConflict(ours: string, theirs: string): VersionConflict | null {
  const order = compareSemver(ours, theirs)
  if (order === null || order === 0) return null
  return { ours, theirs, keep: order > 0 ? ours : theirs }
}

/** The card title: "Conflicts in package.json", or the count. */
export function conflictTitle(conflict: MarkerConflict): string {
  return conflict.files.length === 1
    ? `Conflicts in ${conflict.files[0]}`
    : `Conflicts in ${conflict.files.length} files`
}

const versionLine = (v: VersionConflict) =>
  `package.json "version" conflicts: one side has ${v.ours}, the other ${v.theirs}. Both sides bumped it; keep ${v.keep} (the higher SemVer).`

/** Facts the agent gets with the user's message while the issue stands. */
export function dependencyNotice(issue: DependencyIssue): string {
  const lines: string[] = []
  const conflict = issue.conflict
  if (conflict) {
    lines.push(
      `This workspace has unresolved Git conflict markers (<<<<<<<, =======, >>>>>>>) in: ${conflict.files.join(', ')}.`
    )
    if (conflict.version) lines.push(versionLine(conflict.version))
    if (conflict.manifests)
      lines.push(
        'Dependencies were not installed because the manifest cannot be parsed. Do not run commands that need node_modules until the markers are resolved.'
      )
    lines.push(
      'Mention the conflict to the user. If they ask you to fix it, edit the files to remove every marker (keep both sides’ intent), and finish a merge in progress with git_merge_continue.'
    )
  } else if (issue.install) {
    lines.push(
      `Dependencies are not installed in this workspace: ${issue.install}`,
      'Read and edit files, but do not run commands that need node_modules until the cause is fixed.'
    )
  }
  return lines.length ? `${lines.join('\n')}\n\n` : ''
}

/** The Resolve with agent turn for a conflict card. */
export function resolveConflictPrompt(conflict: MarkerConflict): string {
  return [
    `Resolve the unresolved Git conflict markers in ${conflict.files.join(', ')}.`,
    conflict.version ? versionLine(conflict.version) : '',
    'Remove every <<<<<<<, ======= and >>>>>>> line and keep both sides’ intent. If git status shows a merge in progress in this worktree, finish it with git_merge_continue; otherwise just edit the files.',
    conflict.manifests
      ? 'Then make sure package.json and the lockfile parse, and install the dependencies.'
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** The Fix with agent turn for a failed install. */
export function fixInstallPrompt(reason: string): string {
  return `Dependencies could not be installed in this workspace:\n\n${reason}\n\nFind the cause, fix it and install the dependencies again.`
}
