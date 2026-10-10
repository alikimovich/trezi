// LKM-225, the recoveries around a failed turn, with no provider, network or Git process:
// - statuses: the shared status lines parse back to their meaning;
// - summary: an unclassified error keeps a short redacted first line as its row line;
// - incidents: one record per class per turn with its final outcome (recovered, fell back, failed);
// - git lock: a Git lock error clears a stale lock (through the owner) and runs the effect once
//   more; a fresh lock, a live Git or another error does not;
// - helper: a crashed helper restarts and resumes the same turn, at most twice, never after Stop,
//   a violation or in a background run;
// - fallback: a provider that could not connect hands the turn to the other one (with the
//   conversation), the chat returns on the next message, and the setting gates it;
// - setting: Settings → AI Providers "Automatic provider fallback";
// - doctor: the deterministic diagnosis (cause, fix applied, next step) for an unrecovered class.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helperProvider } from '../src/main/backends/helper-session.ts'
import { CONTINUE_PROMPT, MAX_HELPER_RESTARTS } from '../src/main/backends/turn-recovery.ts'
import { setProviderOwner } from '../src/main/provider-owner.ts'
import { setRepositoryOwner } from '../src/main/repository-owner.ts'
import { summarizeError } from '../src/main/self-heal/catalog.ts'
import {
  fallbackCandidate,
  PROVIDER_FALLBACK_KEY,
  setFallbackLoginProbe,
  setProviderFallbackSource
} from '../src/main/self-heal/fallback.ts'
import { withGitLockRecovery } from '../src/main/self-heal/git-lock.ts'
import { createIncidentTracker } from '../src/main/self-heal/incidents.ts'
import {
  fallbackNote,
  parseRecoveryStatus,
  RECOVERED_STATUS,
  RESTARTING_STATUS,
  reconnectingStatus
} from '../src/main/self-heal/status.ts'
import { newChat, reduce } from '../src/native/chat-state.ts'
import { withProviderFallbackSetting } from '../src/native/settings-provider-fallback.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, label, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await sleep(10)
  }
}

// --- statuses -----------------------------------------------------------------------------
assert.deepEqual(parseRecoveryStatus(reconnectingStatus('codex')), { kind: 'reconnecting' })
assert.deepEqual(parseRecoveryStatus(RESTARTING_STATUS), { kind: 'restarting' })
assert.deepEqual(parseRecoveryStatus(RECOVERED_STATUS), { kind: 'recovered' })
assert.equal(fallbackNote('codex', 'claude'), 'Codex could not connect; this turn used Claude')
assert.deepEqual(parseRecoveryStatus(fallbackNote('codex', 'claude')), { kind: 'fallback' })
assert.equal(parseRecoveryStatus('Reading files…'), null)

// --- the row line of an unclassified error ------------------------------------------------
assert.equal(summarizeError('boom'), 'boom')
assert.equal(summarizeError('\n  ⚠️  First line  \nsecond line'), 'First line')
assert.equal(summarizeError(''), 'Something went wrong')
assert.ok(summarizeError('x'.repeat(500)).length <= 140)
assert.doesNotMatch(summarizeError('Authorization: Bearer abcdefgh12345678'), /abcdefgh12345678/)
{
  const view = newChat('unknown-row')
  view.isRunning = true
  reduce(view, { type: 'error', message: 'Re-add the key in Settings.\nstack line 2' })
  assert.equal(view.messages.at(-1).incident.line, 'Re-add the key in Settings.')
}

// --- one incident record per class per turn -----------------------------------------------
{
  const records = []
  const tracker = createIncidentTracker((record) => records.push(record))
  const feed = (...events) => {
    for (const event of events) tracker.observe('chat', event)
  }
  const status = (text) => ({ type: 'status', text })
  const error = (message) => ({ type: 'error', message })
  const summary = () => records.splice(0).map((r) => [r.code, r.outcome, r.attempts])

  feed(status(reconnectingStatus('codex')), status(RECOVERED_STATUS), { type: 'done' })
  assert.deepEqual(summary(), [['provider-network', 'recovered', 1]])
  feed(
    status(reconnectingStatus('codex')),
    error('workspace routing discovery failed'),
    error('Connection failed: error sending request'),
    { type: 'done' }
  )
  assert.deepEqual(summary(), [['provider-network', 'failed', 1]], 'two errors, one record')
  feed(
    status(reconnectingStatus('codex')),
    status(fallbackNote('codex', 'claude')),
    { type: 'delta', text: 'hi' },
    { type: 'done' }
  )
  assert.deepEqual(summary(), [['provider-network', 'fell-back', 1]])
  feed(
    status(RESTARTING_STATUS),
    status(RESTARTING_STATUS),
    error('The provider helper stopped unexpectedly (status 7)'),
    error('Something else entirely'),
    { type: 'done' }
  )
  assert.deepEqual(
    summary().sort(),
    [
      ['helper-crash', 'failed', 2],
      ['unknown', 'failed', 0]
    ],
    'one record per class'
  )
  feed({ type: 'done' })
  assert.deepEqual(summary(), [], 'a clean turn leaves nothing')
  // A provider that ends a failed turn with the error alone still closes the turn.
  feed(error('workspace routing discovery failed'))
  await sleep(700)
  assert.deepEqual(summary(), [['provider-network', 'failed', 0]])
}

// --- Git lock recovery through the owner --------------------------------------------------
{
  const cleared = []
  const stale = new Set()
  setRepositoryOwner({
    clearStaleLock: async (root) => {
      cleared.push(root)
      return { removed: stale.has(root), reason: stale.has(root) ? 'removed' : 'fresh', age: 90 }
    }
  })
  try {
    const lock = new Error('fatal: Unable to create ‘/r/.git/index.lock’: File exists.')
    let calls = 0
    const flaky = async () => {
      if (++calls === 1) throw lock
      return 'done'
    }
    stale.add('/r')
    assert.equal(await withGitLockRecovery(['/r'], flaky), 'done', 'a stale lock: run again')
    assert.equal(calls, 2)
    calls = 0
    stale.clear()
    await assert.rejects(withGitLockRecovery(['/r'], flaky), /index\.lock/, 'a fresh lock stays')
    assert.equal(calls, 1)
    cleared.length = 0
    await assert.rejects(
      withGitLockRecovery(['/r'], async () => {
        throw new Error('not a lock problem')
      }),
      /not a lock/
    )
    assert.deepEqual(cleared, [], 'another error never asks the owner')
    stale.add('/wt')
    calls = 0
    assert.equal(await withGitLockRecovery(['/live', '/wt'], flaky), 'done', 'either index')
    // A refusal reported as a result (`committed: false`) is checked the same way.
    let tries = 0
    const result = await withGitLockRecovery(
      ['/wt'],
      async () => ({ committed: ++tries > 1 }),
      (r) => !r.committed
    )
    assert.deepEqual([result.committed, tries], [true, 2])
  } finally {
    setRepositoryOwner(null)
  }
}

// --- the helper session's recoveries ------------------------------------------------------
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-self-heal-recovery-')))
const ok = async () => {}
const CRASH = 'The provider helper stopped unexpectedly (status 7). Send your message again.'
const NETWORK = 'workspace routing discovery failed'
const fail = (h, message, exit) => {
  h.handlers.event({ type: 'error', message })
  h.handlers.event({ type: 'done' })
  if (exit) h.handlers.exit(exit)
}
const answer = (h, text = 'ok') => {
  h.handlers.event({ type: 'delta', text })
  h.handlers.event({ type: 'done' })
}

/** A chat on `provider` whose helpers are scripted: `script(helper, text)` runs on every send. */
async function chatOn(provider, script, ctx = {}) {
  const helpers = []
  setProviderOwner({
    kind: 'swift',
    open: async () => ({ tools: [] }),
    openHelper: async (grant, start, handlers) => {
      helpers.push({ grant, start, handlers, sends: [], index: helpers.length })
      return { tools: [] }
    },
    send: async (session, text) => {
      const h = helpers.find((x) => x.grant.session === session)
      h.sends.push(text)
      script(h, text)
    },
    cancel: async () => ({ escalate: false }),
    close: ok,
    resume: ok,
    answer: ok,
    configure: ok
  })
  const events = []
  const s = await helperProvider(provider).startSession(ROOT, { provider }, () => null, {
    emitKey: `chat-${provider}`,
    liveRoot: ROOT,
    onEvent: (e) => events.push(e),
    ...ctx
  })
  const turn = async (text) => {
    const start = events.length
    s.send(text)
    await until(() => events.slice(start).some((e) => e.type === 'done'), `turn ${text}`)
    await sleep(60) // a second `done` would land here
    return events.slice(start)
  }
  return { s, helpers, events, turn }
}
const shape = (events) =>
  events.map((e) =>
    e.type === 'status' ? e.text : e.type === 'delta' ? `delta:${e.text}` : e.type
  )

try {
  // A crash before any output: restart on the same conversation, resend the prompt, Recovered.
  {
    const c = await chatOn('claude', (h) => {
      if (h.index === 0) {
        h.handlers.record({ entries: [], sdkSessionId: 'sdk-1' })
        fail(h, CRASH, 'crashed')
      } else answer(h)
    })
    assert.deepEqual(shape(await c.turn('build it')), [
      RESTARTING_STATUS,
      'delta:ok',
      RECOVERED_STATUS,
      'done'
    ])
    assert.equal(c.helpers.length, 2)
    assert.equal(c.helpers[1].start.context.resumeSessionId, 'sdk-1', 'it resumes the session')
    assert.deepEqual(c.helpers[1].sends, ['build it'], 'the same prompt')
    assert.notEqual(c.helpers[1].grant.session, c.helpers[0].grant.session)
    // Later turns use the restarted helper.
    assert.deepEqual(shape(await c.turn('next')), ['delta:ok', 'done'])
    assert.equal(c.helpers.length, 2)
  }
  // A crash after output: the turn continues instead of repeating the prompt.
  {
    const c = await chatOn('claude', (h, text) => {
      if (h.index === 0) {
        h.handlers.event({ type: 'delta', text: 'part' })
        fail(h, CRASH, 'crashed')
      } else answer(h, text === CONTINUE_PROMPT ? 'rest' : 'wrong')
    })
    assert.deepEqual(shape(await c.turn('long job')), [
      'delta:part',
      RESTARTING_STATUS,
      'delta:rest',
      RECOVERED_STATUS,
      'done'
    ])
    assert.deepEqual(c.helpers[1].sends, [CONTINUE_PROMPT])
  }
  // A helper that always crashes: two restarts, then the one error and one done.
  {
    const c = await chatOn('claude', (h) => fail(h, CRASH, 'crashed'))
    const events = await c.turn('doomed')
    assert.deepEqual(shape(events), [RESTARTING_STATUS, RESTARTING_STATUS, 'error', 'done'])
    assert.equal(c.helpers.length, 1 + MAX_HELPER_RESTARTS)
    assert.match(events.find((e) => e.type === 'error').message, /stopped unexpectedly/)
  }
  // Stop, a broken grant and a background run are never restarted.
  {
    const stopped = await chatOn('claude', () => {})
    stopped.s.send('hang')
    await sleep(30)
    await stopped.s.interrupt()
    fail(stopped.helpers[0], CRASH, 'crashed')
    await until(() => stopped.events.some((e) => e.type === 'done'), 'stopped')
    assert.deepEqual(shape(stopped.events), ['error', 'done'])
    assert.equal(stopped.helpers.length, 1)

    const violated = await chatOn('claude', (h) => fail(h, CRASH, 'violation'))
    assert.deepEqual(shape(await violated.turn('x')), ['error', 'done'])
    assert.equal(violated.helpers.length, 1)

    const background = await chatOn('claude', (h) => fail(h, CRASH, 'crashed'), {
      sessionId: 'spawn-1'
    })
    assert.deepEqual(shape(await background.turn('x')), ['error', 'done'])
    assert.equal(background.helpers.length, 1)
  }

  // Fallback: Codex could not connect; the turn runs on Claude with the conversation, once.
  setFallbackLoginProbe(async (provider) => provider === 'claude')
  setProviderFallbackSource(() => null)
  {
    const history = [
      { role: 'user', text: 'earlier question', at: 1 },
      { role: 'assistant', text: 'earlier answer', at: 2 },
      { role: 'user', text: 'new question', at: 3 }
    ]
    const c = await chatOn('codex', (h) => {
      if (h.grant.provider === 'codex' && h.index === 0) {
        h.handlers.record({ entries: history })
        fail(h, NETWORK)
      } else if (h.grant.provider === 'claude') {
        h.handlers.record({ entries: [], sdkSessionId: 'claude-sdk' })
        answer(h, 'from claude')
      } else answer(h, 'from codex')
    })
    assert.deepEqual(shape(await c.turn('new question')), [
      fallbackNote('codex', 'claude'),
      'delta:from claude',
      'done'
    ])
    const [first, second] = c.helpers
    assert.equal(second.grant.provider, 'claude')
    assert.equal(second.start.options.provider, 'claude')
    assert.equal(second.start.options.model, undefined, "the failed provider's model is dropped")
    assert.equal(second.start.context.resumeSessionId, undefined)
    assert.match(second.sends[0], /earlier question/)
    assert.match(second.sends[0], /earlier answer/)
    assert.match(second.sends[0], /new question$/)
    assert.equal(c.s.record.sdkSessionId, undefined, "Claude's session id is not the chat's")
    assert.equal(c.s.options.provider, 'codex', 'the chat keeps its own provider')
    // The next message goes back to Codex, which gets the conversation once.
    assert.deepEqual(shape(await c.turn('and now')), ['delta:from codex', 'done'])
    assert.equal(c.helpers.length, 3)
    assert.equal(c.helpers[2].grant.provider, 'codex')
    assert.match(c.helpers[2].sends[0], /earlier answer/)
    assert.equal(first.sends.length, 1)
    // A later network failure falls back again, not forever within one turn.
    assert.equal(c.s.record.sdkSessionId, undefined)
  }
  // Not for a Claude-side failure that is not the network, a connection's own endpoint, or
  // when the setting is off or the other provider is not signed in.
  {
    const run = async (setup) => {
      setup()
      const c = await chatOn('codex', (h) =>
        h.grant.provider === 'codex' ? fail(h, NETWORK) : answer(h)
      )
      return { events: await c.turn('x'), helpers: c.helpers }
    }
    for (const [why, setup] of [
      ['the setting is off', () => setProviderFallbackSource(() => 'false')],
      ['the other provider is signed out', () => setFallbackLoginProbe(async () => false)]
    ]) {
      const { events, helpers } = await run(setup)
      assert.deepEqual(shape(events), ['error', 'done'], why)
      assert.equal(helpers.length, 1, why)
      setProviderFallbackSource(() => null)
      setFallbackLoginProbe(async (provider) => provider === 'claude')
    }
    assert.equal(fallbackCandidate('codex', { provider: 'codex', connectionId: 'c1' }), null)
    assert.equal(fallbackCandidate('gemini', { provider: 'gemini' }), null)
    assert.equal(fallbackCandidate('claude', { provider: 'claude' }), 'codex')
    const auth = await chatOn('codex', (h) => fail(h, 'Not logged in · Please run /login'))
    assert.deepEqual(shape(await auth.turn('x')), ['error', 'done'], 'sign-in errors stay')
    assert.equal(auth.helpers.length, 1)
  }
} finally {
  setProviderOwner(null)
  setFallbackLoginProbe(null)
  setProviderFallbackSource(() => null)
  rmSync(ROOT, { recursive: true, force: true })
}

// --- Settings → AI Providers → Automatic provider fallback -------------------------------------
{
  const values = {}
  const handled = []
  const sheets = { current: null, refresh() {} }
  const settings = {
    sheets,
    async open() {
      sheets.current = {
        state: {
          title: 'Settings',
          fields: [
            { id: 'default', section: 'general' },
            { id: 'connection', section: 'providers' },
            { id: 'projectUi', section: 'experimental' }
          ]
        },
        handle: async (action) => handled.push(action.action)
      }
    }
  }
  const preferences = {
    get: (key) => values[key] ?? null,
    set: async (key, value) => {
      values[key] = value
    }
  }
  withProviderFallbackSetting(settings, preferences)
  await settings.open()
  await settings.open()
  assert.deepEqual(
    sheets.current.state.fields.map((f) => f.id),
    ['default', 'connection', 'providerFallback', 'projectUi'],
    'one field, after the provider picker'
  )
  assert.equal(sheets.current.state.fields[2].section, 'providers')
  assert.equal(sheets.current.state.fields[2].value, 'on', 'on by default')
  await sheets.current.handle({ action: 'save', values: { providerFallback: 'off' } })
  assert.equal(values[PROVIDER_FALLBACK_KEY], 'false')
  await sheets.current.handle({ action: 'save', values: { providerFallback: 'on' } })
  assert.equal(values[PROVIDER_FALLBACK_KEY], null)
  await assert.rejects(sheets.current.handle({ action: 'save', values: { providerFallback: 'x' } }))
  assert.deepEqual(handled, ['save', 'save'])
}

// The doctor: deterministic diagnosis with read-only probes and one safe fix.
{
  const { diagnose } = await import('../src/main/self-heal/doctor.ts')
  const locks = []
  const fixedLock = await diagnose('git-lock', {
    root: '/r',
    clearLock: async (root) => {
      locks.push(root)
      return { removed: true }
    }
  })
  assert.deepEqual(locks, ['/r'])
  assert.match(fixedLock.fixApplied, /stale lock/)
  const fresh = await diagnose('git-lock', {
    root: '/r',
    clearLock: async () => ({ removed: false, reason: 'fresh' })
  })
  assert.equal(fresh.fixApplied, null)
  assert.match(fresh.nextStep, /Wait/)
  const full = await diagnose('disk-full', { freeBytes: async () => 1024 })
  assert.match(full.cause, /no space/)
  assert.equal(full.fixApplied, null)
  const freed = await diagnose('disk-full', { freeBytes: async () => 10 * 1024 ** 3 })
  assert.match(freed.cause, /available now/)
  const unknown = await diagnose('unknown')
  assert.ok(unknown.cause && unknown.nextStep && unknown.fixApplied === null)
  for (const code of [
    'provider-network',
    'provider-auth',
    'provider-limit',
    'model-unavailable',
    'helper-crash',
    'dev-server',
    'dependency-install',
    'conflict',
    'landing',
    'stale-preview'
  ]) {
    const d = await diagnose(code)
    assert.ok(d.cause && d.nextStep, code)
  }
}

console.log(
  'SELF-HEAL-RECOVERY OK — statuses, row summary, incident records, Git lock, helper restart, provider fallback, setting and doctor'
)
