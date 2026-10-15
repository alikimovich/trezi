import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'trezi-managed-browser-test-'))
const cli = join(root, 'fake-agent-browser')
const shell = join(root, 'chrome-headless-shell')
writeFileSync(
  cli,
  `#!/usr/bin/env bun
console.log(JSON.stringify({args:process.argv.slice(2),env:{HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,profile:process.env.AGENT_BROWSER_PROFILE,executable:process.env.AGENT_BROWSER_EXECUTABLE_PATH,config:process.env.AGENT_BROWSER_CONFIG,headed:process.env.AGENT_BROWSER_HEADED,idle:process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS}}))
if (process.argv.includes('wait')) await new Promise(resolve => setTimeout(resolve, 5000))
`
)
writeFileSync(shell, '')
chmodSync(cli, 0o700)
chmodSync(shell, 0o700)
const wrapper = join(import.meta.dir, '../bin/managed/agent-browser')
const env = {
  ...process.env,
  TREZI_BROWSER_TEST: '1',
  TREZI_BROWSER_TEST_CLI: cli,
  TREZI_BROWSER_TEST_SHELL: shell,
  TREZI_BROWSER_TEST_ROOT: join(root, 'sessions'),
  AGENT_BROWSER_HEADED: 'true',
  AGENT_BROWSER_PROFILE: '/Applications/Google Chrome.app',
  AGENT_BROWSER_AUTO_CONNECT: 'true'
}
const run = (args, overrides = {}) => {
  const proc = Bun.spawnSync([process.execPath, wrapper, ...args], {
    cwd: root,
    env: { ...env, ...overrides },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

const open = run(['--session', 'trezi-one', 'open', 'http://127.0.0.1:3000'])
assert.equal(open.code, 0, open.err)
const first = JSON.parse(open.out)
assert.match(first.args[1], /^trezi-[a-f0-9]{12}$/)
assert.equal(first.env.executable, shell)
assert.equal(first.env.headed, 'false')
assert.equal(first.env.idle, '120000')
assert.ok(first.env.HOME.startsWith(join(root, 'sessions')))
assert.ok(first.env.TMPDIR.startsWith(join(root, 'sessions')))
assert.ok(first.env.profile.startsWith(join(root, 'sessions')))
assert.equal(readFileSync(first.env.config, 'utf8'), '{}\n')
assert.deepEqual(first.args.slice(2, 10), [
  '--config',
  first.env.config,
  '--executable-path',
  shell,
  '--profile',
  first.env.profile,
  '--headed',
  'false'
])
const warm = JSON.parse(run(['--session', 'trezi-one', 'screenshot', join(root, 'shot.png')]).out)
assert.equal(warm.env.HOME, first.env.HOME, 'same session reuses its daemon environment')
const other = JSON.parse(run(['--session', 'trezi-two', 'open', 'http://127.0.0.1:3000']).out)
assert.notEqual(other.env.HOME, first.env.HOME, 'concurrent sessions are isolated')
const parallel = (session) =>
  new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [wrapper, '--session', session, 'snapshot'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    proc.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    proc.once('error', reject)
    proc.once('close', (code) =>
      code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`exit ${code}`))
    )
  })
const [parallelA, parallelB] = await Promise.all([
  parallel('trezi-parallel-a'),
  parallel('trezi-parallel-b')
])
assert.notEqual(
  parallelA.env.TMPDIR,
  parallelB.env.TMPDIR,
  'simultaneous sessions have separate daemons'
)

const cancelled = spawn(process.execPath, [wrapper, '--session', 'trezi-cancel', 'wait', '5000'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
await new Promise((resolve) => cancelled.stdout.once('data', resolve))
cancelled.kill('SIGTERM')
assert.equal(await new Promise((resolve) => cancelled.once('close', resolve)), 143)
assert.equal(run(['--session', 'trezi-cancel', 'close']).code, 0, 'cancelled session can be closed')

for (const args of [
  ['open', 'http://127.0.0.1:3000'],
  ['--session', 'trezi-one', '--headed', 'open', 'http://127.0.0.1:3000'],
  [
    '--session',
    'trezi-one',
    '--executable-path',
    '/Applications/Google Chrome.app',
    'open',
    'http://127.0.0.1:3000'
  ],
  ['--session', 'trezi-one', '--cdp', '9222', 'snapshot'],
  ['--session', 'trezi-one', 'close', '--all'],
  ['--session', 'trezi-one', 'batch', 'open http://127.0.0.1:3000']
])
  assert.equal(run(args).code, 2, `unsafe call rejected: ${args.join(' ')}`)
assert.equal(
  run(['--session', 'trezi-one', 'open', 'http://127.0.0.1:3000'], {
    TREZI_BROWSER_TEST_CLI: join(root, 'missing-cli')
  }).code,
  2,
  'CLI launch failure is explicit'
)
assert.equal(
  run(['--session', 'trezi-one', 'open', 'http://127.0.0.1:3000'], {
    TREZI_BROWSER_TEST_SHELL: join(root, 'missing-shell')
  }).code,
  2,
  'missing dedicated shell fails closed'
)

assert.equal(run(['--session', 'trezi-one', 'close']).code, 0)
assert.equal(existsSync(join(first.env.HOME, '..')), false, 'close removes only its own profile')
assert.equal(existsSync(other.env.HOME), true, 'another session survives close')
assert.equal(run(['--session', 'trezi-two', 'close']).code, 0)
console.log(
  'MANAGED AGENT-BROWSER OK — pinned shell, isolated sessions, unsafe options and failures'
)
