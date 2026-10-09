import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * LKM-163: with "Agent file access" set to Full access, Codex runs without a sandbox
 * and has no pre-tool hook, so nothing stops it from writing the live checkout instead
 * of its chat worktree. Such a write bypasses landing, Stop and Revert. Bun takes this
 * snapshot of the live tree (its HEAD and its uncommitted files) before and after each
 * turn, and around each of Trezi's own effects, so the turn's report names only what
 * Trezi did not do (`main/live-change-watch.ts`, LKM-215).
 *
 * Both directions count. A file that is uncommitted before the turn and clean after it
 * was reverted or discarded (`git checkout -- f`, `restore`, `stash`, `reset --hard`: the
 * user's work is gone), and a HEAD that moved is a commit made in the live checkout.
 *
 * A read only: `--no-optional-locks` keeps `git status` from refreshing the index.
 */
export type LiveTreeSnapshot = {
  /** `git rev-parse HEAD`; null in a repository without a commit. */
  head: string | null
  /** Each uncommitted file with its status, size and mtime. */
  files: Map<string, string>
}

const MAX_FILES = 5000

const git = (liveRoot: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-C', liveRoot, ...args],
      { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })

/** The live tree's HEAD and each uncommitted file of `liveRoot`; null when Git fails. */
export async function liveTreeSnapshot(liveRoot: string): Promise<LiveTreeSnapshot | null> {
  const out = await git(liveRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (out === null) return null
  const head = (await git(liveRoot, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || null
  const entries = out.split('\0')
  const files = new Map<string, string>()
  for (let i = 0; i < entries.length && files.size < MAX_FILES; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    // A rename or copy is followed by its source path, which is not a file of the tree now.
    if (code[0] === 'R' || code[0] === 'C') i++
    const path = entry.slice(3)
    const info = await lstat(join(liveRoot, path)).catch(() => null)
    files.set(path, info ? `${code}:${info.size}:${info.mtimeMs}` : `${code}:gone`)
  }
  return { head, files }
}

/**
 * Files that became uncommitted, changed again, or stopped being uncommitted (a revert,
 * a discard or a stash) between the two snapshots.
 */
export function liveTreeChanges(before: LiveTreeSnapshot, after: LiveTreeSnapshot): string[] {
  const paths = new Set<string>()
  for (const [path, mark] of after.files) if (before.files.get(path) !== mark) paths.add(path)
  for (const path of before.files.keys()) if (!after.files.has(path)) paths.add(path)
  return [...paths].sort()
}

/** A commit, checkout or reset in the live tree moves HEAD. */
export const liveHeadMoved = (before: LiveTreeSnapshot, after: LiveTreeSnapshot): boolean =>
  before.head !== after.head
