// LKM-176: every native smoke failure ends the run with one fixed-format line, and an
// environment-only failure exits 3 instead of 1.
import assert from 'node:assert/strict'
import {
  describeFailure,
  finishSmokeRun,
  formatEnvLine,
  formatFailureLine,
  formatFailureReport,
  hostLogTail,
  SMOKE_EXIT_ENV,
  SMOKE_EXIT_PRODUCT,
  smokeExitCode,
  smokeGroupOf
} from '../src/native/smoke-report.ts'
import { SmokeTimeoutError, waitFor } from '../src/native/smoke-wait.ts'

const LINE =
  /^SMOKE FAIL (?<group>[\w+-]+)\/(?<check>[\w-]+): (?<message>.+?)(?: \(expected (?<expected>.*), actual (?<actual>.*)\))? \[artifact: (?<artifact>.+)\]$/

// The fixed format, with and without expected/actual values.
assert.equal(
  formatFailureLine({
    group: 'composer',
    check: 'visible-composer',
    message: 'Composer grows upward',
    expected: '60',
    actual: '40',
    artifact: '/a/failure-visible-composer.png'
  }),
  'SMOKE FAIL composer/visible-composer: Composer grows upward (expected 60, actual 40) [artifact: /a/failure-visible-composer.png]'
)
assert.equal(
  formatFailureLine({ group: 'core', check: 'inspector', message: 'boom\n  second line' }),
  'SMOKE FAIL core/inspector: boom second line [artifact: none]',
  'one line, artifact named even when missing'
)
assert.equal(
  formatEnvLine('focus lost during native-chat'),
  'SMOKE ENV focus lost during native-chat'
)

// Groups come from smoke-groups.ts; prelude checks have none.
assert.equal(smokeGroupOf('visible-composer'), 'composer')
assert.equal(smokeGroupOf('chat-islands'), 'islands+shadow-light')
assert.equal(smokeGroupOf('startup'), 'prelude')

// An AssertionError reports its message plus expected and actual.
try {
  assert.deepEqual({ height: 40 }, { height: 60 }, 'Composer grows upward')
} catch (error) {
  assert.deepEqual(describeFailure(error), {
    message: 'Composer grows upward',
    expected: '{"height":60}',
    actual: '{"height":40}'
  })
}
try {
  assert.ok(false, 'Chat must be foreground')
} catch (error) {
  assert.deepEqual(describeFailure(error), {
    message: 'Chat must be foreground',
    expected: 'true',
    actual: 'false'
  })
}
try {
  assert.notEqual(3, 3, 'distinct')
} catch (error) {
  assert.equal(describeFailure(error).expected, 'not 3')
}
// A plain error has no values; long values are truncated with their length.
assert.deepEqual(describeFailure(new Error('Native captureShell timed out\nstack')), {
  message: 'Native captureShell timed out'
})
const long = describeFailure(new assert.AssertionError({ actual: 'x'.repeat(500), expected: 'y' }))
assert.match(long.actual, /… \(502 chars\)$/)

// A timeout names the step that waited and what it waited for (this test is no smoke
// module, so a fake stack stands in for the call site).
let timeout
try {
  await waitFor(
    () => false,
    'composerInspect',
    30,
    () => ({ lastState: { enabled: false } }),
    5
  )
} catch (error) {
  timeout = error
}
assert.ok(timeout instanceof SmokeTimeoutError)
assert.equal(timeout.label, 'composerInspect')
assert.match(timeout.message, /^Native check timed out: composerInspect; false /)
const step = new SmokeTimeoutError(
  'Native check timed out: native chat ready; undefined',
  'native chat ready',
  30000,
  undefined,
  'smoke-core.ts:255:15'
)
assert.deepEqual(describeFailure(step), {
  message: 'timed out after 30.0 s at smoke-core.ts:255:15 waiting for native chat ready',
  expected: 'native chat ready ready',
  actual: 'undefined'
})
const described = describeFailure(timeout)
assert.equal(described.actual, '{"lastState":{"enabled":false}}')
assert.match(
  formatFailureLine({ group: 'composer', check: 'composer', ...described, artifact: '/x.png' }),
  LINE
)

// The run's report: one line per failure, one SMOKE ENV per distinct reason.
const lines = formatFailureReport([
  { name: 'composer', error: new Error('Composer grows upward'), capture: '/a/composer.png' },
  {
    name: 'native-chat',
    error: new Error('Chat must be foreground'),
    capture: '/a/native-chat.png',
    environment: 'focus lost during native-chat'
  },
  {
    name: 'visible-composer',
    error: new Error('Chat must be foreground'),
    capture: 'unavailable (Native captureShell timed out)',
    environment: 'focus lost during native-chat'
  }
])
assert.deepEqual(lines, [
  'SMOKE FAIL composer/composer: Composer grows upward [artifact: /a/composer.png]',
  'SMOKE FAIL chat/native-chat: Chat must be foreground [artifact: /a/native-chat.png]',
  'SMOKE FAIL composer/visible-composer: Chat must be foreground [artifact: unavailable (Native captureShell timed out)]',
  'SMOKE ENV focus lost during native-chat'
])
for (const line of lines.slice(0, 3)) assert.match(line, LINE)

// Exit codes: 1 when any failure is a product failure, 3 when all are environment.
assert.equal(smokeExitCode([]), 0)
assert.equal(smokeExitCode([{ environment: 'display asleep' }]), SMOKE_EXIT_ENV)
assert.equal(smokeExitCode([{ environment: 'display asleep' }, {}]), SMOKE_EXIT_PRODUCT)
assert.equal(SMOKE_EXIT_ENV, 3)
assert.equal(SMOKE_EXIT_PRODUCT, 1)

// The launcher: Bun's lines last; a crash adds the host exit and its last log lines.
const log = [
  '2026-10-05T10:00:00.000Z info service lifecycle Service started',
  '2026-10-05T10:00:01.000Z info app lifecycle Host started',
  '2026-10-05T10:00:02.000Z error app preview WebContent crashed',
  ''
].join('\n')
assert.deepEqual(hostLogTail(log), [
  '2026-10-05T10:00:01.000Z info app lifecycle Host started',
  '2026-10-05T10:00:02.000Z error app preview WebContent crashed'
])
assert.deepEqual(hostLogTail('a\nb\nc', 2), ['b', 'c'], 'falls back to any process')
assert.deepEqual(finishSmokeRun({ code: 0, signal: null }, { exitCode: 0, lines: [] }, []), {
  exitCode: 0,
  lines: []
})
assert.deepEqual(
  finishSmokeRun(
    { code: 1, signal: null },
    { exitCode: 3, lines: ['SMOKE ENV display asleep'] },
    []
  ),
  { exitCode: 3, lines: ['SMOKE ENV display asleep'] }
)
assert.equal(
  finishSmokeRun(
    { code: 1, signal: null },
    { exitCode: 1, lines: ['SMOKE FAIL a/b: c [artifact: none]'] },
    []
  ).exitCode,
  1
)
const crash = finishSmokeRun(
  { code: null, signal: 'SIGSEGV' },
  undefined,
  hostLogTail(log),
  '/a/host-exit.log'
)
assert.equal(crash.exitCode, 1)
assert.deepEqual(crash.lines, [
  'SMOKE FAIL host/exit: native host exited with signal SIGSEGV before the smoke reported a result (expected exit code 0, actual signal SIGSEGV) [artifact: /a/host-exit.log]',
  '  host log: 2026-10-05T10:00:01.000Z info app lifecycle Host started',
  '  host log: 2026-10-05T10:00:02.000Z error app preview WebContent crashed'
])
assert.match(crash.lines[0], LINE)
const quitCrash = finishSmokeRun({ code: 134, signal: null }, { exitCode: 0, lines: [] }, [])
assert.deepEqual(quitCrash, {
  exitCode: 1,
  lines: [
    'SMOKE FAIL host/exit: native host exited with exit code 134 after the smoke reported its result (expected exit code 0, actual exit code 134) [artifact: none]',
    '  host log: (no lines)'
  ]
})

console.log(
  'Native smoke report: fixed SMOKE FAIL/SMOKE ENV lines for assertions, timeouts and host exits; exit 3 only for environment failures.'
)
