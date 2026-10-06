// Swift compiles for scripts/build-native.mjs (LKM-175).
//
// - Binary cache: each product is keyed by its sorted source names and bytes, its flags
//   (optimization, target, frameworks), `swiftc --version` and the SDK version. A hit
//   copies the unsigned binary instead of compiling; signing still runs afterwards. The
//   cache sits outside the worktree, so a fresh worktree whose Swift is unchanged
//   compiles nothing: ~/Library/Caches/Trezi/build/<product>/<hash>, the last
//   CACHE_ENTRIES per product.
// - Module cache: ~/Library/Caches/Trezi/module-cache, shared by every worktree, so the
//   AppKit/SwiftUI Clang modules are built once rather than per checkout.
// - Profiles: `release` (default, `bun run build`) compiles with -O as before;
//   `test` (TREZI_BUILD_PROFILE=test, set by the native test runner) compiles with
//   -Onone, without whole-module optimization, one frontend per file across every core.
// TREZI_BUILD_CACHE=<dir> moves both caches; TREZI_BUILD_CACHE=off compiles every
// product and keeps the module cache in out/native, as before.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync
} from 'node:fs'
import { availableParallelism, homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'

export const CACHE_ENTRIES = 20
const PROFILES = ['release', 'test']

/** The build profile: `release` unless TREZI_BUILD_PROFILE says `test`. */
export function buildProfile(env = process.env) {
  const value = env.TREZI_BUILD_PROFILE?.trim() || 'release'
  if (!PROFILES.includes(value))
    throw new Error(`TREZI_BUILD_PROFILE must be ${PROFILES.join(' or ')}, not "${value}"`)
  return value
}

/** swiftc optimization flags of a profile. The release flags are the pre-LKM-175 ones.
 *  The test profile runs one frontend per file on every core. No -enable-batch-mode:
 *  with Swift 6.3 its frontends exit without writing their objects and the link fails. */
export function optimizationFlags(profile, cores = availableParallelism()) {
  return profile === 'test' ? ['-Onone', '-no-whole-module-optimization', `-j${cores}`] : ['-O']
}

/** The cache folder, or null when TREZI_BUILD_CACHE turns it off. */
export function cacheRoot(env = process.env, home = homedir()) {
  const value = env.TREZI_BUILD_CACHE?.trim()
  if (value === 'off' || value === '0') return null
  return value || join(home, 'Library/Caches/Trezi')
}

/** What identifies the toolchain in a key: compiler version and SDK version/build. */
export function toolchainKey(run = spawnSync) {
  const text = (args) => {
    const result = run('xcrun', args, { encoding: 'utf8' })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  }
  return [
    text(['swiftc', '--version']),
    text(['--show-sdk-version']),
    text(['--show-sdk-build-version'])
  ].join('\n')
}

/** A source's name in the key: its path in the checkout (so every worktree agrees), or
 *  its file name outside it. */
const sourceName = (root, path) => {
  const rel = relative(root, path)
  return rel.startsWith('..') || isAbsolute(rel) ? basename(path) : rel
}

/** The cache key of one product: swiftc `args` without output and module cache paths,
 *  the sorted sources with their bytes, and the toolchain. */
export function productKey({ product, args, toolchain, root, read = readFileSync }) {
  const hash = createHash('sha256').update(`trezi-swift-1\0${product}\0${toolchain}\0`)
  const sources = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '-module-cache-path') i++
    else if (args[i].endsWith('.swift')) sources.push([sourceName(root, args[i]), args[i]])
    else hash.update(`arg:${args[i]}\0`)
  }
  sources.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [name, path] of sources) hash.update(`file:${name}\0`).update(read(path)).update('\0')
  return hash.digest('hex').slice(0, 32)
}

/** Keeps the `keep` most recently used binaries of one product's folder (a hit touches
 *  its entry) and removes abandoned partial writes. */
export function prune(dir, keep = CACHE_ENTRIES, now = Date.now()) {
  const entries = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path, { throwIfNoEntry: false })
    if (!stat) continue
    if (name.endsWith('.tmp')) {
      if (now - stat.mtimeMs > 3_600_000) rmSync(path, { force: true })
    } else entries.push({ path, used: stat.mtimeMs })
  }
  entries.sort((a, b) => b.used - a.used)
  for (const { path } of entries.slice(keep)) rmSync(path, { force: true })
}

const seconds = (since) => `${((performance.now() - since) / 1000).toFixed(1)} s`

/** One swiftc run. Its intermediate objects go to a private `temp` folder in the build
 *  output, apart from the parallel compiles and every other process's temporary files. */
function swiftc(args, temp) {
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  return new Promise((resolve) => {
    const child = spawn('xcrun', ['swiftc', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: `${temp}/` }
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', (error) => resolve({ code: 1, output: `${output}${error.message}\n` }))
    child.on('close', (code, signal) => {
      rmSync(temp, { recursive: true, force: true })
      resolve({ code: code ?? 1, signal, output })
    })
  })
}

/**
 * Returns `compile(product, args, { profile })`, which builds one Swift product (`args`
 * are its sources, frameworks, other flags and `-o <output>`) from the binary cache or
 * with swiftc, and resolves to `{ product, cached, seconds }`. It rejects with the
 * compiler's exit code on failure. Compiles run in parallel; each prints its compiler
 * output in one block when it ends, then one timing line. `toolchain` and `run` (the
 * swiftc runner) are replaced only by tests.
 */
export function swiftBuilder({
  root,
  target,
  profile,
  env = process.env,
  log = console.log,
  toolchain = toolchainKey(),
  run = swiftc
}) {
  const cache = cacheRoot(env)
  let binaries = null
  let moduleCache = join(root, 'out/native/module-cache')
  if (cache)
    try {
      mkdirSync(join(cache, 'build'), { recursive: true })
      mkdirSync(join(cache, 'module-cache'), { recursive: true })
      binaries = join(cache, 'build')
      moduleCache = join(cache, 'module-cache')
    } catch (error) {
      log(`[build] Swift cache unavailable at ${cache} (${error.code ?? error.message}); compiling without it`)
    }
  return async function compile(product, args, options = {}) {
    const started = performance.now()
    const chosen = options.profile ?? profile
    const flags = [...optimizationFlags(chosen), '-target', target, ...args]
    const output = args[args.indexOf('-o') + 1]
    const key = productKey({ product, args: flags, toolchain, root })
    const dir = binaries && join(binaries, product)
    const entry = dir && join(dir, key)
    if (entry && existsSync(entry))
      try {
        // A new file, never bytes over a binary the kernel may have cached a signature for.
        rmSync(output, { force: true })
        copyFileSync(entry, output)
        chmodSync(output, 0o755)
        const now = new Date()
        utimesSync(entry, now, now)
        log(`[build] ${product}: ${seconds(started)} (cache hit ${key.slice(0, 12)}, ${chosen})`)
        return { product, cached: true, seconds: (performance.now() - started) / 1000 }
      } catch (error) {
        log(`[build] ${product}: cache entry unreadable (${error.code ?? error.message}); compiling`)
      }
    const result = await run(
      [...flags, '-module-cache-path', moduleCache],
      join(root, 'out/native/swift-tmp', product)
    )
    if (result.output) process.stderr.write(result.output.endsWith('\n') ? result.output : `${result.output}\n`)
    if (result.code !== 0 || result.signal) {
      log(`[build] ${product}: swiftc failed after ${seconds(started)}`)
      throw Object.assign(new Error(`swiftc ${product} failed`), { code: result.code || 1 })
    }
    if (dir)
      try {
        mkdirSync(dir, { recursive: true })
        const partial = `${entry}.${process.pid}.tmp`
        copyFileSync(output, partial)
        renameSync(partial, entry)
        prune(dir)
      } catch (error) {
        log(`[build] ${product}: not cached (${error.code ?? error.message})`)
      }
    log(`[build] ${product}: ${seconds(started)} (compiled ${chosen} ${optimizationFlags(chosen)[0]})`)
    return { product, cached: false, seconds: (performance.now() - started) / 1000 }
  }
}
