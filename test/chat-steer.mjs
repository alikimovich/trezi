// LKM-709, no desktop: "Steer now" on a queued owner message, through the native chat
// controller (the queue row's action, `agent:steer`, the provider's `steer` outcome).
//  - queue A+B while a turn runs; steer A: `agent:steer` gets exactly A for THIS chat and
//    turn; A stays in its place, marked, until the provider admits it; then it leaves the
//    queue, shows in the transcript where it landed, and never runs as a queued turn; B
//    stays queued and runs next;
//  - rejected, refused by main, uncertain, a turn that ends unanswered, a late answer, a
//    repeated tap, another chat's event, special entries and other providers: nothing is
//    lost, duplicated or sent elsewhere.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { STEER_UNCERTAIN } from '../src/shared/steer.ts'

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const live = '/Users/me/app'

async function harness(provider = 'claude') {
  const calls = [],
    renders = []
  let steerReply = { ok: true }
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: live,
              chats: [
                {
                  sessionKey: 'a',
                  record: { transcript: [] },
                  isRunning: false,
                  options: { provider }
                }
              ]
            }
          ]
        }
      if (channel === 'agent:send') return undefined
      if (channel === 'agent:steer') return steerReply
      return { ok: true }
    },
    render: (state) => renders.push(structuredClone(state)),
    effect: () => {}
  })
  let revision = 0
  const h = {
    controller,
    calls,
    chat: () => controller.get('a'),
    last: () => renders.at(-1),
    sent: () => calls.filter((c) => c[0] === 'agent:send').map((c) => c[1]),
    steers: () => calls.filter((c) => c[0] === 'agent:steer'),
    reply: (next) => {
      steerReply = next
    },
    emit: async (event, key = 'a') => {
      controller.event({ projectKey: key, ...event })
      await tick()
    },
    act: async (action, id) => {
      await controller.action({ chat: 'a', action, id })
      await tick()
    },
    say: async (text) => {
      await controller.composer({
        chat: 'a',
        action: 'input',
        text,
        caret: text.length,
        revision: ++revision
      })
      await controller.composer({ chat: 'a', action: 'send' })
      await tick()
    },
    row: (text) => h.last().composer.queue.find((q) => q.text === text),
    queued: () => h.chat().queue.map((q) => q.text),
    users: () => h.last().messages.filter((m) => m.role === 'user')
  }
  await controller.command({
    type: 'context',
    context: {
      chat: 'a',
      root: live,
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
  return h
}

/** A running turn with A and B queued behind it. */
async function running(provider) {
  const h = await harness(provider)
  await h.say('Build the page')
  assert.deepEqual(h.sent(), ['Build the page'])
  await h.emit({ type: 'delta', text: 'Working on it' })
  await h.say('A: keep the header')
  await h.say('B: then the footer')
  assert.deepEqual(h.queued(), ['A: keep the header', 'B: then the footer'])
  return h
}

// 1. Steer A: exactly A goes to THIS chat's running turn; admitted, it leaves the queue
//    and the transcript shows it where it landed; B stays queued and runs next; A never
//    runs again as a queued turn.
{
  const h = await running()
  assert.equal(h.row('A: keep the header').steer, null, 'Steer now is offered')
  const turn = h.chat().turn
  await h.act('queue-steer', h.row('A: keep the header').id)
  assert.equal(h.steers().length, 1)
  const [, chat, steeredTurn, request, prompt, images] = h.steers()[0]
  assert.deepEqual(
    [chat, steeredTurn, prompt, images],
    ['a', turn, 'A: keep the header', undefined]
  )
  // On its way: still queued in its place, marked, not editable or removable.
  assert.deepEqual(h.queued(), ['A: keep the header', 'B: then the footer'])
  assert.equal(h.row('A: keep the header').steering, true)
  assert.equal(h.row('A: keep the header').editable, false)
  assert.match(h.row('B: then the footer').steer, /Another queued message/)
  await h.act('queue-edit', h.row('A: keep the header').id)
  await h.act('queue-remove', h.row('A: keep the header').id)
  assert.deepEqual(
    h.queued(),
    ['A: keep the header', 'B: then the footer'],
    'kept while on its way'
  )
  assert.equal(h.chat().text, '', 'not edited back into the draft')
  // A repeated tap sends nothing more.
  await h.act('queue-steer', h.row('A: keep the header').id)
  assert.equal(h.steers().length, 1)
  // Another chat's event with this request id changes nothing here.
  await h.emit({ type: 'steer', id: request, state: 'admitted' }, 'b')
  assert.deepEqual(h.queued(), ['A: keep the header', 'B: then the footer'])
  // The provider admits it into the running turn.
  await h.emit({ type: 'steer', id: request, state: 'admitted' })
  assert.deepEqual(h.queued(), ['B: then the footer'])
  const texts = h.last().messages.map((m) => [m.role, m.text, m.steered ?? null])
  assert.deepEqual(texts, [
    ['user', 'Build the page', null],
    ['assistant', 'Working on it', null],
    ['user', 'A: keep the header', 'turn'],
    ['assistant', '', null]
  ])
  assert.equal(h.last().running, true, 'the turn keeps running')
  await h.emit({ type: 'delta', text: 'Kept the header' })
  await tick(60) // streamed text renders on a 33 ms throttle
  assert.equal(h.last().messages.at(-1).text, 'Kept the header', 'the reply continues below')
  assert.equal(h.last().messages.at(-3).text, 'Working on it', 'earlier output untouched')
  // A late repeat of the answer changes nothing.
  await h.emit({ type: 'steer', id: request, state: 'admitted' })
  assert.equal(h.users().length, 2)
  // The turn ends: B runs next; A is never sent as a turn.
  await h.emit({ type: 'done' })
  await tick(20)
  assert.deepEqual(h.sent(), ['Build the page', 'B: then the footer'])
  assert.equal(h.queued().length, 0)
}

// 2. Rejected by the provider, or refused by main: A stays queued in its place, editable,
//    with the reason; the turn's end sends A then B as usual.
for (const how of ['event', 'refused']) {
  const h = await running()
  if (how === 'refused') h.reply({ ok: false, reason: 'idle' })
  await h.act('queue-steer', h.row('A: keep the header').id)
  if (how === 'event')
    await h.emit({ type: 'steer', id: h.steers()[0][3], state: 'rejected', reason: 'unsupported' })
  assert.deepEqual(h.queued(), ['A: keep the header', 'B: then the footer'], how)
  assert.equal(h.row('A: keep the header').steering, undefined)
  assert.equal(h.row('A: keep the header').editable, undefined)
  assert.match(h.last().composer.queueNote, /^Not steered/, how)
  assert.equal(h.users().length, 1, 'nothing invented in the transcript')
  await h.emit({ type: 'done' })
  await tick(20)
  assert.deepEqual(h.sent(), ['Build the page', 'A: keep the header'], how)
  assert.equal(h.last().composer.queueNote, '', 'a new turn clears the note')
}

// 3. The turn ends before the provider answered: A stays queued and sends next as usual;
//    a late admission afterwards is ignored (no duplicate, nothing lost).
{
  const h = await running()
  await h.act('queue-steer', h.row('A: keep the header').id)
  const request = h.steers()[0][3]
  await h.emit({ type: 'done' })
  await tick(20)
  assert.deepEqual(h.sent(), ['Build the page', 'A: keep the header'], 'A as its own turn')
  assert.deepEqual(h.queued(), ['B: then the footer'])
  await h.emit({ type: 'steer', id: request, state: 'admitted' })
  assert.deepEqual(h.queued(), ['B: then the footer'])
  assert.equal(h.users().filter((m) => m.steered).length, 0)
  assert.equal(h.users().filter((m) => m.text === 'A: keep the header').length, 1)
}

// 4. Uncertain: A stays queued and the queue pauses, so it never sends twice.
{
  const h = await running()
  await h.act('queue-steer', h.row('A: keep the header').id)
  await h.emit({ type: 'steer', id: h.steers()[0][3], state: 'uncertain', reason: 'unknown' })
  assert.deepEqual(h.queued(), ['A: keep the header', 'B: then the footer'])
  assert.equal(h.last().composer.queuePaused, true)
  await h.emit({ type: 'done' })
  await tick(20)
  assert.deepEqual(h.sent(), ['Build the page'], 'paused: nothing sent on its own')
  assert.equal(h.last().composer.queueNote, STEER_UNCERTAIN)
}

// 5. Not offered: an answer to a question, Trezi's own Apply, an idle chat, another
//    provider. Choosing it anyway sends nothing and says why.
{
  const h = await running()
  const chat = h.chat()
  chat.queue.push(
    { id: 'ans', chatUiId: 'ui-1', text: 'Blue', attachments: [], selection: null, turn: {} },
    {
      id: 'app',
      text: 'Apply padding',
      attachments: [],
      selection: null,
      turn: {},
      action: { kind: 'inspector-apply', summary: 'padding' }
    }
  )
  h.controller.changed(chat)
  await tick()
  const rows = h.last().composer.queue
  assert.match(rows.find((q) => q.id === 'queued-ans').steer, /answer to a question/)
  assert.match(rows.find((q) => q.id === 'queued-app').steer, /Apply/)
  await h.act('queue-steer', 'queued-ans')
  await h.act('queue-steer', 'queued-app')
  assert.equal(h.steers().length, 0)
}
// Idle: a turn that ended in an error pauses the queue; nothing is running to steer into.
{
  const h = await running()
  await h.emit({ type: 'error', message: 'boom' })
  await tick(20)
  assert.equal(h.last().running, false)
  assert.match(h.row('A: keep the header').steer, /while Claude is working/)
  await h.act('queue-steer', h.row('A: keep the header').id)
  assert.equal(h.steers().length, 0)
  assert.deepEqual(h.queued(), ['A: keep the header', 'B: then the footer'])
}
for (const provider of ['codex', 'gemini']) {
  const h = await running(provider)
  assert.match(h.row('A: keep the header').steer, /per turn/, provider)
  await h.act('queue-steer', h.row('A: keep the header').id)
  assert.equal(h.steers().length, 0, provider)
  assert.match(h.last().composer.queueNote, /^Not steered/, provider)
  assert.deepEqual(h.queued(), ['A: keep the header', 'B: then the footer'])
}
console.log('CHAT-STEER PASS')
