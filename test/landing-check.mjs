// LKM-195: after a turn lands, Trezi checks the preview itself (console errors since the
// landing and a capture) and posts one compact row, so no visual check stays "pending".
import assert from 'node:assert/strict'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { newChat } from '../src/native/chat-state.ts'
import {
  checkAfterLanding,
  LANDING_CHECK,
  LandingChecks,
  landingCheckMessage
} from '../src/native/landing-check.ts'

const SERVER = 'http://localhost:5173/'
const JPEG = Buffer.from('fake jpeg bytes').toString('base64')

/** A host on a virtual clock: `wait` advances time and yields. */
function fakeHost(overrides = {}) {
  let now = 1_000_000
  const calls = { errors: 0, capture: 0, waited: 0 }
  const host = {
    server: () => SERVER,
    url: () => `${SERVER}work/article`,
    errors: async () => [],
    capture: async () => JPEG,
    wait: async (ms) => {
      calls.waited += ms
      now += ms
      await Promise.resolve()
    },
    now: () => now,
    ...overrides
  }
  const counted = {
    ...host,
    errors: async () => {
      calls.errors++
      return host.errors()
    },
    capture: async () => {
      calls.capture++
      return host.capture()
    }
  }
  return { host: counted, calls, at: () => now }
}

// A clean landing: the row says so and carries the capture as a thumbnail.
{
  const { host, calls } = fakeHost()
  const check = await checkAfterLanding('/repo', 0, host)
  assert.deepEqual(check, {
    status: 'clean',
    line: 'Checked after landing: no console errors',
    errors: [],
    thumbnail: `data:image/jpeg;base64,${JPEG}`
  })
  assert.ok(calls.waited >= LANDING_CHECK.settleMs, 'It waits for the reload before looking')
  assert.equal(calls.capture, 1)
}

// Errors logged since the landing count; older ones (before the turn) do not. The row
// lists the first three, collapsed to one line and cut, and the line counts all.
{
  const landedAt = 5000
  const long = `TypeError: ${'x'.repeat(400)}`
  const { host } = fakeHost({
    errors: async () => [
      { text: 'Old error from before the turn', at: landedAt - 1 },
      { text: 'ReferenceError: Hero is not defined\n    at App', at: landedAt + 10 },
      { text: long, at: landedAt + 20 },
      { text: 'Third', at: landedAt + 30 },
      { text: 'Fourth', at: landedAt + 40 }
    ]
  })
  const check = await checkAfterLanding('/repo', landedAt, host)
  assert.equal(check.status, 'errors')
  assert.equal(check.line, 'Checked after landing: 4 console errors')
  assert.equal(check.errors.length, LANDING_CHECK.shownErrors)
  assert.equal(check.errors[0], 'ReferenceError: Hero is not defined at App')
  assert.equal(check.errors[1].length, LANDING_CHECK.errorChars)
  assert.ok(check.errors[1].endsWith('…'))
  assert.ok(!check.errors.some((e) => e.includes('Old error')), 'Pre-existing errors are ignored')
  const one = await checkAfterLanding(
    '/repo',
    0,
    fakeHost({ errors: async () => [{ text: 'Boom', at: 1 }] }).host
  )
  assert.equal(one.line, 'Checked after landing: 1 console error')
}

// The preview cannot be checked: the row says why instead of leaving it pending, and
// gives up at the deadline without capturing anything.
for (const [overrides, reason] of [
  [{ server: () => null }, 'the preview is not running'],
  [{ url: () => null }, 'the preview did not load'],
  [{ url: () => 'http://localhost:4000/' }, 'the preview is showing another project'],
  [{ errors: async () => null }, 'the preview did not finish loading']
]) {
  const { host, calls } = fakeHost(overrides)
  const check = await checkAfterLanding('/repo', 0, host)
  assert.deepEqual(check, {
    status: 'unchecked',
    line: `Not checked after landing: ${reason}`,
    errors: []
  })
  assert.equal(calls.capture, 0)
  assert.ok(calls.waited >= LANDING_CHECK.settleMs + LANDING_CHECK.readyMs)
  assert.ok(calls.waited < LANDING_CHECK.settleMs + LANDING_CHECK.restartReadyMs)
}

// It polls until the instrumentation is ready; an environment restart waits longer.
{
  // Ready after 30 s: past the normal deadline, within the restart one.
  let readyAt = Infinity
  const { host, calls, at } = fakeHost({ errors: async () => (at() >= readyAt ? [] : null) })
  readyAt = at() + 30_000
  const check = await checkAfterLanding('/repo', 0, host, { restart: true })
  assert.equal(check.status, 'clean')
  assert.ok(at() >= readyAt)
  assert.ok(calls.errors > 2, 'Polled the console until ready')
}

// A capture too large for chat frames is left out; a failed capture still reports.
{
  const big = 'A'.repeat(Math.ceil((LANDING_CHECK.thumbnailBytes / 3) * 4) + 8)
  const large = await checkAfterLanding('/repo', 0, fakeHost({ capture: async () => big }).host)
  assert.equal(large.status, 'clean')
  assert.equal(large.thumbnail, undefined)
  const failed = await checkAfterLanding(
    '/repo',
    0,
    fakeHost({
      capture: async () => {
        throw new Error('no snapshot')
      }
    }).host
  )
  assert.equal(failed.status, 'clean')
  assert.equal(failed.thumbnail, undefined)
}

// Cancelled while waiting: nothing.
{
  const check = await checkAfterLanding('/repo', 0, fakeHost().host, { cancelled: () => true })
  assert.equal(check, null)
}

// LandingChecks: one row per landing with files; a newer landing in the same chat
// replaces the waiting one; closing the chat cancels it; other chats are independent.
{
  const posted = []
  const { host } = fakeHost()
  const checks = new LandingChecks(host, (key, check, afterId) =>
    posted.push({ key, check, afterId })
  )
  await checks.landed('chat-a', '/repo', [], 'm1')
  assert.equal(posted.length, 0, 'A landing that changed no file is not checked')
  const first = checks.landed('chat-a', '/repo', ['src/App.tsx'], 'm1')
  const second = checks.landed('chat-a', '/repo', ['src/App.tsx'], 'm2')
  const other = checks.landed('chat-b', '/repo', ['src/Other.tsx'], 'm3')
  await Promise.all([first, second, other])
  assert.deepEqual(
    posted.map((p) => [p.key, p.afterId, p.check.status]),
    [
      ['chat-a', 'm2', 'clean'],
      ['chat-b', 'm3', 'clean']
    ]
  )
  posted.length = 0
  const closed = checks.landed('chat-a', '/repo', ['src/App.tsx'], 'm4')
  checks.cancel('chat-a')
  await closed
  assert.equal(posted.length, 0, 'A closed chat gets no row')
}

// The row: Copy text holds the line and errors; the check reaches the host unchanged.
{
  const check = {
    status: 'errors',
    line: 'Checked after landing: 1 console error',
    errors: ['Boom'],
    thumbnail: `data:image/jpeg;base64,${JPEG}`
  }
  const message = landingCheckMessage(check, 42)
  assert.equal(message.role, 'assistant')
  assert.equal(message.text, 'Checked after landing: 1 console error\nBoom')
  assert.equal(message.at, 42)
  const chat = newChat('chat-a')
  chat.messages.push(message)
  const shown = snapshot(chat, []).messages.at(-1)
  assert.deepEqual(shown.landingCheck, check)
}

console.log('LANDING CHECK OK — clean, errors since landing, unchecked reasons, polling, rows')
