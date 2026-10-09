import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import type { LayersSmoke } from './smoke-layers'
import { waitFor } from './smoke-wait'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Rect = { x: number; y: number; width: number; height: number }
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = any
const near = (actual: number, expected: number, label: string, tolerance = 1) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} ≠ ${expected}`)
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5
const inside = (r: Rect, inner: Rect) =>
  r.x >= inner.x - 0.5 &&
  r.y >= inner.y - 0.5 &&
  r.x + r.width <= inner.x + inner.width + 0.5 &&
  r.y + r.height <= inner.y + inner.height + 0.5
const innerOf = (state: State): Rect => ({
  x: state.area.x + state.inset,
  y: state.area.y + state.inset,
  width: state.area.width - 2 * state.inset,
  height: state.area.height - 2 * state.inset
})

/** LKM-180: both islands move by their header, snap to the preview's and each other's
 *  edges, never land on each other, keep their corner when the window resizes, are
 *  remembered across close/reopen and a restore, and go back home on reset. */
export async function checkMovableIslands(
  host: NativeBridge,
  artifacts: string,
  smoke: LayersSmoke
) {
  const islands = (params: Record<string, unknown> = {}): Promise<State> =>
    host.request('movableIslands', params)
  const foreground = process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1'
  const evidence: Record<string, unknown> = {}
  const saved = () => JSON.parse(smoke.saved() ?? '{}')
  const size = (await islands()).window
  const startWidth = (await host.request('layoutInspect')).width
  const setLayers = async (open: boolean) => {
    if ((await islands()).layers.visible !== open)
      await host.request('shellPerform', { action: 'layers' })
    return waitFor(
      async () => {
        const state = await islands()
        return state.layers.visible === open && state
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
    return islands()
  }
  try {
    await islands({ windowWidth: 1280, windowHeight: size.height, prepare: true })
    await setLayers(false)
    const heading = ((await smoke.invoke('layers:read')).nodes as State[]).find(
      (n) => n.id === 'native-title'
    )
    assert.ok(heading, 'the fixture heading')
    await smoke.send('layers:select', {
      path: heading.path,
      fingerprint: { tag: heading.tag, source: heading.source }
    })
    await setProps(true)
    const home = await islands({ island: 'inspector', action: 'menuReset' })
    evidence.home = home
    const inner = innerOf(home)
    const width = home.inspector.frame.width
    assert.equal(home.inspector.spot, null, 'the editing island starts at home')
    near(home.inspector.frame.x + width, inner.x + inner.width, 'home is the right edge')

    // The header drags; its buttons and menu keep their clicks and never show the hand.
    assert.equal(home.hits.title, 'header', 'the title drags the island')
    assert.equal(home.hits.blank, 'header', 'the empty header drags the island')
    assert.equal(home.hits.close, 'close', 'the close button keeps its click')
    assert.equal(home.hits.more, 'more', 'the … menu keeps its click')
    assert.ok(home.handsClear, 'the open hand stays off the header buttons')
    assert.ok(home.menu.includes('Reset Position'), `the … menu resets ${home.menu}`)

    // A drag moves it sideways at full height; the page shields the new place.
    const moved = await islands({ island: 'inspector', action: 'drag', dx: -200, dy: 40 })
    evidence.moved = moved
    near(moved.inspector.frame.x, home.inspector.frame.x - 200, 'header drag moves the island')
    near(moved.inspector.frame.y, home.inspector.frame.y, 'it keeps the full height')
    assert.ok(moved.inspector.spot, 'the moved place is kept')
    const { frame } = moved.inspector
    assert.ok(
      moved.cover.some(
        (r: Rect) =>
          Math.abs((r.x * frame.width) / r.width - (frame.x - moved.preview.x)) < 2 &&
          Math.abs((r.height * frame.width) / r.width - frame.height) < 2
      ),
      `the page shields the moved island ${JSON.stringify(moved.cover)}`
    )
    await waitFor(() => Number.isFinite(saved().inspectorX), 'moved place saved')

    // Within the threshold of the left edge it snaps there, at the standard inset.
    const off = home.threshold - 3
    const snapped = await islands({
      island: 'inspector',
      action: 'drag',
      dx: inner.x + off - frame.x
    })
    evidence.snapped = snapped
    near(snapped.inspector.frame.x, inner.x, 'snaps to the left edge', 0.01)
    await waitFor(() => {
      const sizes = saved()
      return sizes.inspectorCorner === 1 && Math.abs(sizes.inspectorX - home.inset) < 0.01
    }, 'left-edge place saved from the left')

    // Close with the header's own button, reopen: the same place. A restore does the same.
    await islands({ island: 'inspector', action: 'close' })
    await waitFor(
      async () => !(await host.request('inspectorInspect')).visible,
      'the header close button closes the island'
    )
    near((await setProps(true)).inspector.frame.x, inner.x, 'reopens where it was left')
    const preferences = saved()
    const reset = await islands({ island: 'inspector', action: 'reset' })
    assert.equal(reset.inspector.spot, null, 'double-click on the header resets')
    near(reset.inspector.frame.x, home.inspector.frame.x, 'reset goes home')
    const restored = await islands({ action: 'restore', sizes: preferences })
    near(restored.inspector.frame.x, inner.x, 'a restored window puts it back')

    // A resize keeps its corner; the window comes back.
    const narrow = await islands({ windowWidth: 1000, windowHeight: size.height })
    evidence.narrow = narrow
    near(narrow.inspector.frame.x, narrow.area.x + narrow.inset, 'keeps its left corner')
    await islands({ windowWidth: 1280, windowHeight: size.height, prepare: true })

    // Layers opens beside it; a drop onto the other island moves to the nearest free place.
    const both = await setLayers(true)
    assert.ok(!overlap(both.layers.frame, both.inspector.frame), 'Layers opens clear of it')
    const onto = await islands({
      island: 'inspector',
      action: 'drag',
      dx: both.layers.frame.x - both.inspector.frame.x
    })
    evidence.inspectorOntoLayers = onto
    assert.ok(
      !overlap(onto.inspector.frame, onto.layers.frame) &&
        inside(onto.inspector.frame, innerOf(onto)),
      `the editing island never lands on Layers ${JSON.stringify(onto)}`
    )
    const layersOnto = await islands({
      island: 'layers',
      action: 'drag',
      dx: onto.inspector.frame.x - onto.layers.frame.x,
      dy: 40
    })
    evidence.layersOntoInspector = layersOnto
    const layers = layersOnto.layers.frame
    const inspector = layersOnto.inspector.frame
    assert.ok(
      layersOnto.layers.spot && !overlap(layers, inspector) && inside(layers, innerOf(layersOnto)),
      `Layers never lands on the editing island ${JSON.stringify(layersOnto)}`
    )

    // Near the editing island's side, Layers snaps a standard gap away from it.
    const right = layers.x >= inspector.x + inspector.width
    const line = right ? inspector.x + inspector.width + home.gap : inspector.x - home.gap
    const edge = right ? layers.x : layers.x + layers.width
    const beside = await islands({
      island: 'layers',
      action: 'drag',
      dx: line + (right ? off : -off) - edge
    })
    evidence.beside = beside
    const snappedEdge = right
      ? beside.layers.frame.x
      : beside.layers.frame.x + beside.layers.frame.width
    near(snappedEdge, line, 'Layers snaps beside the editing island', 0.01)
    await waitFor(() => Number.isFinite(saved().layersX), 'Layers place saved')

    for (const appearance of ['light', 'dark']) {
      const stem = `movable-islands-${appearance}`
      if (!foreground) {
        console.log(`SKIP foreground ${stem} capture: TREZI_NATIVE_BACKGROUND_TEST`)
        writeFileSync(
          join(artifacts, `${stem}.png`),
          Buffer.from(await host.request('captureShell'), 'base64')
        )
        continue
      }
      await islands({ prepare: true })
      await delay(350)
      const image = await islands({ capture: appearance })
      assert.equal(image.dark, appearance === 'dark', `${stem}: window appearance forced`)
      writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(image.png, 'base64'))
    }

    // Reset: Layers by a header double-click, the editing island from its … menu.
    await islands({ island: 'layers', action: 'reset' })
    const home2 = await islands({ island: 'inspector', action: 'menuReset' })
    evidence.reset = home2
    assert.equal(home2.layers.spot, null, 'Layers back under its button')
    assert.equal(home2.inspector.spot, null, 'Reset Position puts the editing island back')
    near(home2.inspector.frame.x, home.inspector.frame.x, 'back on the right')
    assert.ok(!overlap(home2.layers.frame, home2.inspector.frame))
    await waitFor(() => {
      const sizes = saved()
      return !('inspectorX' in sizes) && !('layersX' in sizes)
    }, 'reset places saved')
  } finally {
    writeFileSync(join(artifacts, 'movable-islands.json'), JSON.stringify(evidence, null, 2))
    // The window first, whatever failed above: the later chat checks need the canvas this
    // one started with (a 440 pt chat beside a 624 pt preview) and never resize it back.
    await islands({ windowWidth: size.width, windowHeight: size.height, prepare: true })
  }
  const after = await host.request('layoutInspect')
  assert.ok(
    Math.abs(after.width - startWidth) < 1 &&
      Math.abs((await islands()).window.width - size.width) < 1,
    `the window and chat come back to ${size.width} / ${startWidth}: ${JSON.stringify(after)}`
  )
}

/** Leaves both islands home and closed, and the window at its size. */
export async function restoreMovableIslands(
  host: NativeBridge,
  smoke: LayersSmoke,
  size: { width: number; height: number }
) {
  const islands = (params: Record<string, unknown> = {}): Promise<State> =>
    host.request('movableIslands', params)
  await islands({ windowWidth: size.width, windowHeight: size.height })
  await islands({ island: 'layers', action: 'reset' })
  await islands({ island: 'inspector', action: 'reset' })
  if ((await host.request('inspectorInspect')).visible) smoke.props()
  if ((await host.request('layersInspect')).visible)
    await host.request('shellPerform', { action: 'layers' })
}
