import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findLeftovers } from '../main/states-workbench'
import { normalizeRoute, parseWorkbench, WORKBENCH_MANIFEST } from '../shared/states-workbench'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'
import { nativeStates } from './states-install'

type Page = (code: string) => Promise<unknown>
const FOLDER = 'trezi-states/order-list'
const SEAM = 'order-list.fixtures.js'
const ROUTE = '/trezi-states/order-list'
const STATES = ['loading', 'empty', 'list']

// The component's source is the fixture page, so Show states on its `#native-title` finds it.
const manifest = {
  version: 1,
  component: 'OrderList',
  source: 'index.html:3',
  route: ROUTE,
  width: 420,
  states: [
    { id: 'loading', label: 'Loading' },
    { id: 'empty', label: 'Empty' },
    { id: 'list', label: 'List' }
  ],
  missing: [{ id: 'error', label: 'Error', note: 'No error UI in the code' }],
  seams: [SEAM],
  fixtures: ['orderListFixtures'],
  chat: 'smoke'
}

/** A React component fed at its data boundary (the `orders` prop) by the seam's fixtures. */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>OrderList states</title>
<style>body{margin:0;font:14px system-ui;min-height:2400px}#bench{width:420px;margin:24px auto}
#bench:has(.grid){width:auto}.grid{display:flex;flex-wrap:wrap;gap:16px;padding:0 16px}
section[data-trezi-state-frame]{width:420px;border:1px solid #ddd;border-radius:8px;padding:8px}
section h2{font-size:11px;color:#888;margin:0 0 6px}</style></head>
<body><div id="bench"></div>
<script src="${ROUTE}/react.js"></script><script src="${ROUTE}/react-dom.js"></script>
<script src="/${SEAM}"></script>
<script>
const h = React.createElement, states = ${JSON.stringify(STATES)}
function OrderList({ orders }) {
  if (!orders) return h('p', { className: 'loading' }, 'Loading orders…')
  if (!orders.length) return h('p', { className: 'empty' }, 'No orders yet')
  return h('ul', { className: 'orders' }, orders.map((o) => h('li', { key: o.id }, o.name)))
}
const pick = () => { const s = new URLSearchParams(location.search).get('__state'); return s === 'all' || states.includes(s) ? s : states[0] }
function Bench({ state }) {
  const one = (id) => h(OrderList, { orders: orderListFixtures[id] })
  if (state === 'all') return h('div', { className: 'grid', 'data-trezi-state': 'all' },
    states.map((id) => h('section', { key: id, 'data-trezi-state-frame': id }, h('h2', null, id), one(id))))
  return h('div', { 'data-trezi-state': state }, one(state))
}
const root = ReactDOM.createRoot(document.getElementById('bench'))
const render = () => ReactDOM.flushSync(() => root.render(h(Bench, { state: pick() })))
addEventListener('trezi:state', render); addEventListener('popstate', render); render()
</script></body></html>`

const fixtures = `window.orderListFixtures = { loading: null, empty: [], list: [
  { id: 1, name: 'Order #1001' }, { id: 2, name: 'Order #1002' }, { id: 3, name: 'Order #1003' }] }\n`

/**
 * LKM-207: a states workbench end to end, as the component-states skill leaves one. The
 * route is detected from its manifest, the island lists the states, ←/→ and 1-9 switch
 * `__state` in place (no reload, scroll kept), the island's All shows every live frame,
 * Hide hides it, and Remove from the toolbar's States menu deletes the folder and seam
 * after the confirmation and leaves no reference behind. LKM-220: Show states on the
 * fixture's `#native-title` opens the existing workbench (no agent turn); Back returns to
 * the same page through history with the element selected again; the States menu lists
 * the workbench with its last state and reopens it there; the record is in the preference
 * and pruned on removal; the Publish warning offers Open Workbench.
 */
export async function checkStatesWorkbench(
  host: NativeBridge,
  page: Page,
  fixture: string,
  root: string,
  artifacts: string,
  bus: {
    invoke: (channel: string, ...args: any[]) => Promise<any>
    send: (channel: string, ...args: any[]) => unknown
  }
) {
  const start = String(await page('location.href'))
  // Every write live-reloads the static page; wait it out so it cannot reload the workbench.
  await page('(() => { window.statesBefore = 1; return true })()')
  const folder = join(fixture, FOLDER)
  mkdirSync(folder, { recursive: true })
  const umd = (name: string, file: string) =>
    copyFileSync(join(root, 'node_modules', name, 'umd', file), join(folder, `${name}.js`))
  umd('react', 'react.production.min.js')
  umd('react-dom', 'react-dom.production.min.js')
  writeFileSync(join(fixture, SEAM), fixtures)
  writeFileSync(join(folder, 'index.html'), HTML)
  writeFileSync(join(folder, WORKBENCH_MANIFEST), JSON.stringify(manifest, null, 2))

  const states = () => host.request('statesInspect') as Promise<Record<string, any>>
  const rendered = async () =>
    (await page(
      `JSON.stringify({ state: document.querySelector('[data-trezi-state]')?.getAttribute('data-trezi-state') ?? null,
        query: new URLSearchParams(location.search).get('__state'), y: Math.round(scrollY), marker: window.statesMarker === 1,
        frames: [...document.querySelectorAll('[data-trezi-state-frame]')].map((f) => [f.getAttribute('data-trezi-state-frame'), f.querySelector('p,ul')?.className]),
        items: document.querySelectorAll('[data-trezi-state] li').length })`
    ).then((value) => JSON.parse(String(value)))) as {
      state: string | null
      query: string | null
      y: number
      marker: boolean
      frames: [string, string][]
      items: number
    }
  const showing = (id: string, label: string) =>
    waitFor(
      async () => {
        const [view, island] = await Promise.all([rendered(), states()])
        return view.state === id && view.query === id && island.current === id && { view, island }
      },
      label,
      8000,
      async () => ({ page: await rendered(), island: await states() })
    )
  const key = (name: string) =>
    page(
      `(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true })); return true })()`
    )

  await waitFor(
    async () => (await page('typeof window.statesBefore').catch(() => null)) === 'undefined',
    'the fixture page live-reloads after the workbench is written',
    10000
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  const inspector = () => host.request('inspectorInspect') as Promise<Record<string, any>>
  const selected = () =>
    waitFor(
      async () => String((await inspector()).title).endsWith('#native-title'),
      '#native-title is selected',
      10000,
      inspector
    )
  // Show states on the selected title: its component has a workbench, which opens.
  const showStates = async () => {
    const layers = await bus.invoke('layers:read')
    const node = layers?.nodes.find((n: { id?: string }) => n.id === 'native-title')
    assert.ok(node, '#native-title in the Layers tree')
    // After Back the title is already selected: wait for this pick's own generation.
    const before = (await inspector()).generation
    await bus.send('layers:select', {
      path: node.path,
      fingerprint: { tag: node.tag, source: node.source }
    })
    const { generation } = await waitFor(
      async () => {
        const value = await inspector()
        return value.generation !== before && String(value.title).endsWith('#native-title') && value
      },
      '#native-title is selected again',
      10000,
      inspector
    )
    await host.request('inspectorPerform', {
      action: { root: fixture, generation, action: 'states' }
    })
  }
  const back = async (label: string) => {
    assert.equal(await host.request('statesPerform', { action: 'back' }), true, label)
    await waitFor(
      async () =>
        (await page(
          `location.href === ${JSON.stringify(start)} && !!document.querySelector('#native-title')`
        ).catch(() => false)) === true,
      `${label}: the same page`,
      10000
    )
    await selected()
    const history = await host.request('previewHistory')
    assert.equal(history.canForward, true, `${label}: ⌘] returns to the workbench`)
  }
  await showStates()
  const detected = await waitFor(
    async () => {
      const value = await states()
      return value.active && value.visible && value
    },
    'the workbench route shows the States island',
    15000,
    states
  )
  assert.deepEqual(detected.states, STATES, 'the island lists the states in order')
  assert.deepEqual(detected.labels, ['Loading', 'Empty', 'List'])
  assert.deepEqual(detected.missing, ['error'], 'the missing state is listed apart')
  assert.equal(detected.component, 'OrderList')
  const [width, height] = (String(detected.frame).match(/[\d.]+/g) ?? []).slice(2).map(Number)
  assert.ok(width > 100 && height > 16, `the island has a real size: ${detected.frame}`)
  const from = new URL(start)
  assert.equal(
    detected.back,
    `Back to ${normalizeRoute(from.pathname)}${from.search}`,
    'Back names the page Show states came from'
  )
  assert.equal(detected.statesMenuVisible, true, 'the toolbar shows the States menu')
  assert.equal(detected.statesMenuTitle, 'States 1')
  assert.deepEqual(
    detected.workbenches.map((w: Record<string, unknown>) => [w.component, w.folder, w.actions]),
    [
      [
        'OrderList',
        FOLDER,
        ['Open', 'Open All States', 'Continue in Chat', 'Rebuild States', 'Remove Workbench…']
      ]
    ]
  )
  await showing('loading', 'the loading state renders')

  // Keys switch in place: the page keeps its marker (no reload) and its scroll position.
  await page('(() => { window.statesMarker = 1; scrollTo(0, 300); return scrollY })()')
  await key('ArrowRight')
  const empty = await showing('empty', '→ shows the empty state')
  assert.equal(empty.view.marker, true, 'switching does not reload the page')
  assert.equal(empty.view.y, 300, 'switching keeps the scroll position')
  await key('3')
  const list = await showing('list', '3 shows the list state')
  assert.equal(list.view.items, 3, 'the list state renders the fixture orders')
  await key('ArrowRight')
  await showing('loading', '→ wraps to the first state')
  await key('ArrowLeft')
  await showing('list', '← wraps to the last state')

  // The island: a state, then All states with every frame live.
  assert.equal(await host.request('statesPerform', { action: 'select', state: 'empty' }), true)
  await showing('empty', 'the island selects a state')
  assert.equal(await host.request('statesPerform', { action: 'all' }), true)
  const all = await showing('all', 'All states shows the grid')
  assert.deepEqual(all.view.frames, [
    ['loading', 'loading'],
    ['empty', 'empty'],
    ['list', 'orders']
  ])
  assert.equal(all.view.marker, true, 'the grid is the same live page')
  writeFileSync(
    join(artifacts, 'states-workbench.png'),
    Buffer.from(await host.request('captureShell'), 'base64')
  )
  writeFileSync(
    join(artifacts, 'states-workbench.json'),
    JSON.stringify({ detected, all }, null, 2)
  )

  // Hide (H's action) hides the island for a screenshot; again brings it back.
  assert.equal(await host.request('statesPerform', { action: 'hide' }), true)
  await waitFor(
    async () => (await states()).hidden === true && !(await states()).visible,
    'Hide hides the island',
    5000,
    states
  )
  assert.equal(await host.request('statesPerform', { action: 'hide' }), true)
  await waitFor(async () => (await states()).visible, 'Hide again shows the island', 5000, states)

  // LKM-220: Back returns to the page with the title selected; the States menu reopens the
  // workbench at the state last viewed; Show states on the same component does too.
  assert.equal(await host.request('statesPerform', { action: 'select', state: 'empty' }), true)
  await showing('empty', 'the last state viewed')
  await back('Back')
  const listed = await waitFor(
    async () => {
      const value = await states()
      return !value.active && /Last: Empty/.test(value.workbenches?.[0]?.info ?? '') && value
    },
    'the States menu knows the last state',
    5000,
    states
  )
  assert.equal(listed.statesMenuVisible, true, 'the States menu stays off the workbench')
  assert.equal(
    await host.request('shellPerform', { action: 'states-menu', row: `open:${FOLDER}` }),
    true,
    'Open is in the States menu'
  )
  await showing('empty', 'the States menu reopens the workbench at its last state')
  await back('Back again')
  await showStates()
  await showing('empty', 'Show states on the same component opens the existing workbench')
  const active = nativeStates?.services.active()?.root ?? fixture
  const stored = () =>
    JSON.parse(String(nativeStates?.memory.store?.read() ?? '{}'))[active]?.[FOLDER]
  // The preference keeps the last state and the page (and element) it came from.
  const record = await waitFor(
    () => {
      const value = stored()
      return value?.last === 'empty' && value.origin?.url === start && value
    },
    'the workbench record in the preference',
    5000,
    stored
  )
  assert.equal(record.origin.selection?.tag, 'h1')

  // The Publish warning offers Open Workbench (no publish) next to its other actions.
  assert.ok(nativeStates)
  const decision = Promise.resolve(nativeStates.beforePublish(active))
  const warning = await waitFor(
    async () => {
      const value = await host.request('sheetInspect')
      return value.visible && value
    },
    'the Publish warning',
    5000
  )
  assert.deepEqual(warning.actions, ['keep', 'open', 'publish', 'remove'])
  await host.request('sheetPerform', { action: 'open' })
  assert.equal(await decision, false, 'Open Workbench does not publish')

  // Remove from the States menu: confirmed first, then the folder and seam go and nothing refers to them.
  const bench = parseWorkbench(JSON.stringify(manifest), FOLDER)
  assert.ok(bench)
  assert.equal(
    await host.request('shellPerform', { action: 'states-menu', row: `remove:${FOLDER}` }),
    true,
    'Remove Workbench… is in the States menu'
  )
  const sheet = await waitFor(
    async () => {
      const value = await host.request('sheetInspect')
      return value.visible && value
    },
    'the Remove confirmation',
    5000
  )
  assert.equal(sheet.title, 'Remove the OrderList states workbench?')
  assert.deepEqual(sheet.actions, ['keep', 'remove'])
  assert.equal(existsSync(folder), true, 'nothing is removed before the confirmation')
  await host.request('sheetPerform', { action: 'remove' })
  await waitFor(
    () => !existsSync(folder) && !existsSync(join(fixture, SEAM)),
    'Remove deletes the workbench folder and its seam',
    10000
  )
  assert.deepEqual(await findLeftovers(fixture, bench), [], 'no references remain')
  await waitFor(
    async () => {
      const value = await states()
      return !value.active && !value.visible && !value.statesMenuVisible
    },
    'the island and the States menu go with the workbench',
    10000,
    states
  )
  await waitFor(() => stored() === undefined, 'its record is pruned', 5000, stored)
  writeFileSync(
    join(artifacts, 'states-return.json'),
    JSON.stringify({ listed, record, warning }, null, 2)
  )
  await page(`(() => { location.href = ${JSON.stringify(start)}; return true })()`)
  await waitFor(
    async () =>
      (await page(
        `location.href === ${JSON.stringify(start)} && !!document.querySelector('#native-title')`
      ).catch(() => false)) === true,
    'the preview is back on the fixture page',
    10000
  )
  console.log(
    'Native states workbench: route detected, keys/island/All switch in place, Back/States menu/Show states return, Open Workbench on Publish, Remove left no references or record.'
  )
}

/** Leave no workbench behind and the preview back on the fixture's own page. */
export async function restoreStatesWorkbench(page: Page, fixture: string, url: string) {
  rmSync(join(fixture, 'trezi-states'), { recursive: true, force: true })
  rmSync(join(fixture, SEAM), { force: true })
  await nativeStates?.refresh().catch(() => [])
  if (url)
    await page(`(() => { location.href = ${JSON.stringify(url)}; return true })()`).catch(() => {})
}
