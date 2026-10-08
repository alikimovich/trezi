// LKM-207: the component states workbench. Manifest parsing and URL matching, the
// read-only scans, the switcher controller and the Publish warning, with fakes only:
// files live in a temporary folder and nothing reaches a provider or GitHub.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findLeftovers, scanWorkbenches } from '../src/main/states-workbench.ts'
import { NativeGitController } from '../src/native/git-controller.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import { NativeStatesController } from '../src/native/states-controller.ts'
import { PREVIEW_STATES, PREVIEW_STATES_SWITCH } from '../src/shared/preview-channels.ts'
import {
  leftoverTerms,
  matchWorkbench,
  normalizeRoute,
  parseWorkbench,
  showStatesText,
  statesContext,
  stateUrl,
  stepState
} from '../src/shared/states-workbench.ts'

const manifest = {
  version: 1,
  component: 'OrderList',
  source: 'src/OrderList.tsx:4',
  route: '/trezi-states/order-list/',
  width: 420,
  states: [
    { id: 'loading', label: 'Loading' },
    { id: 'empty', label: 'Empty' },
    { id: 'list', label: 'List' },
    { id: 'list', label: 'Duplicate' },
    { id: 'Bad Id', label: 'Bad' },
    { id: 'all', label: 'Reserved' }
  ],
  missing: [{ id: 'error', label: 'Error', note: 'No error UI' }, { id: 'empty' }],
  seams: ['src/routes/states.tsx', '../outside.ts', '.git/config', 'trezi-states/order-list/x.ts'],
  fixtures: ['orderListFixtures', 'bad name;'],
  chat: 'chat-1'
}

// Parsing keeps only safe, unique ids and seams outside the folder.
const bench = parseWorkbench(JSON.stringify(manifest), 'trezi-states/order-list')
assert.deepEqual(
  bench.states.map((s) => s.id),
  ['loading', 'empty', 'list']
)
assert.deepEqual(bench.missing, [{ id: 'error', label: 'Error', note: 'No error UI' }])
assert.equal(bench.route, '/trezi-states/order-list')
assert.equal(bench.width, 420)
assert.deepEqual(bench.seams, ['src/routes/states.tsx'])
assert.deepEqual(bench.fixtures, ['orderListFixtures'])
assert.equal(bench.chat, 'chat-1')
assert.equal(parseWorkbench('{', 'x'), null)
assert.equal(parseWorkbench(JSON.stringify({ route: '/x', states: [] }), 'x'), null)
assert.equal(normalizeRoute('trezi-states/a/index.html?x#y'), '/trezi-states/a')

// The URL decides the switcher: any http(s) origin, `__state` or the first state.
const url = 'http://localhost:5173/trezi-states/order-list/?q=1'
assert.deepEqual(matchWorkbench(url, [bench]), { workbench: bench, current: 'loading' })
assert.equal(matchWorkbench(`${url}&__state=list`, [bench]).current, 'list')
assert.equal(matchWorkbench(`${url}&__state=all`, [bench]).current, 'all')
assert.equal(matchWorkbench(`${url}&__state=nope`, [bench]).current, 'loading')
assert.equal(matchWorkbench('http://localhost:5173/', [bench]), null)
assert.equal(matchWorkbench('file:///trezi-states/order-list', [bench]), null)
assert.equal(
  stateUrl(`${url}#top`, 'empty'),
  'http://localhost:5173/trezi-states/order-list/?q=1&__state=empty#top'
)
assert.equal(stepState({ states: bench.states, current: 'list' }, 1), 'loading')
assert.equal(stepState({ states: bench.states, current: 'loading' }, -1), 'list')
assert.equal(stepState({ states: bench.states, current: 'all' }, 1), 'loading')
assert.equal(stepState({ states: bench.states, current: 'all' }, -1), 'list')

// The explicit invocations: the composer's /states and Show states.
const text = showStatesText('Selected <ul class="orders">. ', 'src/App.tsx:9')
assert.match(
  text,
  /^\/states Selected <ul class="orders">\. The component instance is at src\/App\.tsx:9\./
)
assert.match(statesContext(text, 'chat-1'), /"chat-1"/)
assert.match(statesContext('/states', 'c'), /"c"/)
assert.equal(statesContext('fix /statesman and a/states path', 'chat-1'), '')
assert.deepEqual(leftoverTerms(bench), [
  '/trezi-states/order-list',
  'trezi-states/order-list',
  'orderListFixtures'
])

// Scans are read-only and bounded; generated trees and dot folders are skipped.
const root = await mkdtemp(join(tmpdir(), 'trezi-states-'))
try {
  const folder = join(root, 'trezi-states/order-list')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'trezi-workbench.json'), JSON.stringify(manifest))
  await writeFile(join(folder, 'index.html'), '<div data-trezi-state="loading"></div>')
  await mkdir(join(root, 'node_modules/pkg/trezi-states/x'), { recursive: true })
  await writeFile(
    join(root, 'node_modules/pkg/trezi-states/x/trezi-workbench.json'),
    JSON.stringify(manifest)
  )
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/routes.ts'), "export const states = '/trezi-states/order-list'\n")
  await writeFile(join(root, 'src/app.ts'), 'export const app = 1\n')
  const found = await scanWorkbenches(root)
  assert.deepEqual(
    found.map((b) => b.folder),
    ['trezi-states/order-list']
  )
  const leftovers = await findLeftovers(root, found[0])
  assert.ok(leftovers.includes('src/routes.ts: /trezi-states/order-list'), leftovers.join('\n'))
  assert.ok(!leftovers.some((hit) => hit.startsWith('node_modules')))
} finally {
  await rm(root, { recursive: true, force: true })
}

// The controller: the island, the preload's ids and every action.
const sent = [],
  previews = [],
  loads = [],
  logs = [],
  removed = []
const active = { root: '/repo', url: 'http://localhost:5173/' }
let benches = [bench]
let leftoverHits = []
const sheetHost = { send: (type, payload) => sent.push([type, payload]) }
const sheets = new NativeSheetController(sheetHost, {}, {}, async () => null)
const states = new NativeStatesController({
  send: (command, payload) => sent.push([command, payload]),
  preview: (channel, payload) => previews.push([channel, payload]),
  active: () => active,
  load: async (to) => loads.push(to),
  sheets,
  log: (line, kind) => logs.push([line, kind]),
  remove: async (rootPath, folder, seams) => {
    removed.push([rootPath, folder, seams])
    benches = benches.filter((b) => b.folder !== folder)
    return { ok: true, path: folder }
  },
  scan: async () => benches,
  leftovers: async () => leftoverHits
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const last = (command) => sent.findLast(([type]) => type === command)?.[1]

states.url('http://localhost:5173/')
await settle()
assert.equal(last('statesState').state, null, 'not a workbench route: no island')
assert.deepEqual(last('workbenches').items, [
  { folder: 'trezi-states/order-list', component: 'OrderList', route: '/trezi-states/order-list' }
])

states.url(`${url}&__state=empty`)
await settle()
assert.equal(last('statesState').state.current, 'empty')
assert.deepEqual(previews.at(-1), [PREVIEW_STATES, { ids: ['loading', 'empty', 'list'] }])
// A reload with the same URL tells the fresh preload the ids again.
const told = previews.length
states.url(`${url}&__state=empty`)
assert.equal(previews.length, told + 1)

await states.action({ action: 'next' })
assert.deepEqual(previews.at(-1), [PREVIEW_STATES_SWITCH, 'list'])
assert.equal(last('statesState').state.current, 'list', 'the island answers before the page')
await states.action({ action: 'next' })
assert.deepEqual(previews.at(-1), [PREVIEW_STATES_SWITCH, 'loading'], 'next wraps')
await states.action({ action: 'prev' })
assert.deepEqual(previews.at(-1), [PREVIEW_STATES_SWITCH, 'list'])
await states.action({ action: 'select', id: 'empty' })
assert.deepEqual(previews.at(-1), [PREVIEW_STATES_SWITCH, 'empty'])
const switches = previews.length
await states.action({ action: 'select', id: 'nope' })
assert.equal(previews.length, switches, 'unknown ids are ignored')
await states.action({ action: 'all' })
assert.deepEqual(previews.at(-1), [PREVIEW_STATES_SWITCH, 'all'])
await states.action({ action: 'all' })
assert.deepEqual(previews.at(-1), [PREVIEW_STATES_SWITCH, 'loading'], 'All again goes back')
await states.action({ action: 'hide' })
assert.equal(last('statesState').state.hidden, true)
await states.action({ action: 'hide' })
assert.equal(last('statesState').state.hidden, false)

await states.action({ action: 'open', id: 'trezi-states/order-list' })
assert.equal(loads.at(-1), 'http://localhost:5173/trezi-states/order-list?__state=loading')

// Remove asks first; Cancel deletes nothing.
await states.action({ action: 'remove', id: 'trezi-states/order-list' })
assert.match(sheets.current.state.title, /Remove the OrderList states workbench/)
assert.match(sheets.current.state.detail, /src\/routes\/states\.tsx/)
await sheets.action({ id: sheets.current.state.id, action: 'keep', values: {} })
assert.equal(removed.length, 0)
assert.equal(sheets.current, null)
leftoverHits = ['src/routes.ts: /trezi-states/order-list']
await states.action({ action: 'remove', id: 'trezi-states/order-list' })
await sheets.action({ id: sheets.current.state.id, action: 'remove', values: {} })
assert.deepEqual(removed, [['/repo', 'trezi-states/order-list', ['src/routes/states.tsx']]])
assert.match(logs.at(-1)[0], /Still referenced in: src\/routes\.ts/)
assert.deepEqual(last('workbenches').items, [])
assert.equal(last('statesState').state, null)

// Publish with a workbench present warns: Cancel, Publish Anyway, Remove and Publish.
benches = [bench]
removed.length = 0
leftoverHits = []
await states.refresh('/repo')
const calls = []
const project = { key: 'p', root: '/repo', branch: 'main', activeSessionKey: 'chat-1' }
const workspace = {
  active: project,
  state: { projects: [project] },
  changed() {},
  transact: async (_key, fn) => fn(project),
  refreshEnvironment: async () => {}
}
const invoke = async (channel, ...args) => {
  calls.push([channel, ...args])
  if (channel === 'github:status') return { connected: true, gh: 'ok', login: 'user' }
  if (channel === 'publish:ship') return { ok: true, branch: 'main', url: 'https://example.com/pr' }
  if (channel === 'publish:progress') return null
  return { ok: true }
}
const gitSheets = new NativeSheetController(sheetHost, workspace, {}, invoke)
states.services.sheets = gitSheets
const git = new NativeGitController(
  gitSheets,
  { append: () => {} },
  { get: () => undefined, set: () => {} },
  () => {},
  () => {},
  { active: 'chat-1', get: () => null, submit: async () => {} }
)
git.beforePublish = (rootPath) => states.beforePublish(rootPath)
const ships = () => calls.filter(([channel]) => channel === 'publish:ship').length
const answer = async (action) => {
  await settle()
  assert.match(gitSheets.current.state.title, /states workbench is still in the project/)
  assert.deepEqual(
    gitSheets.current.state.actions.map((a) => a.label),
    ['Cancel', 'Publish Anyway', 'Remove and Publish']
  )
  await gitSheets.action({ id: gitSheets.current.state.id, action, values: {} })
}

let publish = git.publish('p')
await answer('keep')
await publish
assert.equal(ships(), 0, 'Cancel does not publish')
assert.equal(removed.length, 0)

publish = git.publish('p')
await answer('publish')
await publish
assert.equal(ships(), 1, 'Publish Anyway publishes with the workbench')
assert.equal(removed.length, 0)

publish = git.publish('p')
await answer('remove')
await publish
assert.equal(removed.length, 1, 'Remove and Publish removes first')
assert.equal(ships(), 2)

// No workbench: no sheet, and the answer is synchronous so progress shows on the click.
assert.equal(states.beforePublish('/repo'), true)
publish = git.publish('p')
assert.equal(git.decorate({}).publishing, true)
await publish
assert.equal(ships(), 3)
console.log('states-workbench: ok')
