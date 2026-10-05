import assert from 'node:assert/strict'
import { NativeLayersController } from '../src/native/layers-controller.ts'

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
console.log(
  'Native layers: scoped selection/fingerprints, source moves, agent fallback and canceled reads passed'
)
