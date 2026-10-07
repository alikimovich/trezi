import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatIslands } from '../src/main/chat-islands.ts'
import { PendingChats } from '../src/main/chat-pending.ts'
import { chatRecordLookup } from '../src/main/chat-record.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { islandLocator, islandRestorer } from '../src/native/chat-island-session.ts'
import { ISLAND_REASON, ISLAND_RECOVERY } from '../src/shared/chat-islands.ts'

// LKM-199: a chat created through the instant path (LKM-182) is listed before its
// record exists. Its island session must still be registered once the workspace is
// ready, and an island define in it must wait for that instead of failing.
const root = await mkdtemp(join(tmpdir(), 'trezi-island-new-chat-'))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
  // The registry `agent:chat-record` reads: the real PendingChats and the real lookup.
  const preparations = new Map()
  const pending = new PendingChats((chat) => preparations.get(chat.sessionKey).promise)
  const live = new Map([['restored', { recordId: 'record-restored', root, worktree: root }]])
  const repos = new Set([root])
  const sources = {
    settled: (key) => pending.settled(key),
    pending: (key) => pending.status(key),
    pendingRoot: (key) => pending.list().find((chat) => chat.sessionKey === key)?.root,
    session: (key) => live.get(key),
    isRepo: async (dir) => repos.has(dir)
  }
  const begin = (chat, projectRoot = root) => {
    const run = deferred()
    preparations.set(chat, run)
    pending.begin(chat, 'pk', projectRoot, {})
    return run
  }
  const preparation = begin('new')
  const invokes = []
  let controller
  const islands = new ChatIslands(() => {}, undefined, {
    owner,
    locate: islandLocator(
      async (channel, chat, wait) => {
        invokes.push([channel, chat, wait])
        assert.equal(channel, 'agent:chat-record')
        return chatRecordLookup(chat, wait, sources)
      },
      (chat) => controller.get(chat).messages.filter((m) => m.role === 'user').length,
      (chat) => controller.closed.has(chat)
    )
  })
  const liveChat = (key, id) => ({
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
              chats: [
                liveChat('restored', 'record-restored'),
                liveChat('new', ''),
                liveChat('gone', '')
              ]
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
  assert.deepEqual(invokes.at(-1), ['agent:chat-record', 'new', true], 'It waits for the workspace')

  // The catalog answers at once while the workspace is prepared, with the reason code.
  const early = await Promise.race([
    islands.tool('new', root, { action: 'catalog' }),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))
  ])
  assert.notEqual(early, 'blocked', 'The catalog does not wait for the workspace')
  assert.deepEqual(early.readiness, {
    ready: false,
    chat: 'new',
    code: 'workspace_pending',
    reason: ISLAND_REASON.workspace_pending,
    recovery: ISLAND_RECOVERY.workspace_pending
  })
  assert.deepEqual(early.actions, ['catalog', 'define', 'read', 'show', 'clone'])

  // An island define before the workspace is ready waits for it instead of failing.
  const defined = islands.tool('new', root, request)
  await tick()
  live.set('new', { recordId: 'record-new', root, worktree: root })
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
  // Ready: the catalog names the project root, record and checkout.
  const ready = await islands.tool('new', '/worktrees/new', { action: 'catalog' })
  assert.deepEqual(ready.readiness, {
    ready: true,
    chat: 'new',
    root,
    recordId: 'record-new',
    worktree: '/worktrees/new'
  })

  // Provider switch: the record is kept, so the session is too (no reopen).
  const before = islands.sessions.get('new')
  assert.equal(await islands.ensure('new'), before)
  islandRestorer(islands, () => 1)('new', root, 'record-new')
  assert.equal(islands.sessions.get('new'), before)

  // A workspace without a session is attached by the catalog itself (auto-attach).
  islands.close('restored')
  assert.ok(!islands.sessions.has('restored'))
  const catalog = await islands.tool('restored', root, { action: 'catalog' })
  assert.equal(catalog.readiness.ready, true, JSON.stringify(catalog.readiness))
  assert.equal(catalog.readiness.recordId, 'record-restored')
  assert.equal(islands.sessions.get('restored')?.recordId, 'record-restored')

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
  const waiting = closing.attach('gone')
  closing.close('gone')
  gone.resolve()
  assert.deepEqual(await waiting, { blocked: { code: 'closed' } })
  assert.ok(!closing.sessions.has('gone'))

  // Every way a chat cannot host islands: the same code and recovery from catalog,
  // define, read, show and clone.
  const blockedChat = async (chat, code, detail) => {
    const answers = [
      ['catalog', (await islands.tool(chat, root, { action: 'catalog' })).readiness],
      ...(await Promise.all(
        ['define', 'read', 'show', 'clone'].map(async (action) => [
          action,
          await islands.tool(chat, root, { ...request, action, id: 'x' })
        ])
      ))
    ]
    for (const [action, answer] of answers) {
      assert.equal(answer.code, code, `${chat} ${action}: ${JSON.stringify(answer)}`)
      assert.equal(answer.reason, ISLAND_REASON[code])
      assert.equal(answer.recovery, ISLAND_RECOVERY[code])
      assert.equal(answer.detail, detail, `${chat} ${action} detail`)
      if (action === 'catalog') assert.equal(answer.ready, false)
      else assert.equal(answer.error, `${ISLAND_REASON[code]} ${ISLAND_RECOVERY[code]}`, action)
      assert.doesNotMatch(JSON.stringify(answer), /not available for interactive islands yet/)
      assert.ok(!islands.sessions.has(chat), `${chat} gets no session`)
    }
  }
  // Preparation failed in a Git repository.
  begin('broken').reject(new Error('worktree boom'))
  await tick()
  await blockedChat('broken', 'preparation_failed', 'worktree boom')
  // Preparation failed in a folder that is not a Git repository.
  begin('plain', '/not/a/repo').reject(new Error('no repo here'))
  await tick()
  await blockedChat('plain', 'not_git', 'no repo here')
  // A chat that is neither pending nor live.
  await blockedChat('ghost', 'closed')
  // A live chat whose owner record is not stored yet.
  live.set('unrecorded', { recordId: '', root, worktree: root })
  await blockedChat('unrecorded', 'no_session')
  // No locator at all (nothing can find the chat's workspace).
  const bare = new ChatIslands(() => {}, undefined, { owner: stubOwner() })
  assert.deepEqual(await bare.attach('none'), { blocked: { code: 'no_session' } })
  assert.deepEqual((await bare.tool('none', root, request)).code, 'no_session')

  // The lookup behind `agent:chat-record`: pending is immediate unless it waits.
  const later = begin('later')
  assert.deepEqual(await chatRecordLookup('later', false, sources), {
    ready: false,
    code: 'workspace_pending'
  })
  const waited = chatRecordLookup('later', true, sources)
  live.set('later', { recordId: 'record-later', root, worktree: '/worktrees/later' })
  later.resolve()
  assert.deepEqual(await waited, {
    ready: true,
    recordId: 'record-later',
    root,
    worktree: '/worktrees/later'
  })
  console.log('chat-island-new-chat: OK')
} finally {
  await rm(root, { recursive: true, force: true })
}
