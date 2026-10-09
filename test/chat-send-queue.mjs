// LKM-169, no desktop: a message sent while something blocks sending (a running turn,
// a landing, a park waiting for Resolve, a provider login) goes to the composer queue
// exactly once with the reason, is sent once the block clears, and never leaves an
// error turn, a "Worked for 0s" or a duplicate. Queued messages can be edited or removed.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { RESOLVE_NEEDED } from '../src/shared/chat-busy.ts'

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const live = '/Users/me/app'

function harness({ refuseResolve = false, resolveConflicted = ['src/a.tsx'] } = {}) {
  const calls = [],
    renders = []
  let refuse = refuseResolve
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
                  options: { provider: 'claude' }
                }
              ]
            }
          ]
        }
      if (channel === 'agent:send') {
        // The backend's `sendRefusal`, before the chat has seen its park event.
        if (refuse) throw new Error(`Error: ${RESOLVE_NEEDED}`)
        return undefined
      }
      if (channel === 'agent:resolve-conflict')
        return resolveConflicted.length
          ? { ok: true, conflicted: resolveConflicted, prompt: 'Resolve the markers.' }
          : { ok: true, conflicted: [] }
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
    emit: async (event) => {
      controller.event({ projectKey: 'a', ...event })
      await tick()
    },
    act: async (action, id) => {
      await controller.action({ chat: 'a', action, id })
      await tick()
    },
    accept: () => {
      refuse = false
    },
    input: (text) =>
      controller.composer({
        chat: 'a',
        action: 'input',
        text,
        caret: text.length,
        revision: ++revision
      }),
    say: async (text) => {
      await h.input(text)
      await controller.composer({ chat: 'a', action: 'send' })
      await tick()
    },
    // What the user sees: transcript texts, and no error turn or "Worked for" on refusal.
    texts: () => h.last().messages.map((m) => m.text ?? ''),
    userTexts: () =>
      h
        .last()
        .messages.filter((m) => m.role === 'user')
        .map((m) => m.text)
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
const noError = (h) => {
  const all = JSON.stringify(h.texts())
  assert.ok(!all.includes('Unable to send'), 'no error turn')
  assert.ok(!all.includes('Resolve'), 'the refusal is not shown in the transcript')
  assert.ok(!h.last().messages.some((m) => m.workedMs !== undefined), 'no "Worked for 0s"')
}

// 1. A chat waiting for Resolve queues the message once, says why, and sends it after
//    Resolve lands, in order, with no duplicate. Edit and remove work meanwhile.
{
  const h = harness()
  await open(h)
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  assert.equal(
    h
      .last()
      .cards.find((c) => c.id === 'conflict')
      ?.actions.at(-1).action,
    'resolve'
  )
  assert.equal(h.last().composer.sendLabel, 'Queue message')
  await h.say('Make the header blue')
  assert.equal(h.sent().length, 0, 'nothing reaches the backend while Resolve is needed')
  assert.deepEqual(
    h.chat().queue.map((q) => q.text),
    ['Make the header blue'],
    'queued exactly once'
  )
  assert.equal(h.userTexts().length, 0, 'not in the transcript while queued')
  assert.match(h.last().composer.queueNote, /^Waiting for Resolve/)
  assert.equal(h.last().composer.queueCanSend, false)
  assert.equal(h.last().composer.queuePaused, false)
  noError(h)
  // Send now cannot jump the block.
  await h.act('queue-resume')
  assert.equal(h.sent().length, 0)

  // Edit: back into the composer (ahead of a draft), out of the queue; send queues again.
  const [first] = h.last().composer.queue
  await h.input('draft')
  await h.act('queue-edit', first.id)
  assert.equal(h.chat().queue.length, 0)
  assert.equal(h.chat().text, 'Make the header blue\n\ndraft')
  assert.equal(h.last().composer.text, 'Make the header blue\n\ndraft')
  await h.say('Make the header green')
  await h.say('Then add a footer')
  await h.say('Scratch that')
  const scratch = h.last().composer.queue.at(-1)
  await h.act('queue-remove', scratch.id)
  assert.deepEqual(
    h.chat().queue.map((q) => q.text),
    ['Make the header green', 'Then add a footer']
  )
  assert.equal(h.sent().length, 0)

  // Resolve: the resolution turn runs first; the queue waits for it to land.
  await h.act('resolve', 'conflict')
  assert.deepEqual(h.sent(), ['Resolve the markers.'])
  assert.equal(h.chat().queue.length, 2, 'the queue waits for the resolution turn')
  await h.emit({ type: 'done' })
  assert.equal(h.sent().length, 1, 'a park still waiting for Resolve keeps the queue')
  await h.emit({ type: 'isolation', state: 'merged', files: ['src/a.tsx'], group: 'g1' })
  assert.deepEqual(h.sent(), ['Resolve the markers.', 'Make the header green'])
  await h.emit({ type: 'done' })
  assert.deepEqual(h.sent(), ['Resolve the markers.', 'Make the header green', 'Then add a footer'])
  await h.emit({ type: 'done' })
  assert.equal(h.chat().queue.length, 0)
  assert.deepEqual(h.userTexts(), [
    'Resolve the markers.',
    'Make the header green',
    'Then add a footer'
  ])
  assert.ok(!JSON.stringify(h.texts()).includes('Unable to send'))
}

// 2. Resolve merges cleanly (no conflicted files): the park clears and the queue sends.
{
  const h = harness({ resolveConflicted: [] })
  await open(h)
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  await h.say('Queued during the park')
  await h.act('resolve', 'conflict')
  assert.equal(h.sent().length, 0)
  await h.emit({ type: 'isolation', state: 'merged', files: ['src/a.tsx'], group: 'g1' })
  assert.deepEqual(h.sent(), ['Queued during the park'])
  assert.deepEqual(h.userTexts(), ['Queued during the park'])
}

// 3. The backend refuses for Resolve before the chat knows (the issue's report): the
//    message goes back to the queue once, with no error turn, "Worked for 0s" or
//    duplicate, and it is sent once when the park clears (here: Discard).
{
  const h = harness({ refuseResolve: true })
  await open(h)
  await h.say('Make the header blue')
  assert.equal(h.sent().length, 1)
  assert.deepEqual(
    h.chat().queue.map((q) => q.text),
    ['Make the header blue']
  )
  assert.equal(h.userTexts().length, 0, 'the optimistic message is taken back')
  assert.equal(h.chat().isRunning, false)
  assert.equal(h.chat().isolation, 'parked', 'the chat shows Resolve now')
  assert.ok(h.last().cards.some((c) => c.id === 'conflict'))
  assert.match(h.last().composer.queueNote, /^Waiting for Resolve/)
  noError(h)
  h.accept()
  await h.act('discard', 'conflict')
  assert.deepEqual(h.calls.at(-1), ['agent:discard-conflict', 'a'])
  assert.equal(h.sent().length, 1, 'still waiting until the park clears')
  await h.emit({ type: 'isolation', state: 'isolated' })
  assert.equal(h.sent().length, 2)
  assert.equal(h.sent()[1], 'Make the header blue')
  await h.emit({ type: 'done' })
  assert.deepEqual(h.userTexts(), ['Make the header blue'], 'exactly one transcript entry')
  assert.equal(h.chat().queue.length, 0)
}

// 4. A running turn, then its landing: queued without a note (LKM-191: the normal wait),
//    sent once it ends.
{
  const h = harness()
  await open(h)
  await h.say('First')
  assert.equal(h.chat().isRunning, true)
  await h.say('Second')
  assert.equal(h.sent().length, 1)
  assert.equal(h.last().composer.queueNote, '')
  assert.equal(h.last().composer.queueCanSend, false)
  await h.emit({ type: 'delta', text: 'Done.' })
  await h.emit({ type: 'done', landingPending: true })
  assert.equal(h.sent().length, 1, 'the landing still blocks')
  assert.equal(h.last().composer.queueNote, '')
  assert.equal(h.last().composer.queueCanSend, false)
  await h.say('Third')
  assert.equal(h.chat().queue.length, 2)
  await h.emit({ type: 'isolation', state: 'merged', files: ['a.ts'], group: 'g' })
  await h.emit({ type: 'landing-finished' })
  assert.deepEqual(h.sent(), ['First', 'Second'])
  await h.emit({ type: 'done' })
  assert.deepEqual(h.sent(), ['First', 'Second', 'Third'])
  assert.deepEqual(h.userTexts(), ['First', 'Second', 'Third'])
}

// 5. Provider login needed: queued with the reason; the login card's Retry resends the
//    failed message and the queue follows it.
{
  const h = harness()
  await open(h)
  await h.say('Hello')
  await h.emit({ type: 'error', code: 'auth', message: 'Not logged in.' })
  assert.ok(h.last().cards.some((c) => c.id === 'login'))
  await h.say('Queued while signed out')
  assert.equal(h.sent().length, 1, 'not sent while signed out')
  assert.deepEqual(
    h.chat().queue.map((q) => q.text),
    ['Queued while signed out']
  )
  assert.match(h.last().composer.queueNote, /^Waiting for sign-in/)
  assert.equal(h.last().composer.queueCanSend, false)
  await h.act('login-retry', 'login')
  assert.ok(h.calls.some((c) => c[0] === 'agent:restart-chat'))
  assert.deepEqual(h.sent(), ['Hello', 'Hello'])
  await h.emit({ type: 'done' })
  assert.deepEqual(h.sent(), ['Hello', 'Hello', 'Queued while signed out'])
  assert.equal(h.chat().queue.length, 0)
}

console.log('chat-send-queue: OK')
process.exit(0)
