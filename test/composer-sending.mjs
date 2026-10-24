// LKM-338, no desktop: a Send whose draft has not left the composer is held by the chat
// controller (a chat still being prepared, a project still opening), the snapshot says so
// with the composer's own attempt number, and Stop (`cancel-send`) ends it with the exact
// text and attachments kept and nothing sent. The Swift half (the 1.5 s delay, the beam,
// Stop or "Sending…", read-only faded content) is the `composer-sending` fixture below.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { HOME } from '../src/native/chat-start.ts'
import { installNativeStart } from '../src/native/start-runtime.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const live = '/Users/me/app'
const image = { name: 'shot.png', path: '', type: 'image/png', data: 'iVBORw0KGgo=' }

function harness({ hold = false, fail = false } = {}) {
  const calls = [],
    renders = []
  let release = () => {}
  const held = hold ? new Promise((resolve) => (release = resolve)) : null
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      if (channel === 'agent:workspace-snapshot') {
        await held
        if (fail) throw new Error('Workspace unavailable')
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
  controller.active = 'a'
  return {
    controller,
    release,
    chat: () => controller.get('a'),
    composer: () => renders.at(-1).composer,
    cards: () => renders.at(-1).cards,
    // The message text, after the saved-attachments header.
    sent: () => calls.filter((c) => c[0] === 'agent:send').map((c) => c[1].split('\n\n').at(-1)),
    draft: async (text) => {
      await controller.composer({
        chat: 'a',
        action: 'input',
        text,
        caret: text.length,
        revision: 1
      })
      await controller.composer({ chat: 'a', action: 'files', files: [image] })
    },
    send: (attempt) => controller.composer({ chat: 'a', action: 'send', stop: false, attempt }),
    cancel: (attempt) => controller.composer({ chat: 'a', action: 'cancel-send', attempt })
  }
}

// 1. A ready chat: the draft leaves at once. The snapshot names the attempt, not held.
{
  const h = harness()
  await h.controller.initialize(h.chat())
  await h.draft('Quick message')
  await h.send(1)
  await tick()
  assert.deepEqual(h.composer().sending, { attempt: 1, active: false }, 'handled, nothing held')
  assert.equal(h.composer().text, '', 'the draft left the composer')
  assert.deepEqual(h.sent(), ['Quick message'])
}

// 2. A chat still being prepared holds the send with its draft in place; Stop cancels it
//    and the exact text and attachments stay. Preparing finishes later and sends nothing.
{
  const h = harness({ hold: true })
  await h.draft('Long message\nwith two lines')
  const sending = h.send(7)
  await tick()
  assert.deepEqual(h.composer().sending, { attempt: 7, active: true }, 'held, cancellable')
  assert.equal(h.composer().text, 'Long message\nwith two lines', 'the draft stays while held')
  assert.equal(h.composer().attachments.length, 1)
  await h.cancel(6) // a stale attempt cancels nothing
  assert.equal(h.composer().sending.active, true)
  await h.cancel(7)
  assert.deepEqual(h.composer().sending, { attempt: 7, active: false }, 'Stop ended the send')
  h.release()
  await sending
  await tick()
  assert.deepEqual(h.sent(), [], 'a cancelled send is never sent')
  assert.equal(h.chat().text, 'Long message\nwith two lines', 'the exact text is kept')
  assert.deepEqual(
    h.chat().attachments.map(({ id, ...a }) => a),
    [image],
    'the exact attachments are kept'
  )
  assert.equal(h.chat().sent.count, 0)
  // Sending again works once the chat is ready.
  await h.send(8)
  await tick()
  assert.deepEqual(h.sent(), ['Long message\nwith two lines'])
  assert.deepEqual(h.composer().sending, { attempt: 8, active: false })
}

// 3. Held, then the chat becomes ready: the draft leaves and the hold ends with it.
{
  const h = harness({ hold: true })
  await h.draft('Slow message')
  const sending = h.send(9)
  await tick()
  assert.equal(h.composer().sending.active, true)
  h.release()
  await sending
  await tick()
  assert.deepEqual(h.sent(), ['Slow message'])
  assert.deepEqual(h.composer().sending, { attempt: 9, active: false })
  assert.equal(h.composer().text, '')
}

// 4. Preparing fails: the hold ends, the draft is kept and the existing error card shows.
{
  const h = harness({ hold: true, fail: true })
  await h.draft('Kept on failure')
  const sending = h.send(10)
  await tick()
  h.release()
  await sending
  await tick()
  assert.deepEqual(h.composer().sending, { attempt: 10, active: false })
  assert.equal(h.composer().text, 'Kept on failure')
  assert.equal(h.composer().attachments.length, 1)
  assert.ok(
    h.cards().some((card) => card.id === 'error'),
    'the error is shown'
  )
  assert.deepEqual(h.sent(), [])
}

// 5. The no-project draft waits for its project to open; Stop is that card's Cancel.
{
  const choices = [
    {
      value: 'codex:default',
      modelId: 'default',
      provider: 'codex',
      group: 'Codex',
      label: 'Default'
    }
  ]
  const renders = []
  const controller = new NativeChatController({
    invoke: async (channel) =>
      channel === 'providers:choices'
        ? choices
        : channel === 'providers:check-login'
          ? { loggedIn: true }
          : { ok: true },
    render: (state) => renders.push(structuredClone(state)),
    effect: () => {}
  })
  installNativeStart(controller, {
    active: null,
    preferred: {
      provider: 'codex',
      model: 'codex:default',
      modelId: 'default',
      permissionMode: 'auto'
    },
    state: {
      recents: [{ root: '/fixture', name: 'Fixture' }],
      projects: [],
      status: { kind: 'idle' }
    },
    reportError: () => {},
    services: { render: () => {} },
    command: () => new Promise(() => {}) // the project never finishes opening
  })
  await controller.refreshChoices()
  controller.checkReadiness()
  await controller.refreshReadiness()
  await controller.action({ chat: HOME, action: 'start-target', value: '/fixture' })
  controller.get(HOME).text = 'Start here'
  await controller.composer({ chat: HOME, action: 'send', stop: false, attempt: 11 })
  await tick()
  assert.equal(controller.start.pending, true)
  assert.deepEqual(renders.at(-1).composer.sending, { attempt: 11, active: true })
  await controller.composer({ chat: HOME, action: 'cancel-send', attempt: 11 })
  assert.equal(controller.start.pending, false, 'Stop cancels the pending open')
  assert.deepEqual(renders.at(-1).composer.sending, { attempt: 11, active: false })
  assert.equal(controller.get(HOME).text, 'Start here', 'the home draft is kept')
}
console.log('ok - controller holds, cancels and releases a send that has not left')

if (process.platform !== 'darwin') {
  console.log('COMPOSER-SENDING SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('composer-sending', [
    'test/fixtures/composer-sending/main.swift',
    'src/native/ComposerSending.swift'
  ])
  console.log(runFixture(binary).trim())
}
