import assert from 'node:assert/strict'
import {
  assertionLocation,
  firstAssertionLine,
  formatSmokeSummary,
  parseInjectedFailures,
  runSmokeChecks,
  validateSmokeChecks
} from '../src/native/smoke-runner.ts'

// Fixture run: a deliberately failing check must not stop the checks after it.
const calls = []
const lines = []
const pass = (name) => ({
  name,
  run: async () => {
    calls.push(`run:${name}`)
  }
})
const originalError = console.error
console.error = () => {}
let results
try {
  results = await runSmokeChecks(
    [
      pass('startup'),
      pass('open-project'),
      {
        name: 'composer',
        dependsOn: ['open-project'],
        run: async () => {
          calls.push('run:composer')
          assert.deepEqual({ height: 40 }, { height: 60 }, 'Composer grows upward')
        },
        cleanup: async () => {
          calls.push('cleanup:composer')
        }
      },
      {
        name: 'chat-drafts',
        dependsOn: ['composer'],
        run: async () => {
          calls.push('run:chat-drafts')
        }
      },
      {
        name: 'chat-reload',
        dependsOn: ['open-project', 'chat-drafts'],
        run: async () => {
          calls.push('run:chat-reload')
        }
      },
      {
        ...pass('sheets'),
        dependsOn: ['open-project'],
        cleanup: async () => {
          calls.push('cleanup:sheets')
        }
      },
      {
        name: 'layout',
        dependsOn: ['open-project'],
        run: async () => {
          calls.push('run:layout')
          throw new Error('Collapsed workspace at sheets\nsecond line')
        }
      },
      {
        name: 'injected',
        run: async () => {
          calls.push('run:injected')
        }
      },
      pass('final-shell')
    ],
    {
      capture: async (name, error) => {
        calls.push(`capture:${name}`)
        assert.ok(error instanceof Error)
        if (name === 'layout') throw new Error('Native captureShell timed out')
        return `/artifacts/failure-${name}.png`
      },
      restore: async (name) => {
        calls.push(`restore:${name}`)
        if (name === 'composer')
          throw new Error('Sidebar restore left the foreground dirty: sheet visible')
      },
      log: (line) => lines.push(line),
      inject: new Set(['injected'])
    }
  )
} finally {
  console.error = originalError
}

assert.deepEqual(
  calls,
  [
    'run:startup',
    'run:open-project',
    'run:composer',
    'capture:composer',
    'cleanup:composer',
    'restore:composer',
    'run:sheets',
    'run:layout',
    'capture:layout',
    'restore:layout',
    'capture:injected',
    'restore:injected',
    'run:final-shell'
  ],
  'independent checks after a failure still run; cleanup/restore follow only failures; injected checks never run'
)
assert.deepEqual(
  results.map((r) => [r.name, r.outcome]),
  [
    ['startup', 'pass'],
    ['open-project', 'pass'],
    ['composer', 'fail'],
    ['chat-drafts', 'skip'],
    ['chat-reload', 'skip'],
    ['sheets', 'pass'],
    ['layout', 'fail'],
    ['injected', 'fail'],
    ['final-shell', 'pass']
  ]
)
assert.equal(results[3].dependsOn, 'composer')
assert.equal(
  results[4].dependsOn,
  'chat-drafts',
  'a transitively blocked check names its own unmet dependency'
)
assert.ok(lines.includes('SKIP [smoke] chat-drafts — skipped: depends on composer'))
assert.ok(lines.includes('SKIP [smoke] chat-reload — skipped: depends on chat-drafts'))
assert.ok(lines.some((l) => /^FAIL \[smoke\] composer \d+\.\ds — Composer grows upward$/.test(l)))
assert.ok(
  lines.includes(
    'WARN [smoke] composer restore after failure: Sidebar restore left the foreground dirty: sheet visible'
  ),
  'a failed restore is reported and does not stop the run'
)

assert.deepEqual(formatSmokeSummary(results).split('\n'), [
  'NATIVE SMOKE SUMMARY: 4 passed, 3 failed, 2 skipped (9 checks)',
  'FAILED composer',
  '  assertion: Composer grows upward',
  '  capture: /artifacts/failure-composer.png',
  'SKIPPED chat-drafts',
  '  skipped: depends on composer',
  'SKIPPED chat-reload',
  '  skipped: depends on chat-drafts',
  'FAILED layout',
  '  assertion: Collapsed workspace at sheets',
  '  capture: unavailable (Native captureShell timed out)',
  'FAILED injected',
  '  assertion: Deliberate failure injected by TREZI_NATIVE_SMOKE_FAIL: injected',
  '  capture: /artifacts/failure-injected.png'
])
assert.equal(
  formatSmokeSummary([{ name: 'a', outcome: 'pass', duration: 1 }]),
  'NATIVE SMOKE SUMMARY: 1 passed, 0 failed, 0 skipped (1 checks)'
)

// A multi-line AssertionError reports its first line; the location is the smoke module's frame.
try {
  assert.deepEqual([1], [2])
} catch (error) {
  assert.equal(firstAssertionLine(error), 'Expected values to be strictly deep-equal:')
}
assert.equal(firstAssertionLine('\n  plain string\nmore'), 'plain string')
const located = new Error('x')
located.stack =
  'Error: x\n    at assertOk (node:assert:1:1)\n    at run (/out/native/smoke-runner.ts:9:1)\n    at run (/repo/src/native/smoke-core.ts:120:7)\n    at next (/repo/src/native/smoke-projects.ts:5:1)'
assert.equal(assertionLocation(located), 'smoke-core.ts:120:7')
assert.equal(assertionLocation(new Error('no frames')), undefined)

// A halted run (host exited) skips everything left, naming the shared state it needs.
let halted
const haltedResults = await runSmokeChecks(
  [
    {
      name: 'one',
      run: async () => {
        halted = 'native host (it exited)'
      }
    },
    pass('two')
  ],
  { capture: async () => '', restore: async () => {}, log: () => {}, halted: () => halted }
)
assert.deepEqual(
  haltedResults.map((r) => [r.name, r.outcome, r.dependsOn]),
  [
    ['one', 'pass', undefined],
    ['two', 'skip', 'native host (it exited)']
  ]
)

// Misconfiguration fails before any check runs.
assert.throws(() => validateSmokeChecks([pass('a'), pass('a')]), /Duplicate native smoke check: a/)
assert.throws(
  () => validateSmokeChecks([{ ...pass('a'), dependsOn: ['b'] }, pass('b')]),
  /a depends on b, which must run earlier/
)
assert.throws(() => validateSmokeChecks([pass('a')], new Set(['typo'])), /unknown check: typo/)
await assert.rejects(
  runSmokeChecks([pass('late')], {
    capture: async () => '',
    restore: async () => {},
    log: () => {},
    inject: new Set(['nope'])
  }),
  /unknown check: nope/
)
assert.deepEqual([...parseInjectedFailures(' composer, ,sheets ')], ['composer', 'sheets'])
assert.deepEqual([...parseInjectedFailures(undefined)], [])

console.log(
  'Native smoke runner: failures collected, dependents skipped with reasons, independent checks continue, summary format fixed.'
)
