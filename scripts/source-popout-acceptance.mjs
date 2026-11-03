/**
 * LKM-456: LKM-444's `fullscreen-popout-close-native` live check (docs/TESTING.md, "Pop-out
 * full-screen close acceptance"). Builds this exact, clean checkout and launches a disposable
 * test Trezi (`--test`: its own profile, preferences, data, logs and synthetic project in a temp
 * folder that start-native removes) that runs only the smoke prelude and the check. The evidence
 * is copied into a new folder named by SHA, mode and start time, and made read-only.
 *
 *   bun run acceptance:source-popout                         GREEN: must pass on the shipping code
 *   bun run acceptance:source-popout --red=legacy-order-out  RED: must strand the full-screen Space
 *
 * A desktop suite: start it only while holding the manager's shared desktop lock. It takes this
 * checkout's runner lock (test/artifacts/runs/.runner-lock) and refuses to start beside another
 * test Trezi, a dirty tree or a non-foreground run. Input is posted to the app's own event
 * queue: no Accessibility or Input Monitoring grant is asked for and no system setting changes.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseSmokeGroups,
  SOURCE_POPOUT_ACCEPTANCE_CHECK,
  SOURCE_POPOUT_ACCEPTANCE_FLAG,
  smokeLauncherTimeoutMs
} from '../src/native/smoke-groups.ts'
import {
  evidenceFolder,
  redMet,
  SOURCE_POPOUT_RED_MODES,
  SOURCE_POPOUT_RED_STEP
} from '../src/native/source-popout-acceptance.ts'
import { acquireRunLock } from '../test/helpers/test-runner.mjs'

const cwd = fileURLToPath(new URL('../', import.meta.url))
const stop = (message) => {
  console.error(`SOURCE POP-OUT ACCEPTANCE: ${message}`)
  process.exit(2)
}
let red = ''
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--red=')) red = arg.slice('--red='.length)
  else
    stop(`unknown argument ${arg}; the only option is --red=${SOURCE_POPOUT_RED_MODES.join('|')}`)
}
if (red && !SOURCE_POPOUT_RED_MODES.includes(red)) stop(`unknown RED mode ${red}`)
if (process.platform !== 'darwin') stop('the native host needs macOS')
if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1')
  stop('the check needs the foreground; unset TREZI_NATIVE_BACKGROUND_TEST')
const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const head = git('rev-parse', 'HEAD')
if (head.status !== 0) stop('not a Git checkout: the evidence needs an exact source SHA')
const source = {
  sha: head.stdout.trim(),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(),
  status: git('status', '--porcelain').stdout.trim()
}
if (source.status)
  stop(
    `the tree has uncommitted changes, so the build would not be ${source.sha}:\n${source.status}`
  )
if (spawnSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status !== 0)
  stop('the Xcode command-line tools are not installed')
// A test Trezi's host runs as `TreziHost <out> ephemeral …` (scripts/start-native.mjs).
const ps = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
if (ps.status !== 0) stop('cannot list processes to rule out a competing native run')
const competing = ps.stdout.split('\n').filter((line) => /\/TreziHost \S+ ephemeral /.test(line))
if (competing.length) stop(`another test Trezi is running; wait for it:\n${competing.join('\n')}`)

const runs = join(cwd, 'test/artifacts/runs')
mkdirSync(runs, { recursive: true })
let release
try {
  release = acquireRunLock(join(runs, '.runner-lock'))
} catch (error) {
  stop(error.message)
}
process.once('exit', release)

const mode = red ? `red-${red}` : 'green'
const live = join(cwd, 'test/artifacts/native/source-popout-acceptance')
rmSync(live, { recursive: true, force: true })
const smoke = ['--test', '--only=core', SOURCE_POPOUT_ACCEPTANCE_FLAG]
// About thirty full-screen transitions plus a capture per case: 120 s beyond a core run's limit.
const timeout = smokeLauncherTimeoutMs(parseSmokeGroups(smoke), 120_000)
const started = Date.now()
const startedAt = new Date(started).toISOString()
console.log(`SOURCE POP-OUT ACCEPTANCE (${red ? `RED ${red}` : 'GREEN'}) on ${source.sha}`)
const result = spawnSync('bun', ['run', 'dev:native', ...smoke], {
  cwd,
  stdio: 'inherit',
  timeout,
  env: {
    ...process.env,
    TREZI_NATIVE_SMOKE_DEADLINE_MS: String(started + timeout),
    TREZI_BUILD_PROFILE: process.env.TREZI_BUILD_PROFILE || 'test',
    // No simulated focus loss: every step of this check is a foreground one.
    TREZI_NATIVE_SMOKE_STEAL_FOCUS: '',
    TREZI_SOURCE_POPOUT_ACCEPTANCE_RED: red
  }
})

const read = (name) => {
  try {
    return JSON.parse(readFileSync(join(live, name), 'utf8'))
  } catch {
    return null
  }
}
const evidence = read('evidence.json')
const cleanup = read('cleanup.json')
const fresh = !!evidence && Date.parse(evidence.startedAt) >= started
// Provenance: the app that ran was built from this commit, with no local changes.
const built = fresh ? evidence.build : null
const provenance = !!built && built.sha === source.sha && built.dirty === false
const passed = result.status === 0 && fresh && evidence.outcome === 'pass'
const cleaned = cleanup?.clean === true
const met =
  provenance && cleaned && (red ? !passed && redMet(evidence.failure, evidence.stranded) : passed)
const run = {
  ticket: 'LKM-444',
  fixture: 'LKM-456',
  check: SOURCE_POPOUT_ACCEPTANCE_CHECK,
  mode,
  expected: red
    ? `fail at ${SOURCE_POPOUT_RED_STEP} with the pop-out off screen and still in full screen`
    : 'pass',
  met,
  source,
  build: built,
  provenance,
  cleaned,
  command: `bun run acceptance:source-popout${red ? ` --red=${red}` : ''}`,
  launcher: `bun run dev:native ${smoke.join(' ')}`,
  input: fresh ? evidence.input : null,
  exitCode: result.status,
  signal: result.signal,
  timedOut: result.error?.code === 'ETIMEDOUT',
  startedAt,
  finishedAt: new Date().toISOString(),
  failure: fresh ? (evidence.failure ?? null) : 'the check wrote no fresh evidence.json',
  captures: fresh ? evidence.captures : []
}

// Kept: a new folder per run, never overwritten, files read-only.
const kept = join(
  cwd,
  'test/artifacts/native/fullscreen-popout-close',
  evidenceFolder(source.sha, mode, startedAt)
)
if (existsSync(kept)) stop(`evidence folder already exists: ${kept}`)
mkdirSync(join(kept, '..'), { recursive: true })
if (existsSync(live)) cpSync(live, kept, { recursive: true, errorOnExist: true, force: false })
else mkdirSync(kept)
writeFileSync(join(kept, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' })
for (const file of readdirSync(kept)) chmodSync(join(kept, file), 0o444)
chmodSync(kept, 0o555)
console.log(
  `SOURCE POP-OUT ACCEPTANCE ${met ? 'MET' : 'NOT MET'} (${mode}) on ${source.sha}: evidence in ${kept}${run.failure ? `; failure: ${run.failure}` : ''}${provenance ? '' : '; the build is not this exact commit'}${cleaned ? '' : '; cleanup did not leave a clean state'}`
)
process.exit(met ? 0 : 1)
