import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { agentFileAccess, currentAgentFileAccess, realPath } from './agent-file-access'
import {
  type LiveTreeSnapshot,
  liveTreeChanges,
  liveTreeSnapshot
} from './backends/live-tree-watch'
import { repositoryOwner } from './repository-owner'

/**
 * LKM-163, LKM-215: in Full access, Codex runs without a sandbox, so it can write the
 * live checkout instead of its chat worktree, past landing, Stop and Revert. Bun compares
 * the live tree before and after each such turn and names what changed in one compact row.
 *
 * Trezi's own effects during the turn are not outside changes: every repository lease
 * (landings of this and other chats, conflict markers, installs) and every effectful
 * agent tool (land_now, publish, git_sync_base, restarts) is wrapped in
 * `treziLiveEffect`, which snapshots the live tree around it while a watch is open. The
 * paths it changed (with the state it left them in) and the commits it made or brought
 * in are subtracted at the end. Files a dev server generates are never named.
 *
 * Both snapshots are taken inside the repository lease, so they never see a landing half
 * written. A change is the agent's only when one of its own shell commands or edits named
 * the live checkout; otherwise it is the user's editor or another tool, which is normal.
 */
export interface LiveChange {
  /** Repo-relative paths, sorted. */
  files: string[]
  /** Commits made in the live checkout that Trezi did not make, newest first. */
  commits: { sha: string; subject: string }[]
  /** HEAD moved without a new commit (a reset or checkout). */
  headMoved: boolean
  /** One of the agent's commands or edits named the live checkout. */
  agent: boolean
}

/** What a turn's watch needs: the session's options, its worktree and its live root. */
export interface LiveWatchSession {
  root: string
  options: { provider?: string; connectionId?: string; agentFileAccess?: unknown }
  record: { projectRoot: string }
}

const CLEAN = 'clean'
const MAX_COMMITS = 5000

interface Watch {
  live: string
  worktree: string
  before: Promise<LiveTreeSnapshot | null>
  /** Paths Trezi's own effects changed, with the state they left them in. */
  marks: Map<string, string>
  /** Commits Trezi's effects made or brought in, and the HEADs they left. */
  commits: Set<string>
  heads: Set<string>
  agent: boolean
}

const watches = new Map<string, Watch>()

const git = (root: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.quotePath=false', '-C', root, ...args],
      { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })

/** A read in the repository's lane, so it never interleaves with a Trezi write. */
async function inLane<T>(root: string, read: () => Promise<T>): Promise<T> {
  let owner: ReturnType<typeof repositoryOwner> | null = null
  try {
    owner = repositoryOwner()
  } catch {
    return read()
  }
  return owner.withLease(root, read).catch(() => read())
}

/** Full-access Codex in a chat worktree is the one session that can write live directly. */
export function watchesLiveTree(session: LiveWatchSession): boolean {
  const codex = !!session.options.connectionId || session.options.provider === 'codex'
  return (
    codex &&
    (session.options.agentFileAccess === undefined
      ? currentAgentFileAccess()
      : agentFileAccess(session.options.agentFileAccess)) === 'full' &&
    realPath(session.root) !== realPath(session.record.projectRoot)
  )
}

/**
 * Opens chat `key`'s watch for the turn it is about to send (replacing an earlier one).
 * The send does not wait: the first snapshot settles in the repository lane.
 */
export async function beginLiveWatch(key: string, session: LiveWatchSession): Promise<void> {
  if (!watchesLiveTree(session)) {
    watches.delete(key)
    return
  }
  const live = realPath(session.record.projectRoot)
  const before = inLane(live, () => liveTreeSnapshot(live)).catch(() => null)
  watches.set(key, {
    live,
    worktree: realPath(session.root),
    before,
    marks: new Map(),
    commits: new Set(),
    heads: new Set(),
    agent: false
  })
  await before
}

/** The live checkout `text` names outside the worktree (an absolute or `~/` path). */
function namesLive(text: string, w: Watch): boolean {
  const home = homedir()
  const forms = (path: string) =>
    path.startsWith(`${home}/`) ? [path, `~${path.slice(home.length)}`] : [path]
  let rest = text
  for (const form of forms(w.worktree)) rest = rest.split(form).join('')
  return forms(w.live).some((form) => {
    let at = rest.indexOf(form)
    while (at >= 0) {
      const next = rest[at + form.length]
      if (next === undefined || !/[\w.-]/.test(next)) return true
      at = rest.indexOf(form, at + 1)
    }
    return false
  })
}

/** One of the agent's own steps (`$ command`, an edit's path): attributes live changes. */
export function noteAgentStep(key: string, text: string): void {
  const w = watches.get(key)
  if (w && !w.agent && namesLive(text, w)) w.agent = true
}

function openWatches(root: string): Watch[] {
  if (!watches.size) return []
  const live = realPath(root)
  return [...watches.values()].filter((w) => w.live === live)
}

async function commitsBetween(root: string, from: string | null, to: string): Promise<string[]> {
  const range = from ? [`${from}..${to}`] : [to]
  const out = await git(root, ['rev-list', `--max-count=${MAX_COMMITS}`, ...range, '--'])
  return out?.split('\n').filter(Boolean) ?? []
}

/**
 * Runs one of Trezi's own effects on the live checkout `root`. While a watch is open for
 * it, what the effect changed is recorded as Trezi's and never reported as outside.
 */
export async function treziLiveEffect<T>(root: string, operation: () => Promise<T>): Promise<T> {
  if (!openWatches(root).length) return operation()
  const live = realPath(root)
  const before = await liveTreeSnapshot(live)
  try {
    return await operation()
  } finally {
    const after = await liveTreeSnapshot(live)
    if (before && after) {
      const paths = liveTreeChanges(before, after)
      const moved = before.head !== after.head ? after.head : null
      const commits = moved ? await commitsBetween(live, before.head, moved) : []
      for (const w of openWatches(live)) {
        for (const path of paths) w.marks.set(path, after.files.get(path) ?? CLEAN)
        if (moved) w.heads.add(moved)
        for (const sha of commits) w.commits.add(sha)
      }
    }
  }
}

/** Generated by dev servers and builds, Trezi's sidecar, or never landed (`.env`). */
const GENERATED_DIRS = new Set([
  'node_modules',
  '.trezi',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.vite',
  '.turbo',
  '.vercel',
  '.parcel-cache',
  '.cache',
  '.angular',
  '.expo',
  'dist',
  'coverage'
])
export function generatedLivePath(path: string): boolean {
  const parts = path.split('/').filter(Boolean)
  if (parts.slice(0, -1).some((part) => GENERATED_DIRS.has(part))) return true
  const name = parts.at(-1) ?? ''
  return (
    GENERATED_DIRS.has(name) ||
    name.endsWith('.tsbuildinfo') ||
    name === 'next-env.d.ts' ||
    name === '.DS_Store' ||
    name === '.env' ||
    name.startsWith('.env.')
  )
}

/** Outside commits between two HEADs, with the files they touched. */
async function outsideCommits(
  live: string,
  from: string | null,
  to: string,
  trezi: Set<string>
): Promise<{ commits: LiveChange['commits']; files: string[] }> {
  const range = from ? `${from}..${to}` : to
  const out = await git(live, [
    'log',
    `--max-count=${MAX_COMMITS}`,
    '--no-renames',
    '--name-only',
    '--format=%x1e%H%x1f%s',
    range,
    '--'
  ])
  const commits: LiveChange['commits'] = []
  const files: string[] = []
  for (const chunk of out?.split('\x1e') ?? []) {
    const [head, ...names] = chunk.split('\n')
    const [sha, subject = ''] = head.split('\x1f')
    if (!sha || trezi.has(sha)) continue
    commits.push({ sha, subject })
    files.push(...names.filter(Boolean))
  }
  return { commits, files }
}

/**
 * Closes chat `key`'s watch at the end of its turn: what changed in the live checkout
 * that Trezi did not do, or null when nothing did (or no watch was open).
 */
export async function finishLiveWatch(key: string): Promise<LiveChange | null> {
  const w = watches.get(key)
  if (!w) return null
  try {
    const before = await w.before
    const after = before && (await inLane(w.live, () => liveTreeSnapshot(w.live)))
    if (!before || !after) return null
    const files = new Set(
      liveTreeChanges(before, after).filter(
        (path) => w.marks.get(path) !== (after.files.get(path) ?? CLEAN)
      )
    )
    let commits: LiveChange['commits'] = []
    let headMoved = false
    if (before.head !== after.head && after.head) {
      const outside = await outsideCommits(w.live, before.head, after.head, w.commits)
      commits = outside.commits
      for (const path of outside.files) files.add(path)
      headMoved =
        !commits.length &&
        !w.heads.has(after.head) &&
        !(await commitsBetween(w.live, before.head, after.head)).length
    } else if (before.head && !after.head) headMoved = true
    const shown = [...files].filter((path) => !generatedLivePath(path)).sort()
    if (!shown.length && !commits.length && !headMoved) return null
    return { files: shown, commits, headMoved, agent: w.agent }
  } finally {
    if (watches.get(key) === w) watches.delete(key)
  }
}

/** Drops chat `key`'s watch without a report (the chat closed). */
export function forgetLiveWatch(key: string): void {
  watches.delete(key)
}

const SHOWN_FILES = 20

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The row's one line: what changed, short. */
function summary(change: LiveChange): string {
  const parts: string[] = []
  const { files } = change
  if (files.length === 1) parts.push(files[0])
  else if (files.length === 2) parts.push(`${files[0]} and ${files[1]}`)
  else if (files.length > 2) parts.push(`${files[0]} and ${plural(files.length - 1, 'more file')}`)
  if (change.commits.length) parts.push(plural(change.commits.length, 'commit'))
  else if (change.headMoved) parts.push('the checked-out commit')
  return parts.join(', and ')
}

/**
 * The compact row for a turn's outside changes: one line, and Details with the paths
 * (repo-relative, never absolute) and what it means under the current landing model.
 */
export function liveChangeRow(change: LiveChange): { line: string; detail: string } {
  const line = change.agent
    ? `The agent changed your project outside this chat's workspace: ${summary(change)}`
    : `Your project changed outside this chat during this turn: ${summary(change)}`
  const sections: string[] = []
  if (change.files.length) {
    const shown = change.files.slice(0, SHOWN_FILES).map((path) => `- \`${path}\``)
    if (change.files.length > SHOWN_FILES)
      shown.push(`- and ${plural(change.files.length - SHOWN_FILES, 'more file')}`)
    sections.push(`Changed files:\n${shown.join('\n')}`)
  }
  if (change.commits.length) {
    const shown = change.commits
      .slice(0, SHOWN_FILES)
      .map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`.trimEnd())
    if (change.commits.length > SHOWN_FILES)
      shown.push(`- and ${plural(change.commits.length - SHOWN_FILES, 'more commit')}`)
    sections.push(`Commits:\n${shown.join('\n')}`)
  } else if (change.headMoved)
    sections.push('The checked-out commit changed (a reset or checkout).')
  sections.push(
    change.agent
      ? "The agent's own commands wrote to your project directly instead of this chat's workspace. Trezi did not track these changes, so Revert cannot undo them; check them with `git status` and `git log`."
      : 'They came from outside this chat: your editor, another tool or a Git command in your project. That is fine; Trezi lands this chat’s work on top of them.'
  )
  sections.push(
    'This chat edits its own workspace. Trezi lands its changes into your project during the turn (land now, Publish) and when the turn ends; those landings are not listed here.'
  )
  return { line, detail: sections.join('\n\n') }
}
