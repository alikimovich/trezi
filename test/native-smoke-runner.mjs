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

// LKM-176 focus guard: a fake host whose focus the simulation takes away.
const focusHost = () => {
  const host = { focused: true, lost: 0, calls: [] }
  host.hooks = {
    capture: async (name) => `/artifacts/failure-${name}.png`,
    restore: async (name) => {
      host.calls.push(`restore:${name}`)
    },
    focus: async () => {
      const lost = host.lost > 0
      const restored = !host.focused || lost
      host.lost = 0
      if (host.unobtainable)
        return { focused: false, restored: false, lost, reason: host.unobtainable }
      host.focused = true
      host.calls.push(restored ? 'focus:restored' : 'focus')
      return { focused: true, restored, lost }
    },
    loseFocus: async () => {
      host.focused = false
      host.lost++
      host.calls.push('lose')
    }
  }
  return host
}
const foreground = (host, name, extra = {}) => ({
  name,
  run: async () => {
    host.calls.push(`run:${name}`)
    assert.ok(host.focused, 'Chat must be foreground')
  },
  ...extra
})

// Focus lost during a check: restored, retried once, passes; the log says so.
{
  const host = focusHost()
  const log = []
  const out = await runSmokeChecks(
    [
      foreground(host, 'visible-composer', {
        cleanup: async () => {
          host.calls.push('cleanup:visible-composer')
        }
      }),
      foreground(host, 'after')
    ],
    { ...host.hooks, log: (line) => log.push(line), stealFocus: new Set(['visible-composer']) }
  )
  assert.deepEqual(
    out.map((r) => [r.name, r.outcome]),
    [
      ['visible-composer', 'pass'],
      ['after', 'pass']
    ]
  )
  assert.deepEqual(host.calls, [
    'focus',
    'lose',
    'run:visible-composer',
    'focus:restored',
    'cleanup:visible-composer',
    'restore:visible-composer',
    'focus',
    'run:visible-composer',
    'focus',
    'focus',
    'run:after',
    'focus'
  ])
  assert.ok(log.includes('FOCUS [smoke] visible-composer — focus restored during the check'))
  assert.ok(
    log.includes(
      'RETRY [smoke] visible-composer — focus was lost during the check; retrying once: Chat must be foreground'
    )
  )
}

// Focus missing before a check is restored first; the check never sees the loss.
{
  const host = focusHost()
  host.focused = false
  const log = []
  const out = await runSmokeChecks([foreground(host, 'native-chat')], {
    ...host.hooks,
    log: (line) => log.push(line)
  })
  assert.equal(out[0].outcome, 'pass')
  assert.ok(log.includes('FOCUS [smoke] native-chat — focus restored before the check'))
}

// Focus lost again during the retry: an environment failure, not a product failure.
{
  const host = focusHost()
  const errors = console.error
  console.error = () => {}
  const out = await runSmokeChecks(
    [
      {
        name: 'native-chat',
        run: async () => {
          await host.hooks.loseFocus()
          assert.ok(host.focused, 'Chat must be foreground')
        }
      }
    ],
    { ...host.hooks, log: () => {} }
  ).finally(() => {
    console.error = errors
  })
  assert.equal(out[0].outcome, 'fail')
  assert.equal(out[0].environment, 'focus lost during native-chat')
  assert.equal(host.calls.filter((c) => c === 'lose').length, 2, 'retried exactly once')
  assert.ok(formatSmokeSummary(out).includes('  environment: focus lost during native-chat'))
}

// Focus not obtainable before the check: the check still runs; its failure is environmental.
{
  const host = focusHost()
  host.focused = false
  host.unobtainable = 'display asleep'
  const errors = console.error
  console.error = () => {}
  const log = []
  const out = await runSmokeChecks(
    [foreground(host, 'native-chat'), { name: 'pure', run: async () => {} }],
    { ...host.hooks, log: (line) => log.push(line) }
  ).finally(() => {
    console.error = errors
  })
  assert.deepEqual(
    out.map((r) => [r.name, r.outcome, r.environment]),
    [
      ['native-chat', 'fail', 'focus not obtainable before native-chat: display asleep'],
      ['pure', 'pass', undefined]
    ]
  )
  assert.ok(
    log.includes('WARN [smoke] native-chat — focus not obtainable before the check: display asleep')
  )
}

// A product failure with focus intact is not retried and has no environment.
{
  const host = focusHost()
  const errors = console.error
  console.error = () => {}
  const out = await runSmokeChecks(
    [
      {
        name: 'composer',
        run: async () => {
          host.calls.push('run:composer')
          assert.equal(40, 60, 'Composer grows upward')
        }
      }
    ],
    { ...host.hooks, log: () => {} }
  ).finally(() => {
    console.error = errors
  })
  assert.equal(out[0].outcome, 'fail')
  assert.equal(out[0].environment, undefined)
  assert.equal(host.calls.filter((c) => c === 'run:composer').length, 1)
}
assert.throws(
  () => validateSmokeChecks([pass('a')], new Set(), new Set(['typo'])),
  /TREZI_NATIVE_SMOKE_STEAL_FOCUS names an unknown check: typo/
)

// Restore after a check failed with Settings open on AI Providers (its provider editor
// shown): Settings reopens on its remembered section, so restore leaves it on General
// before closing, as a passing `sheets` run does. A retried `sheets` then reopens General.
{
  const sheet = {
    visible: true,
    title: 'Settings',
    section: 'providers',
    fields: ['connections', 'key']
  }
  const requests = []
  const host = {
    emit() {},
    async request(method, body) {
      requests.push(
        (body?.action ?? body?.section) ? `${method}:${body.action ?? body.section}` : method
      )
      if (method === 'sheetInspect') return { ...sheet }
      if (method === 'sheetPerform' && body.action === 'back') sheet.fields = ['connections']
      if (method === 'sheetPerform' && body.action === 'cancel') sheet.visible = false
      if (method === 'settingsVerification') sheet.section = body.section
      if (method === 'sidebarFocus') return { problems: [] }
      return true
    }
  }
  const background = process.env.TREZI_NATIVE_BACKGROUND_TEST
  process.env.TREZI_NATIVE_BACKGROUND_TEST = '1'
  const { restoreSmokeState } = await import('../src/native/smoke-restore.ts')
  // Other restore steps need the live app; only the sheet step matters here.
  await restoreSmokeState(host, '').catch(() => {})
  if (background === undefined) delete process.env.TREZI_NATIVE_BACKGROUND_TEST
  else process.env.TREZI_NATIVE_BACKGROUND_TEST = background
  const sheetCalls = requests.filter((r) => /^sheetPerform|^settingsVerification/.test(r))
  assert.deepEqual(sheetCalls, [
    'sheetPerform:back',
    'settingsVerification:general',
    'sheetPerform:cancel'
  ])
  assert.equal(sheet.section, 'general')
  assert.equal(sheet.visible, false)
}

{
  // native-chat-scroll: every chatAcceptance request activates first; a host that still answers
  // "Chat must be foreground" gets the same request once more, and nothing else is retried.
  const { foregroundChatHost } = await import('./helpers/chat-foreground.mjs')
  const sent = []
  let refusals = 0
  const fake = {
    marker: 'bridge',
    send() {
      return 'sent'
    },
    async request(method, body) {
      sent.push([method, body])
      if (method === 'chatAcceptance' && refusals > 0) {
        refusals--
        throw new Error('Chat must be foreground')
      }
      if (method === 'chatAcceptance' && body?.fail) throw new Error('Unknown scroller override x')
      return { method, body }
    }
  }
  const warnings = []
  const host = foregroundChatHost(fake, (line) => warnings.push(line))
  assert.equal(host.marker, 'bridge', 'other host members pass through')
  assert.equal(host.send(), 'sent', 'methods stay bound to the bridge')

  await host.request('chatAcceptance', { capture: true })
  assert.deepEqual(sent, [['chatAcceptance', { capture: true, prepare: true }]])
  sent.length = 0
  await host.request('chatInspect')
  assert.deepEqual(sent, [['chatInspect', undefined]], 'other requests are not prepared')
  sent.length = 0

  refusals = 1
  const result = await host.request('chatAcceptance', { width: 320, hoverMessage: '' })
  assert.deepEqual(
    sent,
    Array(2).fill(['chatAcceptance', { width: 320, hoverMessage: '', prepare: true }]),
    'one refusal: the same state is sent again after reactivation'
  )
  assert.deepEqual(result.body, { width: 320, hoverMessage: '', prepare: true })
  assert.equal(warnings.length, 1)
  sent.length = 0

  refusals = 2
  await assert.rejects(host.request('chatAcceptance', {}), /Chat must be foreground/)
  assert.equal(sent.length, 2, 'a second refusal fails the step: one retry only')
  sent.length = 0

  await assert.rejects(host.request('chatAcceptance', { fail: true }), /Unknown scroller override/)
  assert.equal(sent.length, 1, 'other errors are never retried')
}

console.log(
  'Native smoke runner: failures collected, dependents skipped with reasons, independent checks continue, summary format fixed, focus restored and retried once, Settings restored to General, chat acceptance reactivated and retried once.'
)
