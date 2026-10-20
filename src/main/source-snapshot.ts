import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { candidateTree, objectFormat, objectId, type TreeChange } from './source-tree'

/**
 * LOCAL-WEBKIT-1: which source a checkout holds right now, exactly. HEAD alone does
 * not say: a worktree's uncommitted and untracked files are what its dev server
 * compiles. `id` is a SHA-256 over HEAD and, for every path Git reports as differing
 * from it (staged, unstaged or untracked, not ignored), the path and its current
 * bytes (a symlink's target, or "deleted"). Every unlisted path is HEAD's content, so
 * two checkouts with the same id hold the same non-ignored source. It is read-only:
 * no index, object or ref is written. Ignored files (build output, `.env`) and the
 * worktree's own `node_modules` are outside it. A changed path that is a directory
 * (a dirty submodule or an embedded repository) or a special file has no bounded exact
 * identity here, so the snapshot fails closed (`unsupported-entry`, no id) rather than
 * letting one constant stand for contents that can change.
 *
 * LOCAL-WEBKIT-3: `tree` is the Git tree id the same bytes would commit to
 * (`./source-tree`), the identity the integration gate binds checks to.
 */
export interface SourceSnapshot {
  /** Null when the snapshot could not be taken exactly; `reason` says why. */
  id: string | null
  /** The candidate tree of exactly these bytes; null without an id or when Git could
   *  not list HEAD's trees. */
  tree: string | null
  head: string | null
  /** Paths that differ from HEAD. */
  dirty: number
  takenAt: number
  reason?:
    | 'not-a-git-checkout'
    | 'too-many-changes'
    | 'too-large'
    | 'unreadable'
    | 'unsupported-entry'
}

/** Beyond these the snapshot is refused rather than slow or partial. */
export const SNAPSHOT_LIMITS = { files: 5000, bytes: 64 * 1024 * 1024 }

const execFileP = promisify(execFile)
/** The worktree's own dependency clone and `.env` symlink are excluded by name. */
const EXCLUDES = [
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/node_modules',
  ':(exclude,top).env'
]
/** Per root: the read running, and the one read queued behind it. */
const lanes = new Map<
  string,
  { running: Promise<SourceSnapshot>; queued?: Promise<SourceSnapshot> }
>()

const git = async (cwd: string, args: string[]) =>
  (
    await execFileP('git', args, {
      cwd,
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
  ).stdout

/**
 * The checkout's snapshot, read entirely after this call. A read already running may
 * have missed a change made just before the call, so it is never shared: the call
 * joins the one read queued behind it (which starts later), or queues it.
 */
export function sourceSnapshot(root: string): Promise<SourceSnapshot> {
  const lane = lanes.get(root)
  if (!lane) return read(root)
  lane.queued ??= lane.running.catch(() => null).then(() => read(root))
  return lane.queued
}

function read(root: string): Promise<SourceSnapshot> {
  const running = take(root).finally(() => {
    if (lanes.get(root)?.running === running) lanes.delete(root)
  })
  lanes.set(root, { running })
  return running
}

async function take(root: string): Promise<SourceSnapshot> {
  const takenAt = Date.now()
  const failed = (reason: SourceSnapshot['reason'], head: string | null = null, dirty = 0) => ({
    id: null,
    tree: null,
    head,
    dirty,
    takenAt,
    reason
  })
  let top: string
  let head: string | null
  let status: string
  try {
    top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
    head = (await git(top, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null
    // `GIT_OPTIONAL_LOCKS=0`: status must not refresh (write) the index of a busy worktree.
    status = await git(top, [
      '-c',
      'core.quotepath=off',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
      ':/',
      ...EXCLUDES
    ])
  } catch {
    return failed('not-a-git-checkout')
  }
  const entries = status.split('\0').filter((entry) => entry.length > 3)
  const paths = [...new Set(entries.map((entry) => entry.slice(3)))].sort()
  // A tracked file Git reports deleted while a directory now stands at its path (whose
  // files Git lists on their own): the file's entry is gone.
  const deleted = new Set(
    entries.filter((entry) => entry.slice(0, 2).includes('D')).map((entry) => entry.slice(3))
  )
  if (paths.length > SNAPSHOT_LIMITS.files) return failed('too-many-changes', head, paths.length)
  const hash = createHash('sha256').update(`head\0${head ?? 'unborn'}\n`)
  const format = await objectFormat(top)
  const changes: TreeChange[] = []
  let bytes = 0
  for (const path of paths) {
    const full = join(top, path)
    let entry: string
    try {
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        const target = await readlink(full)
        entry = `link\0${target}`
        changes.push({
          path,
          mode: '120000',
          oid: objectId(format, 'blob', Buffer.from(target))
        })
      } else if (info.isFile()) {
        bytes += info.size
        if (bytes > SNAPSHOT_LIMITS.bytes) return failed('too-large', head, paths.length)
        // One read feeds both identities, so they always describe the same bytes.
        const content = await readFile(full)
        const digest = createHash('sha256').update(content).digest('hex')
        // Git's own rule: only the owner execute bit makes a blob 100755, so the id and
        // the cached tree can never disagree about a chmod.
        const mode = info.mode & 0o100 ? '100755' : '100644'
        entry = `${mode === '100755' ? 'exec' : 'file'}\0${digest}`
        changes.push({
          path,
          mode,
          oid: objectId(format, 'blob', content)
        })
      } else if (info.isDirectory() && deleted.has(path)) {
        entry = 'deleted'
        changes.push({ path, mode: null, oid: null })
      } else {
        // A directory here is a submodule or embedded repository (Git lists no other
        // directory), and a fifo, socket or device has no content to read. Their
        // contents can change while this path stays "dirty", so no exact id exists.
        return failed('unsupported-entry', head, paths.length)
      }
    } catch (error) {
      // ENOTDIR: a file now stands where this path's directory was.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return failed('unreadable', head, paths.length)
      entry = 'deleted'
      changes.push({ path, mode: null, oid: null })
    }
    hash.update(`${path}\0${entry}\n`)
  }
  const id = hash.digest('hex')
  return { id, tree: await treeOf(top, id, head, changes), head, dirty: paths.length, takenAt }
}

/** The id fixes HEAD and every changed byte, so its tree is computed once. */
const trees = new Map<string, string>()
async function treeOf(
  top: string,
  id: string,
  head: string | null,
  changes: TreeChange[]
): Promise<string | null> {
  const key = `${top}\0${id}`
  const known = trees.get(key)
  if (known) return known
  const tree = await candidateTree(top, head, changes).catch(() => null)
  if (!tree) return null
  if (trees.size >= 256) trees.delete(trees.keys().next().value as string)
  trees.set(key, tree)
  return tree
}
