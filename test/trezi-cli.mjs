/**
 * trezi CLI — the lockfile-drift helper that keeps `trezi --update` (bin/trezi.mjs)
 * from aborting on a dirty, install-generated lockfile, and the shell command's
 * (bin/trezi) help, version and refusals. Opening the app is covered, through a
 * recorded `open`, by test/install-update.mjs. Importing bin/trezi.mjs must NOT
 * run the CLI — `main()` is guarded by invokedAsScript().
 *
 * Run with: bun test/trezi-cli.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockfilesToRestore } from '../bin/trezi.mjs'
import { buildInfo, versionLabel } from '../scripts/version.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (a, b, msg) =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`)

// --- the real-world case: bun install left bun.lock modified (unstaged) ---
eq(lockfilesToRestore(' M bun.lock\n'), ['bun.lock'], 'unstaged bun.lock is restored')
eq(lockfilesToRestore('M  bun.lock\n'), ['bun.lock'], 'staged bun.lock is restored')
eq(lockfilesToRestore('MM bun.lock\n'), ['bun.lock'], 'staged+unstaged bun.lock is restored')

// --- other package managers' lockfiles ---
eq(
  lockfilesToRestore(' M package-lock.json\n M yarn.lock\n M pnpm-lock.yaml\n M bun.lockb\n'),
  ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'],
  'all supported lockfiles are restored'
)

// --- untracked lockfiles have no HEAD version to restore ---
eq(lockfilesToRestore('?? bun.lock\n'), [], 'untracked bun.lock is left alone')

// --- non-lockfile edits are never touched (only lockfiles get discarded) ---
eq(lockfilesToRestore(' M src/main/agent.ts\n'), [], 'source edits are not restored')
eq(
  lockfilesToRestore(' M src/main/agent.ts\n M bun.lock\n'),
  ['bun.lock'],
  'only the lockfile is picked out from a mixed dirty tree'
)

// --- a path merely containing a lockfile name (not exact) is not matched ---
eq(lockfilesToRestore(' M vendor/bun.lock.bak\n'), [], 'non-exact lockfile path is ignored')

// --- clean tree / empty & junk input ---
eq(lockfilesToRestore(''), [], 'empty porcelain → nothing to restore')
eq(lockfilesToRestore('\n\n'), [], 'blank lines → nothing to restore')

const cli = join(repoRoot, 'bin/trezi')
const help = spawnSync(cli, ['--help'], { encoding: 'utf8' })
assert(help.status === 0, 'CLI help exits successfully')
for (const text of ['trezi <folder>', 'trezi .', '--update', '--version'])
  assert(help.stdout.includes(text), `CLI help documents ${text}`)
assert(!help.stdout.includes('--remote'), 'CLI no longer advertises retired remote mode')
const version = spawnSync(cli, ['--version'], { encoding: 'utf8' })
// LKM-143: the built app's stamp when there is one, else the checkout's; Settings shows the same label.
const builtPlist = join(repoRoot, 'out/native/Trezi.app/Contents/Info.plist')
const stamp = (key) =>
  spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', builtPlist], { encoding: 'utf8' })
const expectedVersion =
  existsSync(builtPlist) && stamp('TreziCommit').status === 0
    ? versionLabel({
        version: stamp('CFBundleShortVersionString').stdout.trim(),
        build: stamp('CFBundleVersion').stdout.trim(),
        commit: stamp('TreziCommit').stdout.trim()
      })
    : versionLabel(buildInfo(repoRoot))
eq(version.stdout.trim(), expectedVersion, 'CLI prints "Trezi X.Y.Z (build N, sha)"')
assert(
  /^Trezi \d+\.\d+\.\d+\S* \(build \d+, [0-9a-f]{7,}\)$/.test(version.stdout.trim()),
  `CLI version label format: ${version.stdout}`
)
const retired = spawnSync(cli, ['serve', '/tmp'], { encoding: 'utf8' })
assert(
  retired.status === 1 && retired.stderr.includes('retired'),
  'retired browser mode fails with migration guidance'
)
const unknown = spawnSync(cli, ['--remote'], { encoding: 'utf8' })
assert(
  unknown.status === 1 && unknown.stderr.includes('Unknown option'),
  'unknown options are refused'
)
// An install whose `trezi` link still points at bin/trezi.mjs reaches the same command.
const delegated = spawnSync(process.execPath, [join(repoRoot, 'bin/trezi.mjs'), '--version'], {
  encoding: 'utf8'
})
eq(delegated.stdout, version.stdout, 'bin/trezi.mjs hands launch arguments to bin/trezi')

if (failed) {
  console.error(`TREZI-CLI FAILED — ${failed} assertion(s)`)
  process.exit(1)
}
console.log(
  'TREZI-CLI OK — lockfilesToRestore picks dirty tracked lockfiles; bin/trezi help, version and refusals'
)
