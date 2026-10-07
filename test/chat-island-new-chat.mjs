import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatIslands } from '../src/main/chat-islands.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { islandLocator, islandRestorer } from '../src/native/chat-island-session.ts'

// LKM-199: a chat created through the instant path (LKM-182) is listed before its
// record exists. Its island session must still be registered once the workspace is
// ready, and an island define in it must wait for that instead of failing.
const root = await mkdtemp(join(tmpdir(), 'trezi-island-new-chat-'))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** The Swift editing owner's island surface, in memory. */
function stubOwner() {
  const open = new Map()
  const calls = []
  let next = 0
  return {
    kind: 'swift',
    calls,
    open,
    async islandsOpen(chat, root, record) {
      calls.push(['open', chat, record])
      open.set(chat, { root, record, records: [] })
      return []
    },
    async islandsClose(chat) {
      calls.push(['close', chat])
      open.delete(chat)
    },
    async islandDefine(chat, turn) {
      if (!open.has(chat))
        throw new Error('This chat is not available for interactive islands yet.')
      return { token: `t${++next}`, id: `island-${next}`, revision: 1, turn, replacing: false }
    },
    async islandCommit(chat, token, definition, engine, initial, fallback, name) {
      const record = {
        version: 1,
        id: `island-${token.slice(1)}`,
        revision: 1,
        turn: 1,
        ...definition,
        engine,
        status: 'waiting',
        initial,
        name
      }
      open.get(chat).records.push(record)
      return open.get(chat).records
    },
    async islandAbort() {},
    async islandHealth(chat) {
      return open.get(chat)?.records ?? null
    },
    async islandSettle(chat) {
      return { records: open.get(chat)?.records ?? null, cancelled: false }
    }
  }
}

const request = {
  action: 'define',
  engine: 'agent',
  manifest: {
    file: 'appearance.js',
    component: 'ProjectCard',
    title: 'Project animation',
    params: [
      {
        id: 'duration',
        label: 'Duration',
        kind: 'number',
        min: 0,
        max: 2,
        step: 0.05,
        apply: { strategy: 'literal', anchor: 'const DURATION = ' }
      }
    ]
  },
  blocks: [{ id: 'motion', title: 'Motion', kind: 'group', params: ['duration'] }]
}

try {
  await writeFile(join(root, 'appearance.js'), 'const DURATION = 0.4;\n')
  const owner = stubOwner()
  // The new chat's preparation (worktree, provider, record) is still running.
  const preparation = deferred()
  const records = new Map([['restored', 'record-restored']])
  const invokes = []
  let controller
  const islands = new ChatIslands(() => {}, undefined, {
    owner,
    locate: islandLocator(
      async (channel, chat) => {
        invokes.push([channel, chat])
        assert.equal(channel, 'agent:chat-record')
        if (chat === 'new') await preparation.promise
        const recordId = records.get(chat)
        return recordId ? { root, recordId } : null
      },
      (chat) => controller.get(chat).messages.filter((m) => m.role === 'user').length,
      (chat) => controller.closed.has(chat)
    )
  })
  const live = (key, id) => ({
    sessionKey: key,
    record: { id, transcript: [], title: '' },
    isRunning: false,
    options: { provider: 'codex' }
  })
  controller = new NativeChatController({
    restoreIslands: islandRestorer(islands, (chat) => controller.get(chat).messages.length),
    invoke: async (channel) => {
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root,
              chats: [live('restored', 'record-restored'), live('new', ''), live('gone', '')]
            }
          ]
        }
      if (channel === 'providers:choices') return []
      return { ok: true }
    },
    render: () => {},
    effect: () => {}
  })

  // Restore: a chat with a record registers at once.
  await controller.initialize(controller.get('restored'))
  assert.equal(islands.sessions.get('restored')?.recordId, 'record-restored')
  assert.ok(!invokes.some(([, chat]) => chat === 'restored'), 'A restored chat needs no lookup')

  // New chat: listed with an empty record while its workspace is prepared.
  await controller.initialize(controller.get('new'))
  assert.ok(controller.get('new').ready, 'The composer is ready before the workspace')
  assert.ok(!islands.sessions.has('new'), 'No session before the record exists')
  assert.deepEqual(invokes.at(-1), ['agent:chat-record', 'new'], 'It waits for the workspace')

  // An island define before the workspace is ready waits for it instead of failing.
  const defined = islands.tool('new', root, request)
  await tick()
  records.set('new', 'record-new')
  preparation.resolve()
  const made = await defined
  assert.equal(made.error, undefined, JSON.stringify(made))
  assert.ok(made.id, 'The island is defined in the brand-new chat')
  assert.equal(islands.sessions.get('new')?.recordId, 'record-new')
  assert.deepEqual(
    owner.calls.filter(([kind, chat]) => kind === 'open' && chat === 'new'),
    [['open', 'new', 'record-new']],
    'One session for the new chat, against its record'
  )
  assert.equal(islands.attachments('new').length, 1, 'The island is attached to the chat')

  // Provider switch: the record is kept, so the session is too (no reopen).
  const before = islands.sessions.get('new')
  assert.equal(await islands.ensure('new'), before)
  islandRestorer(islands, () => 1)('new', root, 'record-new')
  assert.equal(islands.sessions.get('new'), before)

  // A chat whose session is missing for another reason registers on the first tool call.
  islands.close('restored')
  const again = await islands.tool('restored', root, {
    ...request,
    manifest: { ...request.manifest }
  })
  assert.equal(again.error, undefined, JSON.stringify(again))
  assert.equal(islands.sessions.get('restored')?.recordId, 'record-restored')

  // A chat closed while its workspace is prepared gets no session.
  const gone = deferred()
  const closing = new ChatIslands(() => {}, undefined, {
    owner: stubOwner(),
    locate: async () => {
      await gone.promise
      return { root, recordId: 'record-gone', turn: () => 1 }
    }
  })
  const pending = closing.ensure('gone')
  closing.close('gone')
  gone.resolve()
  assert.equal(await pending, undefined)
  assert.ok(!closing.sessions.has('gone'))
  // A chat with no workspace answers plainly, never "not available yet".
  const none = await new ChatIslands(() => {}, undefined, { owner: stubOwner() }).tool(
    'none',
    root,
    request
  )
  assert.doesNotMatch(none.error, /not available for interactive islands yet/)
  console.log('chat-island-new-chat: OK')
} finally {
  await rm(root, { recursive: true, force: true })
}
