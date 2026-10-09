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
  { path: [0], fingerprint: { tag: 'div', source: 'a.tsx:1' } }
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
  ['layers:select', { path: [1], fingerprint: { tag: 'p', source: 'i.html:4:1' } }]
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
  { path: [0], fingerprint: { tag: 'p', source: 'i.html:3:1' } }
])
assert.deepEqual(states.at(-1).selected, [0], 'the moved element stays selected')
console.log(
  'Native layers: scoped selection/fingerprints, source moves, agent fallback, canceled reads, selection sync and moved-row follow passed'
)
