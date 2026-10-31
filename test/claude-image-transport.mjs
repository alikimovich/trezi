// LKM-390: the Claude transport of composer images, the path Codex now has to match.
// `session.send` (claude.ts) hands text and images to `InputStream.push`, whose message is
// what the Agent SDK sends: a plain string with no image, otherwise text and base64 vision
// blocks, in order. A resume the SDK refuses replays the same images into the new session.
// The SDK is a stand-in that records each `query` and its input stream; no CLI, no network.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const queries = []
const result = { type: 'result', subtype: 'success', result: 'ok', is_error: false, usage: {} }

function query({ prompt, options }) {
  const record = { resume: options.resume, messages: [] }
  queries.push(record)
  const stream = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: `session-${queries.length}` }
    for await (const message of prompt) {
      record.messages.push(message)
      if (options.resume) throw new Error('No conversation found with session ID')
      yield result
    }
  })()
  return Object.assign(stream, {
    supportedCommands: async () => [],
    supportedModels: async () => [],
    setModel: async () => {},
    setPermissionMode: async () => {},
    interrupt: async () => {}
  })
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query,
  createSdkMcpServer: () => ({ type: 'sdk', name: 'trezi' }),
  tool: (name) => ({ name })
}))

const { claudeProvider } = await import('../src/main/backends/claude.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-claude-images-')))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (ready, what) => {
  for (let i = 0; i < 500 && !ready(); i++) await sleep(10)
  assert.ok(ready(), what)
}
const start = async (ctx = {}) => {
  const events = []
  const session = await claudeProvider.startSession(scratch, { provider: 'claude' }, () => null, {
    emitKey: 'images',
    liveRoot: scratch,
    claudeCli: { executable: '/bin/true' },
    onEvent: (e) => events.push(e),
    ...ctx
  })
  return { session, events }
}
const content = (message) => message.message.content
const png = { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' }
const jpeg = { mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' }
const blocks = (text, ...images) => [
  { type: 'text', text },
  ...images.map(({ mediaType, data }) => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data }
  }))
]

try {
  const { session } = await start()
  session.send('Describe these', [png, jpeg])
  await until(() => queries[0].messages.length === 1, 'the first turn reached the SDK')
  assert.equal(queries[0].messages[0].message.role, 'user')
  assert.deepEqual(content(queries[0].messages[0]), blocks('Describe these', png, jpeg))
  session.send('And now just text')
  await until(() => queries[0].messages.length === 2, 'the next turn reached the SDK')
  assert.equal(content(queries[0].messages[1]), 'And now just text')
  session.send('', [png])
  await until(() => queries[0].messages.length === 3, 'an image alone reached the SDK')
  assert.deepEqual(content(queries[0].messages[2]), blocks('', png).slice(1))
  session.shutdown()

  // A resume the SDK refuses: the new session gets the summary and the same image.
  const lost = await start({ resumeSessionId: 'gone', resumeSummary: 'Earlier: a red square.' })
  lost.session.send('Same picture?', [png])
  await until(() => queries.at(-1).resume === undefined, 'a new session replaced the lost one')
  await until(() => queries.at(-1).messages.length === 1, 'the turn replayed into it')
  const replayed = content(queries.at(-1).messages[0])
  assert.equal(replayed[0].type, 'text')
  assert.match(replayed[0].text, /Earlier: a red square\./)
  assert.ok(replayed[0].text.endsWith('Same picture?'))
  assert.deepEqual(replayed.slice(1), blocks('', png).slice(1))
  assert.ok(
    lost.events.some((e) => e.type === 'status'),
    'the chat is told it was seeded'
  )
  lost.session.shutdown()
  console.log('Claude image transport: vision blocks reach the SDK, also after a lost resume.')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
