// LKM-376: the native chat Stop/queue check leaves a paused queue and a draft for its
// capture. The next check (history-menu) sends on the same chat; without the reset that
// send queued behind the leftover message and never reached its provider stub.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NativeChatController } from '../src/native/chat-controller.ts'
import {
  requireCleanSharedChat,
  resetSharedChat,
  sharedChatProblems
} from '../src/native/smoke-shared-chat.ts'
import { waitFor } from '../src/native/smoke-wait.ts'

async function afterStopQueueCheck({ reset }) {
  const sent = []
  let composer = {}
  let revision = 0
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: '/fixture',
              chats: [
                {
                  sessionKey: 'shared',
                  record: { transcript: [], title: 'Shared' },
                  isRunning: false,
                  options: { provider: 'codex', permissionMode: 'auto' }
                }
              ]
            }
          ]
        }
      if (channel === 'agent:send') sent.push(args[0])
      // smoke-chat's no-terminal Stop: interrupt does nothing, Bun reports the turn idle.
      if (channel === 'agent:turn-state')
        return { turn: controller.get(args[0]).turn, running: false }
      return undefined
    },
    render: (state) => {
      composer = state.composer
    },
    effect() {}
  })
  // Swift replies to chatPerform/composerPerform before Bun handles the forwarded action.
  const host = {
    async request(method, data = {}) {
      const chat = controller.active
      if (method === 'composerInspect') return { ...composer, queueCount: composer.queue.length }
      if (method === 'chatPerform')
        void controller.action({ chat, action: data.action, id: data.card })
      else if (method === 'composerPerform' && 'text' in data)
        void controller.composer({
          chat,
          action: 'input',
          text: data.text,
          caret: data.text.length,
          revision: ++revision
        })
      else if (method === 'composerPerform' && data.action === 'send')
        void controller.composer({ chat, action: 'send' })
      else throw new Error(`Unexpected host request ${method}`)
    }
  }
  const composerUntil = (check, label) =>
    waitFor(async () => {
      const value = await host.request('composerInspect')
      return check(value) && value
    }, label)
  await controller.command({
    type: 'context',
    context: {
      chat: 'shared',
      root: '/fixture',
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })

  // The Stop/queue sequence of smoke-chat.ts, with its unchanged assertions.
  await host.request('composerPerform', { text: 'Stop fixture turn' })
  await host.request('composerPerform', { action: 'send' })
  await waitFor(() => sent.length === 1, 'stop fixture reached the provider')
  await host.request('composerPerform', { text: 'Keep queued message' })
  await host.request('composerPerform', { action: 'send' })
  await composerUntil((value) => value.queueCount === 1, 'message queued')
  await host.request('composerPerform', { text: 'Keep draft' })
  await composerUntil((value) => value.text === 'Keep draft', 'draft kept')
  await host.request('chatPerform', { action: 'stop' })
  await waitFor(() => !controller.get('shared').isRunning, 'Stop settled')
  const stopped = await host.request('composerInspect')
  assert.equal(stopped.queuePaused, true)
  assert.equal(stopped.queueCount, 1)
  assert.equal(stopped.queue[0].text, 'Keep queued message')
  assert.equal(stopped.text, 'Keep draft')
  assert.equal(sent.length, 1, 'Stop sent a queued message automatically')

  if (reset) {
    const clean = await resetSharedChat(host)
    assert.deepEqual(sharedChatProblems(clean), [])
    assert.equal(clean.queuePaused, false)
    assert.equal(clean.queueCount, 0)
    assert.equal(clean.text, '')
    assert.equal(sent.length, 1, 'Resuming the emptied queue sent a leftover message')
  }
  const guard = await requireCleanSharedChat(host, 'history-menu').then(
    () => undefined,
    (error) => error
  )

  // history-menu's turn on the same chat.
  await host.request('composerPerform', { text: 'History indicator turn' })
  await composerUntil((value) => value.text === 'History indicator turn', 'history draft')
  await host.request('composerPerform', { action: 'send' })
  await composerUntil((value) => value.text === '', 'history turn submitted')
  await new Promise((resolve) => setTimeout(resolve, 20))
  return { sent, composer: await host.request('composerInspect'), guard }
}

// With the reset, the next check's send reaches the provider stub, not the queue.
{
  const { sent, composer, guard } = await afterStopQueueCheck({ reset: true })
  assert.equal(guard, undefined)
  assert.equal(sent.length, 2, 'history-menu send did not reach the provider stub')
  assert.ok(sent[1].endsWith('History indicator turn'))
  assert.equal(composer.queueCount, 0)
}

// Without it, the same send is queued behind the paused leftover and never reaches the
// stub (the praxis-24 history-menu timeout); the guard names the leftover state at once.
{
  const { sent, composer, guard } = await afterStopQueueCheck({ reset: false })
  assert.equal(sent.length, 1)
  assert.deepEqual(
    composer.queue.map((q) => q.text),
    ['Keep queued message', 'History indicator turn']
  )
  assert.match(
    String(guard?.message),
    /history-menu: an earlier check left 1 queued message\(s\), a paused queue, the draft "Keep draft"/
  )
}

// The native check resets in its `finally`, so a failed Stop assertion still cleans up,
// and history-menu checks before it sends.
{
  const chat = readFileSync(new URL('../src/native/smoke-chat.ts', import.meta.url), 'utf8')
  const cleanup = chat.slice(chat.lastIndexOf('} finally {'))
  assert.ok(cleanup.indexOf('resetSharedChat(host)') > 0, 'native-chat finally lost its reset')
  assert.ok(
    cleanup.indexOf('resetSharedChat(host)') < cleanup.indexOf('provider.restore()'),
    'the reset must run while the provider stub still catches sends'
  )
  const history = readFileSync(
    new URL('../src/native/smoke-history-menu.ts', import.meta.url),
    'utf8'
  )
  const guarded = history.indexOf("requireCleanSharedChat(host, 'history-menu')")
  assert.ok(
    guarded > 0 && guarded < history.indexOf("{ text: 'History indicator turn' }"),
    'history-menu no longer checks the shared chat before its send'
  )
}

console.log(
  'Native smoke shared chat: Stop/queue leftovers are reset, the next send reaches the provider stub, and leftover state fails fast.'
)
