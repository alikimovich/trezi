import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Rect = { x: number; y: number; width: number; height: number }
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = any
const samePath = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const inside = (r: Rect, area: Rect, inset: number) =>
  r.x >= area.x + inset - 0.5 &&
  r.y >= area.y + inset - 0.5 &&
  r.x + r.width <= area.x + area.width - inset + 0.5 &&
  r.y + r.height <= area.y + area.height - inset + 0.5
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5

/** What the Layers check needs from the smoke: the page, IPC and the fixture's source. */
export type LayersSmoke = {
  fixture: string
  invoke: (channel: string, ...args: unknown[]) => Promise<State>
  send: (channel: string, ...args: unknown[]) => Promise<unknown>
  evaluate: (code: string, isolated?: boolean) => Promise<unknown>
  /** The preview toolbar's editing-island toggle. */
  props: () => void
  /** The page reports its selection was cancelled (Escape or a click on nothing). */
  cancel: () => void
  saved: () => string | null
}

/** LKM-179: the Layers island hangs under its toolbar button, never covers the editing
 *  island at wide or narrow windows, follows the preview's selection both ways, reorders
 *  source by drag (Undo restores it), refuses what the source cannot express and keeps
 *  page hover out from under it. */
export async function checkLayersIsland(host: NativeBridge, artifacts: string, smoke: LayersSmoke) {
  const island = (params: Record<string, unknown> = {}): Promise<State> =>
    host.request('layersIsland', params)
  const foreground = process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1'
  const evidence: Record<string, unknown> = {}
  const index = join(smoke.fixture, 'index.html')
  const original = readFileSync(index, 'utf8')
  const size = (await host.request('inspectorIsland')).window
  const setLayers = async (open: boolean) => {
    if ((await island()).visible !== open) await host.request('shellPerform', { action: 'layers' })
    return waitFor(
      async () => {
        const state = await island()
        return state.visible === open && (!open || state.count > 0) && state
      },
      `Layers ${open ? 'open' : 'closed'}`
    )
  }
  const setProps = async (open: boolean) => {
    if ((await host.request('inspectorInspect')).visible !== open) smoke.props()
    await waitFor(
      async () => (await host.request('inspectorInspect')).visible === open,
      `editing island ${open ? 'open' : 'closed'}`
    )
    await delay(150)
  }
  const nodes = async () => (await smoke.invoke('layers:read')).nodes as State[]
  const select = async (node: State) =>
    smoke.send('layers:select', {
      path: node.path,
      fingerprint: { tag: node.tag, source: node.source }
    })
  try {
    // Placement: under the Layers button, and beside or above the editing island.
    const heading = (await nodes()).find((n) => n.id === 'native-title')
    assert.ok(heading, 'the fixture heading is a Layers row')
    await select(heading)
    for (const [name, width] of [
      ['wide', 1280],
      ['narrow', 900]
    ] as const) {
      await island({ windowWidth: width, windowHeight: size.height, prepare: true })
      await setLayers(true)
      await island({ action: 'reset' })
      const alone = await island()
      evidence[`${name}-alone`] = alone
      const { frame, area, inset, button } = alone
      assert.ok(inside(frame, area, inset), `${name}: Layers floats inside the preview`)
      assert.ok(Math.abs(frame.y - (area.y + inset)) < 0.5, `${name}: Layers hangs from the top`)
      // Centred under the button where the preview allows; flush right if the toolbar
      // moved the button into its overflow menu.
      const half = frame.width / 2
      const center = Math.max(
        area.x + inset + half,
        Math.min(area.x + area.width - inset - half, alone.anchor ?? Number.POSITIVE_INFINITY)
      )
      assert.ok(
        Math.abs(frame.x + half - center) < 1,
        `${name}: Layers is centred under its button ${JSON.stringify({ frame, button })}`
      )
      if (button)
        assert.ok(frame.y >= button.y + button.height - 0.5, `${name}: Layers is below the button`)
      else console.log(`Layers ${name}: the Layers button is in the toolbar overflow`)
      assert.equal(alone.hits.inside, 'layers', `${name}: the island takes the pointer`)
      assert.equal(alone.hits.header, 'layers', `${name}: the header takes the pointer`)
      assert.equal(alone.cornerRadius, 24)
      await setProps(true)
      const both = await island()
      evidence[`${name}-both`] = both
      assert.ok(both.inspectorVisible && both.inspector.width > 0, `${name}: editing island open`)
      assert.ok(
        !overlap(both.frame, both.inspector),
        `${name}: the islands never cover each other ${JSON.stringify(both)}`
      )
      assert.ok(inside(both.frame, both.area, inset), `${name}: Layers stays over the preview`)
      assert.ok(
        inside(both.inspector, both.area, inset),
        `${name}: the editing island stays over the preview`
      )
      if (both.mode === 'stacked')
        assert.ok(
          both.frame.y + both.frame.height <= both.inspector.y,
          `${name}: Layers stacks above`
        )
      else {
        assert.equal(both.mode, 'beside', `${name}: Layers sits beside the editing island`)
        assert.ok(
          both.frame.x + both.frame.width <= both.inspector.x,
          `${name}: Layers on the left`
        )
      }
      if (name === 'wide') {
        assert.equal(both.mode, 'beside', 'wide: both islands fit side by side')
        for (const appearance of ['light', 'dark']) {
          const stem = `layers-island-${appearance}`
          if (!foreground) {
            console.log(`SKIP foreground ${stem} capture: TREZI_NATIVE_BACKGROUND_TEST`)
            writeFileSync(
              join(artifacts, `${stem}.png`),
              Buffer.from(await host.request('captureShell'), 'base64')
            )
            continue
          }
          await island({ prepare: true })
          await delay(350)
          const image = await island({ capture: appearance })
          assert.equal(image.dark, appearance === 'dark', `${stem}: window appearance forced`)
          writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(image.png, 'base64'))
        }
      }
      await setProps(false)
    }
    await island({ windowWidth: size.width, windowHeight: size.height, prepare: true })
    // A header drag and an edge drag move and size the island, remembered for the window.
    const start = await island()
    const moved = await island({ action: 'move', dx: -40, dy: 30 })
    assert.ok(
      moved.custom && Math.abs(moved.frame.x - (start.frame.x - 40)) < 1,
      'header drag moves Layers'
    )
    const resized = await island({ action: 'resize', width: 300, height: 320 })
    assert.ok(
      Math.abs(resized.frame.width - 300) < 1 && Math.abs(resized.frame.height - 320) < 1,
      'edges resize Layers'
    )
    await waitFor(() => {
      const sizes = JSON.parse(smoke.saved() ?? '{}')
      return sizes.layersWidth === 300 && sizes.layers === 320 && Number.isFinite(sizes.layersX)
    }, 'Layers position and size saved')
    await island({ action: 'resize', width: start.size.width, height: start.size.height })
    const reset = await island({ action: 'reset' })
    assert.ok(
      !reset.custom && Math.abs(reset.frame.x - start.frame.x) < 1,
      'reset returns under the button'
    )

    // Selection sync: the page's selection reveals its row, a row selects the page element.
    const page = await nodes()
    const body = page.find((n) => n.tag === 'body')
    const h1 = page.find((n) => n.id === 'native-title')
    const p = page.find((n) => n.tag === 'p' && samePath(n.parentPath, body?.path))
    assert.ok(body && h1 && p, 'the fixture body, heading and paragraph are rows')
    // A move across files goes to the agent and writes nothing: fail fast on a stale stamp.
    assert.ok(
      String(h1.source).startsWith('index.html:') && String(p.source).startsWith('index.html:'),
      `the heading and paragraph are stamped from index.html (heading ${h1.source}, paragraph ${p.source})`
    )
    assert.ok((await island({ action: 'collapse' })).ok)
    const sent = (await island()).selectionsSent
    await select(p)
    const revealed = await waitFor(async () => {
      const state = await island()
      return samePath(state.selected, p.path) && state.selectedVisible && state
    }, 'a preview selection selects and reveals its row')
    assert.equal(
      revealed.selectionsSent,
      sent,
      'a preview selection is not echoed back to the page'
    )
    assert.ok((await island({ action: 'select', path: h1.path })).ok)
    await waitFor(
      async () => (await host.request('inspectorInspect')).title === 'h1#native-title',
      'a row selects its element in the page'
    )
    const picked = await island()
    assert.ok(samePath(picked.selected, h1.path) && picked.selectionsSent === sent + 1)
    smoke.cancel()
    await waitFor(async () => {
      const state = await island()
      return state.selected === null && state.selectedRow === -1
    }, 'clearing the page selection clears the row')

    // Drag the paragraph before the heading; the source changes, the row follows, Undo restores.
    const siblings = page.filter((n) => samePath(n.parentPath, body.path))
    const at = siblings.findIndex((n) => samePath(n.path, h1.path))
    const drop = await island({ action: 'drop', path: p.path, parent: body.path, index: at })
    assert.ok(drop.ok, `the drop is accepted ${JSON.stringify(drop)}`)
    await waitFor(
      () => {
        const text = readFileSync(index, 'utf8')
        return text.indexOf('Bun owns this server') < text.indexOf('id="native-title"')
      },
      'the paragraph moved before the heading in index.html',
      10000,
      // A refusal or an agent fallback shows only as a notice.
      async () => {
        const text = readFileSync(index, 'utf8')
        const state = await island()
        return {
          notice: state.notice,
          drop,
          heading: h1.source,
          paragraph: p.source,
          nativeRows: state.count,
          sourceRows: (await nodes()).length,
          headingOffset: text.indexOf('id="native-title"'),
          paragraphOffset: text.indexOf('Bun owns this server'),
          sourceChanged: text !== original
        }
      }
    )
    // The paragraph now has the heading's old row.
    await waitFor(
      async () =>
        samePath((await island()).selected, h1.path) &&
        (await host.request('inspectorInspect')).title === 'p',
      'the moved paragraph stays selected',
      15000
    )
    assert.ok((await smoke.invoke('edit:undo', smoke.fixture)).ok, 'Undo the move')
    await waitFor(() => readFileSync(index, 'utf8') === original, 'Undo restores index.html')
    await waitFor(
      () =>
        smoke.evaluate(
          `document.querySelector('#native-title')?.nextElementSibling?.tagName === 'P'`
        ),
      'the page shows the original order'
    )

    // A drop the source cannot express is refused with one line, and nothing is sent.
    await smoke.evaluate(
      `document.body.insertAdjacentHTML('afterbegin', '<div id="layers-unstamped">Generated</div>')`
    )
    const generated = await waitFor(
      async () => (await nodes()).find((n) => n.id === 'layers-unstamped'),
      'an unstamped element in the page'
    )
    // The tree refreshes on the page's own mutation ping.
    await waitFor(async () => (await island()).count >= page.length + 1, 'its Layers row')
    const refused = await island({
      action: 'drop',
      path: generated.path,
      parent: body.path,
      index: at + 2
    })
    assert.ok(!refused.ok && /library or generated/.test(refused.reason), JSON.stringify(refused))
    assert.equal((await island()).notice, refused.reason, 'the reason shows under the tree')
    assert.equal(readFileSync(index, 'utf8'), original)
    await smoke.evaluate(`document.querySelector('#layers-unstamped')?.remove()`)

    // LKM-173: in select mode, a pointer over the island never hovers the page under it.
    if (foreground) await checkPointer(island, smoke, evidence)
    else console.log('SKIP Layers island pointer ownership: TREZI_NATIVE_BACKGROUND_TEST')
  } finally {
    writeFileSync(join(artifacts, 'layers-island.json'), JSON.stringify(evidence, null, 2))
  }
}

async function checkPointer(
  island: (params?: Record<string, unknown>) => Promise<State>,
  smoke: LayersSmoke,
  evidence: Record<string, unknown>
) {
  const heading = (await smoke.evaluate(`(() => {
    const r = document.querySelector('#native-title').getBoundingClientRect();
    return {x:r.x + Math.min(20, r.width / 2), y:r.y + r.height / 2};
  })()`)) as { x: number; y: number }
  const hoverBox = () =>
    smoke.evaluate(
      `(() => { const box = document.querySelector('[data-trezi-overlay]')?.shadowRoot?.querySelector('[data-trezi-hover]'); return !!box && box.style.display === 'block'; })()`,
      true
    )
  const shields = async () =>
    (await smoke.evaluate(
      `([...document.querySelector('[data-trezi-cover]')?.shadowRoot?.children ?? []].map(e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }))`,
      true
    )) as Rect[]
  await smoke.invoke('preview:set-select-mode', true)
  try {
    const before = await island({ pointer: true, target: 'page', ...heading })
    await waitFor(hoverBox, 'select-mode hover over the page')
    const over = await island({ pointer: true, target: 'island', ...heading })
    await waitFor(async () => !(await hoverBox()), 'select-mode hover cleared over Layers')
    const cover = await shields()
    const expected = over.expectedCover as Rect[]
    const layers = (await island()).cover as Rect[]
    assert.ok(layers.length > 0, 'Layers covers a preview rect')
    for (const rect of expected)
      assert.ok(
        cover.some((shield) =>
          (['x', 'y', 'width', 'height'] as const).every(
            (key) => Math.abs(shield[key] - rect[key]) <= 1
          )
        ),
        `the page shields the Layers island ${JSON.stringify({ cover, expected })}`
      )
    assert.equal(over.picksTotal, before.picksTotal, 'no pick from a move over Layers')
    evidence.pointer = { before, over, cover }
  } finally {
    await smoke.invoke('preview:set-select-mode', false)
  }
}

/** Leaves no Layers or editing island open, the window at its size and the fixture intact. */
export async function restoreLayersIsland(
  host: NativeBridge,
  smoke: LayersSmoke,
  original: string,
  size: { width: number; height: number }
) {
  await smoke.invoke('preview:set-select-mode', false)
  if ((await host.request('inspectorInspect')).visible) smoke.props()
  if ((await host.request('layersInspect')).visible)
    await host.request('shellPerform', { action: 'layers' })
  await host.request('inspectorIsland', { windowWidth: size.width, windowHeight: size.height })
  await smoke.evaluate(`document.querySelector('#layers-unstamped')?.remove()`)
  const index = join(smoke.fixture, 'index.html')
  if (readFileSync(index, 'utf8') !== original) writeFileSync(index, original)
}
