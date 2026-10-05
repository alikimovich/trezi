import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * LKM-163: with "Agent file access" set to Full access, Codex runs without a sandbox
 * and has no pre-tool hook, so nothing stops it from writing the live checkout instead
 * of its chat worktree. Such a write bypasses landing, Stop and Revert. The adapter takes
 * this snapshot of the live tree's uncommitted files before and after each turn and
 * names the files that changed in one note, so it never goes unnoticed.
 *
 * A read only: `--no-optional-locks` keeps `git status` from refreshing the index. A
 * file another app (or another chat's landing) changed during the turn is named too;
 * the note says the files changed, not that Codex changed them.
 */
export type LiveTreeSnapshot = Map<string, string>

const MAX_FILES = 5000

const status = (liveRoot: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      'git',
      [
        '--no-optional-locks',
        '-C',
        liveRoot,
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all'
      ],
      { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })

/** Each uncommitted file of `liveRoot` with its status, size and mtime; null when Git fails. */
export async function liveTreeSnapshot(liveRoot: string): Promise<LiveTreeSnapshot | null> {
  const out = await status(liveRoot)
  if (out === null) return null
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
  return files
}

/** Files that became uncommitted, or changed again, between the two snapshots. */
export function liveTreeChanges(before: LiveTreeSnapshot, after: LiveTreeSnapshot): string[] {
  return [...after]
    .filter(([path, mark]) => before.get(path) !== mark)
    .map(([path]) => path)
    .sort()
}

/** The one chat note for files that changed in the live checkout during a Full access turn. */
export function liveWriteNote(files: string[], worktree: string): string {
  const shown = files.slice(0, 5).join(', ')
  const more = files.length > 5 ? ` and ${files.length - 5} more` : ''
  return (
    `\n\n⚠️ Files in your live project changed during this turn, outside this chat's workspace: ${shown}${more}. ` +
    `If the agent wrote them directly, Trezi did not track those edits, so Revert cannot undo them; check them in your project. ` +
    `This chat edits its own copy (${worktree}), and Trezi applies that copy's changes when the turn finishes.`
  )
}
