import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewSendChannels } from '../src/native/platform.ts'
import { writeStatesFixtures } from '../src/native/smoke-states-projects.ts'
import { StatesCanvasController } from '../src/native/states-canvas-controller.ts'
import { readProbe } from '../src/native/states-probe.ts'
import { PREVIEW_CANVAS, PREVIEW_CANVAS_RESULT } from '../src/shared/preview-channels.ts'
import { parseCanvasRecipe, readCanvasRecipes } from '../src/shared/states-canvas.ts'

// LKM-263: recipes are app data and the view is driven by Bun; the page never issues commands.
assert.ok(
  previewSendChannels.has(PREVIEW_CANVAS_RESULT),
  'view status reaches the native IPC boundary'
)
assert.ok(!previewSendChannels.has(PREVIEW_CANVAS), 'page cannot issue states view commands')

const root = mkdtempSync(join(tmpdir(), 'trezi-canvas-'))
const fixtures = writeStatesFixtures(root, join(process.cwd(), 'node_modules'))
const badgeSource = 'states-fixtures/vite-app/src/components/StatusBadge.tsx'
const raw = {
  component: 'StatusBadge',
  source: badgeSource,
  exportName: 'StatusBadge',
  // Recipes stored before LKM-263 named Vite module URLs; they are ignored, never required.
  react: '/node_modules/.vite/deps/react.js',
  reactDom: '/node_modules/.vite/deps/react-dom_client.js',
  selection: { tag: 'span', source: fixtures.stamps.badge.componentSource, path: [1] },
  states: [
    {
      id: 'expanded',
      label: 'Expanded',
      props: { status: 'online', label: 'API' },
      actions: [{ type: 'click' }]
    },
    {
      id: 'deep-link',
      label: 'Deep link',
      props: { status: 'offline', label: 'API' },
      route: { pathname: '/p/1', params: { id: '1' } }
    }
  ],
  missing: [{ id: 'hover', label: 'Hover', note: 'Not reachable' }]
}
const parsed = parseCanvasRecipe(raw, 'chat', 1)
assert.ok(parsed)
assert.equal('react' in parsed, false, 'legacy Vite URLs are dropped')
assert.deepEqual(parsed.states[0].actions, [{ type: 'click' }])
assert.deepEqual(parsed.states[1].route, { pathname: '/p/1', params: { id: '1' } })
assert.equal(parsed.width, undefined, 'width is optional')
assert.equal(parseCanvasRecipe({ ...raw, source: '../outside.ts' }, 'chat', 1), null)
assert.equal(parseCanvasRecipe({ ...raw, states: [raw.states[0], raw.states[0]] }, 'chat', 1), null)
assert.equal(
  parseCanvasRecipe(
    { ...raw, states: [{ ...raw.states[0], actions: [{ type: 'eval' }] }] },
    'chat',
    1
  ),
  null
)
assert.equal(
  parseCanvasRecipe(
    { ...raw, states: [{ ...raw.states[0], route: { pathname: 'x' } }] },
    'chat',
    1
  ),
  null
)
assert.equal(
  parseCanvasRecipe(
    { ...raw, states: [{ id: 'x', label: 'X', props: { huge: 'x'.repeat(20000) } }] },
    'chat',
    1
  ),
  null
)

// The page's probe answer is untrusted data: only a bounded plain object survives.
assert.deepEqual(readProbe({ found: true, props: { a: 1 }, width: 320.4 }), {
  props: { a: 1 },
  width: 320
})
assert.deepEqual(readProbe({ found: true, props: [1], width: 10 }), { props: null, width: 0 })
assert.deepEqual(readProbe({ found: true, props: { big: 'x'.repeat(20000) } }).props, null)
assert.deepEqual(readProbe('<script>'), { props: null, width: 0 })

let stored = null
const sent = []
const commands = []
const builds = []
const preferences = {
  get: () => stored,
  apply: async (batch) => {
    const entries = batch({ 'trezi:states-canvases:v1': stored })
    stored = entries[0][1]
  }
}
const page = 'http://localhost:3000/states.html'
const sheets = {
  shown: null,
  present(state, handle) {
    this.shown = { state, handle }
  },
  close() {
    this.shown = null
  }
}
const submitted = []
const services = {
  preferences,
  active: () => ({ root, url: page }),
  pageUrl: () => page,
  sheets,
  preview: (channel, payload) => commands.push([channel, payload]),
  probe: async () => ({ found: false }),
  send: (command, payload) => sent.push([command, payload]),
  legacyItems: () => [],
  chatTitle: () => undefined,
  submit: async (_root, text) => submitted.push(text),
  focusChat: async () => true,
  report: (error) => assert.fail(error),
  build: async (input) => {
    builds.push(input)
    return {
      ok: true,
      code: 'mount()',
      css: '.badge{}',
      inputs: [],
      notes: ['built'],
      framework: 'vite'
    }
  }
}
const badge = {
  tag: 'span',
  id: 'states-badge',
  classes: [],
  selector: '#states-badge',
  ...fixtures.stamps.badge,
  text: null,
  rect: { x: 0, y: 0, width: 200, height: 24 },
  styles: {},
  layerPath: [1]
}
const controller = new StatesCanvasController(services)
const last = () => commands.at(-1)[1]
const bar = () => sent.filter(([name]) => name === 'statesState').at(-1)[1].state

// Show states on a selection discovers, builds and draws every state at once.
assert.equal(await controller.show(root, badge), true)
assert.equal(controller.view.subject.component, 'StatusBadge')
assert.match(controller.view.subject.key, /^discovered:/)
assert.deepEqual(builds.at(-1), {
  root,
  source: badgeSource,
  exportName: 'StatusBadge',
  provider: null
})
assert.equal(last().command, 'open')
assert.equal(last().state, 'all')
assert.deepEqual(last().bundle, { code: 'mount()', css: '.badge{}' })
assert.ok(last().notes.includes('built'))
assert.deepEqual(
  last()
    .states.slice(0, 3)
    .map((state) => state.props.status),
  ['online', 'offline', 'degraded']
)
assert.equal(bar().back, 'Back to page')
assert.deepEqual(
  bar().missing.map((item) => item.id),
  ['interactive']
)
controller.result({ session: 'other', status: 'ready' })
assert.equal(controller.view.status, 'loading', 'a stale session cannot report')
controller.result({ session: controller.view.session, status: 'ready' })
assert.equal(controller.view.status, 'ready')

// Switching draws one state in a new session; the discovered view asks the agent for fixtures.
assert.equal(await controller.action('select', 'status-offline'), true)
assert.equal(last().state, 'status-offline')
assert.equal(controller.view.status, 'loading')
assert.equal(await controller.action('next'), true)
assert.equal(last().state, 'status-degraded')
assert.equal(await controller.action('continue', controller.view.subject.key), true)
assert.match(
  submitted.at(-1),
  /^\/states Register a states recipe with Trezi for StatusBadge .* covering Interactive states/
)
assert.match(submitted.at(-1), /do not write files to the project/)

// A recipe for the open component redraws it with its states first.
const registered = await controller.register(root, 'chat', raw)
assert.match(registered.id, /^canvas:/)
assert.equal(controller.view.subject.key, registered.id)
assert.deepEqual(
  controller.view.subject.states.slice(0, 2).map((state) => state.id),
  ['expanded', 'deep-link']
)
assert.ok(controller.view.subject.states.some((state) => state.origin === 'discovered'))
assert.deepEqual(last().states[0].actions, [{ type: 'click' }])
assert.equal(controller.openForSelection(root, badge), true)

// Legacy workbench ids are never this view.
for (const action of ['open', 'grid', 'rebuild', 'remove', 'continue'])
  assert.equal(await controller.action(action, 'OrderList'), false, action)

// Reload of the same URL redraws, another URL closes; style updates right after a draw are ours.
commands.length = 0
controller.pageLoaded(page)
assert.equal(last().command, 'open')
commands.length = 0
controller.stylesUpdated(Date.now())
assert.equal(commands.length, 0)
controller.stylesUpdated(Date.now() + 5000)
assert.equal(last().command, 'open')
controller.pageLoaded('http://localhost:3000/other')
assert.equal(controller.view, null)
assert.equal(last().command, 'close')

// An edit to an imported module builds again without probing the reloading page; an edit to the
// component itself discovers its states again.
const sourceFile = realpathSync(join(root, badgeSource))
const toneFile = realpathSync(join(root, 'states-fixtures/vite-app/src/lib/tone.ts'))
let probes = 0
services.probe = async () => {
  probes++
  return { found: false }
}
const built = services.build
services.build = async (input) => ({ ...(await built(input)), inputs: [sourceFile, toneFile] })
await controller.show(root, badge)
const counts = () => [builds.length, probes]
// The inputs are polled, and a poll whose baseline was taken after the edit never sees it
// under host load. Edit `file`, wait until the build count reaches `count` (touching it again
// every few seconds while nothing has built), then a little longer for a stray second build.
const settle = async (file, count) => {
  const deadline = Date.now() + 30_000
  let touched = Date.now()
  appendFileSync(file, '\n')
  while (builds.length < count) {
    if (Date.now() > deadline)
      throw new Error(
        `the edit to ${file} did not build again within 30 s; builds ${builds.length}, probes ${probes}, expected ${count} builds`
      )
    if (Date.now() - touched > 3000) {
      appendFileSync(file, '\n')
      touched = Date.now()
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
}
const [built0, probed0] = counts()
const session = controller.view.session
await settle(toneFile, built0 + 1)
assert.deepEqual(counts(), [built0 + 1, probed0], 'a dependency edit only builds again')
assert.notEqual(controller.view.session, session, 'the rebuilt bundle draws in a new session')
assert.equal(last().command, 'open')
await settle(sourceFile, built0 + 2)
assert.deepEqual(counts(), [built0 + 2, probed0 + 1], 'a component edit discovers again')
assert.equal(await controller.action('back'), true)
services.build = built

// Server-only components get the reason instead of frames, with no build.
const server = {
  ...badge,
  id: 'states-server',
  tag: 'p',
  ...fixtures.stamps.server,
  layerPath: [2]
}
services.build = async () => ({
  ok: false,
  reason:
    'states-fixtures/next-app/app/components/ServerStats.tsx imports "server-only", which runs only on the server',
  inputs: []
})
await controller.show(root, server)
assert.equal(controller.view.status, 'error')
assert.match(last().unavailable, /runs only on the server/)
assert.equal(last().bundle, undefined)
const before = builds.length
await controller.show(root, { ...badge, tag: 'ul', ...fixtures.stamps.async, layerPath: [3] })
assert.match(last().unavailable, /async Server Component/)
assert.equal(builds.length, before)
controller.result({ session: controller.view.session, status: 'ready' })
assert.equal(controller.view.status, 'error', 'the page cannot overrule an unavailable component')
assert.equal(await controller.action('back'), true)
assert.equal(controller.view, null)

// Remove asks first; a recipe whose source is gone is stale and says so.
assert.equal(await controller.action('remove', registered.id), true)
assert.match(sheets.shown.state.title, /Remove the StatusBadge states recipe/)
await sheets.shown.handle({ id: 's', action: 'keep', values: {} })
assert.equal(readCanvasRecipes(stored, root).length, 1)
rmSync(join(root, badgeSource))
assert.equal(controller.open(root, registered.id).id, registered.id)
await new Promise((resolve) => setTimeout(resolve, 10))
assert.equal(controller.view.status, 'stale')
assert.match(last().unavailable, /no longer exists/)
assert.equal(bar().status, 'stale')
await controller.action('remove', registered.id)
await sheets.shown.handle({ id: 's', action: 'remove', values: {} })
assert.equal(readCanvasRecipes(stored, root).length, 0)
assert.equal(controller.view, null)
rmSync(root, { recursive: true, force: true })
console.log('states-canvas: OK')
