import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { excludedWorktreePath } from './worktrees'

/**
 * LOCAL-WEBKIT-3: the Git tree a checkout's source would commit to, computed from the
 * bytes `sourceSnapshot` read, without writing an object, index or ref. Unlike the
 * snapshot id it does not include HEAD, so committing the same bytes keeps it: it is
 * the identity the integration gate binds checks to and the repository owner compares
 * with the commit it lands (`HEAD^{tree}`). Paths Trezi never commits
 * (`excludedWorktreePath`: `.env*`, `node_modules`, `.tsbuildinfo`, Trezi's sidecar
 * folders) keep HEAD's entry, as the owner's `unstageExcluded` does. A clean filter or
 * line-ending conversion makes Git store other bytes than the file holds; the owner's
 * comparison then fails and the landing is held, never waved through.
 */

export type ObjectFormat = 'sha1' | 'sha256'

/** One path that differs from HEAD: its new blob, or null when it was deleted. */
export interface TreeChange {
  path: string
  /** `100644`, `100755` or `120000`; null for a deletion. */
  mode: '100644' | '100755' | '120000' | null
  oid: string | null
}

interface Entry {
  mode: string
  oid: string
}

const execFileP = promisify(execFile)
const TREE = '40000'
const formats = new Map<string, ObjectFormat>()

/** The repository's object format (`sha1` unless it was created with sha256). */
export async function objectFormat(top: string): Promise<ObjectFormat> {
  const known = formats.get(top)
  if (known) return known
  const out = await execFileP('git', ['rev-parse', '--show-object-format'], {
    cwd: top,
    timeout: 5000
  }).then(
    (r) => r.stdout.trim(),
    () => 'sha1'
  )
  const format: ObjectFormat = out === 'sha256' ? 'sha256' : 'sha1'
  formats.set(top, format)
  return format
}

/** Git's object id for `content` of `type`: the hash of `<type> <size>\0<content>`. */
export function objectId(format: ObjectFormat, type: 'blob' | 'tree', content: Buffer): string {
  return createHash(format).update(`${type} ${content.length}\0`).update(content).digest('hex')
}

/** The raw trees of `specs` (`<commit>:<dir>`) in one `git cat-file --batch`; a missing
 *  directory answers null. */
function readTrees(top: string, specs: string[]): Promise<(Buffer | null)[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: top,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024 * 1024) child.kill('SIGKILL')
      else chunks.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`))
      const out = Buffer.concat(chunks)
      const trees: (Buffer | null)[] = []
      let at = 0
      for (let i = 0; i < specs.length; i++) {
        const eol = out.indexOf(10, at)
        if (eol < 0) return reject(new Error('git cat-file answered short'))
        const header = out.subarray(at, eol).toString('utf8').split(' ')
        at = eol + 1
        if (header.at(-1) === 'missing' || header.length !== 3) {
          trees.push(null)
          continue
        }
        const length = Number(header[2])
        trees.push(header[1] === 'tree' ? out.subarray(at, at + length) : null)
        at += length + 1
      }
      resolve(trees)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(specs.map((spec) => `${spec}\n`).join(''))
  })
}

function parseTree(raw: Buffer, format: ObjectFormat): Map<string, Entry> {
  const width = format === 'sha256' ? 32 : 20
  const entries = new Map<string, Entry>()
  let at = 0
  while (at < raw.length) {
    const space = raw.indexOf(32, at)
    const nul = raw.indexOf(0, space)
    if (space < 0 || nul < 0) throw new Error('malformed tree')
    const mode = raw.subarray(at, space).toString('latin1')
    const name = raw.subarray(space + 1, nul).toString('utf8')
    entries.set(name, { mode, oid: raw.subarray(nul + 1, nul + 1 + width).toString('hex') })
    at = nul + 1 + width
  }
  return entries
}

const parentOf = (path: string) => {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

/** Git's entry order: bytewise, with a tree's name compared as if it ended in `/`. */
const sortKey = (name: string, entry: Entry) => Buffer.from(entry.mode === TREE ? `${name}/` : name)

function serialize(entries: Map<string, Entry>): Buffer {
  const sorted = [...entries].sort(([a, x], [b, y]) => Buffer.compare(sortKey(a, x), sortKey(b, y)))
  return Buffer.concat(
    sorted.map(([name, { mode, oid }]) =>
      Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')])
    )
  )
}

/**
 * The tree id of HEAD (`null` when unborn) with `changes` laid over it. Only the
 * directories on a changed path are read and hashed again; every other subtree keeps
 * HEAD's id. Rejects on a name Git could not round-trip (a newline) or a Git failure.
 */
export async function candidateTree(
  top: string,
  head: string | null,
  changes: readonly TreeChange[]
): Promise<string> {
  const format = await objectFormat(top)
  const kept = changes.filter((change) => !excludedWorktreePath(change.path))
  if (kept.some((change) => change.path.includes('\n')))
    throw new Error('a changed path has a newline')
  const dirs = new Set<string>([''])
  for (const { path } of kept) {
    for (let dir = parentOf(path); dir; dir = parentOf(dir)) dirs.add(dir)
  }
  const order = [...dirs]
  const raw = head
    ? await readTrees(
        top,
        order.map((dir) => `${head}:${dir}`)
      )
    : []
  const trees = new Map<string, Map<string, Entry>>()
  order.forEach((dir, i) => {
    trees.set(dir, raw[i] ? parseTree(raw[i] as Buffer, format) : new Map())
  })
  // Deletions first: a directory replaced by a file (or the reverse) lists both.
  for (const change of kept)
    if (!change.mode) trees.get(parentOf(change.path))?.delete(nameOf(change.path))
  for (const change of kept) {
    if (!change.mode || !change.oid) continue
    // Every ancestor is a tree entry of its parent, even where HEAD had a file there.
    for (let dir = parentOf(change.path); dir; dir = parentOf(dir)) {
      const siblings = trees.get(parentOf(dir)) as Map<string, Entry>
      const current = siblings.get(nameOf(dir))
      if (current?.mode !== TREE) {
        siblings.set(nameOf(dir), { mode: TREE, oid: '' })
        if (current) trees.set(dir, new Map())
      }
    }
    ;(trees.get(parentOf(change.path)) as Map<string, Entry>).set(nameOf(change.path), {
      mode: change.mode,
      oid: change.oid
    })
  }
  const hash = (dir: string): string | null => {
    const entries = trees.get(dir) as Map<string, Entry>
    for (const [name, entry] of [...entries]) {
      if (entry.mode !== TREE || !trees.has(join(dir, name))) continue
      const oid = hash(join(dir, name))
      if (oid) entries.set(name, { mode: TREE, oid })
      else entries.delete(name)
    }
    if (dir && entries.size === 0) return null
    return objectId(format, 'tree', serialize(entries))
  }
  return hash('') as string
}
