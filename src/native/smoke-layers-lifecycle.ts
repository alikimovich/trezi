import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import type { LayersSmoke } from './smoke-layers'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = any
type Rect = { x: number; y: number; width: number; height: number }

const outlines = `(() => [...document.querySelector('[data-trezi-overlay]')?.shadowRoot?.querySelectorAll('[data-trezi-selbox]') ?? []].filter(b => b.style.display !== 'none').length)()`
const grip = (prop: string) => `(() => {
  const g = document.querySelector('[data-trezi-overlay]')?.shadowRoot?.querySelector('[data-trezi-spacing-handle][data-prop="${prop}"]');
  const t = document.querySelector('#native-title');
  if (!g || !t) return null;
  const a = g.getBoundingClientRect(), b = t.getBoundingClientRect();
  return {grip:{x:a.x,y:a.y,width:a.width,height:a.height}, target:{x:b.x,y:b.y,width:b.width,height:b.height}};
})()`

/** LKM-541: closing Layers with Selection mode off drops a row's transient selection,
 *  outline and inspector context; with it on only the island hides. Late row picks and
 *  reopening leave nothing stale, Layers never changes the mode, and (foreground) one
 *  real pointer drag on a spacing grip stages an inspector draft without a source write. */
export async function checkLayersLifecycle(
  host: NativeBridge,
  smoke: LayersSmoke,
  evidence: Record<string, unknown>,
  foreground: boolean
) {
  const island = (params: Record<string, unknown> = {}): Promise<State> =>
    host.request('layersIsland', params)
  const inspect = (): Promise<State> => host.request('inspectorInspect')
  const selectMode = async () => (await host.request('shellInspect')).selectMode === true
  const index = join(smoke.fixture, 'index.html')
  const original = readFileSync(index, 'utf8')
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
  const shown = async () => Number(await smoke.evaluate(outlines, true))
  const heading = ((await smoke.invoke('layers:read')).nodes as State[]).find(
    (n) => n.id === 'native-title'
  )
  assert.ok(heading, 'the fixture heading is a Layers row')

  await smoke.invoke('preview:set-select-mode', false)
  smoke.cancel()
  await setLayers(false)
  // Opening Layers alone does not enable Selection mode.
  await setLayers(true)
  assert.equal(await selectMode(), false, 'opening Layers leaves Selection mode off')

  // Select OFF: a row pick outlines the element; closing Layers clears it all.
  assert.ok((await island({ action: 'select', path: heading.path })).ok)
  await waitFor(
    async () => (await inspect()).title === 'h1#native-title' && (await shown()) > 0,
    'Select off: a row selects and outlines its element'
  )
  await setLayers(false)
  await waitFor(
    async () => (await shown()) === 0 && (await inspect()).title !== 'h1#native-title',
    'Select off: closing Layers clears the outline and inspector context'
  )
  assert.equal(await selectMode(), false, 'closing Layers never enables Selection mode')
  // A row pick arriving after close must not bring the outline back.
  await smoke.send('layers:select', {
    path: heading.path,
    fingerprint: { tag: heading.tag, source: heading.source },
    from: 'layers'
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await shown(), 0, 'a late row pick after close draws no outline')
  const reopened = await setLayers(true)
  assert.equal(reopened.selected, null, 'reopened Layers shows no stale row')
  evidence.lifecycleOff = { reopened: reopened.selected, title: (await inspect()).title }

  // Select ON: the same flow hides only Layers and keeps the selection.
  await smoke.invoke('preview:set-select-mode', true)
  try {
    assert.ok((await island({ action: 'select', path: heading.path })).ok)
    await waitFor(
      async () => (await inspect()).title === 'h1#native-title' && (await shown()) > 0,
      'Select on: a row selects its element'
    )
    await setLayers(false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal((await inspect()).title, 'h1#native-title', 'Select on: the selection stays')
    assert.ok((await shown()) > 0, 'Select on: the outline stays')
    assert.equal(await selectMode(), true, 'closing Layers never exits Selection mode')
    evidence.lifecycleOn = { title: (await inspect()).title, outlines: await shown() }

    // Grips sit on the rendered element; one real drag stages a draft, never a write.
    const at = (await waitFor(
      () => smoke.evaluate(grip('padding-top'), true),
      'a padding-top grip on the selected heading'
    )) as { grip: Rect; target: Rect }
    const { grip: g, target: t } = at
    assert.ok(
      g.x >= t.x - 0.5 &&
        g.x + g.width <= t.x + t.width + 0.5 &&
        g.y >= t.y - 0.5 &&
        g.y + g.height <= t.y + t.height + 0.5,
      `the grip lies inside the element ${JSON.stringify(at)}`
    )
    evidence.grip = at
    if (!foreground) {
      console.log('SKIP spacing grip pointer drag: TREZI_NATIVE_BACKGROUND_TEST')
      return
    }
    const before = (await inspect()).values?.['style:padding-top']
    const drag = await island({
      previewDrag: true,
      x: g.x + g.width / 2,
      y: g.y + g.height / 2,
      dx: 0,
      dy: 16
    })
    const staged = await waitFor(
      async () => {
        const state = await inspect()
        const value = state.values?.['style:padding-top']
        // Staged as a draft, or refused honestly when the source cannot own the value.
        return ((value && value !== before) || /padding-top/.test(state.error)) && state
      },
      'the released grip reaches the inspector',
      10000,
      async () => ({ drag, before, inspect: await inspect() })
    )
    assert.equal(readFileSync(index, 'utf8'), original, 'a drag writes no source')
    evidence.drag = {
      drag,
      before,
      value: staged.values?.['style:padding-top'],
      error: staged.error
    }
    if (staged.values?.['style:padding-top'] !== before)
      await host.request('inspectorPerform', {
        action: { root: smoke.fixture, generation: staged.generation, action: 'revert-draft' }
      })
    assert.equal(readFileSync(index, 'utf8'), original, 'reverting the draft writes no source')
  } finally {
    await smoke.invoke('preview:set-select-mode', false)
    smoke.cancel()
  }
}
