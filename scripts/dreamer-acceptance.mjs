/**
 * LKM-447: the opt-in Dreamer acceptance (docs/DREAMER.md "Acceptance on the shipping code").
 * Builds and launches a disposable test Trezi (`--test`: its own profile, preferences, data
 * and logs in a temp folder that start-native removes) that runs only the smoke prelude
 * and `dreamer-export-primary`, then records the source, the outcome and the evidence.
 *
 *   bun run acceptance:dreamer                        GREEN: must pass on the shipping code
 *   bun run acceptance:dreamer --red=stub-save-panel  RED: must fail at the real save panel
 *
 * A desktop suite: start it only while holding the manager's shared desktop lock. It also
 * takes this checkout's runner lock (test/artifacts/runs/.runner-lock) and refuses to start
 * beside another test Trezi, so it never competes with a native-suite run.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DREAMER_ACCEPTANCE_RED_MODES } from '../src/native/dreamer-acceptance.ts'
import {
  DREAMER_ACCEPTANCE_CHECK,
  DREAMER_ACCEPTANCE_FLAG,
  parseSmokeGroups,
  smokeLauncherTimeoutMs
} from '../src/native/smoke-groups.ts'
import { acquireRunLock } from '../test/helpers/test-runner.mjs'

const cwd = fileURLToPath(new URL('../', import.meta.url))
const stop = (message) => {
  console.error(`DREAMER ACCEPTANCE: ${message}`)
  process.exit(2)
}
let red = ''
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--red=')) red = arg.slice('--red='.length)
  else stop(`unknown argument ${arg}; the only option is --red=${DREAMER_ACCEPTANCE_RED_MODES.join('|')}`)
}
if (red && !DREAMER_ACCEPTANCE_RED_MODES.includes(red)) stop(`unknown RED mode ${red}`)
if (process.platform !== 'darwin') stop('the native host needs macOS')
if (spawnSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status !== 0)
  stop('the Xcode command-line tools are not installed')
if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1')
  stop('the check needs the foreground; unset TREZI_NATIVE_BACKGROUND_TEST')
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

const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout?.trim() ?? ''
const source = {
  sha: git('rev-parse', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  dirty: git('status', '--porcelain').length > 0
}
const dir = join(cwd, 'test/artifacts/native/dreamer-acceptance')
rmSync(dir, { recursive: true, force: true })
const smoke = ['--test', '--only=settings', DREAMER_ACCEPTANCE_FLAG]
const timeout = smokeLauncherTimeoutMs(parseSmokeGroups(smoke))
const started = Date.now()
console.log(`DREAMER ACCEPTANCE (${red ? `RED ${red}` : 'GREEN'}) on ${source.sha}${source.dirty ? ' (dirty)' : ''}`)
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
    TREZI_DREAMER_ACCEPTANCE_RED: red
  }
})

let evidence = null
try {
  evidence = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'))
} catch {}
const fresh = evidence && Date.parse(evidence.startedAt) >= started
const passed = result.status === 0 && fresh && evidence.outcome === 'pass'
// RED is met only when the check ran and failed where the stub replaced the real panel.
const redMet = !!red && !passed && fresh && /real NSSavePanel opened/.test(evidence.error ?? '')
const run = {
  ticket: 'LKM-447',
  check: DREAMER_ACCEPTANCE_CHECK,
  mode: red ? `red:${red}` : 'green',
  expected: red ? 'fail at "real NSSavePanel opened"' : 'pass',
  met: red ? redMet : passed,
  source,
  command: `bun run acceptance:dreamer${red ? ` --red=${red}` : ''}`,
  launcher: `bun run dev:native ${smoke.join(' ')}`,
  exitCode: result.status,
  signal: result.signal,
  timedOut: result.error?.code === 'ETIMEDOUT',
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  failure: fresh ? (evidence.error ?? null) : 'the check wrote no fresh evidence.json',
  captures: fresh ? Object.keys(evidence.captures ?? {}) : []
}
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
console.log(
  `DREAMER ACCEPTANCE ${run.met ? 'MET' : 'NOT MET'} (${run.mode}): evidence in ${dir}${run.failure ? `; failure: ${run.failure}` : ''}`
)
process.exit(run.met ? 0 : 1)
