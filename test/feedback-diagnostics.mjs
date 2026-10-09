// LKM-165: the feedback diagnostics bundle. Secrets are removed, the home folder is
// shortened to `~`, the chat's landing state and worktree status are included, and the
// host is sampled only when its main thread is slow. No real `log`, `sample` or
// provider call runs: commands are injected.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUSY_MS,
  captureConsole,
  DIAGNOSTICS_LIMIT,
  gatherDiagnostics,
  redact,
  SYSTEM_LOG_LINES,
  SYSTEM_LOG_PREDICATE,
  systemLogLines
} from '../src/main/feedback-diagnostics.ts'
import { buildFeedbackBody, SAFE_LIMIT } from '../src/shared/feedback-body.ts'

const HOME = '/Users/someone'
const SECRETS = [
  'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
  'sk-proj-1234567890abcdefghij',
  'ghp_abcdefghijklmnopqrstuvwxyz0123',
  'github_pat_11ABCDEFG0123456789_abcdefghij',
  'xoxb-1234567890-abcdefghij',
  'AKIAABCDEFGHIJKLMNOP',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl',
  'opaque-bearer-value-123',
  'hunter2-password',
  'client-secret-value',
  'url-password'
]
const leaky = [
  `key ${SECRETS[0]} and ${SECRETS[1]}`,
  `gh ${SECRETS[2]} ${SECRETS[3]}`,
  `slack ${SECRETS[4]} aws ${SECRETS[5]} jwt ${SECRETS[6]}`,
  `Authorization: Bearer ${SECRETS[7]}`,
  `password=${SECRETS[8]} "client_secret": "${SECRETS[9]}"`,
  `https://user:${SECRETS[10]}@example.com/repo.git`,
  `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----`,
  `opened ${HOME}/dev/app/src/App.tsx`
].join('\n')
const clean = redact(leaky, HOME)
for (const secret of SECRETS) assert.ok(!clean.includes(secret), `redacted ${secret}`)
assert.ok(!clean.includes('b3BlbnNzaC1rZXktdjEAAAAA'), 'private keys are removed')
assert.ok(!clean.includes(HOME), 'the home folder is shortened')
assert.ok(clean.includes('opened ~/dev/app/src/App.tsx'))
assert.ok(clean.includes('https://user:[redacted]@example.com/repo.git'))

// Bun's console output is kept for the bundle and still printed.
captureConsole()
console.error(`provider failed: token=${SECRETS[1]} in ${HOME}/dev/app`)

const START = Date.parse('2020-01-01T12:00:00.000Z')
const logDir = mkdtempSync(join(tmpdir(), 'trezi-feedback-log-'))
writeFileSync(
  join(logDir, 'trezi-2020-01-01.log'),
  [
    '2020-01-01T11:00:00.000Z info backend chat Too old',
    '2020-01-01T11:50:00.000Z info app lifecycle App started',
    '2020-01-01T11:55:00.000Z info backend chat chat=chat-1 turn=t1 Turn started provider=claude',
    ''
  ].join('\n')
)
process.on('exit', () => rmSync(logDir, { recursive: true, force: true }))

function sources(pingMs, output = {}) {
  const calls = []
  let clock = START
  return {
    calls,
    value: {
      home: HOME,
      logDir,
      hostPid: 4242,
      chat: { key: 'chat-1', root: `${HOME}/dev/app` },
      now: () => clock,
      ping: async () => {
        clock += pingMs
      },
      run: async (command, args) => {
        calls.push([command, ...args])
        if (command === '/usr/bin/sample')
          return output.sample ?? `Sampling process 4242 for 3 seconds\nmain thread ${HOME}/x`
        if (command === 'git') return `## trezi/chat-1\n M ${HOME}/dev/app/a.ts`
        if (command === '/usr/bin/log')
          return (
            output.log ??
            `Timestamp               Ty Process[PID:TID]\n2020-01-01 11:59:00.000 E  TreziHost[1:2] Authorization: Bearer ${SECRETS[7]}`
          )
        throw new Error(`unexpected ${command}`)
      }
    }
  }
}

const slow = sources(BUSY_MS + 400)
const text = await gatherDiagnostics(slow.value)
for (const secret of SECRETS) assert.ok(!text.includes(secret), `bundle has no ${secret}`)
assert.ok(!text.includes(HOME), 'bundle paths are shortened')
assert.match(text, /## App main thread\nreplied in \d+ ms \(busy\)/)
assert.match(text, /## Main thread sample \(3 s\)\nSampling process 4242/)
assert.deepEqual(
  slow.calls.find(([c]) => c === '/usr/bin/sample'),
  ['/usr/bin/sample', '4242', '3']
)
assert.match(
  text,
  /## Chat landing state\n\{[\s\S]*"state": "live"[\s\S]*"liveRoot": "~\/dev\/app"/
)
assert.match(text, /## Chat worktree git status\n## trezi\/chat-1\n M ~\/dev\/app\/a.ts/)
assert.deepEqual(
  slow.calls.find(([c]) => c === 'git'),
  ['git', '--no-optional-locks', '-C', `${HOME}/dev/app`, 'status', '--porcelain=v1', '--branch']
)
assert.match(
  text,
  /## Backend console \(last hour\)\n.*error: provider failed: token=\[redacted\] in ~\/dev\/app/
)
// LKM-168: the product log's last 30 minutes, from every process; older lines stay out.
assert.match(
  text,
  /## Trezi log \(last 30 minutes\)\n.*info app lifecycle App started\n.*info backend chat chat=chat-1 turn=t1 Turn started/
)
assert.ok(!text.includes('Too old'), 'lines older than 30 minutes are left out')
assert.match(
  text,
  /## System log, Trezi errors and faults \(last hour\)\n2020-01-01 11:59:00.000 E {2}TreziHost\[1:2\] Authorization: Bearer \[redacted\]/
)
assert.deepEqual(slow.calls.find(([c]) => c === '/usr/bin/log').slice(1), [
  'show',
  '--last',
  '1h',
  '--style',
  'compact',
  '--predicate',
  SYSTEM_LOG_PREDICATE
])
// LKM-199: errors and faults of Trezi's processes and subsystems only, a repeated message
// collapsed, the newest SYSTEM_LOG_LINES lines kept.
assert.match(SYSTEM_LOG_PREDICATE, /process BEGINSWITH "Trezi"/)
assert.match(SYSTEM_LOG_PREDICATE, /messageType == error OR messageType == fault/)
const stamp = (i) => `2020-01-01 11:${String(i % 60).padStart(2, '0')}:00.000 F  TreziHost[1:2]`
const noisy = [
  'Timestamp               Ty Process[PID:TID]',
  `${stamp(0)} Publishing changes from within view updates`,
  `${stamp(1)} Publishing changes from within view updates`,
  `${stamp(2)} Publishing changes from within view updates`,
  `${stamp(3)} Something else`,
  ...Array.from({ length: 300 }, (_, i) => `${stamp(i)} distinct fault ${i}`)
].join('\n')
assert.deepEqual(systemLogLines(noisy.split('\n').slice(0, 5).join('\n')), [
  `${stamp(0)} Publishing changes from within view updates (repeated 2 more times)`,
  `${stamp(3)} Something else`
])
const capped = systemLogLines(noisy)
assert.equal(capped.length, SYSTEM_LOG_LINES)
assert.equal(capped.at(-1), `${stamp(299)} distinct fault 299`)

// A responsive host is not sampled; a host that does not answer is.
const fast = sources(5)
assert.ok(!(await gatherDiagnostics(fast.value)).includes('Main thread sample'))
assert.ok(!fast.calls.some(([c]) => c === '/usr/bin/sample'))
const hung = sources(0)
hung.value.ping = () => Promise.reject(new Error('Native webViews timed out'))
assert.match(await gatherDiagnostics(hung.value), /did not reply within 2 s \(busy\)/)
assert.ok(hung.calls.some(([c]) => c === '/usr/bin/sample'))

// Huge outputs are cut so the bundle fits the issue body next to the feedback.
const huge = sources(BUSY_MS, { sample: 'x'.repeat(200_000), log: 'y'.repeat(200_000) })
const big = await gatherDiagnostics(huge.value)
assert.ok(big.length <= DIAGNOSTICS_LIMIT + 100, `bundle is ${big.length} characters`)
const body = buildFeedbackBody({ body: 'The app is slow', diagnostics: big })
assert.ok(body.length <= SAFE_LIMIT)
assert.ok(body.includes('<summary>Diagnostics</summary>'))
assert.ok(!buildFeedbackBody({ body: 'x' }).includes('Diagnostics'), 'nothing without consent')
console.log(
  'FEEDBACK DIAGNOSTICS OK — consented bundle redacted, paths shortened, busy host sampled'
)
