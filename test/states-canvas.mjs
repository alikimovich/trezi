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
// Vite's cache key is allowed on a runtime URL so the recipe names the component's own React.
assert.equal(
  parseCanvasRecipe({ ...raw, react: '/node_modules/.vite/deps/react.js?v=1a2b3c4d' }, 'chat', 1)
    ?.react,
  '/node_modules/.vite/deps/react.js?v=1a2b3c4d'
)
for (const react of [
  '/react.js?x=1',
  '/react.js?v=1&x=2',
  '/react.js?v=a?b',
  '/react.js#frag',
  '/react.js?v=',
  '/../react.js?v=1'
])
  assert.equal(parseCanvasRecipe({ ...raw, react }, 'chat', 1), null, react)
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
let page = 'http://localhost:5173/orders'
const sheets = {
  shown: null,
  present(state, handle) {
    this.shown = { state, handle }
  },
  close() {
    this.shown = null
  }
}
const services = {
  preferences,
  active: () => ({ root, url: page }),
  pageUrl: () => page,
  sheets,
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

// A legacy workbench folder id is never the open canvas: the menu's legacy entries reach their own owner.
for (const action of ['open', 'grid', 'rebuild', 'remove', 'continue'])
  assert.equal(await reopened.action(action, 'OrderList'), false, action)
assert.equal(readCanvasRecipes(stored, root).length, 1)
assert.equal(reopened.view.recipe.id, registered.id)
assert.equal(sheets.shown, null)

// A page reload of the same URL redraws; another URL disposes. Style updates redraw, but not
// the ones our own draw causes.
commands.length = 0
reopened.pageLoaded(page)
assert.equal(commands.at(-1)[1].command, 'open')
assert.equal(commands.at(-1)[1].refresh, true)
assert.equal(reopened.view.status, 'loading')
commands.length = 0
reopened.stylesUpdated(Date.now())
assert.equal(commands.length, 0, 'a style update right after a draw is ignored')
reopened.stylesUpdated(Date.now() + 5000)
assert.equal(commands.at(-1)[1].refresh, true)

// Remove asks first; Cancel keeps the recipe, Remove forgets it and closes the canvas.
assert.equal(await reopened.action('remove', registered.id), true)
assert.equal(readCanvasRecipes(stored, root).length, 1)
assert.match(sheets.shown.state.title, /Remove the Orders states canvas/)
await sheets.shown.handle({ id: 's', action: 'keep', values: {} })
assert.equal(readCanvasRecipes(stored, root).length, 1)
await reopened.action('remove', registered.id)
await sheets.shown.handle({ id: 's', action: 'remove', values: {} })
assert.equal(readCanvasRecipes(stored, root).length, 0)
assert.equal(reopened.view, null)

// Without an id, two exports of one source file are two canvases; the same export again updates
// its canvas (revision 2) and never touches the other.
const pick = () =>
  controller.expect(root, { tag: 'div', componentSource: 'src/Orders.tsx:12', layerPath: [0, 2] })
pick()
const first = await controller.register(root, 'chat-a', raw)
pick()
const summary = await controller.register(root, 'chat-b', {
  ...raw,
  component: 'Orders summary',
  exportName: 'OrdersSummary'
})
assert.ok(first.id && summary.id)
assert.notEqual(first.id, summary.id)
assert.match(first.id, /^canvas:[a-z0-9][a-z0-9-]{0,39}$/)
assert.match(summary.id, /^canvas:[a-z0-9][a-z0-9-]{0,39}$/)
let both = readCanvasRecipes(stored, root)
assert.equal(both.length, 2)
assert.equal(both.find((r) => r.id === first.id).chat, 'chat-a')
assert.equal(both.find((r) => r.id === summary.id).exportName, 'OrdersSummary')
const updated = await controller.register(root, 'chat-a', { ...raw, width: 500 })
assert.equal(updated.id, first.id, 'the same export updates its own canvas')
both = readCanvasRecipes(stored, root)
assert.equal(both.length, 2)
assert.equal(both.find((r) => r.id === first.id).revision, 2)
assert.equal(both.find((r) => r.id === first.id).width, 500)
assert.equal(both.find((r) => r.id === summary.id).revision, 1)
assert.equal(both.find((r) => r.id === summary.id).chat, 'chat-b')
assert.notEqual(
  parseCanvasRecipe({ ...raw, source: 'a/'.repeat(40) + 'x.tsx' }, 'c', 1)?.id,
  parseCanvasRecipe({ ...raw, source: 'b/'.repeat(40) + 'x.tsx' }, 'c', 1)?.id,
  'long paths with one tail stay apart'
)

// A recipe whose source is gone is stale and says so instead of importing it.
controller.expect(root, { tag: 'div', componentSource: 'src/Orders.tsx:12', layerPath: [0, 2] })
const again = await controller.register(root, 'chat', raw)
rmSync(join(root, 'src/Orders.tsx'))
commands.length = 0
assert.equal(controller.open(root, again.id).id, again.id)
assert.equal(controller.view.status, 'stale')
assert.match(controller.view.reason, /no longer exists/)
assert.match(commands.at(-1)[1].unavailable, /no longer exists/)
controller.result({ session: controller.view.session, status: 'ready' })
assert.equal(controller.view.status, 'stale', 'the page cannot overrule a stale source')
assert.equal(sent.at(-1)[1].state.status, 'stale')
controller.pageLoaded('http://localhost:5173/other')
assert.equal(controller.view, null, 'navigation disposes the canvas')
assert.equal(commands.at(-1)[1].command, 'close')
rmSync(root, { recursive: true, force: true })
console.log('states-canvas: OK')
