import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'
import { nativeCanvas } from './states-install'

type Page = (code: string) => Promise<unknown>

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
  await page('(() => { window.canvasBeforeSetup = 1; return true })()')
  mkdirSync(join(fixture, 'src'), { recursive: true })
  const entry = join(fixture, 'runtime-entry.js')
  const runtime = join(fixture, 'runtime.js')
  const module = join(fixture, 'src', 'Orders.js')
  const react = join(root, 'node_modules/react/index.js')
  const dom = join(root, 'node_modules/react-dom/client.js')
  writeFileSync(
    entry,
    `import * as React from ${JSON.stringify(react)}; import {createRoot} from ${JSON.stringify(dom)}; export const createElement=React.createElement; export const Component=React.Component; export {createRoot};`
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
  const built = await bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' })
  assert.ok(built.success, `React runtime bundle: ${built.logs.join('; ')}`)
  writeFileSync(runtime, await built.outputs[0].text())
  rmSync(entry)
  writeFileSync(
    module,
    `import {createElement} from '/runtime.js';
export function Orders({orders}) { if (!orders) return createElement('p',{className:'loading'},'Loading orders');
  if (!orders.length) return createElement('p',{className:'empty'},'No orders');
  return createElement('ul',{className:'orders'},orders.map(x=>createElement('li',{key:x.id},x.name))); }
export function Frame({children}) { return createElement('div',{className:'provider'},children); }`
  )
  await waitFor(
    async () => (await page('typeof window.canvasBeforeSetup').catch(() => null)) === 'undefined',
    'fixture live reload after canvas modules are written',
    10000
  )
  // FSEvents can deliver a second change for the generated bundle after the first reload.
  await new Promise((resolve) => setTimeout(resolve, 700))
  const served = (await page(`Promise.all(['/runtime.js','/src/Orders.js'].map(async path => {
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
  const before = await page(
    `JSON.stringify({url:location.href,history:history.length,scroll:scrollY,token:window.canvasDocumentToken,original:document.querySelector('#original-orders')?.textContent})`
  )
  const inventory = () => readdirSync(fixture, { recursive: true }).map(String).sort()
  const files = inventory()
  const sourceBefore = readFileSync(module, 'utf8')
  nativeCanvas.expect(fixture, {
    tag: 'div',
    componentSource: 'src/Orders.js:1',
    layerPath: [0, 0]
  } as Parameters<NonNullable<typeof nativeCanvas>['expect']>[1])
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
  const registered = await nativeCanvas.register(fixture, 'smoke', recipe)
  assert.ok(registered.id, `recipe registered: ${JSON.stringify(registered)}`)
  const opened = nativeCanvas.open(fixture, registered.id)
  assert.equal(opened.id, registered.id)
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
      `canvas ${state}`,
      10000
    )
  await rendered('loading', 'Loading orders')
  await waitFor(() => nativeCanvas?.view?.status === 'ready', 'canvas reports ready', 5000)
  assert.equal(await host.request('statesPerform', { action: 'select', state: 'empty' }), true)
  await rendered('empty', 'No orders')
  await nativeCanvas.action('select', 'populated')
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
  assert.equal(
    await page(
      `JSON.stringify({url:location.href,history:history.length,scroll:scrollY,token:window.canvasDocumentToken,original:document.querySelector('#original-orders')?.textContent})`
    ),
    before
  )
  assert.deepEqual(inventory(), files)
  assert.equal(readFileSync(module, 'utf8'), sourceBefore)
  nativeCanvas.close()
  assert.equal(nativeCanvas.open(fixture, registered.id).id, registered.id)
  assert.equal(nativeCanvas.view?.state, 'populated')
  await nativeCanvas.action('remove', registered.id)
  assert.deepEqual(inventory(), files)
  assert.equal(await page('document.querySelector("[data-trezi-states-canvas]") === null'), true)
  rmSync(module)
  rmSync(runtime)
  await page('document.querySelector("#original-orders")?.remove()')
}

export async function restoreStatesCanvas(fixture: string) {
  nativeCanvas?.close()
  for (const recipe of nativeCanvas?.recipes(fixture) ?? [])
    await nativeCanvas?.action('remove', recipe.id)
  for (const path of [
    join(fixture, 'src/Orders.js'),
    join(fixture, 'runtime.js'),
    join(fixture, 'runtime-entry.js')
  ])
    rmSync(path, { force: true })
}
