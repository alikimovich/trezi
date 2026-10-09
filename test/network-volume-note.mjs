// LKM-144: the one-time explanation of macOS's network-volume prompt. It shows on the
// first Claude turn of a profile only, never for Codex, Gemini or a connection, and is
// remembered in the service-owned preferences.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import {
  NETWORK_VOLUME_NOTE,
  NETWORK_VOLUME_NOTE_KEY,
  networkVolumeNote,
  runsClaudeCli
} from '../src/native/network-volume-note.ts'

const store = new Map(),
  writes = []
const preferences = {
  get: (key) => store.get(key) ?? null,
  set: async (key, value) => {
    writes.push([key, value])
    store.set(key, value)
  }
}

assert.equal(runsClaudeCli({ provider: 'claude' }), true)
assert.equal(runsClaudeCli({ provider: undefined }), true)
assert.equal(runsClaudeCli({ provider: 'codex' }), false)
assert.equal(runsClaudeCli({ provider: 'gemini' }), false)
assert.equal(runsClaudeCli({ provider: 'claude', connectionId: 'c1' }), false)

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const live = (chat, provider) => ({
  sessionKey: chat,
  record: { transcript: [], title: chat },
  isRunning: false,
  options: { provider, permissionMode: 'auto' }
})
const snapshot = {
  projects: [
    {
      root: '/fixture',
      chats: [live('codex', 'codex'), live('claude', 'claude'), live('again', 'claude')]
    }
  ]
}
const sent = []
const controller = new NativeChatController({
  invoke: async (channel, ...args) => {
    if (channel === 'agent:workspace-snapshot') return snapshot
    if (channel === 'providers:choices')
      return [
        {
          value: 'claude:default',
          modelId: 'default',
          provider: 'claude',
          group: 'Claude',
          label: 'Default'
        },
        {
          value: 'codex:default',
          modelId: 'default',
          provider: 'codex',
          group: 'Codex',
          label: 'Default'
        }
      ]
    if (channel === 'agent:send') sent.push(args[2])
    return { ok: true }
  },
  render: () => {},
  effect: () => {},
  notice: networkVolumeNote(preferences)
})
const context = (chat) => ({
  chat,
  root: '/fixture',
  selection: null,
  turn: {},
  setup: { needed: false, dismissed: false, status: null },
  tokens: { needed: false, dismissed: false },
  notes: [],
  spawns: []
})
const statuses = (chat) =>
  controller
    .get(chat)
    .messages.filter((m) => m.role === 'assistant')
    .flatMap((m) => m.statuses)
let revision = 0
const turn = async (chat) => {
  await controller.command({ type: 'context', context: context(chat) })
  await controller.composer({ chat, action: 'input', text: 'Hi', caret: 2, revision: ++revision })
  await controller.composer({ chat, action: 'send' })
  await tick()
}

await controller.refreshChoices()
await turn('codex')
assert.deepEqual(sent, ['codex'])
assert.deepEqual(statuses('codex'), [], 'a Codex turn does not explain a Claude prompt')
assert.deepEqual(writes, [])

await turn('claude')
assert.deepEqual(sent, ['codex', 'claude'])
assert.deepEqual(
  statuses('claude'),
  [NETWORK_VOLUME_NOTE],
  'the first Claude turn explains the prompt'
)
assert.equal(controller.get('claude').activityDetail, NETWORK_VOLUME_NOTE)
assert.deepEqual(writes, [[NETWORK_VOLUME_NOTE_KEY, 'shown']])

await turn('again')
assert.deepEqual(statuses('again'), [], 'once per profile, not per chat')
assert.equal(writes.length, 1)
console.log('Network-volume note: first Claude turn only, remembered, not for Codex passed.')
