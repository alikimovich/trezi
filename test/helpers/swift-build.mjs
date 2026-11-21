// One Swift build cache for every unit test fixture (LKM-167). A compile with a cold
// Clang module cache spends ~25 s rebuilding Foundation/AppKit modules; with the shared
// module cache below it takes a few seconds, and an unchanged fixture is not rebuilt
// at all: binaries are cached by toolchain, flags and source contents. At most
// SWIFT_SLOTS compiles run at once across all test processes (the swiftc lane), so
// parallel test workers never stack up compiles. Cache: `$TREZI_TEST_CACHE/swift`, else
// one shared folder for every linked Git worktree (`cacheBase`), else
// `.local/test-cache/swift`; delete it any time.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** The folder that holds `swift/`. `TREZI_TEST_CACHE` wins. A linked Git worktree (its
 *  `.git` is a file: every Forge check, every agent worktree) uses one per-user folder,
 *  so a fresh worktree starts warm (LKM-776: a cold worktree spent its whole Forge check
 *  waiting on ~80 fixture compiles in the two swiftc slots). The key is the toolchain,
 *  flags and every source's repo path and bytes, so worktrees on different commits
 *  share only identical builds. A normal clone (the main checkout, CI) keeps
 *  `.local/test-cache`, which CI caches. */
export function cacheBase({ env = process.env, dir = root, home = homedir() } = {}) {
  if (env.TREZI_TEST_CACHE) return env.TREZI_TEST_CACHE
  if (statSync(join(dir, '.git'), { throwIfNoEntry: false })?.isFile())
    return process.platform === 'darwin'
      ? join(home, 'Library/Caches/trezi-unit-tests')
      : join(home, '.cache/trezi-unit-tests')
  return join(dir, '.local/test-cache')
}
export const SWIFT_CACHE = join(cacheBase(), 'swift')
// Product caches the swift-preview tests hand to Trezi's own code (scanner tools, the
// toolchain probe, preview derived data). Those rebuild a folder in place, so they stay
// in this checkout and are never shared by two concurrent worktrees.
export const LOCAL_SWIFT_CACHE = join(
  process.env.TREZI_TEST_CACHE || join(root, '.local/test-cache'),
  'swift'
)
// A new build of a name removes that name's other builds once unused this long. Every
// hit refreshes the binary's mtime; with one cache shared by concurrent worktrees, an
// immediate prune could delete a binary another check is about to run.
export const STALE_MS = 24 * 60 * 60 * 1000

/** Removes `name`'s cached builds in `dir` other than `keep` that were last used (mtime)
 *  more than `maxAgeMs` before `now`. */
export function pruneBuilds(dir, name, keep, { now = Date.now(), maxAgeMs = STALE_MS } = {}) {
  const stem = new RegExp(`^${name}-[0-9a-f]{24}$`)
  for (const entry of readdirSync(dir)) {
    if (!stem.test(entry) || entry === keep) continue
    const mtime = statSync(join(dir, entry), { throwIfNoEntry: false })?.mtimeMs
    if (mtime !== undefined && now - mtime > maxAgeMs) rmSync(join(dir, entry), { force: true })
  }
}
export const MODULE_CACHE = join(SWIFT_CACHE, 'module-cache')
export const SWIFT_SLOTS = 2
// Absolute: some suites put a scripted `xcrun` first on PATH.
const xcrun = '/usr/bin/xcrun'
const compiler = process.platform === 'darwin' ? [xcrun, 'swiftc'] : ['swiftc']

let toolchain
function toolchainKey() {
  if (toolchain === undefined) {
    const version = spawnSync(compiler[0], [...compiler.slice(1), '--version'], {
      encoding: 'utf8'
    })
    const sdk =
      process.platform === 'darwin'
        ? spawnSync(xcrun, ['--show-sdk-path'], { encoding: 'utf8' }).stdout
        : ''
    toolchain = `${version.stdout}${version.stderr}${sdk}`
  }
  return toolchain
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

/** Creates the lock file `path` with this pid and returns its release, or null while a
 *  live process holds it (a dead owner's lock is removed for the next try). */
function tryLock(path) {
  try {
    const fd = openSync(path, 'wx')
    writeFileSync(fd, `${process.pid}\n`)
    closeSync(fd)
    return () => rmSync(path, { force: true })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner = 0
    try {
      owner = Number(readFileSync(path, 'utf8'))
    } catch {}
    // An empty file is a lock being written right now, unless it is old.
    const stale = owner
      ? !alive(owner)
      : Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 5_000
    if (stale) rmSync(path, { force: true })
    return null
  }
}

/** Takes one of SWIFT_SLOTS lock files; a slot whose owner died is taken over. */
function acquireSlot() {
  const slots = join(SWIFT_CACHE, 'slots')
  mkdirSync(slots, { recursive: true })
  for (;;) {
    for (let i = 0; i < SWIFT_SLOTS; i++) {
      const release = tryLock(join(slots, `slot-${i}`))
      if (release) return release
    }
    pause(100)
  }
}

/** One uncached swiftc run in the swiftc lane with the shared module cache, for a test
 *  that must really rebuild (keychain-rebuild). Returns spawnSync's result. */
export function swiftCompile(args, output, { cwd = root, timeout = 400_000 } = {}) {
  mkdirSync(SWIFT_CACHE, { recursive: true })
  const release = acquireSlot()
  try {
    return spawnSync(
      compiler[0],
      [...compiler.slice(1), '-module-cache-path', MODULE_CACHE, ...args, '-o', output],
      { cwd, encoding: 'utf8', timeout }
    )
  } finally {
    release()
  }
}

/** The macOS platform's compiler plugins (SwiftUIMacros, which expands `@State`). The
 *  swiftc driver passes this folder to the frontend; a bare `-frontend` run does not. */
let platformPlugins
function platformPluginArgs() {
  if (platformPlugins === undefined) {
    const platform =
      process.platform === 'darwin'
        ? spawnSync(xcrun, ['--show-sdk-platform-path'], { encoding: 'utf8' }).stdout.trim()
        : ''
    const dir = platform ? join(platform, 'Developer/usr/lib/swift/host/plugins') : ''
    platformPlugins = dir && existsSync(dir) ? ['-plugin-path', dir] : []
  }
  return platformPlugins
}

/** One uncached `swiftc -frontend` run in the swiftc lane with the shared module cache,
 *  for a test that reads a compile's diagnostics. Returns spawnSync's result. */
export function swiftFrontend(args, { cwd = root, timeout = 400_000 } = {}) {
  mkdirSync(SWIFT_CACHE, { recursive: true })
  const release = acquireSlot()
  try {
    return spawnSync(
      compiler[0],
      [
        ...compiler.slice(1),
        '-frontend',
        ...platformPluginArgs(),
        ...args,
        '-module-cache-path',
        MODULE_CACHE
      ],
      { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }
    )
  } finally {
    release()
  }
}

/** The key part of one argument: a file's repo path (or name) and bytes, else the flag. */
function keyPart(arg, cwd) {
  const path = resolve(cwd, arg)
  if (!arg.startsWith('-') && existsSync(path) && statSync(path).isFile()) {
    const rel = relative(root, path)
    const name = rel.startsWith('..') || isAbsolute(rel) ? basename(path) : rel
    return [`file:${name}`, readFileSync(path)]
  }
  return [`arg:${arg}`]
}

/** The cache path `swiftBuild` uses for these arguments. */
export function swiftBinary(name, args, { cwd = root } = {}) {
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/, 'swiftBuild name')
  const key = createHash('sha256').update(toolchainKey())
  for (const arg of args) for (const part of keyPart(arg, cwd)) key.update(part).update('\0')
  return join(SWIFT_CACHE, `${name}-${key.digest('hex').slice(0, 24)}`)
}

/** Compiles `args` (sources and flags; relative paths from `cwd`, the repo by default)
 *  once per toolchain, flags and source contents and returns the cached binary. With
 *  `out`, copies it there and returns `out` (for a binary that is signed, bundled or
 *  must not be replaced while it runs). `name` must be unique per distinct build: a
 *  new build of a name prunes that name's builds unused for a day (pruneBuilds). */
export function swiftBuild(name, args, { out, cwd = root, timeout = 400_000 } = {}) {
  const binary = swiftBinary(name, args, { cwd })
  mkdirSync(SWIFT_CACHE, { recursive: true })
  // One process builds a binary; others that need it wait for that build instead of
  // compiling it again in the second swiftc slot (LOCAL-TEST-CLEANUP-V2: with four
  // workers asking for the shared skills fixture at once, two spent compile-sized CPU,
  // an estimate from per-process CPU). If the builder fails or dies, the next waiter
  // builds.
  let unlock = null
  while (!existsSync(binary) && !unlock) {
    unlock = tryLock(`${binary}.lock`)
    if (!unlock) pause(100)
  }
  if (unlock) {
    let release = () => {}
    try {
      release = acquireSlot()
      // Another worker may have built it before this one took the build lock.
      if (!existsSync(binary)) {
        const building = `${binary}.${process.pid}.tmp`
        const result = spawnSync(
          compiler[0],
          [...compiler.slice(1), '-module-cache-path', MODULE_CACHE, ...args, '-o', building],
          { cwd, encoding: 'utf8', timeout }
        )
        if (result.status !== 0) rmSync(building, { force: true })
        assert.equal(
          result.status,
          0,
          `swiftc: ${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`
        )
        renameSync(building, binary)
        pruneBuilds(SWIFT_CACHE, name, basename(binary))
      }
    } finally {
      release()
      unlock()
    }
  }
  // Mark it used, so a prune elsewhere keeps it (pruneBuilds).
  const now = new Date()
  utimesSync(binary, now, now)
  if (!out) return binary
  copyFileSync(binary, out)
  return out
}

/** Runs a built fixture from the repo root; asserts exit 0 and returns its stdout. */
export function runFixture(binary, args = [], { timeout = 180_000 } = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', timeout })
  assert.equal(
    result.status,
    0,
    `${binary}: ${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`
  )
  return result.stdout
}
