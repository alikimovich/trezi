// LKM-175: the native build's Swift binary cache and test profile
// (scripts/native-swift.mjs), without a real compile:
// - profiles: release keeps -O; test is -Onone, no whole-module optimization, -j<cores>;
// - the key covers sorted source names and bytes, flags and toolchain, but not output or
//   module cache paths, so every worktree of the same tree shares one entry;
// - a hit copies an executable binary without running swiftc; a changed source misses;
//   each product keeps its CACHE_ENTRIES most recently used binaries;
// - an unusable cache still compiles; TreziSecrets is always the release build, and the
//   native test runner selects the test profile.
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildProfile,
  CACHE_ENTRIES,
  cacheRoot,
  optimizationFlags,
  productKey,
  prune,
  swiftBuilder
} from '../scripts/native-swift.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-build-cache-')))
try {
  assert.equal(buildProfile({}), 'release')
  assert.equal(buildProfile({ TREZI_BUILD_PROFILE: 'test' }), 'test')
  assert.throws(() => buildProfile({ TREZI_BUILD_PROFILE: 'debug' }), /release or test/)
  assert.deepEqual(optimizationFlags('release', 8), ['-O'], 'the release build is unchanged')
  assert.deepEqual(optimizationFlags('test', 8), ['-Onone', '-no-whole-module-optimization', '-j8'])
  assert.equal(cacheRoot({}, '/Users/someone'), '/Users/someone/Library/Caches/Trezi')
  assert.equal(cacheRoot({ TREZI_BUILD_CACHE: '/elsewhere' }), '/elsewhere')
  assert.equal(cacheRoot({ TREZI_BUILD_CACHE: 'off' }), null)

  // Two worktrees with the same sources.
  const tree = (name) => {
    const root = join(scratch, name)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/A.swift'), 'let a = 1\n')
    writeFileSync(join(root, 'src/B.swift'), 'let b = 2\n')
    return root
  }
  const one = tree('one')
  const two = tree('two')
  const args = (root, extra = []) => [
    '-Onone',
    '-target',
    'arm64-apple-macosx',
    join(root, 'src/A.swift'),
    join(root, 'src/B.swift'),
    '-o',
    join(root, 'bin'),
    '-module-cache-path',
    join(root, 'mc'),
    ...extra
  ]
  const key = (root, list = args(root), toolchain = 'swift 6.3') =>
    productKey({ product: 'Host', args: list, toolchain, root })
  assert.equal(key(one), key(two), 'output and module cache paths are not part of the key')
  const reordered = args(one)
  ;[reordered[3], reordered[4]] = [reordered[4], reordered[3]]
  assert.equal(key(one, reordered), key(one), 'sources are sorted')
  assert.notEqual(key(one, args(one, ['-framework', 'AppKit'])), key(one), 'flags')
  assert.notEqual(key(one, undefined, 'swift 6.4'), key(one), 'toolchain')
  assert.notEqual(
    productKey({ product: 'Service', args: args(one), toolchain: 'swift 6.3', root: one }),
    key(one),
    'product'
  )
  writeFileSync(join(two, 'src/B.swift'), 'let b = 3\n')
  assert.notEqual(key(one), key(two), 'source bytes')
  writeFileSync(join(two, 'src/B.swift'), 'let b = 2\n')

  // Pruning keeps the most recently used entries and fresh partial writes.
  const product = join(scratch, 'prune')
  mkdirSync(product)
  const now = Date.now()
  for (let i = 0; i < CACHE_ENTRIES + 5; i++) {
    const path = join(product, `entry-${String(i).padStart(2, '0')}`)
    writeFileSync(path, 'x')
    const at = new Date(now - (CACHE_ENTRIES + 5 - i) * 60_000)
    utimesSync(path, at, at)
  }
  writeFileSync(join(product, 'old.1.tmp'), '')
  utimesSync(join(product, 'old.1.tmp'), new Date(now - 7_200_000), new Date(now - 7_200_000))
  writeFileSync(join(product, 'fresh.2.tmp'), '')
  prune(product, CACHE_ENTRIES, now)
  const kept = readdirSync(product).sort()
  assert.equal(kept.filter((name) => name.startsWith('entry-')).length, CACHE_ENTRIES)
  assert.ok(
    !kept.includes('entry-00') && kept.includes(`entry-${CACHE_ENTRIES + 4}`),
    'newest kept'
  )
  assert.ok(!kept.includes('old.1.tmp') && kept.includes('fresh.2.tmp'), 'abandoned partials go')

  // The builder: compile once, then a hit in the other worktree without swiftc.
  const cache = join(scratch, 'cache')
  const calls = []
  const run = async (list) => {
    calls.push(list)
    const output = list[list.indexOf('-o') + 1]
    writeFileSync(output, `binary of ${readFileSync(list.find((arg) => arg.endsWith('B.swift')))}`)
    return { code: 0, output: '' }
  }
  const lines = []
  const builder = (root, extra = {}) =>
    swiftBuilder({
      root,
      target: 'arm64-apple-macosx',
      profile: 'test',
      env: { TREZI_BUILD_CACHE: cache },
      log: (line) => lines.push(line),
      toolchain: 'swift 6.3',
      run,
      ...extra
    })
  const sources = (root) => [
    join(root, 'src/A.swift'),
    join(root, 'src/B.swift'),
    '-o',
    join(root, 'bin')
  ]
  const first = await builder(one)('Host', sources(one))
  assert.equal(first.cached, false)
  assert.equal(calls.length, 1)
  assert.ok(
    calls[0].includes('-Onone') && calls[0].includes(join(cache, 'module-cache')),
    'test flags, shared module cache'
  )
  assert.equal(readdirSync(join(cache, 'build/Host')).length, 1, 'one cache entry')
  const second = await builder(two)('Host', sources(two))
  assert.equal(second.cached, true)
  assert.equal(calls.length, 1, 'a hit runs no compiler')
  assert.equal(readFileSync(join(two, 'bin'), 'utf8'), 'binary of let b = 2\n')
  assert.ok(statSync(join(two, 'bin')).mode & 0o100, 'the copy is executable')
  assert.ok(
    lines.some((line) => /^\[build\] Host: [\d.]+ s \(cache hit/.test(line)),
    'timing line'
  )
  // A changed source misses; the release profile is a different entry.
  writeFileSync(join(two, 'src/B.swift'), 'let b = 4\n')
  assert.equal((await builder(two)('Host', sources(two))).cached, false)
  assert.equal(readFileSync(join(two, 'bin'), 'utf8'), 'binary of let b = 4\n')
  await builder(two)('Host', sources(two), { profile: 'release' })
  assert.deepEqual(calls.at(-1).slice(0, 1), ['-O'], 'the release option compiles with -O')
  assert.equal(readdirSync(join(cache, 'build/Host')).length, 3)
  // A failing compile rejects with the compiler's code and caches nothing.
  writeFileSync(join(two, 'src/B.swift'), 'let b = broken\n')
  await assert.rejects(
    builder(two, { run: async () => ({ code: 2, output: 'error\n' }) })('Host', sources(two)),
    (error) => error.code === 2
  )
  assert.equal(readdirSync(join(cache, 'build/Host')).length, 3)
  // A cache that cannot be created still compiles.
  const blocked = join(scratch, 'blocked')
  writeFileSync(blocked, '')
  const fallback = await builder(one, { env: { TREZI_BUILD_CACHE: blocked } })('Host', sources(one))
  assert.equal(fallback.cached, false)
  assert.ok(lines.some((line) => /Swift cache unavailable/.test(line)))
  assert.ok(
    calls.at(-1).includes(join(one, 'out/native/module-cache')),
    'module cache falls back to out/native'
  )
  assert.ok(!existsSync(join(blocked, 'build')))

  // Wiring: Secrets stays release; the native test runner selects the test profile.
  const read = (path) => readFileSync(join(repo, path), 'utf8')
  const build = read('scripts/build-native.mjs')
  assert.match(build, /compile\('TreziSecrets', \[[\s\S]*?\], \{ profile: 'release' \}\)/)
  assert.match(
    build,
    /Promise\.allSettled\(\[bundles, service, host, secrets\]\)/,
    'steps run in parallel'
  )
  assert.doesNotMatch(build, /'-O'|-enable-batch-mode/, 'flags come from the profile')
  assert.match(
    read('scripts/dev-native.mjs'),
    /TREZI_BUILD_PROFILE: process\.env\.TREZI_BUILD_PROFILE \|\| 'test'/
  )
  assert.match(
    read('test/native-runtime.mjs'),
    /TREZI_BUILD_PROFILE: process\.env\.TREZI_BUILD_PROFILE \|\| 'test'/
  )
  assert.match(
    JSON.parse(read('package.json')).scripts['test:native'],
    /^TREZI_BUILD_PROFILE=test /
  )
  assert.doesNotMatch(JSON.parse(read('package.json')).scripts.build, /TREZI_BUILD_PROFILE/)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(
  'NATIVE-BUILD-CACHE OK — release keeps -O, test is -Onone/-j; keys ignore output paths and cover sources, flags and toolchain; hits skip swiftc; pruning keeps 20; an unusable cache still compiles'
)
