/**
 * LKM-453: the opt-in chat recovery acceptance (docs/TESTING.md "Chat recovery acceptance").
 * Builds and launches a disposable test Trezi (`--test`: its own profile, preferences, data
 * and logs in a temp folder that start-native removes) that runs only the smoke prelude and
 * `chat-recovery-flow-native`, then keeps the evidence for the exact source it ran on.
 *
 *   bun run acceptance:chat-recovery                   GREEN: must pass on the shipping code
 *   bun run acceptance:chat-recovery --red=delay-busy  RED: must fail at the held busy state
 *
 * A desktop suite: start it only while holding the manager's shared desktop lock. It also
 * takes this checkout's runner lock (test/artifacts/runs/.runner-lock) and refuses to start
 * beside another test Trezi, so it never competes with a native-suite run.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUSY_MARKER, CHAT_RECOVERY_RED_MODES } from '../src/native/chat-recovery-acceptance.ts'
import {
  CHAT_RECOVERY_ACCEPTANCE_CHECK,
  CHAT_RECOVERY_ACCEPTANCE_FLAG,
  parseSmokeGroups,
  smokeLauncherTimeoutMs
} from '../src/native/smoke-groups.ts'
import { acquireRunLock } from '../test/helpers/test-runner.mjs'

const cwd = fileURLToPath(new URL('../', import.meta.url))
const stop = (message) => {
  console.error(`CHAT RECOVERY ACCEPTANCE: ${message}`)
  process.exit(2)
}
let red = ''
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--red=')) red = arg.slice('--red='.length)
  else
    stop(`unknown argument ${arg}; the only option is --red=${CHAT_RECOVERY_RED_MODES.join('|')}`)
}
if (red && !CHAT_RECOVERY_RED_MODES.includes(red)) stop(`unknown RED mode ${red}`)
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
if (!/^[0-9a-f]{40}$/.test(source.sha)) stop('cannot read the source commit')
if (source.dirty) stop('the checkout has uncommitted changes; evidence must match the exact source SHA')
const dir = join(cwd, 'test/artifacts/native/chat-recovery-acceptance')
rmSync(dir, { recursive: true, force: true })
const smoke = ['--test', '--only=chat', CHAT_RECOVERY_ACCEPTANCE_FLAG]
const timeout = smokeLauncherTimeoutMs(parseSmokeGroups(smoke))
const started = Date.now()
const mode = red ? `red-${red}` : 'green'
console.log(
  `CHAT RECOVERY ACCEPTANCE (${red ? `RED ${red}` : 'GREEN'}) on ${source.sha}${source.dirty ? ' (dirty)' : ''}`
)
const result = spawnSync('bun', ['run', 'dev:native', ...smoke], {
  cwd,
  stdio: 'inherit',
  timeout,
  env: {
    ...process.env,
    TREZI_NATIVE_SMOKE_DEADLINE_MS: String(started + timeout),
    TREZI_BUILD_PROFILE: process.env.TREZI_BUILD_PROFILE || 'test',
    // The disposable build must not inspect or use the operator's login keychain.
    TREZI_SIGN_IDENTITY: '-',
    // No simulated focus loss: every step of this check is a foreground one.
    TREZI_NATIVE_SMOKE_STEAL_FOCUS: '',
    TREZI_CHAT_RECOVERY_ACCEPTANCE_RED: red,
    TREZI_ACCEPTANCE_SOURCE_SHA: source.sha
  }
})

let evidence = null
try {
  evidence = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'))
} catch {}
const fresh = evidence && Date.parse(evidence.startedAt) >= started && evidence.sha === source.sha
const passed = result.status === 0 && fresh && evidence.outcome === 'pass'
// RED is met only when the check ran and failed where the busy state should have been.
const redMet = !!red && !passed && fresh && (evidence.error ?? '').includes(BUSY_MARKER)
const run = {
  ticket: 'LKM-453',
  check: CHAT_RECOVERY_ACCEPTANCE_CHECK,
  mode: red ? `red:${red}` : 'green',
  expected: red ? `fail at "${BUSY_MARKER}"` : 'pass',
  met: red ? redMet : passed,
  source,
  command: `bun run acceptance:chat-recovery${red ? ` --red=${red}` : ''}`,
  launcher: `bun run dev:native ${smoke.join(' ')}`,
  exitCode: result.status,
  signal: result.signal,
  timedOut: result.error?.code === 'ETIMEDOUT',
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  failure: fresh
    ? (evidence.error ?? null)
    : 'the check wrote no fresh evidence.json for this commit',
  captures: fresh ? Object.keys(evidence.captures ?? {}) : []
}
// Kept per commit and run, read-only, with each file's digest: a later run never replaces it.
const stamp = new Date(started).toISOString().replace(/[:.]/g, '-')
const kept = join(
  cwd,
  'test/artifacts/acceptance',
  CHAT_RECOVERY_ACCEPTANCE_CHECK,
  source.sha,
  `${mode}-${stamp}-${randomUUID()}`
)
mkdirSync(kept, { recursive: true })
try {
  cpSync(dir, kept, { recursive: true })
} catch {}
run.files = Object.fromEntries(
  readdirSync(kept)
    .sort()
    .map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(join(kept, name)))
        .digest('hex')
    ])
)
writeFileSync(join(kept, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
for (const name of readdirSync(kept)) chmodSync(join(kept, name), 0o444)
console.log(
  `CHAT RECOVERY ACCEPTANCE ${run.met ? 'MET' : 'NOT MET'} (${run.mode}): evidence in ${kept}${run.failure ? `; failure: ${run.failure}` : ''}`
)
process.exit(run.met ? 0 : 1)
