// One Swift build cache for every unit test fixture (LKM-167). A compile with a cold
// Clang module cache spends ~25 s rebuilding Foundation/AppKit modules; with the shared
// module cache below it takes a few seconds, and an unchanged fixture is not rebuilt
// at all: binaries are cached by toolchain, flags and source contents. At most
// SWIFT_SLOTS compiles run at once across all test processes (the swiftc lane), so
// parallel test workers never stack up compiles. Cache: `.local/test-cache/swift`
// (or `$TREZI_TEST_CACHE/swift`); delete it any time.
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
  writeFileSync
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
export const SWIFT_CACHE = join(
  process.env.TREZI_TEST_CACHE || join(root, '.local/test-cache'),
  'swift'
)
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

/** Takes one of SWIFT_SLOTS lock files; a slot whose owner died is taken over. */
function acquireSlot() {
  const slots = join(SWIFT_CACHE, 'slots')
  mkdirSync(slots, { recursive: true })
  for (;;) {
    for (let i = 0; i < SWIFT_SLOTS; i++) {
      const path = join(slots, `slot-${i}`)
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
        // An empty file is a slot being written right now, unless it is old.
        const stale = owner
          ? !alive(owner)
          : Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 5_000
        if (stale) rmSync(path, { force: true })
      }
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

/** Compiles `args` (sources and flags; relative paths from `cwd`, the repo by default)
 *  once per toolchain, flags and source contents and returns the cached binary. With
 *  `out`, copies it there and returns `out` (for a binary that is signed, bundled or
 *  must not be replaced while it runs). `name` must be unique per distinct build: a
 *  new build of a name prunes that name's older binaries. */
export function swiftBuild(name, args, { out, cwd = root, timeout = 400_000 } = {}) {
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/, 'swiftBuild name')
  const key = createHash('sha256').update(toolchainKey())
  for (const arg of args) for (const part of keyPart(arg, cwd)) key.update(part).update('\0')
  const binary = join(SWIFT_CACHE, `${name}-${key.digest('hex').slice(0, 24)}`)
  mkdirSync(SWIFT_CACHE, { recursive: true })
  if (!existsSync(binary)) {
    const release = acquireSlot()
    try {
      // Another worker may have built it while this one waited for a slot.
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
        const stem = new RegExp(`^${name}-[0-9a-f]{24}$`)
        for (const entry of readdirSync(SWIFT_CACHE))
          if (stem.test(entry) && entry !== basename(binary))
            rmSync(join(SWIFT_CACHE, entry), { force: true })
      }
    } finally {
      release()
    }
  }
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
