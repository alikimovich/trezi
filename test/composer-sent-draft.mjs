// LKM-304, no desktop: an accepted send clears exactly the draft it sent. Inputs the native
// composer emitted against that draft before the cleared snapshot arrived (AppKit's smart
// quote, a key typed after Return) never restore it or send it twice; text typed after
// it, a refused send and the busy Stop control are kept. The Swift half (removing the sent
// text and keeping the rest) is the native `composer-send` check.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const live = '/Users/me/app'

function harness({ hold = false } = {}) {
  const calls = [],
    renders = []
  let release = () => {}
  const held = hold ? new Promise((resolve) => (release = resolve)) : null
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      if (channel === 'agent:workspace-snapshot') {
        await held
        return {
          projects: [
            {
              root: live,
              chats: [
                {
                  sessionKey: 'a',
                  record: { transcript: [] },
                  isRunning: false,
                  options: { provider: 'claude' }
                }
              ]
            }
          ]
        }
      }
      return { ok: true }
    },
    render: (state) => renders.push(structuredClone(state)),
    effect: () => {}
  })
  // The composer's own revision and the send count it applied, as Composer.swift keeps them.
  let revision = 0
  const h = {
    controller,
    release,
    chat: () => controller.get('a'),
    composer: () => renders.at(-1).composer,
    sent: () => calls.filter((c) => c[0] === 'agent:send').map((c) => c[1]),
    interrupts: () => calls.filter((c) => c[0] === 'agent:interrupt').length,
    input: (text, sent = 0) =>
      controller.composer({
        chat: 'a',
        action: 'input',
        text,
        caret: text.length,
        revision: ++revision,
        sent
      }),
    enter: () => controller.composer({ chat: 'a', action: 'key', key: 'Enter' }),
    click: (stop) => controller.composer({ chat: 'a', action: 'send', stop }),
    revision: () => revision
  }
  return h
}
const open = (h) =>
  h.controller.command({
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

// 1. Return, then AppKit curls the apostrophe before the cleared snapshot arrives. The
//    curled draft never comes back; Stop shows; one send, of the text that was sent.
{
  const h = harness()
  await open(h)
  await h.input("Don't stop")
  const at = h.revision()
  await h.enter()
  await h.input('Don’t stop') // emitted before the composer applied the clear
  await tick()
  assert.deepEqual(h.sent(), ["Don't stop"], 'sent once, as submitted')
  assert.equal(h.chat().text, '', 'the smart-quoted draft is not restored')
  assert.deepEqual(
    h.composer().sent,
    { count: 1, revision: at },
    'the snapshot names the sent draft'
  )
  assert.equal(h.composer().stop, true, 'Stop replaces Send while the turn runs')
  // The composer removed the sent text and sends what is left, at the new count.
  await h.input('', 1)
  assert.equal(h.chat().text, '')
  // A second Return on the cleared draft sends nothing.
  await h.enter()
  await tick()
  assert.equal(h.sent().length, 1, 'no duplicate send')
}

// 2. New text typed after Return, before the acknowledgement, is kept.
{
  const h = harness()
  await open(h)
  await h.input('First message')
  await h.enter()
  await h.input('First messageNext')
  assert.equal(h.chat().text, '', 'the stale draft with the new text is ignored')
  await h.input('Next', 1)
  assert.equal(h.chat().text, 'Next', 'the remainder is the new draft')
  assert.equal(h.composer().text, 'Next')
  assert.deepEqual(h.sent(), ['First message'])
}

// 3. Busy controls: a second click on the Send arrow, emitted before the snapshot
//    turned it into Stop, neither stops the turn nor sends again. Stop still stops.
{
  const h = harness()
  await open(h)
  await h.input('Ship it')
  await h.click(false)
  await h.click(false)
  await tick()
  assert.deepEqual(h.sent(), ['Ship it'])
  assert.equal(h.interrupts(), 0, 'a Send click never stops the turn')
  assert.equal(h.chat().isRunning, true)
  await h.click(true)
  assert.equal(h.interrupts(), 1, 'Stop stops')
}

// 4. A message queued behind a running turn clears the same way, exactly once.
{
  const h = harness()
  await open(h)
  await h.input('Running')
  await h.enter()
  await h.input('Queue it’s next', 1)
  const at = h.revision()
  await h.enter()
  await h.input('Queue it’s next', 1) // stale: count 1, the queued send made it 2
  await tick()
  assert.deepEqual(
    h.chat().queue.map((q) => q.text),
    ['Queue it’s next'],
    'queued exactly once'
  )
  assert.equal(h.chat().text, '')
  assert.deepEqual(h.composer().sent, { count: 2, revision: at })
  assert.deepEqual(h.sent(), ['Running'])
}

// 5. A refused send (the chat is switching model) keeps the draft and the send count.
{
  const h = harness()
  await open(h)
  await h.input('Keep me')
  h.chat().switching = true
  await h.enter()
  assert.equal(h.chat().text, 'Keep me', 'a refused send keeps the draft')
  assert.deepEqual(h.chat().sent, { count: 0, revision: 0 })
  assert.equal(h.sent().length, 0)
}

// 6. Text typed while a not-yet-ready chat initializes is after the sent draft: the
//    clear names the revision that was sent, so the composer keeps the newer text.
{
  const h = harness({ hold: true })
  void open(h)
  await tick()
  await h.input('Early')
  const at = h.revision()
  const sending = h.enter()
  await h.input('Early words')
  h.release()
  await sending
  await tick()
  assert.deepEqual(h.sent(), ['Early'], 'only the submitted draft is sent')
  assert.deepEqual(h.chat().sent, { count: 1, revision: at })
}

// 7. The new-project (planning) chat: a message sent while its turn runs is queued once.
//    The draft clears, a stale input and a second Enter queue nothing more, and what the
//    user types meanwhile survives the queued message's own send.
{
  let finish = () => {}
  const planned = []
  const renders = []
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      if (channel === 'planning:send') {
        planned.push(args[2])
        if (planned.length === 1) await new Promise((resolve) => (finish = resolve))
        return { record: { transcript: [] } }
      }
      return { ok: true }
    },
    render: (state) => renders.push(structuredClone(state)),
    effect: () => {}
  })
  controller.start.planningKey = 'plan'
  controller.active = 'plan'
  const chat = controller.get('plan')
  chat.ready = true
  let revision = 0
  const input = (text, sent = 0) =>
    controller.composer({
      chat: 'plan',
      action: 'input',
      text,
      caret: text.length,
      revision: ++revision,
      sent
    })
  const enter = () => controller.composer({ chat: 'plan', action: 'key', key: 'Enter' })
  await input('First')
  void enter()
  await tick()
  assert.deepEqual(planned, ['First'])
  assert.equal(chat.isRunning, true)
  await input('Second', 1)
  const at = revision
  await enter()
  await input('Second’s', 1) // stale: typed before the clear reached the composer
  await enter()
  assert.equal(chat.text, '', 'the queued draft is cleared')
  assert.deepEqual(renders.at(-1).composer.sent, { count: 2, revision: at })
  assert.deepEqual(controller.planningQueued.get('plan'), ['Second'], 'queued exactly once')
  await input('Third', 2)
  finish()
  await tick(20)
  assert.deepEqual(planned, ['First', 'Second'], 'the queued message is sent after the turn')
  assert.equal(chat.text, 'Third', 'the queued send leaves the new draft alone')
}
console.log(
  'Composer sent draft: stale inputs, new text, busy controls, queue, planning queue and refusal passed.'
)
