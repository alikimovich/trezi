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
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  lockfilesToRestore,
  runStep,
  stepExitStatus,
  tailLines,
  updateOptions
} from '../bin/trezi.mjs'
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

// --- LKM-596: `trezi --update` options, failure status and its private log ---
eq(updateOptions([]), { verbose: false }, 'update is concise by default')
eq(updateOptions(['--verbose']), { verbose: true }, '--verbose shows full output')
eq(
  updateOptions(['--no-launch', '--verbose']),
  { verbose: true },
  'legacy --no-launch is accepted and ignored'
)
for (const bad of ['-v', '--quiet', 'now'])
  assert(
    (() => {
      try {
        updateOptions([bad])
        return false
      } catch (error) {
        return /Unknown option for trezi --update/.test(error.message)
      }
    })(),
    `update refuses ${bad}`
  )
eq(stepExitStatus({ code: 3, signal: null }), 3, 'a failed step keeps its exit code')
eq(stepExitStatus({ code: null, signal: 'SIGTERM' }), 143, 'a signalled step exits 128 + signal')
eq(stepExitStatus({ code: null, signal: null }), 1, 'an unknown failure exits 1')

const scratch = mkdtempSync(join(tmpdir(), 'trezi-cli-'))
try {
  const logPath = join(scratch, 'update.log')
  const log = { path: logPath, fd: openSync(logPath, 'w') }
  // Large, mixed stdout/stderr output streams to the log, nothing is shown, the status is real.
  const script =
    "for (let i = 0; i < 200000; i++) process.stdout.write('stdout line ' + i + ' ' + 'x'.repeat(60) + '\\n');" +
    "process.stderr.write('stderr: compiler warning\\n'); process.exit(7)"
  const big = await runStep(process.execPath, ['-e', script], { cwd: scratch, log, verbose: false })
  closeSync(log.fd)
  eq([big.code, big.signal], [7, null], 'runStep resolves with the real exit code')
  const text = readFileSync(logPath, 'utf8')
  assert(statSync(logPath).size > 14_000_000, 'the whole large output reaches the log')
  assert(
    text.includes('stdout line 199999') && text.includes('stderr: compiler warning'),
    'stdout and stderr are logged'
  )
  assert(text.endsWith('==> exit 7\n'), 'the log records the exit')
  eq(
    tailLines(logPath, 2),
    ['stderr: compiler warning', '==> exit 7'],
    'tailLines reads the end of the log'
  )
  const killed = await runStep('/bin/sh', ['-c', 'kill -TERM $$'], {
    cwd: scratch,
    log: null,
    verbose: false
  })
  eq([killed.code, killed.signal], [null, 'SIGTERM'], 'runStep reports a signal')
  const missing = await runStep(join(scratch, 'no-such-tool'), [], {
    cwd: scratch,
    log: null,
    verbose: false
  })
  assert(missing.error?.code === 'ENOENT', 'runStep reports a missing tool')
  writeFileSync(join(scratch, 'short.log'), 'one\ntwo\n\n')
  eq(tailLines(join(scratch, 'short.log')), ['one', 'two'], 'tailLines drops trailing blank lines')
  eq(tailLines(join(scratch, 'absent.log')), [], 'tailLines of a missing log is empty')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const cli = join(repoRoot, 'bin/trezi')
const help = spawnSync(cli, ['--help'], { encoding: 'utf8' })
assert(help.status === 0, 'CLI help exits successfully')
for (const text of ['trezi <folder>', 'trezi .', '--update', '--verbose', '--version'])
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
  'TREZI-CLI OK — lockfilesToRestore picks dirty tracked lockfiles; update options, step status and streamed log; bin/trezi help, version and refusals'
)
