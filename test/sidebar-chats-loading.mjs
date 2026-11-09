// LKM-618: at launch the sidebar listed the project's stored chat keys before the agent reopened
// the project. `agent:open-project` keeps only the current chat (its peers become History), so
// the stored peers showed as a stack of "Loading chat" rows that vanished. Through the real
// workspace, chat and shell controllers, with the agent's replies held by hand (no sleeps): while
// the list is unconfirmed, unresolved chats are not rows and the project carries one loading line.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { NativeShellController } from '../src/native/shell-controller.ts'
import { NativeWorkspaceController } from '../src/native/workspace-controller.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick()
}
const gate = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}
const record = (key, extra = {}) => ({
  key,
  root: key,
  name: key.slice(1),
  url: null,
  previewKind: 'web',
  branch: null,
  launchSpec: null,
  touchedAt: 1,
  ...extra
})
const live = (sessionKey, title) => ({
  sessionKey,
  options: { provider: 'codex', permissionMode: 'auto' },
  isRunning: false,
  record: { transcript: [], title }
})

/** One app launch: a stored workspace, an agent with no open projects yet, held opens. */
function launch(stored, activeKey) {
  const agent = new Map(),
    opens = new Map(),
    reopen = new Map(),
    calls = []
  const view = { projects: stored, activeKey, recents: [] }
  const store = {
    snapshot: () => structuredClone(view),
    open: async (root) => ({ key: root, created: false }),
    select: async (key) => {
      view.activeKey = key
    },
    close: async (key) => {
      view.projects = view.projects.filter((p) => p.key !== key)
    },
    reorder: async () => {},
    update: async (patches) => {
      for (const patch of patches)
        Object.assign(view.projects.find((p) => p.key === patch.key) ?? {}, patch.fields)
    },
    recent: async () => {},
    subscribe() {}
  }
  const invoke = async (channel, ...args) => {
    calls.push([channel, ...args])
    const root = args[0]
    if (channel === 'agent:workspace-snapshot') return { projects: [...agent.values()] }
    if (channel === 'agent:open-project') {
      const held = gate()
      opens.set(root, held)
      await held.promise
      const chats = reopen.get(root) ?? [live(root, `${root.slice(1)} chat`)]
      agent.set(root, { root, projectKey: root, chats, activeSessionKey: chats[0]?.sessionKey })
      return { transcript: [] }
    }
    if (channel === 'project:detect')
      return {
        name: root.slice(1),
        devCommand: 'bun run dev',
        framework: 'vite',
        previewKind: 'web'
      }
    if (channel === 'git:ensure' || channel === 'git:list') return { branch: 'main' }
    if (channel === 'devserver:info') return { running: false }
    if (channel === 'devserver:start') return { url: 'http://127.0.0.1:7784' }
    if (channel === 'sessions:list') return []
    if (channel === 'agent:new-chat') {
      const sessionKey = `${root}#new`
      agent.get(root).chats.push(live(sessionKey, ''))
      return { ok: true, sessionKey }
    }
    if (channel === 'agent:turn-state') return { turn: {}, running: false }
    if (channel === 'providers:choices') return []
    return { ok: true }
  }
  const chat = new NativeChatController({ invoke, render: () => {}, effect: () => {} })
  const workspace = new NativeWorkspaceController({
    store,
    invoke,
    render: () => {},
    activate: async () => {},
    closeChat: (key) => chat.chats.delete(key),
    reusableChat: () => false
  })
  const renders = []
  const shell = new NativeShellController(
    workspace,
    chat,
    { mode: 'merge', decorate: (s) => s },
    { get: () => undefined, set: async () => {} },
    (s) => renders.push(s),
    () => {}
  )
  const state = () => {
    shell.render()
    return renders.at(-1)
  }
  const row = (key) => state().rows.find((r) => r.project === key)
  const shown = (key) => row(key).recent?.map((r) => [r.session, r.title])
  /** The open request for `root`, once the controller has sent it. */
  const opened = async (root) => {
    for (let i = 0; i < 50 && !opens.has(root); i++) await tick()
    assert.ok(opens.has(root), `open-project ${root} was requested`)
    const held = opens.get(root)
    opens.delete(root)
    return held
  }
  return { agent, reopen, calls, chat, workspace, shell, state, row, shown, opened }
}
const keys = ['/p', '/p#1', '/p#2', '/p#3']

// --- The reported case: four stored keys, one real chat -------------------------------------
{
  const app = launch([record('/p', { sessionKeys: keys, activeSessionKey: '/p' })], '/p')
  const attached = app.workspace.command({ type: 'attach' })
  const open = await app.opened('/p')
  assert.equal(app.workspace.chatListPending('/p'), true)
  assert.deepEqual(app.shown('/p'), [], 'no unresolved chat is a row while the list is read')
  assert.equal(app.row('/p').chatsLoading, true, 'one loading line stands for the list')
  assert.equal(
    app.row('/p').children.filter((r) => r.kind === 'chat').length,
    0,
    'no chat rows to select, archive or open a menu on'
  )
  assert.equal(app.state().selected, 'chat:/p', 'the selected chat keeps its identity')
  assert.deepEqual(app.workspace.active.sessionKeys, keys, 'stored keys are kept, not dropped')
  open.resolve()
  await attached
  await settle()
  assert.equal(app.workspace.chatListPending('/p'), false)
  assert.deepEqual(app.workspace.active.sessionKeys, ['/p'], 'the agent lists one open chat')
  assert.equal(app.row('/p').chatsLoading, undefined, 'the loader ends with the list')
  await app.chat.initialize(app.chat.get('/p'))
  assert.deepEqual(app.shown('/p'), [['/p', 'p chat']], 'the one actual chat, titled')
  assert.equal(app.state().selected, 'chat:/p')
}

// --- Several actual chats survive, and a valid cached title stays while the list is read ----
{
  const app = launch([record('/p', { sessionKeys: keys, activeSessionKey: '/p' })], '/p')
  app.reopen.set('/p', [live('/p', 'First'), live('/p#2', 'Second')])
  app.chat.get('/p#2').title = 'Cached second'
  const attached = app.workspace.command({ type: 'attach' })
  const open = await app.opened('/p')
  assert.deepEqual(app.shown('/p'), [['/p#2', 'Cached second']], 'cached real content is kept')
  assert.equal(app.row('/p').chatsLoading, true, 'and the rest are still loading')
  open.resolve()
  await attached
  await settle()
  for (const key of ['/p', '/p#2']) await app.chat.initialize(app.chat.get(key))
  assert.deepEqual(
    app.shown('/p'),
    [
      ['/p#2', 'Second'],
      ['/p', 'First']
    ],
    'both actual chats, newest opened first'
  )
  assert.equal(app.row('/p').chatsLoading, undefined)
  assert.equal(app.state().selected, 'chat:/p', 'the selection survives the refresh')
}

// --- A successfully empty list is not pending -----------------------------------------------
{
  const app = launch([record('/p', { sessionKeys: keys, activeSessionKey: '/p' })], '/p')
  app.reopen.set('/p', [])
  const attached = app.workspace.command({ type: 'attach' })
  ;(await app.opened('/p')).resolve()
  await attached
  await settle()
  assert.deepEqual(app.shown('/p'), [], 'nothing to list')
  assert.equal(app.row('/p').chatsLoading, undefined, 'and no loader: the list is known')
}

// --- An error ends the loader without inventing rows ----------------------------------------
{
  const app = launch([record('/p', { sessionKeys: keys, activeSessionKey: '/p' })], '/p')
  const attached = app.workspace.command({ type: 'attach' })
  ;(await app.opened('/p')).reject(new Error('Agent failed'))
  await attached
  await settle()
  assert.equal(app.workspace.state.status.kind, 'error')
  assert.equal(app.row('/p').chatsLoading, undefined, 'no cat hides the error')
  assert.deepEqual(app.shown('/p'), [], 'and no fake rows')
  assert.deepEqual(app.workspace.active.sessionKeys, keys, 'the stored keys stay for a retry')
  // Retry: selecting the project again reopens it.
  const retried = app.workspace.select('/p')
  const open = await app.opened('/p')
  assert.equal(app.row('/p').chatsLoading, true, 'the retry loads again')
  open.resolve()
  await retried
  await settle()
  assert.equal(app.row('/p').chatsLoading, undefined)
  assert.deepEqual(app.workspace.active.sessionKeys, ['/p'])
}

// --- Switching projects while the old list loads --------------------------------------------
{
  const app = launch(
    [
      record('/a', { sessionKeys: ['/a', '/a#1', '/a#2'], activeSessionKey: '/a' }),
      record('/b', { sessionKeys: ['/b', '/b#1'], activeSessionKey: '/b' })
    ],
    '/a'
  )
  const attached = app.workspace.command({ type: 'attach' })
  const openA = await app.opened('/a')
  assert.equal(app.row('/a').chatsLoading, true)
  const toB = app.workspace.select('/b')
  const openB = await app.opened('/b')
  assert.equal(app.row('/a').chatsLoading, undefined, 'only the selected project nests a loader')
  assert.equal(app.row('/b').chatsLoading, true)
  assert.equal(app.state().selected, 'chat:/b')
  openA.resolve()
  await attached
  await settle()
  assert.equal(app.state().project, '/b', 'a late completion does not select the old project')
  assert.equal(app.row('/b').chatsLoading, true, "and does not end the new project's loader")
  assert.deepEqual(app.shown('/b'), [], 'nor put its chats under the new project')
  assert.deepEqual(app.workspace.state.projects.find((p) => p.key === '/a').sessionKeys, ['/a'])
  openB.resolve()
  await toB
  await settle()
  await app.chat.initialize(app.chat.get('/b'))
  assert.deepEqual(app.shown('/b'), [['/b', 'b chat']])
  assert.equal(app.row('/b').chatsLoading, undefined)
}

// --- New chat, archive and History still work once the list is known ------------------------
{
  const app = launch([record('/p', { sessionKeys: keys, activeSessionKey: '/p' })], '/p')
  const attached = app.workspace.command({ type: 'attach' })
  ;(await app.opened('/p')).resolve()
  await attached
  await settle()
  await app.workspace.command({ type: 'new-chat', key: '/p' })
  assert.ok(app.workspace.active.sessionKeys.length === 2, 'new chat adds an open chat')
  const created = app.workspace.active.activeSessionKey
  app.chat.get(created).ready = true
  assert.ok(
    app.shown('/p').some(([key]) => key === created),
    'a new chat is a row at once'
  )
  assert.equal(app.row('/p').chatsLoading, undefined)
}

// --- The Swift side: one noninteractive line, the existing cat, no app timer -----------------
const loader = readFileSync('src/native/SidebarChatsLoader.swift', 'utf8')
assert.match(loader, /CatArtwork\.frames\["run"\]/, 'reuses the preview cat')
assert.doesNotMatch(loader, /Timer\.scheduledTimer|CVDisplayLink|displayLink/, 'no app clock')
const cell = readFileSync('src/native/ProjectCell.swift', 'utf8')
assert.match(cell, /"kind":"chats-loading"/)
const chats = readFileSync('src/native/SidebarChats.swift', 'utf8')
assert.match(
  chats,
  /shouldSelectItem item: Any\) -> Bool \{ \["project", "chat"\]\.contains/,
  'only projects and chats are selectable'
)

console.log(
  'Sidebar chats loading: stored keys hidden until listed, one loader, cached titles, empty, error/retry, project switch and new chat passed'
)
