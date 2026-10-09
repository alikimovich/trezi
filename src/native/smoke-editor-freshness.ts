import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { noteSourceChange } from '../main/source-changes'
import type { NativeBridge } from './bridge'
import { nativeFreshness } from './editor-freshness-runtime'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: IPC and host inspection payloads are untyped JSON
type Any = any
export interface FreshnessSmoke {
  fixture: string
  invoke: (channel: string, ...args: Any[]) => Promise<Any>
  send: (channel: string, ...args: Any[]) => Promise<Any>
  page: (code: string, isolated?: boolean) => Promise<Any>
  props: () => void
}

const CARD = [
  'function Badge({ label }: { label: string }) { return <span>{label}</span> }',
  'export function FreshCard() { return <Badge label="One" /> }'
].join('\n')
const CARD_COLUMN = CARD.split('\n')[1].indexOf('<Badge') + 1
const PAGE = `<!doctype html>
<html>
<head>
<link rel="stylesheet" href="fresh.module.css">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="node_modules/trezi-fresh/fresh.css">
</head>
<body>
<div id="fresh-box" class="fresh-box">Fresh</div>
<div id="fresh-card" data-trezi-source="fresh-card.tsx:2:${CARD_COLUMN}">One</div>
</body>
</html>
`
const FILES = ['fresh.html', 'fresh.module.css', 'tokens.css', 'fresh-card.tsx']

/**
 * LKM-216: the editor never shows stale styles. A CSS module rule saved through the
 * editor reaches the preview's computed style and the island within 1 s, with the
 * island's "Updated" pulse; a component edit updates the props, a page edit the Layers
 * tree, a token file the token list; a stylesheet the page kept stale (the fixture's
 * live reload ignores `node_modules`) is found and swapped without reloading the page.
 */
export async function checkEditorFreshness(
  host: NativeBridge,
  artifacts: string,
  smoke: FreshnessSmoke
) {
  const { fixture, invoke, send, page } = smoke
  const island = (): Promise<Any> => host.request('inspectorInspect')
  const read = (file: string) => readFileSync(join(fixture, file), 'utf8')
  // The editor's save path: the whole file against the baseline it loaded.
  const save = async (file: string, content: string) => {
    const result = await invoke('source:write', fixture, `${file}:1:1`, read(file), content)
    assert.ok(result?.ok, `source:write ${file}: ${JSON.stringify(result)}`)
  }
  const select = async (id: string) => {
    const layers = await invoke('layers:read'),
      node = layers?.nodes.find((n: Any) => n.id === id)
    assert.ok(node, `#${id} in the Layers tree`)
    await send('layers:select', {
      path: node.path,
      fingerprint: { tag: node.tag, source: node.source }
    })
    await waitFor(async () => (await island()).title.endsWith(`#${id}`), `#${id} selected`)
  }
  const tab = async (name: string) => {
    const state = await island()
    if (state.tab !== name)
      await host.request('inspectorPerform', {
        action: { root: fixture, generation: state.generation, action: 'tab', value: name }
      })
    await waitFor(async () => (await island()).tab === name, `${name} tab`)
  }
  const computed = (prop: string) =>
    page(`getComputedStyle(document.querySelector('#fresh-box')).getPropertyValue('${prop}')`)
  const evidence: Record<string, unknown> = {}

  writeFileSync(join(fixture, 'fresh.module.css'), '.fresh-box { opacity: 0.5; }\n')
  writeFileSync(join(fixture, 'tokens.css'), ':root { --fresh-one: #112233; }\n')
  writeFileSync(join(fixture, 'fresh-card.tsx'), CARD)
  mkdirSync(join(fixture, 'node_modules/trezi-fresh'), { recursive: true })
  writeFileSync(
    join(fixture, 'node_modules/trezi-fresh/fresh.css'),
    '#fresh-box { border: 1px solid black; }\n'
  )
  writeFileSync(join(fixture, 'fresh.html'), PAGE)
  const origin = new URL(String(await page('location.href'))).origin
  await page(`(() => { location.href = ${JSON.stringify(`${origin}/fresh.html`)}; return true })()`)
  await waitFor(
    async () =>
      (await computed('opacity')) === '0.5' &&
      (await page(`!!document.querySelector('#fresh-card')`)),
    'fresh page loaded'
  )

  // 1. A CSS module rule saved through the editor: preview and island within 1 s.
  await select('fresh-box')
  if (!(await island()).visible) smoke.props()
  await waitFor(async () => (await island()).visible, 'editing island open')
  await tab('styles')
  await waitFor(
    async () => (await island()).values['style:opacity'] === '0.5',
    'island opacity 0.5'
  )
  const before = await island()
  const started = Date.now()
  await save('fresh.module.css', '.fresh-box { opacity: 0.25; }\n')
  const after = await waitFor(
    async () => {
      const state = await island()
      return (
        (await computed('opacity')) === '0.25' && state.values['style:opacity'] === '0.25' && state
      )
    },
    'CSS edit reaches the preview and the island',
    5000,
    island
  )
  const elapsed = Date.now() - started
  writeFileSync(
    join(artifacts, 'editor-freshness-pulse.png'),
    Buffer.from(await host.request('captureShell'), 'base64')
  )
  evidence.css = { elapsed, before: before.updated, after: after.updated, pulses: after.pulses }
  assert.ok(elapsed <= 1000, `The CSS edit showed after ${elapsed} ms (limit 1000 ms)`)
  assert.ok(after.updated > before.updated, 'The island counts the update')
  assert.ok(after.pulses > before.pulses, 'The island played its "Updated" pulse')
  assert.equal(after.generation, before.generation, 'The island updated in place (no reload)')

  // 2. A token file change: the token list follows without waiting for a TTL.
  assert.ok(!after.tokens.some((t: string) => t.includes('fresh-two')))
  await save('tokens.css', ':root { --fresh-one: #112233; --fresh-two: #445566; }\n')
  const tokens = await waitFor(
    async () => {
      const state = await island()
      return state.tokens.some((t: string) => t.includes('fresh-two')) && state.tokens
    },
    'token list updated',
    5000,
    island
  )
  evidence.tokens = tokens

  // 3. A component edit: the props re-read. The earlier saves' own re-reads and style
  // checks finish first: one that lands after the new selection (a reload under load)
  // would put the previous element back.
  await waitFor(
    () => nativeFreshness.hub?.idle ?? true,
    'freshness hub idle before the component selection',
    5000,
    () => ({ stats: JSON.stringify(nativeFreshness.hub?.stats) })
  )
  await select('fresh-card')
  await tab('props')
  await waitFor(
    async () => (await island()).values['prop:label'] === 'One',
    'prop label One',
    10000,
    island
  )
  await save('fresh-card.tsx', CARD.replace('label="One"', 'label="Two"'))
  await waitFor(
    async () => (await island()).values['prop:label'] === 'Two',
    'prop label Two',
    5000,
    island
  )

  // 4. A page edit: the Layers tree re-reads.
  if (!(await host.request('layersInspect')).visible)
    await host.request('shellPerform', { action: 'layers' })
  const layers = await waitFor(async () => {
    const state = await host.request('layersInspect')
    return state.visible && state.count > 0 && state
  }, 'Layers open')
  await save(
    'fresh.html',
    read('fresh.html').replace('</body>', '<p id="fresh-added">Added</p>\n</body>')
  )
  await waitFor(
    async () => (await host.request('layersInspect')).count > layers.count,
    'Layers shows the added node',
    5000,
    () => host.request('layersInspect')
  )
  await host.request('shellPerform', { action: 'layers' })
  await waitFor(async () => !(await host.request('layersInspect')).visible, 'Layers closed')

  // 5. A stylesheet the page kept stale is found and swapped, without a page reload.
  // The earlier saves' own checks finish first, so only this change can reload the page.
  await waitFor(
    () => nativeFreshness.hub?.idle ?? true,
    'freshness hub idle before the dependency change',
    5000,
    () => ({ stats: JSON.stringify(nativeFreshness.hub?.stats) })
  )
  await waitFor(
    async () =>
      (await computed('border-top-width')) === '1px' &&
      (await page(`document.readyState === 'complete'`)),
    'dependency CSS loaded'
  )
  // The fixture server's live reload follows the earlier saves of this check (FSEvents can
  // lag by seconds under load), so the baseline is a page that kept its sentinel for a
  // quiet second: only the dependency change below may then reload it.
  let quietSince = 0
  await waitFor(
    async () => {
      if (quietSince && (await page('window.freshSentinel === true')))
        return Date.now() - quietSince >= 1000
      await page('(() => { window.freshSentinel = true; return true })()')
      quietSince = Date.now()
      return false
    },
    'page stable before the dependency change',
    15000
  )
  const reloads = nativeFreshness.hub?.stats.styleReloads ?? 0
  const hardBefore = nativeFreshness.hub?.stats.hardReloads ?? 0
  writeFileSync(
    join(fixture, 'node_modules/trezi-fresh/fresh.css'),
    '#fresh-box { border: 7px solid black; outline: none; }\n'
  )
  noteSourceChange(fixture, ['node_modules/trezi-fresh/fresh.css'], 'dependency')
  await waitFor(
    async () => (await computed('border-top-width')) === '7px',
    'stale stylesheet refreshed',
    5000,
    async () => ({
      stats: JSON.stringify(nativeFreshness.hub?.stats),
      active: JSON.stringify(nativeFreshness.hub?.host.active()),
      changedAt: nativeFreshness.hub?.changedAt,
      appliedAt: nativeFreshness.hub?.appliedAt,
      border: await computed('border-top-width'),
      links: JSON.stringify(await page(`[...document.querySelectorAll('link')].map((l) => l.href)`))
    })
  )
  assert.equal(
    await page('window.freshSentinel === true'),
    true,
    `No page reload (hard reloads ${hardBefore} -> ${nativeFreshness.hub?.stats.hardReloads}; ${JSON.stringify(nativeFreshness.hub?.stats)})`
  )
  assert.ok(
    (nativeFreshness.hub?.stats.styleReloads ?? 0) > reloads,
    'A targeted stylesheet reload'
  )
  assert.ok(
    await page(
      `[...document.querySelectorAll('link')].some((l) => l.href.includes('trezi-fresh='))`
    ),
    'The stale link was replaced by a cache-busted copy'
  )
  evidence.stale = nativeFreshness.hub?.stats
  writeFileSync(join(artifacts, 'editor-freshness.json'), JSON.stringify(evidence, null, 2))
  console.log(
    `Native editor freshness: CSS edit in ${elapsed} ms with the island's pulse; tokens, props and Layers re-read; a stale stylesheet swapped without reload.`
  )
}

/** Back to the fixture's start page, without the files this check wrote. */
export async function restoreEditorFreshness(
  host: NativeBridge,
  smoke: FreshnessSmoke,
  url: string
) {
  const state = await host.request('inspectorInspect')
  if (state.visible)
    await host.request('inspectorPerform', {
      action: { root: smoke.fixture, generation: state.generation, action: 'close' }
    })
  if ((await host.request('layersInspect')).visible)
    await host.request('shellPerform', { action: 'layers' })
  // The hub may still be checking the last stylesheet swap: let it finish before the
  // page moves, and make sure the original page is back before the files go.
  const idle = () => waitFor(() => nativeFreshness.hub?.idle ?? true, 'freshness hub idle', 5000)
  await idle().catch(() => {})
  if (url) {
    await smoke
      .page(`(() => { location.href = ${JSON.stringify(url)}; return true })()`)
      .catch(() => {})
    await waitFor(
      async () =>
        (await smoke
          .page(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`)
          .catch(() => false)) === true,
      'the original page is back',
      10000
    )
  }
  for (const file of FILES) rmSync(join(smoke.fixture, file), { force: true })
  rmSync(join(smoke.fixture, 'node_modules/trezi-fresh'), { recursive: true, force: true })
  // The deletions are file changes too: let their re-read and check settle.
  await new Promise((resolve) => setTimeout(resolve, 400))
  await idle().catch(() => {})
}
