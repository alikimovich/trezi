import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentPreviewOverlay } from '../main/preview-overlay'
import { PREVIEW_OVERLAY_PREFERENCE } from '../shared/preview-overlay'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = any
const near = (actual: number, expected: number, label: string, tolerance = 0.5) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} ≠ ${expected}`)
// The project's own DOM, without the preview instrumentation's hosts.
const DOM = `(() => {
  const skip = '[data-trezi-overlay],[data-trezi-cover],[data-trezi-viewport-size],[data-trezi-frame],[data-trezi-frame-style],[data-trezi-status],[data-trezi-composer],[data-trezi-toolbar],[data-trezi-drop-line]'
  const clone = document.documentElement.cloneNode(true)
  for (const el of clone.querySelectorAll(skip)) el.remove()
  return clone.outerHTML + '|' + document.styleSheets.length
})()`

/** LKM-205: rulers, guides and layout grids. Shortcuts and toolbar, a guide created by
 *  dragging from each ruler (one snapping to an element edge), moved and removed, columns
 *  at two viewport widths, settings kept per project and per viewport, the agent's
 *  read-only view, an unchanged DOM and no page input, and light and dark captures. */
export async function checkPreviewOverlay(
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  preference: (key: string) => string | null
) {
  const inspect = (): Promise<State> => host.request('previewOverlayInspect')
  const test = (params: Record<string, unknown>): Promise<State> =>
    host.request('previewOverlayTest', params)
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  const until = (check: (s: State) => boolean, label: string, timeout = 10000) =>
    waitFor(
      async () => {
        const state = await inspect()
        return check(state) && state
      },
      label,
      timeout
    )
  const first = nativeWorkspace.active!
  const key = (root: string, viewport: string) => JSON.stringify([root, viewport])
  const evidence: Record<string, unknown> = {}
  await until((s) => s.key === key(first.root, 'desktop'), 'overlay settings for the project')
  await test({ action: 'set', state: {} })
  const dom = await page(DOM)
  const inputs = await page('window.previewInputs.length')

  // ⇧⌘R and ⌃G through the View menu.
  const rulers = await test({ action: 'key', key: 'rulers' })
  assert.deepEqual(
    [rulers.handled, rulers.after.rulers],
    [true, true],
    'Shift-Command-R shows the rulers'
  )
  const shown = await until(
    (s) => !s.rulersHidden && s.page.width > 0 && s.frame.x >= s.left.x + s.left.width - 0.5,
    'rulers beside the page'
  )
  near(shown.top.height, 16, 'ruler thickness')
  const menu = shown.menu
  assert.deepEqual(
    [menu['Show Rulers'].state, menu['Show Rulers'].key, menu['Show Rulers'].modifiers],
    [true, 'R', 1179648]
  )
  assert.deepEqual(
    [menu['Show Layout Grid'].key, menu['Show Layout Grid'].modifiers],
    ['g', 262144]
  )

  // A horizontal guide from the top ruler, a vertical one from the left ruler that snaps
  // to the heading's left edge, then moved and dragged back onto its ruler.
  const fromTop = await test({ action: 'drag', from: 'top', to: { x: 200, y: 140 } })
  assert.equal(fromTop.owner, 'top')
  assert.equal(fromTop.state.guides.length, 1)
  assert.equal(fromTop.state.guides[0].axis, 'y')
  near(fromTop.state.guides[0].position, 140, 'horizontal guide', 5)
  const h1 = JSON.parse(
    await page('JSON.stringify(document.querySelector("#native-title").getBoundingClientRect())')
  )
  const snapped = await test({
    action: 'drag',
    from: 'left',
    to: { x: h1.left + 3, y: h1.top + h1.height / 2 }
  })
  const vertical = snapped.state.guides.find((g: State) => g.axis === 'x')
  assert.equal(snapped.owner, 'left')
  assert.ok(snapped.drag.snapped, 'The guide snaps to the element edge')
  near(vertical.position, h1.left, 'snapped to the heading edge', 0.01)
  const moved = await test({ action: 'drag', from: vertical.id, to: { x: h1.left + 120, y: 300 } })
  assert.equal(moved.owner, 'guide')
  const after = moved.state.guides.find((g: State) => g.id === vertical.id)
  near(after.position, h1.left + 120, 'moved guide', 5)
  const removed = await test({
    action: 'drag',
    from: vertical.id,
    to: { x: 300, y: 300 },
    remove: true
  })
  assert.deepEqual(
    removed.state.guides.map((g: State) => g.axis),
    ['y'],
    'Dropping on the ruler removes the guide'
  )
  assert.equal(
    await page('window.previewInputs.length'),
    inputs,
    'Guide drags reach no page listener'
  )
  evidence.guides = { fromTop: fromTop.drag, snapped: snapped.drag, h1, moved: after }

  // ⌃G with the desktop preset, then a stretched four-column grid at two viewport widths.
  const grid = await test({ action: 'key', key: 'grid' })
  assert.deepEqual(
    [grid.handled, grid.after.gridVisible, grid.after.grids.length],
    [true, true, 1],
    'Control-G shows the preset grid'
  )
  const columns = {
    kind: 'columns',
    count: 4,
    gutter: 16,
    margin: 16,
    align: 'stretch',
    color: '#007aff',
    opacity: 0.1
  }
  await test({ action: 'set', state: { ...grid.after, grids: [columns] } })
  const widths: State[] = []
  for (const width of [600, 900]) {
    await host.request('previewViewport', { width })
    const s = await until(
      (v) => Math.abs(v.page.width - width) <= 20 && v.columns.length === 1,
      `viewport ${width}`
    )
    const [column] = s.columns[0]
    assert.equal(s.columns[0].length, 4)
    near(column.start, 16, `first column at ${width}`, 0.01)
    near(column.width, (s.viewportWidth - 32 - 48) / 4, `column width at ${width}`, 0.01)
    near(column.viewX, 16 * s.scale, `column on screen at ${width}`)
    widths.push({ width, viewport: s.viewportWidth, scale: s.scale, column })
  }
  assert.ok(widths[1].column.width > widths[0].column.width, 'Columns follow the viewport width')
  await host.request('previewViewport', {})
  evidence.columns = widths
  assert.equal(await page(DOM), dom, 'Rulers, guides and grids leave the DOM unchanged')

  // Remembered per project (rulers) and per viewport (guides and grids).
  const stored = () => JSON.parse(preference(PREVIEW_OVERLAY_PREFERENCE) ?? '{}')[first.root]
  await waitFor(
    () => stored()?.rulers && stored()?.viewports?.desktop?.grids?.length === 1,
    'overlay settings saved'
  )
  await host.request('shellPerform', { action: 'device' })
  const mobile = await until((s) => s.key === key(first.root, 'mobile'), 'mobile overlay settings')
  assert.ok(mobile.state.rulers && !mobile.state.guides.length && !mobile.state.grids.length)
  await test({
    action: 'set',
    state: { ...mobile.state, guides: [{ id: 'm1', axis: 'x', position: 20 }] }
  })
  await waitFor(() => stored()?.viewports?.mobile?.guides?.length === 1, 'mobile guide saved')
  await host.request('shellPerform', { action: 'device' })
  const desktop = await until((s) => s.key === key(first.root, 'desktop'), 'desktop restored')
  assert.deepEqual(
    desktop.state.guides.map((g: State) => g.axis),
    ['y']
  )
  assert.equal(desktop.state.grids.length, 1)
  const secondRoot = join(fixture, '../Folder Beta')
  mkdirSync(secondRoot, { recursive: true })
  if (!existsSync(join(secondRoot, 'index.html')))
    writeFileSync(join(secondRoot, 'index.html'), '<h1 id="second-project">Second project</h1>')
  await nativeWorkspace.command({ type: 'open', root: secondRoot })
  const second = nativeWorkspace.active!
  const other = await until((s) => s.key === key(second.root, 'desktop'), 'second project', 20000)
  assert.ok(!other.state.rulers && !other.state.guides.length, 'Another project starts clean')
  assert.equal(
    await host.request('shellPerform', { action: 'select-row', row: `project:${first.key}` }),
    true
  )
  const back = await until(
    (s) => s.key === key(first.root, 'desktop'),
    'first project again',
    20000
  )
  assert.ok(back.state.rulers && back.state.guides.length === 1, 'The project keeps its guides')
  await nativeWorkspace.command({ type: 'close', key: second.key })

  // The agent reads them, read-only.
  const agent = agentPreviewOverlay(first.root)
  assert.ok(agent?.readOnly === true && agent.rulers === true && agent.viewport === 'desktop')

  // The toolbar button opens the settings popover.
  const clicked = await host.request('shellPerform', { action: 'overlay' })
  await until((s) => s.panelShown, 'overlay popover').catch(async (error) => {
    const { panelNote } = await inspect()
    throw new Error(`${error.message} (click ${JSON.stringify(clicked)}, ${panelNote})`)
  })
  await host.request('shellPerform', { action: 'overlay' })
  await until((s) => !s.panelShown, 'overlay popover closed')

  if (process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1') {
    for (const dark of [false, true]) {
      const image = await test({ action: 'capture', dark })
      assert.ok(image.width > 0 && image.dark === dark)
      writeFileSync(
        join(artifacts, `preview-overlay-${dark ? 'dark' : 'light'}.png`),
        Buffer.from(image.png, 'base64')
      )
    }
  } else evidence.captures = 'skipped: background test'
  evidence.final = await inspect()
  writeFileSync(join(artifacts, 'preview-overlay.json'), JSON.stringify(evidence, null, 2))
}

/** Leaves the project without rulers, guides or grids at its own viewport width. */
export async function restorePreviewOverlay(host: NativeBridge) {
  await host.request('previewViewport', {}).catch(() => {})
  if (nativeWorkspace.active?.viewport === 'mobile')
    await host.request('shellPerform', { action: 'device' })
  await host.request('previewOverlayTest', { action: 'set', state: {} }).catch(() => {})
}
