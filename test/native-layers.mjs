import assert from 'node:assert/strict'
import {
  movedLayerPath,
  NativeLayersController,
  resolveLayerSelection
} from '../src/native/layers-controller.ts'

const calls = [],
  renders = [],
  fallback = []
const node = (path, source) => ({ path, source, tag: 'div', parentPath: [], depth: 1 })
const snapshot = {
  nodes: [node([0], 'a.tsx:1'), node([1], 'a.tsx:2')],
  totalSeen: 2,
  truncated: false
}
const controller = new NativeLayersController(
  async (channel, ...args) => {
    calls.push([channel, ...args])
    return channel === 'layers:read' ? snapshot : { needsAgent: true, agentPrompt: 'Move the div' }
  },
  async (...args) => calls.push(args),
  (state) => renders.push(state),
  async (...args) => fallback.push(args)
)
await controller.activate('/a')
await controller.toggle()
assert.equal(renders.at(-1).nodes.length, 2)
await controller.action({ root: '/other', action: 'select', path: [0] })
assert.equal(calls.at(-1)[0], 'layers:read')
await controller.action({ root: '/a', action: 'select', path: [0] })
assert.deepEqual(calls.at(-1), [
  'layers:select',
  { path: [0], fingerprint: { tag: 'div', source: 'a.tsx:1' }, from: 'layers' }
])
await controller.action({ root: '/a', action: 'move', path: [0], target: [1], position: 'after' })
assert.deepEqual(fallback.at(-1), ['/a', 'Move the div'])
await controller.toggle()
assert.equal(renders.at(-1).visible, false)
assert.deepEqual(calls.at(-1), ['layers:hover', null])
let finish
const racing = new NativeLayersController(
  async () => new Promise((resolve) => (finish = resolve)),
  async () => {},
  (state) => renders.push(state),
  async () => {}
)
racing.root = '/a'
const pending = racing.toggle()
await new Promise((resolve) => setTimeout(resolve, 0))
await racing.toggle()
finish(snapshot)
await pending
assert.equal(racing.snapshot, null)

// LKM-179: selection follows the preview, survives refreshes and never loops.
const row = (path, source, extra = {}) => ({ path, source, tag: 'li', parentPath: [0], ...extra })
assert.deepEqual(
  resolveLayerSelection([row([0, 1], 'a.tsx:4')], {
    path: [0, 1],
    tag: 'li',
    source: 'a.tsx:4',
    id: null
  }),
  [0, 1]
)
// An edit shifted the row: its source location still finds it.
assert.deepEqual(
  resolveLayerSelection([row([0, 0], 'a.tsx:2'), row([0, 2], 'a.tsx:4')], {
    path: [0, 1],
    tag: 'li',
    source: 'a.tsx:4',
    id: null
  }),
  [0, 2]
)
// A loop repeats the stamp: the row nearest the old path wins.
assert.deepEqual(
  resolveLayerSelection([row([0, 0], 'a.tsx:9'), row([3, 1], 'a.tsx:9')], {
    path: [3, 2],
    tag: 'li',
    source: 'a.tsx:9',
    id: null
  }),
  [3, 1]
)
assert.equal(
  resolveLayerSelection([row([0, 0], 'a.tsx:1')], {
    path: [0, 0],
    tag: 'p',
    source: 'b.tsx:1',
    id: null
  }),
  null
)
assert.deepEqual(movedLayerPath([0, 1], [0, 0], 'before'), [0, 0])
assert.deepEqual(movedLayerPath([0, 0], [0, 2], 'after'), [0, 2])
assert.deepEqual(movedLayerPath([0, 0], [0, 2], 'before'), [0, 1])
assert.equal(movedLayerPath([0, 0], [1], 'before'), null)
assert.equal(movedLayerPath([0, 0], [0, 2], 'inside'), null)

let page = {
  nodes: [
    row([], 'i.html:2:7', { tag: 'body', parentPath: null }),
    row([0], 'i.html:3:1', { tag: 'h1', id: 'title' }),
    row([1], 'i.html:4:1', { tag: 'p', text: 'Body' })
  ],
  totalSeen: 3,
  truncated: false
}
const sent = [],
  states = []
const sync = new NativeLayersController(
  async (channel, root, request) => {
    if (channel === 'layers:read') return page
    sent.push(['move', request])
    return { applied: true }
  },
  async (...args) => sent.push(args),
  (state) => states.push(state)
)
await sync.activate('/i')
sync.selected({ tag: 'p', id: null, source: 'i.html:4:1', layerPath: [1] })
assert.equal(states.length, 1, 'a hidden tree does not publish selections')
await sync.toggle()
assert.deepEqual(states.at(-1).selected, [1], 'opening Layers selects the preview selection')
sync.selected({ tag: 'h1', id: 'title', source: 'i.html:3:1', layerPath: [0] })
assert.deepEqual(states.at(-1).selected, [0])
sync.selected(null)
assert.equal(states.at(-1).selected, null, 'clearing the preview selection clears the row')
const before = sent.length
await sync.action({ root: '/i', action: 'select', path: [1] })
assert.deepEqual(sent.slice(before), [
  ['layers:select', { path: [1], fingerprint: { tag: 'p', source: 'i.html:4:1' }, from: 'layers' }]
])
// Dragging the paragraph before the heading follows it to its new row once the page re-renders.
await sync.action({ root: '/i', action: 'move', path: [1], target: [0], position: 'before' })
assert.equal(sent.at(-1)[0], 'move')
assert.equal(sent.at(-1)[1].position, 'before')
page = {
  ...page,
  nodes: [
    page.nodes[0],
    row([0], 'i.html:3:1', { tag: 'p', text: 'Body' }),
    row([1], 'i.html:4:1', { tag: 'h1', id: 'title' })
  ]
}
await sync.refresh()
assert.deepEqual(sent.at(-1), [
  'layers:select',
  { path: [0], fingerprint: { tag: 'p', source: 'i.html:3:1' }, from: 'layers' }
])
assert.deepEqual(states.at(-1).selected, [0], 'the moved element stays selected')

// An outline drop may arrive while the controller is one preview read behind.
// A missing row gets one fresh read before the move is discarded.
let reads = 0
const recovered = []
const staleDrop = new NativeLayersController(
  async (channel, _root, request) => {
    if (channel === 'layers:read') {
      reads++
      return reads === 1 ? { ...page, nodes: [page.nodes[0], page.nodes[1]] } : page
    }
    recovered.push(request)
    return { applied: true }
  },
  async () => {},
  () => {}
)
await staleDrop.activate('/i')
await staleDrop.toggle()
await staleDrop.action({ root: '/i', action: 'move', path: [0], target: [1], position: 'before' })
assert.equal(reads, 3, 'a missing target gets one read before the move and one after it')
assert.equal(recovered.length, 1, 'the recovered drop reaches the source owner')

// LKM-541: closing Layers clears a row's selection with Select off and keeps it with Select on.
{
  const sends = [],
    views = []
  let releases = 0,
    selecting = false
  const lifecycle = new NativeLayersController(
    async (channel) => (channel === 'layers:read' ? snapshot : null),
    async (...args) => sends.push(args),
    (state) => views.push(state),
    async () => {}
  )
  lifecycle.selectionMode = () => selecting
  lifecycle.release = () => {
    releases++
    // What the runtime does: the inspector drops the element and tells Layers.
    lifecycle.selected(null)
  }
  const modeSends = () => sends.filter(([channel]) => /select-mode/.test(channel))
  await lifecycle.activate('/l')
  await lifecycle.toggle()
  assert.equal(releases, 0, 'opening Layers alone neither selects nor releases')
  await lifecycle.toggle()
  assert.equal(releases, 0, 'closing without a row pick keeps any other selection')

  // Select OFF: open, pick, close → the transient selection, outline and inspector go.
  await lifecycle.toggle()
  await lifecycle.action({ root: '/l', action: 'select', path: [1] })
  assert.deepEqual(sends.at(-1), [
    'layers:select',
    { path: [1], fingerprint: { tag: 'div', source: 'a.tsx:2' }, from: 'layers' }
  ])
  await lifecycle.toggle()
  assert.equal(releases, 1, 'Select off: closing Layers releases the row pick')
  assert.equal(lifecycle.selection, null)
  const watchOff = sends.findIndex(
    ([channel, on]) => channel === 'layers:set-watch' && on === false
  )
  assert.ok(watchOff >= 0, 'the preview stops treating later row picks as live')
  // A row click delivered after close is late: no new selection reaches the preview.
  const before = sends.length
  await lifecycle.action({ root: '/l', action: 'select', path: [0] })
  assert.equal(sends.length, before, 'late row select after close is dropped')
  assert.equal(lifecycle.selection, null)
  // Reopen: no stale selected row.
  await lifecycle.toggle()
  assert.equal(views.at(-1).visible, true)
  assert.equal(views.at(-1).selected, null, 'reopened Layers shows no stale selection')

  // Select ON: the same flow hides only Layers; the selection stays.
  selecting = true
  await lifecycle.action({ root: '/l', action: 'select', path: [0] })
  await lifecycle.toggle()
  assert.equal(releases, 1, 'Select on: closing Layers keeps the selected object')
  assert.deepEqual(lifecycle.selection?.path, [0])
  assert.equal(views.at(-1).visible, false)
  await lifecycle.toggle()
  assert.deepEqual(views.at(-1).selected, [0], 'reopened Layers shows the kept selection')
  await lifecycle.action({ root: '/l', action: 'close' })
  assert.equal(releases, 1, 'the close action follows the same rule')
  assert.equal(modeSends().length, 0, 'Layers never changes Selection mode')
}
console.log(
  'Native layers: scoped selection/fingerprints, source moves, agent fallback, canceled reads, selection sync and moved-row follow passed'
)
