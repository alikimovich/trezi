import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Rect = { x: number; y: number; width: number; height: number }
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Island = any
const near = (a: number, b: number, label: string) =>
  assert.ok(Math.abs(a - b) < 0.5, `${label}: ${a} vs ${b}`)
const sameRect = (a: Rect, b: Rect, label: string) => {
  for (const key of ['x', 'y', 'width', 'height'] as const) near(a[key], b[key], `${label} ${key}`)
}

/** The open island floats inside the preview area, below the toolbar, and only its own frame takes the pointer. */
function checkOpen(state: Island, label: string) {
  const { island, area, inset } = state
  assert.ok(
    state.visible && island.width > 0 && island.height > 0,
    `${label}: island visible ${JSON.stringify(island)}`
  )
  near(state.cornerRadius, 24, `${label} corner radius`)
  near(inset, 10, `${label} inset`)
  near(island.x + island.width, area.x + area.width - inset, `${label} right inset`)
  near(island.y, area.y + inset, `${label} top inset`)
  near(island.y + island.height, area.y + area.height - inset, `${label} bottom inset`)
  assert.ok(
    island.x >= area.x + inset - 0.5,
    `${label}: the island stays over the preview ${JSON.stringify({ island, area })}`
  )
  near(island.width, Math.min(state.inspectorWidth, area.width - 2 * inset), `${label} width`)
  assert.ok(
    state.toolbarGap >= inset - 0.5,
    `${label}: the island clears the toolbar and address bar (${state.toolbarGap})`
  )
  assert.equal(state.hits.inside, 'inspector', `${label}: inside the island`)
  assert.equal(state.hits.above, 'preview', `${label}: above the island reaches the preview`)
  if (state.hits.left)
    assert.equal(state.hits.left, 'preview', `${label}: left of the island reaches the preview`)
  assert.equal(state.hits.edge, 'divider', `${label}: the left edge resizes`)
}

/** The preview page, its selection's source file and select mode, for the pointer check. */
export type IslandPage = {
  evaluate: (code: string, isolated?: boolean) => Promise<unknown>
  source: () => string
  /** The selected element's computed value of one style property (`styles:read`). */
  styles: (prop: string) => Promise<unknown>
  /** Selects the fixture heading in the page, as a click on it would. */
  select: () => Promise<void>
  selectMode: (on: boolean) => Promise<unknown>
}

/** LKM-162: the island's fields, slider and tabs are the window's hit views; padding-top
 *  typed into its real field edits the element; and in select mode a click and a wheel
 *  inside it never pick. LKM-173: a move over the page hovers, over the island it does
 *  not, and back on the page it hovers again. */
async function checkPointer(
  island: (params?: Record<string, unknown>) => Promise<Island>,
  page: IslandPage,
  evidence: Record<string, unknown>
) {
  // The page's selection did not survive the island's open/close and resize cycles above
  // (styles:read had no element), so a Styles edit had nothing to preview on: select again.
  evidence.pointerSelectionBefore = await page.styles('padding-top')
  await page.select()
  await waitFor(
    async () => ((await page.styles('padding-top')) as { values?: unknown } | null)?.values,
    'the heading selected in the page'
  )
  // A new selection rebuilds the island's fields as its reads arrive; type only once they settle.
  let last = ''
  let steady = 0
  const targets = await waitFor(async () => {
    const state = await island({ pointer: true })
    if (state.tab !== 'styles' || !state.controls?.field?.found) return false
    const key = `${state.generation}:${state.fields}`
    steady = key === last ? steady + 1 : 0
    last = key
    if (steady < 3) await delay(250)
    return steady >= 3 && state
  }, 'Styles tab with the padding-top field')
  evidence.pointerTargets = targets
  for (const name of ['field', 'slider', 'tabs']) {
    const control = targets.controls[name]
    assert.ok(control.found, `pointer: the island has its ${name}`)
    assert.ok(
      control.insideIsland && control.target === 'inspector' && control.control,
      `pointer: the ${name}'s center hits the ${name} inside the island ${JSON.stringify(control)}`
    )
  }
  // Before select mode: turning it off drops the page's selection, which a Styles edit previews on.
  const edit = await island({ pointer: true, step: 'edit', value: '12' })
  evidence.pointerEdit = edit
  assert.ok(edit.focused, `pointer: a click focuses padding-top ${JSON.stringify(edit)}`)
  await waitFor(
    () => /padding(Top|-top)["']?\s*:\s*["']?12/.test(page.source()),
    'padding-top 12 in the source',
    10000,
    async () => ({
      island: await island({ pointer: true }),
      selection: await page.styles('padding-top')
    })
  )
  const paddingTop = () =>
    page.evaluate(`getComputedStyle(document.querySelector('#native-title')).paddingTop`)
  await waitFor(
    async () => (await paddingTop()) === '12px',
    'padding-top 12px on the element',
    10000,
    async () => ({
      computed: await paddingTop(),
      inline: await page.evaluate(`document.querySelector('#native-title').getAttribute('style')`),
      selection: await page.styles('padding-top'),
      island: await island({ pointer: true })
    })
  )
  const heading = (await page.evaluate(`(() => {
    const r = document.querySelector('#native-title').getBoundingClientRect();
    return {x:r.x + Math.min(20, r.width / 2), y:r.y + r.height / 2};
  })()`)) as { x: number; y: number }
  const move = (target: 'page' | 'island', offset = 0, click = false) =>
    island({
      pointer: true,
      step: 'move',
      target,
      x: heading.x + offset,
      y: heading.y,
      click
    })
  const hoverBox = () =>
    page.evaluate(
      `(() => { const box = document.querySelector('[data-trezi-overlay]')?.shadowRoot?.querySelector('[data-trezi-hover]'); return !!box && box.style.display === 'block'; })()`,
      true
    )
  await page.selectMode(true)
  try {
    const before = await move('page')
    await waitFor(hoverBox, 'select-mode hover over the page')
    const over = await move('island')
    await waitFor(async () => !(await hoverBox()), 'select-mode hover cleared over the island')
    // A real return gesture lands at a new coordinate; reusing the exact point can
    // be coalesced by WebKit when the island move was handled by AppKit.
    const after = await move('page', 4)
    await waitFor(hoverBox, 'select-mode hover restored over the page', 10000, async () => ({
      move: after,
      page: await page.evaluate(`(() => {
        const r = document.querySelector('#native-title').getBoundingClientRect();
        return { heading: {x:r.x,y:r.y,width:r.width,height:r.height},
          hit: document.elementFromPoint(${heading.x + 4}, ${heading.y})?.tagName,
          scrollY: window.scrollY };
      })()`)
    }))
    const cover = (await page.evaluate(
      `([...document.querySelector('[data-trezi-cover]')?.shadowRoot?.children ?? []].map(e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }))`,
      true
    )) as Rect[]
    const shield = cover[0]
    const expected = before.expectedCover[0]
    assert.ok(
      shield &&
        expected &&
        (['x', 'y', 'width', 'height'] as const).every(
          (key) => Math.abs(shield[key] - expected[key]) <= 1
        ),
      `pointer: the page shields the island's rect ${JSON.stringify({ cover, expected })}`
    )
    assert.equal(
      await page.evaluate(
        `document.elementFromPoint(${expected.x + expected.width / 2}, ${expected.y + expected.height / 2})?.closest('[data-trezi-cover]') !== null`
      ),
      true,
      'pointer: the browser hit target over the island is the cover shield'
    )
    const scrollBefore = await page.evaluate('window.scrollY')
    await move('island', 0, true)
    await delay(400)
    const afterClick = await move('island')
    assert.equal(
      afterClick.picksTotal,
      before.picksTotal,
      'pointer: no element-picked message from the island click'
    )
    assert.equal(
      await page.evaluate('window.scrollY'),
      scrollBefore,
      'pointer: island wheel does not scroll the page'
    )
    evidence.pointerMoves = { before, over, after, afterClick, cover }
  } finally {
    await page.selectMode(false)
  }
  // Interact mode uses the page's own hover machinery, including CSS and mouseenter.
  const cover = (await move('island')).expectedCover[0] as Rect
  assert.ok(cover, 'pointer: native island has a covered preview rect')
  await page.evaluate(`(() => {
    const style = document.createElement('style');
    style.textContent = '#native-title:hover, #island-hover-probe:hover { background-color: rgb(12, 34, 56) !important; cursor: pointer !important; }';
    document.head.append(style);
    const probe = document.createElement('div');
    probe.id = 'island-hover-probe';
    probe.style.cssText = 'position:fixed;left:${cover.x + cover.width / 2 - 20}px;top:${cover.y + cover.height / 2 - 20}px;width:40px;height:40px;background-color:rgb(255, 255, 255);z-index:2147483646';
    document.body.append(probe);
    window.__treziHoverEnter = { page: 0, island: 0 };
    document.querySelector('#native-title').addEventListener('mouseenter', () => window.__treziHoverEnter.page++);
    probe.addEventListener('mouseenter', () => window.__treziHoverEnter.island++);
  })()`)
  const interact = () =>
    page.evaluate(`(() => {
    const title = document.querySelector('#native-title');
    const probe = document.querySelector('#island-hover-probe');
    return { page: getComputedStyle(title).backgroundColor,
      island: getComputedStyle(probe).backgroundColor,
      cursor: getComputedStyle(title).cursor,
      enters: window.__treziHoverEnter };
  })()`)
  await move('page')
  await waitFor(async () => {
    const state = (await interact()) as Island
    return state.page === 'rgb(12, 34, 56)' && state.enters.page > 0 && state.cursor === 'pointer'
  }, 'interact-mode CSS hover, cursor and mouseenter over the page')
  const pageHover = await interact()
  await move('island')
  await waitFor(async () => {
    const state = (await interact()) as Island
    return state.page !== 'rgb(12, 34, 56)' && state.island !== 'rgb(12, 34, 56)'
  }, 'interact-mode hover cleared over the island')
  const islandHover = (await interact()) as Island
  assert.equal(
    islandHover.enters.island,
    0,
    'pointer: mouseenter does not reach the page under the island'
  )
  evidence.interactHover = { pageHover, islandHover }
  await page.evaluate(`document.querySelector('#island-hover-probe')?.remove()`)
}

/** LKM-122: the inspector floats over the preview's right edge; the preview keeps its
 *  width open and closed, at the default and minimum window sizes. */
export async function checkInspectorIsland(
  host: NativeBridge,
  artifacts: string,
  toggle: () => void,
  saved: () => string | null,
  page: IslandPage
) {
  const island = (params: Record<string, unknown> = {}): Promise<Island> =>
    host.request('inspectorIsland', params)
  const foreground = process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1'
  const evidence: Record<string, unknown> = {}
  const capture = async (stem: string, state: Island) => {
    evidence[stem] = state
    if (!foreground) {
      console.log(
        `SKIP foreground ${stem} capture: TREZI_NATIVE_BACKGROUND_TEST (offscreen capture saved instead)`
      )
      writeFileSync(
        join(artifacts, `${stem}.png`),
        Buffer.from(await host.request('captureShell'), 'base64')
      )
      return
    }
    await island({ prepare: true })
    await delay(350)
    const image = await island({ capture: true })
    writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(image.png, 'base64'))
  }
  const setOpen = async (open: boolean) => {
    if ((await island()).visible !== open) toggle()
    await waitFor(
      async () => (await island()).visible === open,
      `inspector ${open ? 'open' : 'closed'}`
    )
    await delay(150)
  }
  const initial = await island()
  const restore = { windowWidth: initial.window.width, windowHeight: initial.window.height }
  try {
    for (const [name, size] of [
      ['default', restore],
      ['narrow', { windowWidth: initial.minWindow.width, windowHeight: initial.minWindow.height }]
    ] as const) {
      await island(size)
      await setOpen(true)
      const open = await island()
      evidence[`${name}-open-state`] = open
      checkOpen(open, name)
      if (name === 'default') {
        // Posted pointer events and the field editor need the key, frontmost window.
        if (foreground) await checkPointer(island, page, evidence)
        else console.log('SKIP inspector island pointer ownership: TREZI_NATIVE_BACKGROUND_TEST')
      }
      await capture(`inspector-island-${name}-open`, open)
      await setOpen(false)
      const closed = await island()
      assert.deepEqual(closed.island, { x: 0, y: 0, width: 0, height: 0 })
      assert.deepEqual(closed.hits, {})
      sameRect(
        open.preview,
        closed.preview,
        `${name}: the preview frame is the same open and closed`
      )
      await capture(`inspector-island-${name}-closed`, closed)
      await setOpen(true)
      if (name === 'default') {
        // Drag the left edge both ways past the limits: the width clamps to 220…500 and is saved.
        const start = open.inspectorWidth
        for (const [delta, expected] of [
          [-1000, 500],
          [1000, 220],
          [220 - start, start]
        ]) {
          const dragged = await island({ drag: delta })
          near(dragged.inspectorWidth, expected, `drag ${delta}`)
          checkOpen(dragged, `drag ${delta}`)
          sameRect(dragged.preview, open.preview, `drag ${delta}: the preview does not change`)
          await waitFor(() => {
            try {
              return JSON.parse(saved() ?? '{}').inspector === expected
            } catch {
              return false
            }
          }, `inspector width ${expected} saved`)
          evidence[`drag ${delta}`] = {
            inspectorWidth: dragged.inspectorWidth,
            island: dragged.island,
            preview: dragged.preview
          }
        }
      } else {
        // Minimum window: the island's height fits the preview area and its fields scroll inside it.
        const small = await island({ scroll: true })
        const { scroll } = small
        assert.ok(scroll, 'The island has its own scroll view')
        assert.ok(
          scroll.frame.y >= small.island.y &&
            scroll.frame.y + scroll.frame.height <= small.island.y + small.island.height + 0.5,
          `The scroll view sits inside the island: ${JSON.stringify({ scroll, island: small.island })}`
        )
        assert.ok(
          scroll.document > scroll.visible && scroll.scrolled > 0,
          `The fields scroll at the minimum window size: ${JSON.stringify(scroll)}`
        )
        evidence.minimumScroll = scroll
        // At its minimum width the island leaves the preview's left side exposed and pointable.
        const start = small.inspectorWidth
        const narrowest = await island({ drag: 1000 })
        evidence.minimumNarrowest = narrowest
        near(narrowest.inspectorWidth, 220, 'narrow drag')
        checkOpen(narrowest, 'narrow drag')
        sameRect(narrowest.preview, open.preview, 'narrow drag: the preview does not change')
        assert.equal(
          narrowest.hits.left,
          'preview',
          'narrow drag: left of the island reaches the preview'
        )
        near((await island({ drag: 220 - start })).inspectorWidth, start, 'narrow drag back')
      }
    }
    await setOpen(false)
  } finally {
    await island(restore)
    await setOpen(initial.visible)
    writeFileSync(join(artifacts, 'inspector-island.json'), JSON.stringify(evidence, null, 2))
  }
  console.log(
    `Native inspector island: preview width unchanged open/closed at default and minimum widths, 220–500 saved resize, toolbar clearance, pointer targets${foreground ? ', pointer ownership, padding-top edit' : ''} and scrolling pass.`
  )
}
