import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewSendChannels } from '../src/native/platform.ts'
import { StatesCanvasController } from '../src/native/states-canvas-controller.ts'
import { PREVIEW_CANVAS, PREVIEW_CANVAS_RESULT } from '../src/shared/preview-channels.ts'
import { parseCanvasRecipe, readCanvasRecipes } from '../src/shared/states-canvas.ts'

assert.ok(
  previewSendChannels.has(PREVIEW_CANVAS_RESULT),
  'canvas status reaches the native IPC boundary'
)
assert.ok(!previewSendChannels.has(PREVIEW_CANVAS), 'page cannot issue canvas commands')

const root = mkdtempSync(join(tmpdir(), 'trezi-canvas-'))
mkdirSync(join(root, 'src'))
writeFileSync(join(root, 'src/Orders.tsx'), 'export function Orders() {}')
const raw = {
  component: 'Orders',
  source: 'src/Orders.tsx',
  exportName: 'Orders',
  react: '/node_modules/.vite/deps/react.js',
  reactDom: '/node_modules/.vite/deps/react-dom_client.js',
  width: 420,
  selection: { tag: 'div', source: 'src/Orders.tsx:12', path: [0, 2] },
  states: [
    { id: 'loading', label: 'Loading', props: { orders: null } },
    { id: 'empty', label: 'Empty', props: { orders: [] } },
    { id: 'populated', label: 'Populated', props: { orders: [{ id: 1, name: 'One' }] } }
  ],
  missing: [{ id: 'error', label: 'Error', note: 'Not implemented' }]
}
assert.equal(parseCanvasRecipe({ ...raw, source: '../outside.ts' }, 'chat', 1), null)
assert.equal(parseCanvasRecipe({ ...raw, states: [raw.states[0], raw.states[0]] }, 'chat', 1), null)
assert.equal(parseCanvasRecipe({ ...raw, react: '//other-host/react.js' }, 'chat', 1), null)
assert.equal(
  parseCanvasRecipe(
    { ...raw, states: [{ id: 'x', label: 'X', props: { huge: 'x'.repeat(20000) } }] },
    'chat',
    1
  ),
  null
)

let stored = null
const sent = [],
  commands = []
const preferences = {
  get: () => stored,
  apply: async (batch) => {
    const entries = batch({ 'trezi:states-canvases:v1': stored })
    stored = entries[0][1]
  }
}
const services = {
  preferences,
  active: () => ({ root, url: 'http://localhost:5173/orders' }),
  preview: (channel, payload) => commands.push([channel, payload]),
  send: (command, payload) => sent.push([command, payload]),
  legacyItems: () => [],
  chatTitle: () => undefined,
  submit: async () => {},
  focusChat: async () => true,
  report: () => {}
}
const controller = new StatesCanvasController(services)
controller.expect(root, { tag: 'div', componentSource: 'src/Orders.tsx:12', layerPath: [0, 2] })
const registered = await controller.register(root, 'chat', raw)
assert.match(registered.id, /^canvas:/)
assert.equal(readCanvasRecipes(stored, root).length, 1)
assert.equal(controller.open(root, registered.id).id, registered.id)
assert.equal(commands.at(-1)[0], PREVIEW_CANVAS)
assert.equal(commands.at(-1)[1].state, 'loading')
await controller.action('select', 'populated')
assert.equal(commands.at(-1)[1].state, 'populated')
await controller.action('all')
assert.equal(commands.at(-1)[1].state, 'all')
controller.result({ session: 'stale', status: 'error' })
assert.equal(controller.view.status, 'loading')
controller.result({ session: controller.view.session, status: 'ready' })
assert.equal(controller.view.status, 'ready')
controller.close()
assert.equal(controller.view, null)
const reopened = new StatesCanvasController(services)
assert.equal(reopened.open(root, registered.id).id, registered.id)
assert.equal(reopened.view.state, 'populated')
await reopened.action('remove', registered.id)
assert.equal(readCanvasRecipes(stored, root).length, 0)
assert.equal(reopened.view, null)
rmSync(root, { recursive: true, force: true })
console.log('states-canvas: OK')
