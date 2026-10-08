import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeWorkspaceController } from '../src/native/workspace-controller.ts'
import { workspaceService } from './helpers/workspace-fixture.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const gate = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
const projects = new Map(),
  calls = [],
  renders = [],
  active = []
let slow,
  installing,
  serving = false,
  failed = false,
  counter = 0
const profile = mkdtempSync(join(tmpdir(), 'trezi-workspace-controller-'))
process.on('exit', () => rmSync(profile, { recursive: true, force: true }))
const saved = () => readFileSync(join(profile, 'workspace.json'), 'utf8')
/** The store's operations land in `calls` too, so ordering against dependent commands is visible. */
function logged(store) {
  const wrap =
    (name) =>
    async (...args) => {
      calls.push([`store:${name}`, ...args])
      const result = await store[name](...args)
      calls.push([`stored:${name}`, ...args])
      return result
    }
  return {
    ...store,
    open: wrap('open'),
    select: wrap('select'),
    close: wrap('close'),
    reorder: wrap('reorder'),
    recent: wrap('recent'),
    update: store.update
  }
}
const services = (store) => ({
  store,
  render: (state) => renders.push(state),
  activate: async (entry) => {
    active.push(entry?.key ?? null)
  },
  closeChat() {},
  reusableChat: () => false,
  invoke: async (channel, ...args) => {
    calls.push([channel, ...args])
    const root = args[0]
    if (channel === 'agent:workspace-snapshot') return { projects: [...projects.values()] }
    if (channel === 'agent:open-project') {
      projects.set(root, {
        root,
        projectKey: root,
        chats: [{ sessionKey: root, options: {}, isRunning: false, record: { transcript: [] } }],
        activeSessionKey: root
      })
      return { transcript: [] }
    }
    if (channel === 'project:detect') {
      if (root === '/slow' && slow) await slow.promise
      if (root === '/failure' && failed) throw new Error('Preview failure')
      return {
        name: root.slice(1),
        devCommand: 'bun run dev',
        framework: 'vite',
        previewKind: 'web'
      }
    }
    if (channel === 'git:ensure') return { branch: 'trezi/test' }
    if (channel === 'devserver:info')
      return serving
        ? { running: true, server: { url: 'http://127.0.0.1:7784' } }
        : { running: false }
    if (channel === 'devserver:install') await installing?.promise
    if (channel === 'devserver:stop') serving = false
    if (channel === 'devserver:start') return { url: 'http://127.0.0.1:7784' }
    if (channel === 'sessions:list') return []
    if (channel === 'agent:new-chat' || channel === 'agent:resume-session') {
      const sessionKey = root + '#' + ++counter
      projects
        .get(root)
        .chats.push({ sessionKey, options: {}, isRunning: false, record: { transcript: [] } })
      return { ok: true, sessionKey }
    }
    if (channel === 'agent:close-chat') {
      const project = projects.get(root)
      project.chats = project.chats.filter((c) => c.sessionKey !== args[1])
      return { ok: true, activeSessionKey: project.chats[0]?.sessionKey }
    }
    if (channel === 'agent:close-project') projects.delete(root)
    return { ok: true }
  }
})
// The real Swift owner on this profile (the only workspace writer).
const running = []
const owner = async (dir) => {
  const service = await workspaceService(dir)
  running.push(service)
  return service.store
}
const shared = await owner(profile)
const controller = new NativeWorkspaceController(services(logged(shared)))
await controller.command({ type: 'attach' })
await controller.open('/one')
assert.equal(controller.state.status.kind, 'running')
await controller.command({ type: 'new-chat', key: '/one' })
const second = controller.active.activeSessionKey
assert.notEqual(second, '/one')
await controller.command({ type: 'chat', key: '/one', session: '/one' })
assert.equal(controller.active.activeSessionKey, '/one')
await assert.rejects(controller.command({ type: 'chat', key: '/one', session: '/other' }))
await controller.command({ type: 'close-chat', key: '/one', session: second })
assert.deepEqual(controller.active.sessionKeys, ['/one'])
// LKM-172: a switch to another project is heard before "Opening …" renders; a restart
// or a re-select of the loaded project is not a switch.
const switches = []
controller.switching = (key) => switches.push([key, renders.at(-1)?.status.kind])
await controller.command({ type: 'restart', key: '/one' })
await controller.select('/one')
assert.deepEqual(switches, [], 'Restarting or re-selecting the loaded project is no switch')
slow = gate()
const opening = controller.open('/slow')
await tick()
await controller.open('/two')
slow.resolve()
await opening
assert.deepEqual(
  switches.map(([key]) => key),
  ['/slow', '/two'],
  'Each switch to another project is heard'
)
assert.equal(switches[0][1], 'running', 'The switch is heard before Opening renders')
controller.switching = undefined
assert.equal(controller.state.activeKey, '/two')
assert.equal(active.at(-1), '/two')
assert.equal(controller.state.status.name, 'two')
slow = gate()
const closingOpen = controller.select('/slow')
await tick()
const closing = controller.close('/slow')
slow.resolve()
await Promise.all([closingOpen, closing])
assert.equal(projects.has('/slow'), false)
assert.ok(calls.some((c) => c[0] === 'devserver:stop' && c[1] === '/slow'))
assert.ok(!controller.state.projects.some((p) => p.key === '/slow'))
failed = true
await controller.open('/failure')
assert.equal(controller.state.status.kind, 'error')
assert.equal(controller.state.loadedKey, null)
assert.equal(active.at(-1), '/failure')
assert.ok(projects.has('/failure'), 'failed preview must retain repair chat')
await controller.close('/failure')
// A restart keeps the loaded chat during its busy phase, but a failed restart
// must hide that chat once the error replaces the preview.
failed = false
await controller.open('/failure')
assert.equal(controller.state.loadedKey, '/failure')
failed = true
await controller.command({ type: 'restart', key: '/failure' })
assert.equal(controller.state.status.kind, 'error')
assert.equal(controller.state.loadedKey, null)
await controller.close('/failure')
assert.equal(controller.state.activeKey, '/two')
assert.equal(JSON.parse(saved()).activeKey, '/two')
assert.equal(renders.at(-1).activeKey, '/two')
console.log(
  'Native workspace: project/chat commands, stale opening, close during startup, repair chat and persistence passed'
)

const order = controller.state.projects.map((project) => project.key)
assert.ok(order.length >= 2)
const activeBeforeReorder = controller.state.activeKey
const sessionsBeforeReorder = controller.state.projects.map((project) => [
  project.key,
  [...project.sessionKeys]
])
const serviceCalls = calls.length
await controller.reorderProject(order[0], null)
assert.deepEqual(
  controller.state.projects.map((project) => project.key),
  [...order.slice(1), order[0]]
)
assert.deepEqual(
  JSON.parse(saved()).projects.map((project) => project.key),
  [...order.slice(1), order[0]]
)
await controller.reorderProject(order[0], order[1])
assert.deepEqual(
  controller.state.projects.map((project) => project.key),
  order
)
const revision = controller.state.revision
for (const [key, before] of [
  [order[0], order[0]],
  ['/missing', null],
  [order[0], '/missing'],
  [order[0], order[1]]
])
  await controller.reorderProject(key, before)
assert.equal(controller.state.revision, revision, 'invalid and unchanged drops are ignored')
assert.equal(controller.state.activeKey, activeBeforeReorder)
assert.deepEqual(
  controller.state.projects.map((project) => [project.key, [...project.sessionKeys]]),
  sessionsBeforeReorder
)
assert.deepEqual(
  calls.slice(serviceCalls).filter((call) => !call[0].startsWith('store')),
  [],
  'reordering must not restart providers or previews'
)
console.log(
  'Native project reordering: both directions, persistence, invalid drops and session preservation passed'
)

// LKM-146: landed manifest changes stop the server, install under their own label, then
// start it and reload the preview; other landed files only restart it.
{
  const key = controller.state.activeKey,
    root = controller.active.root
  serving = true
  installing = gate()
  let start = calls.length
  const landing = controller.refreshEnvironment(key, ['package.json', 'src/App.tsx'])
  for (
    let i = 0;
    i < 2000 && !calls.slice(start).some((call) => call[0] === 'devserver:install');
    i++
  )
    await tick()
  assert.deepEqual(controller.state.status, { kind: 'busy', label: 'Installing dependencies…' })
  assert.deepEqual(
    renders.at(-1).status,
    { kind: 'busy', label: 'Installing dependencies…' },
    'the preview shows the install'
  )
  installing.resolve()
  await landing
  const order = calls
    .slice(start)
    .map((call) => call[0])
    .filter((name) => /^(devserver|preview):(stop|install|start|load)$/.test(name))
  assert.deepEqual(order, [
    'devserver:stop',
    'devserver:install',
    'devserver:start',
    'preview:load'
  ])
  assert.ok(
    calls.slice(start).every((call) => call[0] !== 'devserver:install' || call[1] === root),
    'the install runs in the live checkout'
  )
  assert.ok(
    !('installDependencies' in calls.slice(start).find((call) => call[0] === 'devserver:start')[1])
  )
  assert.equal(controller.state.status.kind, 'running')
  assert.equal(controller.active.dependenciesPending, false)
  start = calls.length
  serving = true
  await controller.refreshEnvironment(key, ['vite.config.ts'])
  assert.deepEqual(
    calls
      .slice(start)
      .map((call) => call[0])
      .filter((name) => name.startsWith('devserver:') && name !== 'devserver:info'),
    ['devserver:stop', 'devserver:start']
  )
  const lastStart = () => calls.slice(start).find((call) => call[0] === 'devserver:start')[1]
  const lastLoad = () => calls.slice(start).find((call) => call[0] === 'preview:load')
  assert.ok(!('cleanCache' in lastStart()), 'a config change keeps the dependency cache')
  assert.equal(lastLoad().length, 2, 'and reloads normally')
  // LKM-197: a dependency change already installed (the watch) restarts with clean
  // caches, says so, and reloads past WebKit's caches on the route it showed.
  start = calls.length
  serving = true
  const statuses = renders.length
  await controller.refreshEnvironment(key, undefined, true)
  assert.ok(
    calls.slice(start).every((call) => call[0] !== 'devserver:install'),
    'nothing is reinstalled'
  )
  assert.equal(lastStart().cleanCache, true)
  assert.deepEqual(lastLoad().slice(2), [{ hard: true, keepPath: true }])
  assert.ok(
    renders
      .slice(statuses)
      .some((r) => r.status.label === 'Dependencies changed — restarting preview…'),
    'the preview says why it restarts'
  )
  start = calls.length
  serving = true
  await controller.command({ type: 'restart', key, cleanCache: true })
  assert.equal(lastStart().cleanCache, true, 'the manual clean restart')
  assert.deepEqual(lastLoad().slice(2), [{ hard: true, keepPath: true }])
  serving = false
  installing = undefined
  console.log(
    'Native workspace LKM-146: landed manifests stop, install (shown), restart and reload; config changes only restart passed'
  )
}

// --- S04: the store owns identity/order/selection; each is persisted first ------
// Metadata reaches the owner over its pipe: wait until the stored file stops changing.
const flush = async (path = join(profile, 'workspace.json')) => {
  let last
  for (let stable = 0, i = 0; stable < 4 && i < 400; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const now = readFileSync(path, 'utf8')
    stable = now === last ? stable + 1 : 0
    last = now
  }
}
{
  const at = (name, root) => calls.findIndex((call) => call[0] === name && call[1] === root)
  const start = calls.length
  await controller.open('/three/')
  const mine = calls.slice(start)
  const index = (name, root) => mine.findIndex((call) => call[0] === name && call[1] === root)
  assert.ok(
    index('stored:open', '/three/') >= 0 &&
      index('stored:open', '/three/') < index('agent:open-project', '/three/'),
    'identity persisted before the session starts'
  )
  assert.ok(
    index('stored:select', '/three') >= 0 &&
      index('stored:select', '/three') < index('git:ensure', '/three/'),
    'selection persisted before the project is touched'
  )
  const devserver = mine.findIndex(
    (call) => call[0] === 'devserver:start' && call[1]?.root === '/three/'
  )
  assert.ok(
    devserver > index('stored:select', '/three'),
    'selection persisted before the server starts'
  )
  assert.equal(controller.state.activeKey, '/three', 'canonical key from the store')
  await flush()
  const file = JSON.parse(saved())
  const three = file.projects.find((p) => p.key === '/three')
  assert.equal(
    three.branch,
    'trezi/test',
    'legacy-owned metadata reaches the store through the typed adapter'
  )
  assert.equal(three.url, 'http://127.0.0.1:7784')
  assert.equal(typeof three.touchedAt, 'number')
  assert.deepEqual(
    file.recents[0],
    { root: '/three/', name: 'three/', at: file.recents[0].at },
    'recents are stored by the owner'
  )
  for (const display of ['status', 'history', 'error', 'revision'])
    assert.ok(!(display in file), `${display} is display state, never stored`)
  await controller.open('/three')
  assert.equal(
    controller.state.projects.filter((p) => p.key === '/three').length,
    1,
    'the same root is never duplicated'
  )
  assert.ok(at('stored:open', '/three') > 0)
  console.log(
    'Native workspace S04: identity and selection persisted before sessions/servers; canonical keys; metadata adapter; display state not stored passed'
  )
}

// LKM-204: a pick shows its project in the first state after the click, before the store
// saves it or any server starts; an older pick's acknowledgement (its snapshot still
// naming that project) or a stale external snapshot never brings a previous one back.
{
  const original = controller.services.store
  let hold = null,
    acked = null
  controller.services.store = {
    ...original,
    snapshot: () => {
      const view = original.snapshot()
      return acked ? { ...view, activeKey: acked } : view
    },
    select: async (key) => {
      const done = original.select(key)
      await hold?.promise
      await done
      acked = key
    }
  }
  const shown = (from) =>
    renders
      .slice(from)
      .map((state) => state.activeKey)
      .filter((key, index, all) => key !== all[index - 1])
  const [a, b, c] = ['/three', '/two', '/one']
  assert.equal(controller.state.activeKey, a)
  hold = gate()
  let from = renders.length - 1,
    start = calls.length
  const single = controller.command({ type: 'select', key: b, generation: 7 })
  await tick()
  assert.equal(renders.at(-1).activeKey, b, 'the first state after the click names B')
  assert.equal(renders.at(-1).selection, 7, 'and echoes the pick')
  assert.deepEqual(renders.at(-1).status, { kind: 'busy', label: 'Opening two…' })
  assert.ok(
    !calls
      .slice(start)
      .some((call) => call[0] === 'project:detect' || call[0] === 'devserver:start'),
    'B shows before its server starts'
  )
  // An external snapshot still naming A, adopted while B is unsaved.
  acked = a
  controller.adopt(true)
  controller.changed()
  assert.equal(controller.state.activeKey, b, 'a stale snapshot does not bring A back')
  hold.resolve()
  await single
  assert.deepEqual(shown(from), [a, b], 'A → B is one transition')
  assert.equal(controller.state.status.kind, 'running')
  assert.equal(active.at(-1), b)
  // Rapid B → C → A: every acknowledgement but the last carries an older pick.
  hold = gate()
  from = renders.length - 1
  const picks = [
    controller.command({ type: 'select', key: c, generation: 8 }),
    controller.command({ type: 'select', key: a, generation: 9 })
  ]
  await tick()
  assert.equal(renders.at(-1).activeKey, a)
  hold.resolve()
  await Promise.all(picks)
  const rapid = shown(from)
  assert.equal(rapid.at(-1), a, 'rapid picks end on the last one')
  assert.equal(rapid.indexOf(a, 1), rapid.length - 1, 'nothing shows after the last pick')
  assert.equal(controller.state.activeKey, a)
  assert.equal(active.at(-1), a, 'the last pick is activated')
  assert.equal(original.snapshot().activeKey, a, 'and stored')
  controller.services.store = original
  console.log(
    'Native workspace LKM-204: the switch shows the pick at once; stale and older acknowledgements ignored; rapid picks end on the last passed'
  )
}

// A store that cannot persist the selection: nothing dependent runs.
{
  const store = shared
  const refusing = {
    ...store,
    select: async () => {
      throw new Error('The workspace was not saved')
    }
  }
  const blocked = new NativeWorkspaceController(services(refusing))
  await blocked.command({ type: 'attach' })
  const start = calls.length
  await blocked.open('/blocked')
  assert.equal(blocked.state.status.kind, 'error')
  assert.match(blocked.state.status.message, /not saved/)
  assert.ok(
    !calls
      .slice(start)
      .some((call) =>
        ['agent:open-project', 'devserver:start', 'agent:set-active'].includes(call[0])
      ),
    'no dependent command without a persisted selection'
  )
  console.log(
    'Native workspace S04: a refused selection starts no session, server or activation passed'
  )
}

// Restart: a new controller on the same store file restores projects, order and selection.
{
  await flush()
  const before = JSON.parse(saved())
  const order = before.projects.map((p) => p.key)
  projects.clear()
  for (const service of running.splice(0)) await service.close()
  const restarted = new NativeWorkspaceController(services(await owner(profile)))
  await restarted.command({ type: 'attach' })
  assert.deepEqual(
    restarted.state.projects.map((p) => p.key),
    order,
    'order survives restart'
  )
  assert.equal(restarted.state.activeKey, before.activeKey, 'selection survives restart')
  const rendered = renders.length,
    snapshot = saved()
  await restarted.command({ type: 'attach' })
  assert.equal(renders.length, rendered + 1, 'a reattaching UI gets a projection')
  assert.deepEqual(
    renders.at(-1).projects.map((p) => p.key),
    order
  )
  assert.equal(renders.at(-1).activeKey, before.activeKey)
  assert.equal(saved(), snapshot, 'reattach changes nothing stored')
  console.log(
    'Native workspace S04: restart restores projects/order/selection; UI reattach re-renders without writes passed'
  )
}

// Old records (before sessions/chat settings existed) restore with defaults; nothing is dropped.
{
  const old = mkdtempSync(join(tmpdir(), 'trezi-workspace-old-'))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    join(old, 'workspace.json'),
    JSON.stringify({
      projects: [
        { root: '/legacy', key: '/legacy', name: 'Legacy', touchedAt: 5, future: { kept: true } },
        { root: 'relative', key: 'relative' },
        null
      ],
      activeKey: '/legacy',
      extra: 1
    })
  )
  projects.clear()
  const restored = new NativeWorkspaceController(services(await owner(old)))
  await restored.command({ type: 'attach' })
  const entry = restored.state.projects[0]
  assert.deepEqual(
    [entry.key, entry.sessionKeys, entry.activeSessionKey, entry.previewKind],
    ['/legacy', ['/legacy'], '/legacy', 'web']
  )
  await flush(join(old, 'workspace.json'))
  const file = JSON.parse(readFileSync(join(old, 'workspace.json'), 'utf8'))
  assert.deepEqual(
    file.projects.slice(1),
    [{ root: 'relative', key: 'relative' }, null],
    'invalid entries are kept, not deleted'
  )
  assert.deepEqual(file.projects[0].future, { kept: true }, 'unknown entry fields are kept')
  assert.equal(file.extra, 1, 'unknown top-level fields are kept')
  rmSync(old, { recursive: true, force: true })
  console.log(
    'Native workspace S04: old records get defaults; invalid entries and unknown fields are preserved passed'
  )
}

for (const service of running) await service.close()
