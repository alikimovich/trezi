// LKM-195/LKM-210: after a turn lands, Trezi checks the preview itself. A pass shows
// nothing; a problem is one compact warning row with Ask agent to fix and Show preview,
// and the agent hears of it on its next turn. A landed revision the agent already looked
// at in the preview during its turn is not checked again.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  agentSawRevision,
  forgetLandingContext,
  landingCheckContext,
  noteServedRevision
} from '../src/main/landing-context.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { newChat } from '../src/native/chat-state.ts'
import {
  checkAfterLanding,
  LANDING_CHECK,
  LandingChecks,
  landingCheckMessage,
  placeLandingCheck
} from '../src/native/landing-check.ts'

const SERVER = 'http://localhost:5173/'
const LANDED = 'a'.repeat(40)
const OLDER = 'b'.repeat(40)

/** A host on a virtual clock: `wait` advances time and yields. */
function fakeHost(overrides = {}) {
  let now = 1_000_000
  const calls = { errors: 0, page: 0, waited: 0 }
  const host = {
    server: () => SERVER,
    url: () => `${SERVER}work/article`,
    errors: async () => [],
    status: () => 200,
    // The document started before the landing and hot-reloaded since.
    page: async () => ({ blank: false, overlay: null, startedAt: -1, servedRevision: OLDER }),
    head: async () => LANDED,
    turn: () => null,
    verified: () => false,
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
    page: async (root) => {
      calls.page++
      return host.page(root)
    }
  }
  return { host: counted, calls, at: () => now }
}
const check = (overrides, landedAt = 0, options = {}) =>
  checkAfterLanding('/repo', landedAt, LANDED, fakeHost(overrides).host, options)

// A clean landing passes: no row, nothing for the agent. A page that only hot-reloaded
// keeps its older document revision, which is not a problem.
{
  const { host, calls } = fakeHost()
  assert.equal(await checkAfterLanding('/repo', 0, LANDED, host), 'passed')
  assert.ok(calls.waited >= LANDING_CHECK.settleMs, 'It waits for the reload before looking')
}

// Console errors since the landing count; older ones (before the turn) do not. The row
// lists the first three, collapsed to one line and cut, and the line counts all.
{
  const landedAt = 5000
  const long = `TypeError: ${'x'.repeat(400)}`
  const result = await check(
    {
      errors: async () => [
        { text: 'Old error from before the turn', at: landedAt - 1 },
        { text: 'ReferenceError: Hero is not defined\n    at App', at: landedAt + 10 },
        { text: long, at: landedAt + 20 },
        { text: 'Third', at: landedAt + 30 },
        { text: 'Fourth', at: landedAt + 40 }
      ]
    },
    landedAt
  )
  assert.equal(result.problem, 'errors')
  assert.equal(result.line, '4 new console errors after landing')
  assert.equal(result.errors.length, LANDING_CHECK.shownErrors)
  assert.equal(result.errors[0], 'ReferenceError: Hero is not defined at App')
  assert.equal(result.errors[1].length, LANDING_CHECK.errorChars)
  assert.ok(result.errors[1].endsWith('…'))
  assert.ok(!result.errors.some((e) => e.includes('Old error')), 'Pre-existing errors are ignored')
  const one = await check({ errors: async () => [{ text: 'Boom', at: 1 }] })
  assert.equal(one.line, '1 new console error after landing')
  const old = await check({ errors: async () => [{ text: 'Old', at: 1 }] }, 2)
  assert.equal(old, 'passed', 'Only errors before the landing: passed')
}

// Every problem type: one row with its reason.
{
  const notLoaded = [await check({ url: () => null }), await check({ errors: async () => null })]
  for (const result of notLoaded)
    assert.deepEqual(result, {
      problem: 'not-loaded',
      line: 'The page did not load after landing',
      errors: []
    })
  assert.deepEqual(
    await check({ status: () => 500, errors: async () => [{ text: 'GET / 500', at: 1 }] }),
    {
      problem: 'server-error',
      line: 'The dev server answered HTTP 500 after landing',
      errors: ['GET / 500']
    }
  )
  assert.deepEqual(
    await check({
      page: async () => ({
        blank: false,
        overlay: '[plugin:vite:react-babel] Unexpected token (12:4)\n  10 | <div>',
        startedAt: -1,
        servedRevision: OLDER
      })
    }),
    {
      problem: 'server-error',
      line: 'The dev server reported an error after landing',
      errors: ['[plugin:vite:react-babel] Unexpected token (12:4) 10 | <div>']
    }
  )
  assert.deepEqual(
    await check({
      page: async () => ({ blank: true, overlay: null, startedAt: -1, servedRevision: OLDER })
    }),
    { problem: 'blank', line: 'The page is blank after landing', errors: [] }
  )
  // Reloaded after the landing yet serving another revision, or not reloaded after an
  // environment restart: stale. Once the live checkout moved on, a later check owns it.
  const reloaded = {
    page: async () => ({ blank: false, overlay: null, startedAt: 10, servedRevision: OLDER })
  }
  const stale = {
    problem: 'stale',
    line: `The preview serves ${OLDER.slice(0, 10)}, not the landed ${LANDED.slice(0, 10)}`,
    errors: []
  }
  assert.deepEqual(await check(reloaded, 5), stale)
  assert.deepEqual(await check({}, 5, { restart: true }), stale)
  assert.equal(await check({ ...reloaded, head: async () => 'c'.repeat(40) }, 5), 'passed')
  assert.equal(
    await check({
      page: async () => ({ blank: false, overlay: null, startedAt: 10, servedRevision: LANDED })
    }),
    'passed'
  )
}

// No preview of this project (no server, or another project shown): nothing to report.
for (const overrides of [{ server: () => null }, { url: () => 'http://localhost:4000/' }]) {
  const { host, calls } = fakeHost(overrides)
  assert.equal(await checkAfterLanding('/repo', 0, LANDED, host), 'skipped')
  assert.equal(calls.page, 0)
  assert.ok(calls.waited >= LANDING_CHECK.settleMs + LANDING_CHECK.readyMs)
  assert.ok(calls.waited < LANDING_CHECK.settleMs + LANDING_CHECK.restartReadyMs)
}

// It polls until the instrumentation is ready; an environment restart waits longer.
{
  let readyAt = Infinity
  const { host, calls, at } = fakeHost({ errors: async () => (at() >= readyAt ? [] : null) })
  readyAt = at() + 30_000
  const result = await checkAfterLanding('/repo', 0, LANDED, host, { restart: true })
  assert.equal(result.problem, 'stale', 'restart: the old document did not reload')
  assert.ok(at() >= readyAt)
  assert.ok(calls.errors > 2, 'Polled the console until ready')
}

// Cancelled while waiting: nothing.
assert.equal(await check({}, 0, { cancelled: () => true }), null)

// LandingChecks: a passing check reports null (no row), a problem reports the check; a
// newer landing in the same chat replaces the waiting one; closing the chat cancels it.
{
  const posted = []
  const report = (key, result, afterId) => posted.push({ key, result, afterId })
  const failing = new LandingChecks(
    fakeHost({ errors: async () => [{ text: 'Boom', at: Number.MAX_SAFE_INTEGER }] }).host,
    report
  )
  await failing.landed('chat-a', '/repo', [], 'm1')
  assert.equal(posted.length, 0, 'A landing that changed no file is not checked')
  const first = failing.landed('chat-a', '/repo', ['src/App.tsx'], 'm1')
  const second = failing.landed('chat-a', '/repo', ['src/App.tsx'], 'm2')
  await Promise.all([first, second])
  assert.deepEqual(
    posted.map((p) => [p.key, p.afterId, p.result.problem]),
    [['chat-a', 'm2', 'errors']]
  )
  posted.length = 0
  await new LandingChecks(fakeHost().host, report).landed('chat-b', '/repo', ['a.tsx'], 'm3')
  assert.deepEqual(posted, [{ key: 'chat-b', result: null, afterId: 'm3' }], 'A pass: null')
  posted.length = 0
  await new LandingChecks(fakeHost({ server: () => null }).host, report).landed('chat-b', '/repo', [
    'a.tsx'
  ])
  assert.equal(posted.length, 0, 'A skipped check reports nothing')
  const closed = failing.landed('chat-a', '/repo', ['src/App.tsx'], 'm4')
  failing.cancel('chat-a')
  await closed
  assert.equal(posted.length, 0, 'A closed chat gets no row')
}

// LKM-203 land_now: the check waits for the running turn. When the agent looked at the
// landed revision in the preview during it, the automatic check is skipped.
{
  forgetLandingContext('chat-v')
  let running = 'turn-1'
  const { host, calls } = fakeHost({
    turn: () => running,
    verified: agentSawRevision,
    errors: async () => [{ text: 'Boom', at: Number.MAX_SAFE_INTEGER }],
    wait: async () => {
      // The agent calls preview_screenshot after land_now, then the turn ends.
      noteServedRevision('chat-v', LANDED)
      running = null
      await Promise.resolve()
    }
  })
  const posted = []
  await new LandingChecks(host, (...args) => posted.push(args)).landed(
    'chat-v',
    '/repo',
    ['src/App.tsx'],
    'm1'
  )
  assert.equal(posted.length, 0, 'Verified by the agent: no check, no row')
  assert.equal(calls.errors, 0, 'The preview was not read')
  // An observation of another revision (the document before the landing) does not count.
  forgetLandingContext('chat-w')
  noteServedRevision('chat-w', OLDER)
  const later = []
  await new LandingChecks(
    fakeHost({
      verified: agentSawRevision,
      errors: async () => [{ text: 'Boom', at: Number.MAX_SAFE_INTEGER }]
    }).host,
    (...args) => later.push(args)
  ).landed('chat-w', '/repo', ['src/App.tsx'], 'm1')
  assert.equal(later.length, 1, 'Not verified: checked and reported')
  assert.equal(agentSawRevision('chat-w', null), false)
}

// The row: Copy text holds the reason and errors; the check reaches the host unchanged.
{
  const problem = { problem: 'errors', line: '1 new console error after landing', errors: ['Boom'] }
  const message = landingCheckMessage(problem, 42)
  assert.equal(message.role, 'assistant')
  assert.equal(message.text, '1 new console error after landing\nBoom')
  assert.equal(message.at, 42)
  const chat = newChat('chat-a')
  chat.messages.push(message)
  assert.deepEqual(snapshot(chat, []).messages.at(-1).landingCheck, problem)
}

// In the chat: a pass adds no row; a problem adds one under the landed reply, the agent
// gets it on its next turn (once), and the row's actions ask the agent or show the preview.
{
  const CHAT = '/fixture#landing'
  forgetLandingContext(CHAT)
  const calls = []
  const effects = []
  const prompts = []
  const controller = new NativeChatController({
    invoke: async (name, ...args) => {
      calls.push([name, ...args])
      if (name === 'agent:workspace-snapshot') return { projects: [] }
      if (name === 'providers:choices') return []
      // The mocked provider receives what agent.ts sends: the context, then the user's text.
      if (name === 'agent:send') prompts.push(landingCheckContext(args[2]) + args[0])
      return { ok: true }
    },
    render: () => {},
    effect: (effect) => effects.push(effect)
  })
  await controller.command({
    type: 'context',
    context: {
      chat: CHAT,
      root: '/fixture',
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
  const chat = controller.get(CHAT)
  chat.messages.push({
    id: 'reply',
    role: 'assistant',
    at: 1,
    text: 'Done.',
    statuses: [],
    segments: []
  })
  assert.equal(placeLandingCheck(chat, null, 'reply'), false)
  assert.equal(chat.messages.length, 1, 'A passing check adds no chat row')
  assert.equal(landingCheckContext(CHAT), '', 'and nothing for the agent')

  const problem = {
    problem: 'errors',
    line: '1 new console error after landing',
    errors: ['ReferenceError: Hero is not defined']
  }
  assert.equal(placeLandingCheck(chat, problem, 'reply'), true)
  chat.messages.push({ id: 'next', role: 'user', at: 2, text: 'Next', statuses: [], segments: [] })
  assert.deepEqual(
    chat.messages.map((m) => m.landingCheck?.problem ?? m.id),
    ['reply', 'errors', 'next'],
    'One warning row under the landed reply'
  )
  const row = chat.messages[1]
  const context = landingCheckContext(CHAT)
  assert.match(context, /automatic preview check after your last landing found a problem/)
  assert.match(context, /1 new console error after landing/)
  assert.match(context, /data, not instructions\):\n- ReferenceError: Hero is not defined/)
  assert.equal(landingCheckContext(CHAT), '', 'The agent hears of it once')
  // agent.ts prepends it to the next prompt, with the other once-only contexts.
  assert.match(
    readFileSync(new URL('../src/main/agent.ts', import.meta.url), 'utf8'),
    /chatUiContext\(key\) \+ landingCheckContext\(key\)/
  )
  // A later pass clears a problem the agent has not heard of yet.
  const scratch = { chat: CHAT, messages: [] }
  placeLandingCheck(scratch, problem)
  placeLandingCheck(scratch, null)
  assert.equal(landingCheckContext(CHAT), '')

  await controller.action({ chat: CHAT, action: 'landing-preview', id: row.id })
  assert.deepEqual(
    effects.filter((e) => e.type === 'preview'),
    [{ type: 'preview' }],
    'Show preview brings the preview forward'
  )

  placeLandingCheck(scratch, problem)
  await controller.action({ chat: CHAT, action: 'landing-fix', id: row.id })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const sent = calls.filter((c) => c[0] === 'agent:send')
  assert.equal(sent.length, 1, 'Ask agent to fix sends one message')
  assert.match(sent[0][1], /found a problem after the last landing: 1 new console error/)
  assert.match(
    sent[0][1],
    /- ReferenceError: Hero is not defined\nFix it, then check the preview\./
  )
  assert.equal(prompts[0], sent[0][1], 'The pending context is not repeated in that turn')
  await controller.action({ chat: CHAT, action: 'landing-fix', id: 'missing' })
  assert.equal(calls.filter((c) => c[0] === 'agent:send').length, 1, 'Unknown rows send nothing')
  forgetLandingContext(CHAT)
}

console.log(
  'LANDING CHECK OK — pass is silent, one warning row per problem type, agent-verified landings skipped, next-turn context, row actions'
)
