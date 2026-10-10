import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'
import { nativeCanvas } from './states-install'

type Page = (code: string) => Promise<unknown>
type Inspect = Record<string, any>

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const rect = (value: string) => {
  const [x, y, width, height] = (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  return { x, y, width, height }
}
const luminance = (css: string) => {
  const [r, g, b] = (css.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** A real React export and provider, served from the disposable native fixture. Setup
 * happens before inventory is taken; registration/switch/rebuild/close/remove must not
 * change a single project file or the original page. */
export async function checkStatesCanvas(
  host: NativeBridge,
  page: Page,
  fixture: string,
  root: string,
  artifacts: string
) {
  assert.ok(nativeCanvas, 'canvas controller installed')
  const canvas = nativeCanvas
  await page('(() => { window.canvasBeforeSetup = 1; return true })()')
  mkdirSync(join(fixture, 'src'), { recursive: true })
  const entry = join(fixture, 'runtime-entry.js')
  const runtime = join(fixture, 'runtime.js')
  const cjsEntry = join(fixture, 'runtime-cjs-entry.js')
  const cjsRuntime = join(fixture, 'runtime-cjs.js')
  const module = join(fixture, 'src', 'Orders.js')
  const hooks = join(fixture, 'src', 'Hooks.js')
  const boom = join(fixture, 'src', 'Boom.js')
  const react = join(root, 'node_modules/react/index.js')
  const dom = join(root, 'node_modules/react-dom/client.js')
  writeFileSync(
    entry,
    `import * as React from ${JSON.stringify(react)}; import {createRoot} from ${JSON.stringify(dom)}; export const createElement=React.createElement; export const Component=React.Component; export {createRoot};`
  )
  // What Vite serves for an optimized CommonJS dependency: the only export is `default`.
  writeFileSync(
    cjsEntry,
    `import * as React from ${JSON.stringify(react)}; import {createRoot} from ${JSON.stringify(dom)}; export default {createElement:React.createElement,Component:React.Component,createContext:React.createContext,useState:React.useState,useContext:React.useContext,createRoot};`
  )
  const bun = (
    globalThis as unknown as {
      Bun: {
        build(options: {
          entrypoints: string[]
          target: string
          format: string
        }): Promise<{ success: boolean; logs: unknown[]; outputs: { text(): Promise<string> }[] }>
      }
    }
  ).Bun
  for (const [from, to] of [
    [entry, runtime],
    [cjsEntry, cjsRuntime]
  ]) {
    const built = await bun.build({ entrypoints: [from], target: 'browser', format: 'esm' })
    assert.ok(built.success, `React runtime bundle: ${built.logs.join('; ')}`)
    writeFileSync(to, await built.outputs[0].text())
    rmSync(from)
  }
  writeFileSync(
    module,
    `import {createElement} from '/runtime.js';
export function Orders({orders}) { if (!orders) return createElement('p',{className:'loading'},'Loading orders');
  if (!orders.length) return createElement('p',{className:'empty'},'No orders');
  return createElement('ul',{className:'orders'},orders.map(x=>createElement('li',{key:x.id},x.name))); }
export function Frame({children}) { return createElement('div',{className:'provider'},children); }`
  )
  // The component imports the exact `?v=` URL a Vite project serves: one React instance.
  writeFileSync(
    hooks,
    `import R from '/runtime-cjs.js?v=abc123';
const Theme = R.createContext('none');
export function Hooked({label}) { const [n]=R.useState(7); const theme=R.useContext(Theme);
  return R.createElement('p',{className:'hooked'},label+':'+n+':'+theme); }
export function HookFrame({children}) { return R.createElement(Theme.Provider,{value:'provided'},children); }`
  )
  writeFileSync(
    boom,
    `import {createElement} from '/runtime.js';
export function Boom() { throw new Error('Boom fixture failed'); }
export function Quiet() { return createElement('p',null,'quiet'); }`
  )
  await waitFor(
    async () => (await page('typeof window.canvasBeforeSetup').catch(() => null)) === 'undefined',
    'fixture live reload after canvas modules are written',
    10000
  )
  // FSEvents can deliver a second change for the generated bundle after the first reload.
  await delay(700)
  const served =
    (await page(`Promise.all(['/runtime.js','/runtime-cjs.js?v=abc123','/src/Orders.js','/src/Hooks.js'].map(async path => {
    const response=await fetch(path);return {path,status:response.status,type:response.headers.get('content-type')}
  }))`)) as { path: string; status: number; type: string }[]
  assert.ok(
    served.every((item) => item.status === 200 && item.type.startsWith('text/javascript')),
    `canvas module responses: ${JSON.stringify(served)}`
  )
  await page(`(async()=>{const React=await import('/runtime.js'); const {Orders}=await import('/src/Orders.js');
    const host=document.createElement('div');host.id='original-orders';document.body.append(host);
    React.createRoot(host).render(React.createElement(Orders,{orders:[{id:0,name:'Original'}]}));
    window.canvasDocumentToken=crypto.randomUUID();scrollTo(0,250);return true})()`)
  await waitFor(
    async () =>
      (await page("document.querySelector('#original-orders')?.textContent")) === 'Original',
    'original component mounted',
    10000
  )
  const snapshot = () =>
    page(
      `JSON.stringify({url:location.href,history:history.length,scroll:scrollY,token:window.canvasDocumentToken,original:document.querySelector('#original-orders')?.textContent})`
    )
  const before = await snapshot()
  const inventory = () => readdirSync(fixture, { recursive: true }).map(String).sort()
  const files = inventory()
  const sourceBefore = readFileSync(module, 'utf8')
  const pick = (source: string) =>
    canvas.expect(fixture, {
      tag: 'div',
      componentSource: `${source}:1`,
      layerPath: [0, 0]
    } as Parameters<typeof canvas.expect>[1])
  const switcher = () => host.request('statesInspect') as Promise<Inspect>
  const rendered = async (state: string, expected: string) =>
    waitFor(
      async () => {
        const data = JSON.parse(
          String(
            await page(
              `JSON.stringify({state:document.querySelector('[data-trezi-states-canvas]')?.getAttribute('data-trezi-state'),text:document.querySelector('[data-trezi-states-canvas]')?.textContent,frames:[...document.querySelectorAll('[data-trezi-state-frame]')].map(x=>x.getAttribute('data-trezi-state-frame'))})`
            )
          )
        )
        return data.state === state && data.text.includes(expected) && data
      },
      `canvas ${state} shows ${expected}`,
      10000
    )

  pick('src/Orders.js')
  const recipe = {
    component: 'Orders',
    source: 'src/Orders.js',
    exportName: 'Orders',
    provider: { source: 'src/Orders.js', exportName: 'Frame' },
    react: '/runtime.js',
    reactDom: '/runtime.js',
    width: 420,
    states: [
      { id: 'loading', label: 'Loading', props: { orders: null } },
      { id: 'empty', label: 'Empty', props: { orders: [] } },
      {
        id: 'populated',
        label: 'Populated',
        props: {
          orders: [
            { id: 1, name: 'Canvas one' },
            { id: 2, name: 'Canvas two' }
          ]
        }
      }
    ],
    missing: [{ id: 'error', label: 'Error', note: 'Not implemented' }]
  }
  const registered = await canvas.register(fixture, 'smoke', recipe)
  assert.ok(registered.id, `recipe registered: ${JSON.stringify(registered)}`)
  assert.ok(registered.id.startsWith('canvas:'), 'recipe ids have their own namespace')
  const orders = registered.id
  const opened = canvas.open(fixture, orders)
  assert.equal(opened.id, orders)
  await rendered('loading', 'Loading orders')
  await waitFor(() => canvas.view?.status === 'ready', 'canvas reports ready', 5000)
  assert.equal(await host.request('statesPerform', { action: 'select', state: 'empty' }), true)
  await rendered('empty', 'No orders')
  await canvas.action('select', 'populated')
  await rendered('populated', 'Canvas two')
  assert.equal(await host.request('statesPerform', { action: 'all' }), true)
  const all = await rendered('all', 'Canvas one')
  assert.deepEqual(all.frames, ['loading', 'empty', 'populated'])
  assert.equal(
    await page("document.querySelectorAll('[data-trezi-state-frame] .provider').length"),
    3
  )
  writeFileSync(
    join(artifacts, 'states-canvas.png'),
    Buffer.from(await host.request('captureShell'), 'base64')
  )
  assert.equal(await snapshot(), before, 'URL, history, scroll and the original page are untouched')
  assert.deepEqual(inventory(), files)
  assert.equal(readFileSync(module, 'utf8'), sourceBefore)

  // Light and dark follow the window appearance (a test override, never a system setting), live:
  // the same dialog element repaints without a re-render.
  await page(
    "(() => { document.querySelector('[data-trezi-states-canvas]').setAttribute('data-probe', 'kept'); return true })()"
  )
  const background = async () =>
    String(
      await page(
        "getComputedStyle(document.querySelector('[data-trezi-states-canvas]')).backgroundColor"
      )
    )
  try {
    const seen: Record<string, number> = {}
    for (const appearance of ['light', 'dark'] as const) {
      await host.request('shellPerform', { action: 'window-appearance', row: appearance })
      await waitFor(
        async () => {
          seen[appearance] = luminance(await background())
          return appearance === 'light' ? seen[appearance] > 0.8 : seen[appearance] < 0.3
        },
        `canvas background follows ${appearance}`,
        5000,
        async () => ({ background: await background() })
      )
      await delay(350)
      writeFileSync(
        join(artifacts, `states-canvas-${appearance}.png`),
        Buffer.from(await host.request('captureShell'), 'base64')
      )
      assert.equal(
        await page(
          "document.querySelector('[data-trezi-states-canvas]')?.getAttribute('data-probe')"
        ),
        'kept',
        `${appearance}: the canvas was not re-rendered`
      )
    }
    assert.ok(
      seen.light > seen.dark + 0.5,
      `light ${seen.light} is clearly lighter than ${seen.dark}`
    )
  } finally {
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
  }

  // The shared States menu: a legacy workbench folder is never the open canvas.
  const recipes = canvas.recipes(fixture).length
  for (const action of ['open', 'grid', 'rebuild', 'remove', 'continue'])
    assert.equal(await canvas.action(action, 'OrderList'), false, `legacy ${action} is not ours`)
  assert.equal(canvas.recipes(fixture).length, recipes, 'a legacy action keeps the canvas recipe')
  assert.equal(canvas.view?.recipe.id, orders)
  assert.equal(canvas.view?.state, 'all')
  // Remove… from the menu asks first, and Cancel keeps the recipe.
  assert.equal(
    await host.request('shellPerform', { action: 'states-menu', row: `remove:${orders}` }),
    true,
    'Remove is in the States menu for a canvas'
  )
  const sheet = await waitFor(
    async () => {
      const value = await host.request('sheetInspect')
      return value.visible && value
    },
    'the canvas Remove confirmation',
    5000
  )
  assert.equal(sheet.title, 'Remove the Orders states canvas?')
  assert.deepEqual(sheet.actions, ['keep', 'remove'])
  assert.equal(
    canvas.recipes(fixture).length,
    recipes,
    'nothing is removed before the confirmation'
  )
  await host.request('sheetPerform', { action: 'keep' })
  assert.equal(canvas.recipes(fixture).length, recipes)

  // Close returns to the page; reopening uses the saved recipe and last state.
  canvas.close()
  assert.equal(await snapshot(), before)
  assert.equal(canvas.open(fixture, orders).id, orders)
  assert.equal(canvas.view?.state, 'populated')
  await rendered('populated', 'Canvas two')

  // A render with a thrown component reports the error and its reason to the native bar.
  pick('src/Boom.js')
  const broken = await canvas.register(fixture, 'smoke', {
    component: 'Boom',
    source: 'src/Boom.js',
    exportName: 'Boom',
    react: '/runtime.js',
    reactDom: '/runtime.js',
    width: 300,
    states: [{ id: 'default', label: 'Default', props: {} }],
    missing: []
  })
  assert.ok(broken.id, JSON.stringify(broken))
  canvas.open(fixture, broken.id)
  await waitFor(
    () => canvas.view?.status === 'error' && canvas.view.reason.includes('Boom fixture failed'),
    'a throwing component reports an error',
    8000,
    async () => ({ view: canvas.view })
  )
  const errored = await switcher()
  assert.equal(errored.status, 'error')
  assert.match(errored.reason, /Boom fixture failed/)
  assert.equal(errored.component, 'Boom')
  // An export the module lacks is unsupported, not a blank canvas.
  pick('src/Boom.js')
  const missing = await canvas.register(fixture, 'smoke', {
    id: broken.id,
    component: 'Boom',
    source: 'src/Boom.js',
    exportName: 'Absent',
    react: '/runtime.js',
    reactDom: '/runtime.js',
    width: 300,
    states: [{ id: 'default', label: 'Default', props: {} }],
    missing: []
  })
  assert.equal(missing.id, broken.id)
  await waitFor(
    () => canvas.view?.status === 'error' && canvas.view.reason.includes('not exported'),
    'a missing export is reported as unsupported',
    8000,
    async () => ({ view: canvas.view })
  )

  // An edit to the component's source re-renders the open canvas: the fixture server reloads
  // the document, and the canvas (same URL) draws again from the new module.
  canvas.open(fixture, orders, 'empty')
  await rendered('empty', 'No orders')
  writeFileSync(module, sourceBefore.replace('No orders', 'No orders yet (edited)'))
  await rendered('empty', 'No orders yet (edited)')
  await waitFor(() => canvas.view?.status === 'ready', 'the refreshed canvas is ready', 8000)
  assert.equal(canvas.view?.recipe.id, orders)
  assert.equal(
    JSON.parse(String(await snapshot())).url,
    JSON.parse(String(before)).url,
    'the edit did not change the URL'
  )

  // Many states and long labels at a narrow window: the native bar falls back to its compact
  // row and stays inside the page.
  pick('src/Hooks.js')
  const long = 'A very long state label that keeps going to exercise the picker and the menu'
  const many = await canvas.register(fixture, 'smoke', {
    component: 'Hooked component with a very long display name that overflows a bar',
    source: 'src/Hooks.js',
    exportName: 'Hooked',
    provider: { source: 'src/Hooks.js', exportName: 'HookFrame' },
    react: '/runtime-cjs.js?v=abc123',
    reactDom: '/runtime-cjs.js?v=abc123',
    width: 360,
    states: Array.from({ length: 24 }, (_, index) => ({
      id: `state-${index + 1}`,
      label: `${index + 1}. ${long}`.slice(0, 80),
      props: { label: `S${index + 1}` }
    })),
    missing: [{ id: 'offline', label: 'Offline', note: long }]
  })
  assert.ok(many.id, `hooks recipe registered: ${JSON.stringify(many)}`)
  assert.notEqual(many.id, orders)
  canvas.open(fixture, many.id)
  // Hooks and context work through the default-only (CommonJS-shaped) runtime and its ?v= URL.
  await rendered('state-1', 'S1:7:provided')
  await waitFor(() => canvas.view?.status === 'ready', 'the hooks canvas is ready', 8000)
  assert.equal(await canvas.action('select', 'state-24'), true)
  await rendered('state-24', 'S24:7:provided')
  try {
    await host.request('shellPerform', { action: 'window-width', row: '850' })
    const narrow = await waitFor(
      async () => {
        const value = await switcher()
        return value.visible && value.compact && value
      },
      'the states bar is compact at a narrow window',
      5000,
      switcher
    )
    const bounds = rect(narrow.page)
    const frame = rect(narrow.frame)
    assert.equal(narrow.states.length, 24)
    assert.ok(
      frame.x >= bounds.x - 0.5 &&
        frame.x + frame.width <= bounds.x + bounds.width + 0.5 &&
        frame.y >= bounds.y - 0.5 &&
        frame.y + frame.height <= bounds.y + bounds.height + 0.5,
      `the bar ${narrow.frame} stays inside the page ${narrow.page}`
    )
    writeFileSync(
      join(artifacts, 'states-canvas-narrow.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
  } finally {
    await host.request('shellPerform', { action: 'window-width', row: '1320' })
  }
  const wide = await waitFor(
    async () => {
      const value = await switcher()
      return value.visible && value
    },
    'the states bar at the usual width',
    5000
  )
  const wideFrame = rect(wide.frame)
  const widePage = rect(wide.page)
  assert.ok(
    wideFrame.x >= widePage.x - 0.5 &&
      wideFrame.x + wideFrame.width <= widePage.x + widePage.width + 0.5,
    'the bar stays inside the page at the usual width'
  )

  // A recipe whose source is gone is stale: explicit, never a silent failure.
  canvas.open(fixture, broken.id)
  rmSync(boom)
  await waitFor(
    () => canvas.view?.status === 'stale',
    'a recipe with a missing source is stale',
    8000,
    async () => ({ view: canvas.view })
  )
  const stale = await switcher()
  assert.equal(stale.status, 'stale')
  assert.match(stale.reason, /no longer exists/)
  assert.equal(
    await page(
      "document.querySelector('[data-trezi-states-canvas]')?.getAttribute('data-trezi-state')"
    ),
    'unavailable'
  )

  // Remove forgets the recipes only; the project's files are as they were.
  canvas.close()
  for (const id of [orders, many.id, broken.id]) await canvas.remove(fixture, id)
  assert.equal(canvas.recipes(fixture).length, 0)
  writeFileSync(module, sourceBefore)
  assert.deepEqual(
    inventory(),
    files.filter((file) => file !== join('src', 'Boom.js')),
    'the project holds the files the test wrote and nothing else'
  )
  assert.equal(await page('document.querySelector("[data-trezi-states-canvas]") === null'), true)
  for (const path of [module, hooks, runtime, cjsRuntime]) rmSync(path, { force: true })
  await page('document.querySelector("#original-orders")?.remove()')
}

export async function restoreStatesCanvas(fixture: string) {
  nativeCanvas?.close()
  for (const recipe of nativeCanvas?.recipes(fixture) ?? [])
    await nativeCanvas?.remove(fixture, recipe.id)
  for (const path of [
    join(fixture, 'src/Orders.js'),
    join(fixture, 'src/Hooks.js'),
    join(fixture, 'src/Boom.js'),
    join(fixture, 'runtime.js'),
    join(fixture, 'runtime-cjs.js'),
    join(fixture, 'runtime-entry.js'),
    join(fixture, 'runtime-cjs-entry.js')
  ])
    rmSync(path, { force: true })
}
