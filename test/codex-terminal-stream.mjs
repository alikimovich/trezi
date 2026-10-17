import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The fake CLI yields a terminal event and then either closes its stream by itself
// ('natural turn') or never does. An open stream is cut after a short grace period
// by aborting the signal the adapter hands the SDK, like the real CLI being killed;
// a stream that ends on its own must not be cut (no return(), no abort).
process.env.TREZI_CODEX_STREAM_GRACE_MS = '300'
const prompts = []
let closed = 0
let naturalEnds = 0
let naturalReturned = 0
let naturalAborted = false
class FakeCodex {
  startThread() {
    return this.thread()
  }
  resumeThread() {
    return this.thread()
  }
  thread() {
    return {
      id: null,
      runStreamed: async (prompt, options) => ({
        events: (async function* () {
          prompts.push(prompt)
          const natural = prompt === 'natural turn'
          let finishedYielding = false
          try {
            yield {
              type: 'item.completed',
              item: { id: 'item_0', type: 'agent_message', text: 'The task is complete.' }
            }
            yield {
              ...(prompt === 'failed turn'
                ? { type: 'turn.failed', error: { message: 'fixture failure' } }
                : {
                    type: 'turn.completed',
                    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }
                  })
            }
            if (natural) {
              await new Promise((resolve) => setTimeout(resolve, 50))
              finishedYielding = true
              naturalAborted = options.signal.aborted
              return
            }
            await new Promise((resolve) => {
              if (options.signal.aborted) resolve()
              else options.signal.addEventListener('abort', resolve, { once: true })
            })
          } finally {
            if (natural) {
              if (finishedYielding) naturalEnds++
              else naturalReturned++
            } else closed++
          }
        })()
      })
    }
  }
}
mock.module('@openai/codex-sdk', () => ({ Codex: FakeCodex }))
mock.module('../src/main/backends/codex-mcp.ts', () => ({
  treziMcpConfig: () => ({ mcp_servers: {} }),
  verifyTreziMcp: async () => {},
  isolatedCodexConfig: (config = {}) => config,
  gitAccessHook: () => ({})
}))
mock.module('../src/main/trezi-agent-tools.ts', () => ({
  registerTreziAgentTools: async () => ({ socketPath: '/nowhere', token: 'fake', dispose() {} }),
  shutdownTreziAgentTools: async () => {}
}))

const { codexProvider } = await import('../src/main/backends/codex.ts')
const { NativeChatController } = await import('../src/native/chat-controller.ts')
const root = mkdtempSync(join(tmpdir(), 'trezi-codex-terminal-'))
const chatKey = 'fixture-codex-terminal'
const events = []
const deliveries = []
let controller
let complete
let targetDone = 2
const turnsCompleted = new Promise((resolve) => {
  complete = resolve
})
const previousBin = process.env.TREZI_CODEX_BIN
const versionCli = join(root, 'codex-version')
writeFileSync(versionCli, '#!/bin/sh\necho codex-cli 0.160.1\n')
chmodSync(versionCli, 0o755)
process.env.TREZI_CODEX_BIN = versionCli // only the adapter's version probe; no Codex process
try {
  const session = await codexProvider.startSession(
    root,
    { provider: 'codex', permissionMode: 'auto' },
    () => null,
    {
      emitKey: chatKey,
      onEvent: (event) => {
        events.push(event)
        controller?.event(event)
        if (events.filter((entry) => entry.type === 'done').length === targetDone) complete()
      }
    }
  )
  controller = new NativeChatController({
    invoke: async (name, ...args) => {
      if (name === 'agent:send') session.send(args[0])
      if (name === 'agent:chat-ui-delivery') deliveries.push(args)
      return { ok: true }
    },
    render: () => {},
    effect: () => {}
  })
  const chat = controller.get(chatKey)
  chat.ready = true
  chat.root = root
  chat.isRunning = true
  chat.context = {
    chat: chatKey,
    root,
    selection: null,
    turn: {},
    setup: { needed: false, dismissed: false, status: null },
    tokens: { needed: false, dismissed: false },
    notes: [],
    spawns: []
  }
  chat.queue.push({
    id: 'ui-answer',
    chatUiId: 'ui-answer',
    text: 'Everything is there; it is OK.',
    attachments: [],
    selection: null,
    turn: {}
  })

  session.send('first turn')
  let timeout
  try {
    await Promise.race([
      turnsCompleted,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Codex terminal did not drain the queued answer')),
          3000
        )
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
  assert.equal(prompts.length, 2, 'the queued answer starts one following turn')
  assert.equal(prompts[1].includes('Everything is there; it is OK.'), true)
  assert.equal(events.filter((event) => event.type === 'done').length, 2)
  assert.equal(chat.queue.length, 0)
  assert.equal(chat.isRunning, false, 'Writing and Stop clear when the turn completes')
  assert.equal(deliveries.length, 1)
  assert.equal(closed, 2, 'both open streams closed at their terminal events')
  targetDone = 3
  const failureCompleted = new Promise((resolve) => {
    complete = resolve
  })
  session.send('failed turn')
  let failureTimeout
  try {
    await Promise.race([
      failureCompleted,
      new Promise((_, reject) => {
        failureTimeout = setTimeout(() => reject(new Error('Codex failure did not finish')), 3000)
      })
    ])
  } finally {
    clearTimeout(failureTimeout)
  }
  assert.equal(events.filter((event) => event.type === 'error').length, 1)
  assert.equal(events.filter((event) => event.type === 'done').length, 3)
  assert.equal(closed, 3, 'failed turns also close their open stream')
  targetDone = 4
  const naturalCompleted = new Promise((resolve) => {
    complete = resolve
  })
  session.send('natural turn')
  let naturalTimeout
  try {
    await Promise.race([
      naturalCompleted,
      new Promise((_, reject) => {
        naturalTimeout = setTimeout(() => reject(new Error('natural stream did not finish')), 3000)
      })
    ])
  } finally {
    clearTimeout(naturalTimeout)
  }
  assert.equal(naturalEnds, 1, 'the stream ended on its own after the terminal event')
  assert.equal(naturalReturned, 0, 'the iterator was not closed with return()')
  assert.equal(naturalAborted, false, 'the CLI was not cut while it was exiting by itself')
  assert.equal(events.filter((event) => event.type === 'done').length, 4)
  assert.equal(closed, 3, 'open-stream counter is untouched by the natural stream')
  session.dispose()
} finally {
  if (previousBin === undefined) delete process.env.TREZI_CODEX_BIN
  else process.env.TREZI_CODEX_BIN = previousBin
  rmSync(root, { recursive: true, force: true })
}
console.log('codex-terminal-stream: OK')
