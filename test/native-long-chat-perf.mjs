// LKM-165: a long chat must not slow the app. On a synthetic 2,000-message chat, the
// preview mode switch and adding an attachment each stay under 100 ms, the bridge
// payload included: an unchanged transcript is not re-sent to the host, so neither
// re-serializes (or makes Swift re-decode) the whole conversation.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { chatFrames } from '../src/native/chat-frames.ts'
import { NativeShellController } from '../src/native/shell-controller.ts'

const ROOT = '/Users/someone/dev/app'
const MESSAGES = 2000
const BUDGET_MS = 100
const transcript = []
for (let i = 0; i < MESSAGES / 2; i++) {
  transcript.push({ role: 'user', text: `Change the hero section, step ${i}. `.repeat(6), at: i })
  transcript.push({
    role: 'assistant',
    text: `Updated ${ROOT}/src/components/Hero${i}.tsx and its styles. `.repeat(20),
    tools: Array.from({ length: 6 }, (_, t) => `Edit ${ROOT}/src/components/Hero${i}-${t}.tsx`),
    at: i
  })
}
const context = {
  chat: 'long',
  root: ROOT,
  selection: null,
  turn: {},
  setup: { needed: false, dismissed: false, status: null },
  tokens: { needed: false, dismissed: false },
  notes: [],
  spawns: []
}
// The host bridge serializes every frame it sends (`chat-runtime.ts`); its size is
// what the host decodes on its main thread.
const frames = []
const frame = chatFrames()
const chat = new NativeChatController({
  invoke: async (channel) => {
    if (channel === 'agent:workspace-snapshot')
      return {
        projects: [
          {
            root: ROOT,
            chats: [
              {
                sessionKey: 'long',
                record: { transcript, title: 'Long chat' },
                isRunning: false,
                options: { provider: 'claude', permissionMode: 'auto' }
              }
            ]
          }
        ]
      }
    if (channel === 'providers:choices') return []
    return { ok: true }
  },
  render: (state) => frames.push(JSON.stringify(frame(state))),
  effect() {}
})
await chat.command({ type: 'context', context })
const long = chat.get('long')
assert.ok(long.messages.length >= MESSAGES, `the synthetic chat has ${long.messages.length}`)
assert.ok(frames.at(-1).length > 1_000_000, 'the first frame carries the whole transcript')

const active = { key: 'p', root: ROOT, url: 'http://127.0.0.1:7784/', viewport: 'desktop' }
const workspace = {
  state: {
    projects: [{ key: 'p', root: ROOT, name: 'app', sessionKeys: ['long'] }],
    status: { kind: 'running' },
    history: {},
    recents: [],
    loadedKey: 'p'
  },
  active: { ...active, activeSessionKey: 'long' },
  services: { invoke: async () => ({}) },
  changed() {}
}
const shellFrames = []
const shell = new NativeShellController(
  workspace,
  chat,
  { mode: 'merge', decorate: (s) => s },
  { get: () => undefined, set: async () => {} },
  (s) => shellFrames.push(JSON.stringify(s)),
  () => {}
)
shell.render()

/** The slowest of a few runs, so one GC pause does not decide it either way. */
async function measure(label, run) {
  const times = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    await run(i)
    times.push(performance.now() - start)
  }
  const worst = Math.max(...times)
  console.log(
    `${label}: worst ${worst.toFixed(1)} ms of ${times.map((t) => t.toFixed(1)).join(', ')}`
  )
  assert.ok(worst < BUDGET_MS, `${label} took ${worst.toFixed(1)} ms (budget ${BUDGET_MS} ms)`)
}

// The mode switch: the shell action, plus the chat frame it shares the loop with.
await measure('mode switch', async () => {
  await shell.action({ action: 'select-object' })
  chat.changed(long)
})
await measure('attachment add', async (i) => {
  await chat.composer({
    chat: 'long',
    action: 'files',
    files: [{ name: `shot-${i}.png`, type: 'image/png', data: 'iVBORw0KGgo='.repeat(4000) }]
  })
})
assert.equal(long.attachments.length, 5)
const composerFrame = JSON.parse(frames.at(-1))
assert.equal(composerFrame.messages, undefined, 'composer frames do not re-send the transcript')
assert.equal(composerFrame.composer.attachments.length, 5)

// A transcript change still reaches the host in full; another chat always does.
long.messages.at(-1).text = 'Edited'
chat.changed(long)
assert.equal(JSON.parse(frames.at(-1)).messages.at(-1).text, 'Edited')
chat.changed(long)
assert.equal(JSON.parse(frames.at(-1)).messages, undefined)
const other = frame({ ...JSON.parse(frames.at(-2)), chat: 'other' })
assert.equal(other.messages.length, long.messages.length, 'a different chat gets its transcript')
console.log(
  'NATIVE LONG CHAT PERF OK — mode switch and attachment add under 100 ms at 2,000 messages'
)
