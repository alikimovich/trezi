// LKM-220: going back from a states workbench to the page it came from and returning to it.
// The records (origin page, last state, chat) persist in a fake preference and are pruned;
// Back, Show states, Continue in chat and Rebuild run against fakes only.
import assert from 'node:assert/strict'
import {
  addReference,
  setReferenceDetails,
  withReferences
} from '../src/native/chat-island-refs.ts'
import { NativeStatesController } from '../src/native/states-controller.ts'
import {
  benchForSelection,
  normalizeRecords,
  pageLabel,
  STATES_RECORDS_PREFERENCE,
  sameDocument,
  sourceFile
} from '../src/shared/states-records.ts'
import {
  parseWorkbench,
  rebuildStatesText,
  workbenchReference,
  workbenchReferenceText
} from '../src/shared/states-workbench.ts'

assert.match(STATES_RECORDS_PREFERENCE, /^trezi:/)
const bench = parseWorkbench(
  JSON.stringify({
    component: 'OrderList',
    source: 'src/OrderList.tsx:4',
    route: '/trezi-states/order-list',
    states: [
      { id: 'loading', label: 'Loading' },
      { id: 'empty', label: 'Empty' }
    ]
  }),
  'trezi-states/order-list'
)
const other = parseWorkbench(
  JSON.stringify({
    component: 'Card',
    source: 'src/Card.tsx',
    route: '/trezi-states/card',
    states: [{ id: 'a' }]
  }),
  'trezi-states/card'
)

// Pure helpers.
assert.equal(sourceFile('/repo/src/OrderList.tsx:9:3', '/repo'), 'src/OrderList.tsx')
assert.equal(sourceFile('./src/a.ts:1'), 'src/a.ts')
assert.equal(sourceFile(null), null)
assert.ok(sameDocument('http://h:1/a/?x=1#top', 'http://h:1/a?x=1'))
assert.ok(!sameDocument('http://h:1/a?x=1', 'http://h:1/a?x=2'))
assert.ok(!sameDocument('http://h:1/a', 'http://h:2/a'))
assert.equal(pageLabel({ url: 'http://h/orders/?tab=2' }), '/orders?tab=2')
assert.equal(pageLabel({ url: 'http://h/orders', title: 'Orders' }), 'Orders')
assert.deepEqual(normalizeRecords('{'), {})
assert.deepEqual(
  normalizeRecords({
    relative: { a: { last: 'x' } },
    '/repo': {
      a: { last: 'all', origin: { url: 'file:///x' } },
      b: {
        last: 'empty',
        origin: { url: 'http://h/', y: -1, selection: { tag: 'ul', path: [0, 'x'] } }
      }
    }
  }),
  {
    '/repo': {
      b: {
        last: 'empty',
        origin: {
          url: 'http://h/',
          selection: { tag: 'ul', id: null, source: null, componentSource: null, path: null }
        }
      }
    }
  },
  'bad roots, origins, offsets, paths and the grid are dropped'
)
const recorded = {
  'trezi-states/card': {
    origin: { url: 'http://h/', selection: { tag: 'li', componentSource: 'src/List.tsx:3:1' } }
  }
}
assert.equal(
  benchForSelection(
    { source: 'src/Other.tsx:1', componentSource: 'src/List.tsx:3:1' },
    [bench, other],
    recorded
  ),
  other,
  'the same instance first'
)
assert.equal(
  benchForSelection(
    { source: '/repo/src/OrderList.tsx:12:5', componentSource: null },
    [bench, other],
    {},
    '/repo'
  ),
  bench,
  'else the component file'
)
assert.equal(
  benchForSelection({ source: 'src/App.tsx:2', componentSource: null }, [bench, other], {}),
  null
)
assert.equal(workbenchReference(bench), '#states-order-list')
assert.match(
  workbenchReferenceText(bench),
  /OrderList states workbench in trezi-states\/order-list .*states loading, empty/
)
assert.match(
  rebuildStatesText(bench),
  /^\/states The OrderList component \(src\/OrderList\.tsx:4\) changed\. Rebuild .* in place: keep the route \/trezi-states\/order-list/
)

// A controller over a fake preference and preview.
let stored = null
const store = {
  read: () => stored,
  write: async (update) => {
    stored = update(stored)
  }
}
const active = { root: '/repo', url: 'http://localhost:5173/' }
let benches = []
const page = { href: 'http://localhost:5173/orders?tab=2', title: 'Orders', x: 0, y: 340 }
let viaHistory = false
let open = ['chat-9']
const calls = []
const sent = []
const services = () => ({
  send: (command, payload) => sent.push([command, payload]),
  preview: () => {},
  active: () => active,
  load: async (to) => {
    calls.push(['load', to])
  },
  sheets: { present: () => {}, close: () => {} },
  log: (line, kind) => kind === 'error' && calls.push(['error', line]),
  remove: async () => ({ ok: true }),
  scan: async () => benches,
  leftovers: async () => [],
  records: store,
  page: async () => page,
  scrollTo: async (x, y) => calls.push(['scroll', x, y]),
  back: async (to) => {
    calls.push(['back', to])
    return viaHistory
  },
  layers: async () => ({
    nodes: [
      { path: [0, 1], tag: 'ul', id: null, source: 'src/Other.tsx:2:1' },
      { path: [0, 2], tag: 'ul', id: null, source: 'src/OrderList.tsx:9:3' }
    ]
  }),
  pick: (path, fingerprint) => calls.push(['pick', path, fingerprint]),
  focusChat: async (_root, chat) => {
    calls.push(['focus', chat])
    return open.includes(chat)
  },
  newChat: async (_root, made) => calls.push(['new-chat', made.folder]),
  submit: async (_root, text, chat) => calls.push(['submit', text, chat]),
  chatTitle: (chat) => (chat === 'chat-9' ? 'Order states' : undefined)
})
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const last = (command) => sent.findLast(([type]) => type === command)?.[1]
const took = (kind) => calls.filter(([name]) => name === kind)
const element = {
  tag: 'ul',
  id: null,
  source: 'src/OrderList.tsx:9:3',
  componentSource: 'src/App.tsx:20:5',
  layerPath: [0, 2]
}

let states = new NativeStatesController(services())
states.url('http://localhost:5173/orders?tab=2')
await settle()

// Show states with no workbench yet asks the agent; the page waits for the one that lands.
assert.equal(await states.show('/repo', element, 'chat-9'), false)
benches = [bench]
states.landed('/repo')
await settle()
const record = states.memory.get('/repo', bench.folder)
assert.equal(record.chat, 'chat-9')
assert.deepEqual(record.origin, {
  url: 'http://localhost:5173/orders?tab=2',
  title: 'Orders',
  x: 0,
  y: 340,
  selection: {
    tag: 'ul',
    id: null,
    source: 'src/OrderList.tsx:9:3',
    componentSource: 'src/App.tsx:20:5',
    path: [0, 2]
  }
})
assert.ok(JSON.parse(stored)['/repo'][bench.folder].origin, 'written through to the preference')

// On the workbench: the island's Back names the page; the menu row knows page, chat and state.
states.url('http://localhost:5173/trezi-states/order-list?__state=empty')
await settle()
assert.equal(last('statesState').state.back, 'Back to Orders')
assert.deepEqual(last('workbenches').items, [
  {
    folder: bench.folder,
    component: 'OrderList',
    route: bench.route,
    from: 'Orders',
    chat: 'Order states',
    last: 'Empty'
  }
])
states.url('http://localhost:5173/trezi-states/order-list?__state=all')
assert.equal(states.memory.get('/repo', bench.folder).last, 'empty', 'the grid is not a last state')

// Back with no history entry for the page: a load, then its scroll and the instance.
await states.action({ action: 'back' })
assert.deepEqual(took('back').at(-1), ['back', 'http://localhost:5173/orders?tab=2'])
assert.deepEqual(took('load').at(-1), ['load', 'http://localhost:5173/orders?tab=2'])
states.url('http://localhost:5173/orders?tab=2')
await settle()
assert.deepEqual(took('scroll'), [['scroll', 0, 340]])
assert.deepEqual(took('pick'), [['pick', [0, 2], { tag: 'ul', source: 'src/OrderList.tsx:9:3' }]])

// Back through history (so ⌘] returns): no load and no scroll, WebKit restores it.
states.url('http://localhost:5173/trezi-states/order-list?__state=empty')
await settle()
viaHistory = true
const loads = took('load').length
await states.action({ action: 'back' })
assert.equal(took('load').length, loads, 'a history step, not a load')
states.url('http://localhost:5173/orders?tab=2#top')
await settle()
assert.equal(took('scroll').length, 1)
assert.equal(took('pick').length, 2)

// Records survive a restart: a new controller over the same preference.
states = new NativeStatesController(services())
states.url('http://localhost:5173/orders?tab=2')
await settle()
assert.equal(last('workbenches').items[0].from, 'Orders')
// Show states on the same component opens the existing workbench at its last state.
assert.equal(await states.show('/repo', element, 'chat-9'), true)
assert.deepEqual(took('load').at(-1), [
  'load',
  'http://localhost:5173/trezi-states/order-list?__state=empty'
])
// Also from another instance of it, by the manifest's component file.
assert.equal(
  await states.show('/repo', {
    ...element,
    source: 'src/OrderList.tsx:30:1',
    componentSource: 'src/Page.tsx:4:1',
    layerPath: null
  }),
  true
)

// The menu's actions.
await states.action({ action: 'grid', id: bench.folder })
assert.deepEqual(took('load').at(-1), [
  'load',
  'http://localhost:5173/trezi-states/order-list?__state=all'
])
await states.action({ action: 'continue', id: bench.folder })
assert.deepEqual(took('focus').at(-1), ['focus', 'chat-9'])
assert.equal(took('new-chat').length, 0, 'the creating chat is still open')
open = []
await states.action({ action: 'continue', id: bench.folder })
assert.deepEqual(took('new-chat'), [['new-chat', bench.folder]], 'else a new chat with the chip')
await states.action({ action: 'rebuild', id: bench.folder })
assert.deepEqual(took('submit'), [['submit', rebuildStatesText(bench), 'chat-9']])

// Another page as the fallback origin when Show states did not open it.
benches = [bench, other]
states.url('http://localhost:5173/settings')
await settle()
states.url('http://localhost:5173/trezi-states/card?__state=a')
await settle()
assert.equal(last('statesState').state.back, 'Back to /settings')

// Pruned: a folder that is gone loses its record, and an empty project leaves the preference.
benches = [other]
await states.refresh('/repo')
assert.equal(states.memory.get('/repo', bench.folder), undefined)
assert.ok(!JSON.parse(stored)['/repo'][bench.folder])
benches = []
await states.refresh('/repo')
await settle()
assert.equal(stored, null)

// A workbench chip sends what it names.
setReferenceDetails((_chat, name) =>
  name === workbenchReference(bench) ? workbenchReferenceText(bench) : undefined
)
const chat = { chat: 'c', root: '/repo', references: [] }
addReference(chat, '#states-order-list')
addReference(chat, '#states-order-list')
addReference(chat, '#nope')
assert.deepEqual(chat.references, ['#states-order-list'])
const message = withReferences(chat, 'Add a long-name state')
assert.ok(message.startsWith('#states-order-list Add a long-name state\n\n'))
assert.ok(message.endsWith(workbenchReferenceText(bench)))
assert.deepEqual(chat.references, [])
assert.equal(took('error').length, 0, took('error').join('\n'))
console.log('states-return: ok')
