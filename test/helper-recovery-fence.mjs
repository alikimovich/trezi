// LKM-580: a helper recovery (restart after a crash, fallback after a network failure) that is
// still awaiting the old helper's exit, the provider probe or the new helper's open must not
// send to the new helper once the user pressed Stop or a newer turn began. Drives the real
// helper session (`helperProvider`) against a scripted provider owner whose awaits are gated
// by hand, so every ordering is explicit; no provider, network or desktop.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helperProvider } from '../src/main/backends/helper-session.ts'
import { setProviderOwner } from '../src/main/provider-owner.ts'
import { setFallbackLoginProbe, setProviderFallbackSource } from '../src/main/self-heal/fallback.ts'
import { fallbackNote, RECOVERED_STATUS, RESTARTING_STATUS } from '../src/main/self-heal/status.ts'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-helper-recovery-fence-')))
const CRASH = 'The provider helper stopped unexpectedly (status 7). Send your message again.'
const NETWORK = 'workspace routing discovery failed'
const ok = async () => {}

const gate = () => {
  let open
  const promise = new Promise((resolve) => {
    open = resolve
  })
  return { promise, open }
}
/** Lets every pending promise continuation run (no timers involved). */
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
}
const until = async (condition, label) => {
  for (let i = 0; i < 200 && !condition(); i++) await settle()
  assert.ok(condition(), `never reached: ${label}`)
}
const fail = (h, message, exit) => {
  h.handlers.event({ type: 'error', message })
  h.handlers.event({ type: 'done' })
  if (exit) h.handlers.exit(exit)
}
const answer = (h, text = 'ok') => {
  h.handlers.event({ type: 'delta', text })
  h.handlers.event({ type: 'done' })
}
const shape = (events) =>
  events.map((e) =>
    e.type === 'status' ? e.text : e.type === 'delta' ? `delta:${e.text}` : e.type
  )

/** A chat whose helper opens after the first wait on `opens[n]` when one is set. */
async function chatOn(provider, script, opens = {}) {
  const helpers = []
  const cancels = []
  setProviderOwner({
    kind: 'swift',
    open: async () => ({ tools: [] }),
    openHelper: async (grant, start, handlers) => {
      const index = helpers.length
      helpers.push({ grant, start, handlers, sends: [], index, opened: false })
      if (opens[index]) await opens[index].promise
      helpers[index].opened = true
      return { tools: [] }
    },
    send: async (session, text) => {
      const h = helpers.find((x) => x.grant.session === session)
      h.sends.push(text)
      script(h, text)
    },
    cancel: async (session) => {
      cancels.push(session)
      return { escalate: false }
    },
    close: ok,
    resume: ok,
    answer: ok,
    configure: ok
  })
  const events = []
  const s = await helperProvider(provider).startSession(ROOT, { provider }, () => null, {
    emitKey: `chat-${provider}`,
    liveRoot: ROOT,
    onEvent: (e) => events.push(e)
  })
  const dones = () => events.filter((e) => e.type === 'done').length
  return { s, helpers, events, cancels, dones }
}

const failures = []
/** Runs one ordering; a failure is reported with the others, not instead of them. */
const scenario = async (name, run) => {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`FAIL ${name}: ${error.message.split('\n')[0]}`)
  }
}

setProviderFallbackSource(() => null)
try {
  // Control: a gated reopen that nobody interrupts still resumes the turn once.
  await scenario('control: uninterrupted gated reopen', async () => {
    const reopened = gate()
    const c = await chatOn(
      'claude',
      (h) => (h.index === 0 ? fail(h, CRASH, 'crashed') : answer(h)),
      { 1: reopened }
    )
    c.s.send('build it')
    await until(() => c.helpers.length === 2, 'reopen started')
    reopened.open()
    await until(() => c.dones() === 1, 'turn ended')
    await settle()
    assert.deepEqual(shape(c.events), [RESTARTING_STATUS, 'delta:ok', RECOVERED_STATUS, 'done'])
    assert.deepEqual(c.helpers[1].sends, ['build it'])
  })

  // Stop while the recovery waits for the crashed helper's exit: nothing restarts.
  await scenario('restart: Stop during exit wait', async () => {
    const c = await chatOn('claude', (h) => (h.index === 0 ? fail(h, CRASH) : answer(h)))
    c.s.send('build it')
    await until(() => c.helpers[0].sends.length === 1, 'first send')
    await settle()
    assert.deepEqual(shape(c.events), [], 'the crash is held while the exit is awaited')
    await c.s.interrupt()
    c.helpers[0].handlers.exit('crashed')
    await until(() => c.dones() === 1, 'stopped turn ended')
    await settle()
    assert.equal(c.helpers.length, 1, 'no helper started after Stop')
    assert.deepEqual(shape(c.events), ['error', 'done'], 'the held error ends the stopped turn')
  })

  // Stop while the new helper is opening: the opened helper is never sent the old turn.
  await scenario('restart: Stop during reopen', async () => {
    const reopened = gate()
    const c = await chatOn(
      'claude',
      (h) => (h.index === 0 ? fail(h, CRASH, 'crashed') : answer(h)),
      { 1: reopened }
    )
    c.s.send('build it')
    await until(() => c.helpers.length === 2, 'reopen started')
    await c.s.interrupt()
    reopened.open()
    await until(() => c.helpers[1].opened, 'reopen finished')
    await until(() => c.dones() === 1, 'stopped turn ended')
    await settle()
    assert.deepEqual(c.helpers[1].sends, [], 'no send after Stop')
    assert.deepEqual(shape(c.events), [RESTARTING_STATUS, 'error', 'done'])
    // The next message uses the helper that opened, once (this stub's cancel is a no-op; the
    // real owner may kill an opening helper at its deadline, and the chat is then rebuilt).
    c.s.send('next')
    await until(() => c.dones() === 2, 'next turn ended')
    await settle()
    assert.deepEqual(c.helpers[1].sends, ['next'])
    assert.equal(c.helpers.length, 2)
  })

  // Stop, then a new message while the recovery's helper is still opening: only the new turn
  // is sent, and the old turn's held error and done never land inside it.
  await scenario('restart: Stop then new turn during reopen', async () => {
    const reopened = gate()
    const c = await chatOn(
      'claude',
      (h, text) => (h.index === 0 ? fail(h, CRASH, 'crashed') : answer(h, `re:${text}`)),
      { 1: reopened }
    )
    c.s.send('build it')
    await until(() => c.helpers.length === 2, 'reopen started')
    await c.s.interrupt()
    c.s.send('next')
    reopened.open()
    await until(() => c.dones() >= 1, 'a turn ended')
    await settle()
    assert.deepEqual(c.helpers[1].sends, ['next'], 'the old turn is not resent')
    assert.deepEqual(shape(c.events), [RESTARTING_STATUS, 'delta:re:next', 'done'])
  })

  // A newer turn without Stop (the chat settled the old one) supersedes the recovery too.
  await scenario('restart: newer turn during reopen', async () => {
    const reopened = gate()
    const c = await chatOn(
      'claude',
      (h, text) => (h.index === 0 ? fail(h, CRASH, 'crashed') : answer(h, `re:${text}`)),
      { 1: reopened }
    )
    c.s.send('build it')
    await until(() => c.helpers.length === 2, 'reopen started')
    c.s.send('next')
    reopened.open()
    await until(() => c.dones() >= 1, 'a turn ended')
    await settle()
    assert.deepEqual(c.helpers[1].sends, ['next'], 'the superseded turn is not resent')
    assert.deepEqual(shape(c.events), [RESTARTING_STATUS, 'delta:re:next', 'done'])
  })

  // Fallback: Stop while the other provider's sign-in is probed: nothing opens.
  await scenario('fallback: Stop during sign-in probe', async () => {
    const probed = gate()
    setFallbackLoginProbe(async (provider) => {
      await probed.promise
      return provider === 'claude'
    })
    const c = await chatOn('codex', (h) =>
      h.grant.provider === 'codex' ? fail(h, NETWORK) : answer(h, 'from claude')
    )
    c.s.send('question')
    await until(() => c.helpers[0].sends.length === 1, 'first send')
    // The held `done` hands the turn to the fallback, which is now awaiting the probe.
    await settle()
    await c.s.interrupt()
    probed.open()
    await until(() => c.dones() === 1, 'stopped turn ended')
    await settle()
    assert.equal(c.helpers.length, 1, 'no fallback helper after Stop')
    assert.deepEqual(shape(c.events), ['error', 'done'])
  })

  // Fallback: Stop while the fallback helper opens: it is not sent the turn, no note shows.
  await scenario('fallback: Stop during open', async () => {
    setFallbackLoginProbe(async (provider) => provider === 'claude')
    const opened = gate()
    const c = await chatOn(
      'codex',
      (h) => (h.grant.provider === 'codex' ? fail(h, NETWORK) : answer(h, 'from claude')),
      { 1: opened }
    )
    c.s.send('question')
    await until(() => c.helpers.length === 2, 'fallback open started')
    await c.s.interrupt()
    opened.open()
    await until(() => c.helpers[1].opened, 'fallback open finished')
    await until(() => c.dones() === 1, 'stopped turn ended')
    await settle()
    assert.deepEqual(c.helpers[1].sends, [], 'no fallback send after Stop')
    assert.deepEqual(shape(c.events), ['error', 'done'])
    assert.ok(!c.events.some((e) => e.text === fallbackNote('codex', 'claude')))
  })
  await scenario('fallback: newer turn during open', async () => {
    setFallbackLoginProbe(async (provider) => provider === 'claude')
    const opened = gate()
    const c = await chatOn(
      'codex',
      (h, text) =>
        h.grant.provider === 'codex' && h.index === 0 ? fail(h, NETWORK) : answer(h, `re:${text}`),
      { 1: opened }
    )
    c.s.send('question')
    await until(() => c.helpers.length === 2, 'fallback open started')
    c.s.send('next')
    opened.open()
    await until(() => c.dones() >= 1, 'a turn ended')
    await settle()
    assert.deepEqual(c.helpers[1].sends, [], 'the fallback helper is not sent the old turn')
    assert.equal(c.helpers.length, 3, 'the newer turn returns to the chat provider')
    assert.equal(c.helpers[2].grant.provider, 'codex')
    assert.equal(c.helpers[2].sends.length, 1)
    assert.match(c.helpers[2].sends[0], /next$/)
    assert.deepEqual(
      shape(c.events).filter((e) => e !== 'error'),
      [`delta:re:${c.helpers[2].sends[0]}`, 'done']
    )
    assert.ok(!c.events.some((e) => e.type === 'error'))
  })
} finally {
  setProviderOwner(null)
  setFallbackLoginProbe(null)
  setProviderFallbackSource(() => null)
  rmSync(ROOT, { recursive: true, force: true })
}

assert.deepEqual(failures, [], 'every ordering holds')
console.log('HELPER-RECOVERY-FENCE OK — restart and fallback never send after Stop or a newer turn')
