import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SelectedElement } from '../shared/api'
import type { NativeBridge } from './bridge'
import {
  removeStatesFixtures,
  STATES_EDIT,
  STATES_FOLDER,
  writeStatesFixtures
} from './smoke-states-projects'
import { waitFor } from './smoke-wait'
import { nativeCanvas, nativeStates } from './states-install'

type Page = (code: string) => Promise<unknown>
type Invoke = (channel: string, ...args: any[]) => Promise<unknown>
type Frame = {
  id: string
  card: string | null
  theme: string | null
  badge: string | null
  text: string
  bg: string | null
  img: boolean
  error: string | null
  height: number
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let startURL = ''

/** What the view draws, read through its open shadow root and the same-origin state frames. */
const FRAMES = `JSON.stringify((() => {
  const host = document.querySelector('[data-trezi-states-canvas]')
  if (!host) return null
  const shadow = host.shadowRoot
  return {
    state: host.getAttribute('data-trezi-state'),
    status: host.getAttribute('data-trezi-status'),
    message: shadow.querySelector('[data-trezi-states-message]')?.textContent ?? null,
    open: !!shadow.querySelector('dialog')?.open,
    frames: [...shadow.querySelectorAll('[data-trezi-state-frame]')].map((section) => {
      const iframe = section.querySelector('iframe')
      const doc = iframe.contentDocument
      const card = doc?.querySelector('[data-card]')
      const badge = doc?.querySelector('[data-badge]')
      const styled = card ?? badge
      return {
        id: section.getAttribute('data-trezi-state-frame'),
        card: card?.getAttribute('data-card') ?? null,
        theme: card?.getAttribute('data-theme') ?? null,
        badge: badge?.getAttribute('data-badge') ?? null,
        text: doc?.getElementById('trezi-root')?.textContent ?? '',
        bg: styled ? getComputedStyle(styled).backgroundColor : null,
        img: !!doc?.querySelector('img[src^="data:image/png"]'),
        error: doc?.querySelector('[data-trezi-state-error]')?.textContent ?? null,
        height: iframe.getBoundingClientRect().height
      }
    })
  }
})())`

/**
 * LKM-263: Show states on a Next.js App Router component and a Vite React component. Trezi
 * builds each from the project's sources and draws real variants in isolated frames over the
 * preview; switching, a recipe with an interactive action, an edit redrawing the view, server-only
 * and async components, and Back to the untouched page are checked. Not one project file changes.
 */
export async function checkStatesCanvas(
  host: NativeBridge,
  page: Page,
  fixture: string,
  root: string,
  artifacts: string,
  invoke: Invoke
) {
  assert.ok(nativeCanvas && nativeStates, 'states controllers installed')
  const canvas = nativeCanvas
  const states = nativeStates
  startURL = String(await page('location.href'))
  writeStatesFixtures(fixture, join(root, 'node_modules'))
  // Every write live-reloads the static fixture; let FSEvents settle before navigating.
  await delay(900)
  const url = new URL('states.html', startURL).href
  await invoke('preview:load', url)
  await waitFor(
    async () =>
      (await page('!!document.querySelector("#states-badge")').catch(() => false)) === true,
    'the stamped states page loads',
    10000
  )
  // A live reload still in flight from the writes would drop the token below.
  await delay(700)
  await page('(() => { window.statesToken = crypto.randomUUID(); scrollTo(0, 40); return true })()')
  const snapshot = async () =>
    JSON.parse(
      String(
        await page(
          'JSON.stringify({url: location.href, history: history.length, scroll: scrollY, token: window.statesToken, card: document.querySelector("#states-card")?.textContent})'
        )
      )
    )
  const before = await snapshot()
  const inventory = () =>
    readdirSync(fixture, { recursive: true })
      .map(String)
      .filter((path) => !path.split('/').some((part) => part === 'node_modules' || part === '.git'))
      .sort()
  const files = inventory()
  const edited = join(fixture, STATES_EDIT.next)
  const original = readFileSync(edited, 'utf8')
  const element = async (id: string): Promise<SelectedElement> => {
    const raw = JSON.parse(
      String(
        await page(`JSON.stringify((() => {
          const el = document.getElementById(${JSON.stringify(id)})
          const path = []
          for (let node = el; node && node !== document.body; node = node.parentElement) path.unshift([...node.parentElement.children].indexOf(node))
          const r = el.getBoundingClientRect()
          return { tag: el.tagName.toLowerCase(), path, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, source: el.getAttribute('data-trezi-source'), componentSource: el.getAttribute('data-trezi-component-source'), text: el.textContent }
        })())`)
      )
    )
    return {
      tag: raw.tag,
      id,
      classes: [],
      selector: `#${id}`,
      source: raw.source,
      componentSource: raw.componentSource,
      text: raw.text,
      rect: raw.rect,
      styles: {},
      layerPath: raw.path
    }
  }
  const view = async () => JSON.parse(String(await page(FRAMES)))
  const drawn = (label: string, check: (value: any) => boolean, ms = 20000) =>
    waitFor(
      async () => {
        const value = await view()
        return value && check(value) && value
      },
      label,
      ms,
      async () => ({ view: await view(), status: canvas.view?.status, reason: canvas.view?.reason })
    )
  const switcher = () => host.request('statesInspect') as Promise<Record<string, any>>
  const shot = async (name: string) =>
    writeFileSync(join(artifacts, name), Buffer.from(await host.request('captureShell'), 'base64'))

  // Next.js: next/image, next/link, next/navigation, next/font, a CSS module, the `@/` alias and
  // the app's providers.tsx, all from the project's sources.
  assert.equal(await states.show(fixture, await element('states-card')), true)
  const next = await drawn(
    'Next.js ProjectCard states are drawn and ready',
    (value) => value.status === 'ready' && value.frames.length >= 5
  )
  assert.equal(canvas.view?.subject.component, 'ProjectCard')
  assert.equal(next.state, 'all')
  const byId = (value: { frames: Frame[] }, id: string) =>
    value.frames.find((frame: Frame) => frame.id === id) as Frame
  const ids = next.frames.map((frame: Frame) => frame.id)
  for (const id of ['default', 'loading', 'error', 'disabled', 'no-tags', 'status-paused'])
    assert.ok(ids.includes(id), `state ${id} in ${ids.join(', ')}`)
  const ready = byId(next, 'default')
  assert.equal(ready.card, 'ready')
  assert.equal(ready.theme, 'studio', 'the conventional providers.tsx wraps every state')
  assert.equal(ready.bg, 'rgb(250, 240, 255)', 'the CSS module styles apply')
  assert.ok(ready.img, 'next/image renders the imported PNG')
  assert.ok(ready.height > 40, `the frame fits its content (${ready.height})`)
  assert.equal(byId(next, 'loading').card, 'loading')
  assert.equal(byId(next, 'error').card, 'error')
  assert.match(byId(next, 'no-tags').text, /No tags yet/)
  assert.match(byId(next, 'status-paused').text, /paused/)
  const bar = await waitFor(
    async () => {
      const value = await switcher()
      return value.visible && value.status === 'ready' && value
    },
    'the bar reports the states ready',
    5000,
    switcher
  )
  assert.equal(bar.component, 'ProjectCard')
  assert.equal(bar.back, 'Back to page')
  await shot('states-next.png')

  // Switching draws one state, isolated in its own frame.
  assert.equal(await host.request('statesPerform', { action: 'select', state: 'loading' }), true)
  const loading = await drawn(
    'the Loading state alone',
    (value) => value.state === 'loading' && value.frames.length === 1 && value.status === 'ready'
  )
  assert.equal(loading.frames[0].card, 'loading')
  await canvas.action('select', 'default')
  await drawn(
    'the Default state alone',
    (value) => value.state === 'default' && value.status === 'ready'
  )

  // Back returns to the page exactly as it was.
  assert.equal(await host.request('statesPerform', { action: 'back' }), true)
  await waitFor(async () => (await view()) === null && !canvas.view, 'the view closes', 5000)
  assert.deepEqual(
    await snapshot(),
    before,
    'URL, history, scroll and the page document are untouched'
  )

  // Vite React: an enum, a boolean, the vite.config alias and a CSS module.
  assert.equal(await states.show(fixture, await element('states-badge')), true)
  const vite = await drawn(
    'Vite StatusBadge states are drawn and ready',
    (value) => value.status === 'ready' && value.frames.length >= 3
  )
  assert.equal(canvas.view?.subject.component, 'StatusBadge')
  assert.deepEqual(vite.frames.map((frame: Frame) => frame.badge).slice(0, 3), [
    'online',
    'offline',
    'degraded'
  ])
  assert.equal(byId(vite, 'default').bg, 'rgb(240, 246, 255)')
  assert.deepEqual(
    canvas.view?.subject.missing.map((item) => item.id),
    ['interactive']
  )
  // A recipe reaches internal state with an action; its states come first.
  const recipe = await canvas.register(fixture, 'smoke', {
    component: 'StatusBadge',
    source: `${STATES_FOLDER}/vite-app/src/components/StatusBadge.tsx`,
    exportName: 'StatusBadge',
    states: [
      {
        id: 'expanded',
        label: 'Expanded',
        props: { status: 'online', label: 'API' },
        actions: [{ type: 'click' }]
      }
    ],
    missing: []
  })
  assert.ok(recipe.id?.startsWith('canvas:'), JSON.stringify(recipe))
  const expanded = await drawn(
    'the recipe state with a click action',
    (value) =>
      value.status === 'ready' &&
      value.frames[0]?.id === 'expanded' &&
      /details/.test(value.frames[0].text)
  )
  assert.equal(expanded.frames[0].badge, 'online')
  await shot('states-vite.png')
  // The States menu routes by id: a legacy workbench folder is never this view.
  for (const action of ['open', 'grid', 'rebuild', 'remove', 'continue'])
    assert.equal(await canvas.action(action, 'OrderList'), false, `legacy ${action} is not ours`)
  assert.equal(
    await host.request('shellPerform', { action: 'states-menu', row: `remove:${recipe.id}` }),
    true
  )
  const sheet = await waitFor(
    async () => {
      const value = await host.request('sheetInspect')
      return value.visible && value
    },
    'the recipe Remove confirmation',
    5000
  )
  assert.equal(sheet.title, 'Remove the StatusBadge states recipe?')
  await host.request('sheetPerform', { action: 'keep' })
  assert.equal(canvas.recipes(fixture).length, 1)

  // Server-only and async Server Components get a specific reason, not a blank view.
  assert.equal(await states.show(fixture, await element('states-server')), true)
  const server = await drawn('the server-only message', (value) =>
    /runs only on the server/.test(value.message ?? '')
  )
  assert.match(server.message, /imports "server-only", which runs only on the server/)
  assert.equal(server.state, 'unavailable')
  assert.equal(server.open, true, 'the message covers the page in the open view')
  await waitFor(
    async () => (await switcher()).status === 'error',
    'the bar reports the reason',
    5000
  )
  // The message draws at once; give WebKit a moment to paint it before the window capture.
  await delay(600)
  await shot('states-server-only.png')
  assert.equal(await states.show(fixture, await element('states-async')), true)
  const asyncView = await drawn(
    'the async Server Component message',
    (value) => /async Server Component/.test(value.message ?? ''),
    10000
  )
  assert.match(asyncView.message, /Select a client component inside it/)

  // An edit to a module the component imports draws the open view again from the new source.
  assert.equal(await states.show(fixture, await element('states-card')), true)
  await canvas.action('select', 'default')
  await drawn(
    'Default before the edit',
    (value) =>
      value.state === 'default' &&
      value.status === 'ready' &&
      /Updated /.test(value.frames[0]?.text ?? '')
  )
  writeFileSync(
    edited,
    "export function formatDate(_iso: string): string {\n  return 'edited by smoke'\n}\n"
  )
  await drawn(
    'the edited module redraws the state',
    (value) =>
      value.state === 'default' && /Updated edited by smoke/.test(value.frames[0]?.text ?? ''),
    20000
  )
  writeFileSync(edited, original)
  assert.equal(await host.request('statesPerform', { action: 'back' }), true)
  await waitFor(async () => (await view()) === null, 'the view closes after the edit', 5000)
  assert.equal((await snapshot()).url, before.url, 'the edit never navigated the page')

  await canvas.remove(fixture, recipe.id as string)
  assert.equal(canvas.recipes(fixture).length, 0)
  assert.deepEqual(inventory(), files, 'Show states wrote no file into the project')
  assert.equal(readFileSync(edited, 'utf8'), original)
}

export async function restoreStatesCanvas(fixture: string, page: Page, invoke: Invoke) {
  nativeCanvas?.close()
  for (const recipe of nativeCanvas?.recipes(fixture) ?? [])
    await nativeCanvas?.remove(fixture, recipe.id)
  removeStatesFixtures(fixture)
  if (!startURL) return
  // Removing the fixtures live-reloads the page in place; navigate once that has settled, or
  // the reload lands on the removed states.html.
  await delay(900)
  await invoke('preview:load', startURL)
  await waitFor(
    async () => (await page('location.href').catch(() => '')) === startURL,
    'the fixture start page is back',
    10000
  )
}
