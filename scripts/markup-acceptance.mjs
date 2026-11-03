/** LKM-455 operator entrypoint. Hold the manager's canonical native-desktop lease first. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKUP_ACCEPTANCE_CHECK, MARKUP_ACCEPTANCE_FLAG, parseSmokeGroups, smokeLauncherTimeoutMs } from '../src/native/smoke-groups.ts'
import { acquireRunLock } from '../test/helpers/test-runner.mjs'

const cwd = fileURLToPath(new URL('../', import.meta.url))
const stop = (reason) => { console.error(`MARKUP ACCEPTANCE: ${reason}`); process.exit(2) }
const args = process.argv.slice(2)
if (args.length > 1 || (args.length && args[0] !== '--red=active-fill')) stop('use no arguments or --red=active-fill')
const red = args.length > 0
if (process.platform !== 'darwin') stop('the native host needs macOS')
if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') stop('a foreground window is required')
if (spawnSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status !== 0) stop('Swift tools unavailable')
const ps = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
if (ps.status !== 0 || ps.stdout.split('\n').some(line => /\/TreziHost \S+ ephemeral /.test(line)))
  stop('another ephemeral Trezi is running, or its process list is unavailable')

const runs = join(cwd, 'test/artifacts/runs')
mkdirSync(runs, { recursive: true })
let release
try { release = acquireRunLock(join(runs, '.runner-lock')) } catch (error) { stop(error.message) }
process.once('exit', release)

const git = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout?.trim() ?? ''
const source = { sha: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: !!git('status', '--porcelain') }
// Never reuse or remove an earlier result, including a failed or interrupted run.
const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const dir = join(cwd, 'test/artifacts/native/markup-acceptance', id)
mkdirSync(dir, { recursive: false })
const smoke = ['--test', '--only=core', MARKUP_ACCEPTANCE_FLAG]
const timeout = smokeLauncherTimeoutMs(parseSmokeGroups(smoke))
const started = Date.now()
const command = `bun run acceptance:markup${red ? ' --red=active-fill' : ''}`
const run = { ticket: 'LKM-455', check: MARKUP_ACCEPTANCE_CHECK, mode: red ? 'red:active-fill' : 'green', source, command, launcher: `bun run dev:native ${smoke.join(' ')}`, startedAt: new Date(started).toISOString(), evidence: dir }
const write = () => writeFileSync(join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
write()
const result = spawnSync('bun', ['run', 'dev:native', ...smoke], {
  cwd, stdio: 'inherit', timeout,
  env: { ...process.env, TREZI_SIGN_IDENTITY: '-', TREZI_SIGN_CREATE: '0', TREZI_BUILD_PROFILE: 'test',
    TREZI_NATIVE_SMOKE_DEADLINE_MS: String(started + timeout), TREZI_NATIVE_SMOKE_STEAL_FOCUS: '',
    TREZI_MARKUP_ACCEPTANCE_DIR: dir, TREZI_MARKUP_ACCEPTANCE_RED: red ? 'active-fill' : '' }
})
let evidence
try { evidence = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) } catch {}
const fresh = evidence && Date.parse(evidence.startedAt) >= started
const greenMet = result.status === 0 && fresh && evidence.outcome === 'pass'
const redMet = red && result.status !== 0 && fresh && evidence.outcome === 'fail' && /RED active-fill: no active fill after Cancel/.test(evidence.error ?? '')
Object.assign(run, { exitCode: result.status, signal: result.signal, timedOut: result.error?.code === 'ETIMEDOUT',
  finishedAt: new Date().toISOString(), met: red ? redMet : greenMet,
  failure: fresh ? evidence.error ?? null : 'no fresh evidence.json', captures: fresh ? Object.keys(evidence.captures ?? {}) : [] })
write()
console.log(`MARKUP ACCEPTANCE ${run.met ? 'MET' : 'NOT MET'} (${run.mode}): ${dir}`)
process.exit(run.met ? 0 : 1)
