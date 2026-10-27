import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BranchDiff,
  BranchDiffFile,
  BranchDiffHunk,
  BranchDiffSection
} from '../shared/native-editor'
import { defaultBase } from './publish-scope'

/**
 * The editor's read-only Changes list (LKM-364): what the current branch changed since
 * its merge-base with the default branch, kept apart from the uncommitted changes
 * (staged, unstaged, untracked). Git runs only the read subcommands below, without
 * optional locks, fsmonitor hooks, external diff drivers or textconv, so viewing never
 * touches the index, refs or work tree. Paths are relative to the project folder.
 */
export const READ_ONLY_GIT = new Set([
  'rev-parse',
  'symbolic-ref',
  'merge-base',
  'diff',
  'ls-files'
])
/** Bounds for large diffs: files per section, hunks per file, patch and untracked bytes. */
export const DIFF_LIMITS = {
  files: 500,
  hunks: 50,
  patchBytes: 4 * 1024 * 1024,
  fileBytes: 1024 * 1024
}

export type GitRead = (root: string, args: string[], maxBuffer?: number) => Promise<string>

const ENV_SCOPE = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_CEILING_DIRECTORIES'
]

/** Runs one allowlisted read in `root`; anything else is refused before Git starts. */
export const gitRead: GitRead = (root, args, maxBuffer = 2 * 1024 * 1024) => {
  if (!READ_ONLY_GIT.has(args[0])) return Promise.reject(new Error(`git ${args[0]} is not a read`))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C'
  }
  // Another repository named by the environment never stands in for this project's.
  for (const name of ENV_SCOPE) delete env[name]
  const flags = ['--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false']
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      [...flags, ...args],
      { cwd: root, env, maxBuffer, timeout: 15_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  )
}

const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--relative']
const STATUS: Record<string, BranchDiffFile['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type'
}

/** `--name-status -z`: status, then one path (two for renames and copies). */
export function parseNameStatus(output: string): { status: string; path: string; from?: string }[] {
  const tokens = output.split('\0')
  const files: { status: string; path: string; from?: string }[] = []
  for (let i = 0; i < tokens.length - 1; ) {
    const status = tokens[i++][0]
    if (!status) continue
    if (status === 'R' || status === 'C') {
      files.push({ status, from: tokens[i], path: tokens[i + 1] })
      i += 2
    } else files.push({ status, path: tokens[i++] })
  }
  return files
}

/** `--numstat -z`: counts by (new) path; `-` counts are a binary file. */
export function parseNumstat(
  output: string
): Map<string, { added: number | null; removed: number | null }> {
  const tokens = output.split('\0'),
    counts = new Map<string, { added: number | null; removed: number | null }>()
  for (let i = 0; i < tokens.length - 1; ) {
    const [added, removed, path] = tokens[i++].split('\t')
    if (added === undefined || removed === undefined) continue
    // A rename's counts end with an empty path, then the old and new paths.
    let file = path
    if (!file) {
      file = tokens[i + 1]
      i += 2
    }
    counts.set(file, {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed)
    })
  }
  return counts
}

/** Each file block's `@@` headers of a `-U0` patch, in the patch's (the listing's) order. */
export function parseHunks(patch: string): { hunks: BranchDiffHunk[]; more: boolean }[] {
  return patch
    .split(/^diff --git /m)
    .slice(1)
    .map((block) => {
      const hunks: BranchDiffHunk[] = []
      let more = false
      for (const m of block.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        if (hunks.length >= DIFF_LIMITS.hunks) {
          more = true
          break
        }
        hunks.push({
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4])
        })
      }
      return { hunks, more }
    })
}

function summed(
  kind: BranchDiffSection['kind'],
  label: string,
  files: BranchDiffFile[],
  truncated: boolean
): BranchDiffSection {
  const shown = files.slice(0, DIFF_LIMITS.files)
  return {
    kind,
    label,
    files: shown,
    added: shown.reduce((n, f) => n + (f.added ?? 0), 0),
    removed: shown.reduce((n, f) => n + (f.removed ?? 0), 0),
    truncated: truncated || files.length > shown.length
  }
}

async function tracked(
  read: GitRead,
  root: string,
  kind: BranchDiffSection['kind'],
  label: string,
  range: string[]
) {
  const args = (format: string[]) => [...DIFF, ...format, ...range, '--']
  const [status, numstat] = await Promise.all([
    read(root, args(['--name-status', '-z'])),
    read(root, args(['--numstat', '-z']))
  ])
  const counts = parseNumstat(numstat)
  const files: BranchDiffFile[] = parseNameStatus(status).map(({ status, path, from }) => {
    const count = counts.get(path)
    return {
      path,
      ...(from ? { from } : {}),
      status: STATUS[status] ?? 'modified',
      added: count?.added ?? null,
      removed: count?.removed ?? null,
      binary: !!count && count.added === null,
      hunks: []
    }
  })
  let truncated = false
  if (files.length)
    try {
      // The same diff in the same order: one block per listed file.
      const blocks = parseHunks(await read(root, args(['-U0']), DIFF_LIMITS.patchBytes))
      if (blocks.length === files.length)
        blocks.forEach((block, i) => {
          files[i].hunks = block.hunks
          truncated ||= block.more
        })
      else truncated = true
    } catch {
      truncated = true // Too large to read whole: files and counts, no hunks.
    }
  return summed(kind, label, files, truncated)
}

async function untracked(read: GitRead, root: string) {
  const paths = (await read(root, ['ls-files', '--others', '--exclude-standard', '-z', '--']))
    .split('\0')
    .filter(Boolean)
  const files: BranchDiffFile[] = []
  for (const path of paths.slice(0, DIFF_LIMITS.files)) {
    const file: BranchDiffFile = {
      path,
      status: 'untracked',
      added: null,
      removed: null,
      binary: false,
      hunks: []
    }
    try {
      const info = await lstat(join(root, path))
      // Symlinks are listed, never followed; large files are listed without counting.
      if (info.isFile() && info.size <= DIFF_LIMITS.fileBytes) {
        const content = await readFile(join(root, path))
        file.binary = content.subarray(0, 8000).includes(0)
        if (!file.binary) {
          const text = content.toString('utf8')
          file.added = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
          file.removed = 0
        }
      }
    } catch {}
    files.push(file)
  }
  return summed('untracked', 'Untracked (uncommitted)', files, paths.length > files.length)
}

const short = (sha: string) => sha.trim().slice(0, 7)
const nameOf = (ref: string) => ref.replace(/^refs\/(remotes|heads)\//, '')

/** The first of the default branch (remote, then local; master when main is only assumed)
 *  or the branch's upstream that shares history with HEAD, and that merge-base. */
async function resolveBase(read: GitRead, root: string) {
  const trimmed = (r: string, a: string[]) => read(r, a).then((s) => s.trim())
  const name = await defaultBase(root, trimmed)
  const refs = [`refs/remotes/origin/${name}`, `refs/heads/${name}`]
  if (name === 'main') refs.push('refs/remotes/origin/master', 'refs/heads/master')
  const upstream = await trimmed(root, ['rev-parse', '--symbolic-full-name', '@{upstream}']).catch(
    () => ''
  )
  if (upstream.startsWith('refs/') && !refs.includes(upstream)) refs.push(upstream)
  for (const ref of refs) {
    try {
      await read(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      const fork = await trimmed(root, ['merge-base', ref, 'HEAD'])
      if (fork) return { ref: nameOf(ref), fork, tried: refs }
    } catch {
      /* Missing here, or no shared history: try the next one. */
    }
  }
  return { ref: '', fork: '', tried: refs }
}

const EMPTY = (root: string, message: string, git = true): BranchDiff => ({
  root,
  git,
  branch: '',
  head: '',
  detached: false,
  base: null,
  sections: [],
  message
})

/** The project's committed and uncommitted changes, read-only. */
export async function branchDiff(root: string, read: GitRead = gitRead): Promise<BranchDiff> {
  const inside = await read(root, ['rev-parse', '--is-inside-work-tree']).catch(() => '')
  if (inside.trim() !== 'true')
    return EMPTY(
      root,
      'This project is not in a Git repository, so there are no branch changes to show.',
      false
    )
  try {
    const branch = (
      await read(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
    ).trim()
    const headSha = (
      await read(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')
    ).trim()
    const diff: BranchDiff = {
      ...EMPTY(root, ''),
      branch,
      head: short(headSha),
      detached: !branch && !!headSha
    }
    const sections: Promise<BranchDiffSection>[] = []
    if (!headSha) {
      diff.message = 'No commits yet: only uncommitted changes are listed.'
    } else {
      const base = await resolveBase(read, root)
      if (base.fork) {
        diff.base = {
          ref: base.ref,
          sha: short(base.fork),
          label: `Base: merge-base with ${base.ref} @ ${short(base.fork)}`,
          fallback: false
        }
        sections.push(
          tracked(read, root, 'committed', `Committed since ${short(base.fork)} (${base.ref})`, [
            base.fork,
            'HEAD'
          ])
        )
      } else {
        const looked = base.tried.map(nameOf).join(', ')
        diff.base = {
          ref: 'HEAD',
          sha: short(headSha),
          label: `Base: HEAD @ ${short(headSha)} (no default branch found: looked for ${looked}), so no committed changes are listed`,
          fallback: true
        }
        sections.push(
          Promise.resolve(
            summed('committed', 'Committed: no base branch to compare with', [], false)
          )
        )
      }
      if (diff.detached) diff.message = `Detached HEAD at ${short(headSha)}.`
    }
    sections.push(
      tracked(read, root, 'staged', 'Staged (uncommitted)', ['--cached']),
      tracked(read, root, 'unstaged', 'Unstaged (uncommitted)', []),
      untracked(read, root)
    )
    diff.sections = await Promise.all(sections)
    return diff
  } catch (error) {
    return EMPTY(
      root,
      `Could not read the changes: ${String((error as Error)?.message ?? error).split('\n')[0]}`
    )
  }
}
