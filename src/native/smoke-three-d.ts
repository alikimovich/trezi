import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PREVIEW_THREE_D_ACTION } from '../shared/preview-channels'
import type { NativeBridge } from './bridge'
import { preparePreviewInput } from './smoke-input'
import { waitFor } from './smoke-wait'

type Rect = { x: number; y: number; width: number; height: number }
const intersects = (a: Rect, b: Rect) =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)

/** The real isolated preview opens the scene; actions go through native Swift. */
export async function checkThreeD(host: NativeBridge, artifacts: string) {
  const page = (code: string, isolated = false) =>
    host.request('evaluate', { view: 'preview', code, isolated })
  const inspect = () => host.request('threeDInspect')
  const open = async () => {
    await preparePreviewInput(host)
    if ((await page('document.documentElement.style.cursor')) !== 'crosshair')
      await host.request('shellPerform', { action: 'select-object' })
    await waitFor(
      () => page(`document.documentElement.style.cursor === 'crosshair'`),
      '3D select mode'
    )
    const point = await page(
      `(() => { const r = document.querySelector('#native-title').getBoundingClientRect(); return {x:r.x+20,y:r.y+r.height/2} })()`
    )
    await host.request('previewInput', point)
    const button = await waitFor(
      () =>
        page(
          `(() => {
      const b = document.querySelector('[data-trezi-overlay]')?.shadowRoot?.querySelector('[data-kind="three-d"]');
      if (!b || b.offsetParent === null) return null;
      const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`,
          true
        ),
      '3D toolbar button'
    )
    await host.request('previewInput', button)
    return waitFor(async () => {
      const state = await inspect()
      return state.active && state.layers.length && state
    }, 'native exploded chrome')
  }
  const viewport = await page('({width:innerWidth,height:innerHeight})')
  const opened = await open()
  assert.match(opened.headerType, /ThreeDBar/)
  assert.match(opened.footerType, /ThreeDBar/)
  assert.deepEqual([opened.insets.top, opened.insets.bottom], [48, 76])
  await waitFor(
    () =>
      page(
        `!!document.querySelector('[data-trezi-three-d]')?.shadowRoot?.activeElement?.classList.contains('stage')`,
        true
      ),
    '3D stage focused after the first appearance'
  )
  const transform = () =>
    page(
      `document.querySelector('[data-trezi-three-d]')?.shadowRoot?.querySelector('.scene')?.style.transform`,
      true
    )
  const beforeCamera = await transform()
  const pageInputs = await page('window.previewInputs?.length ?? 0')
  await host.request('previewInput', { key: 'ArrowRight' })
  await waitFor(async () => (await transform()) !== beforeCamera, 'arrow key rotates the 3D camera')
  const afterArrow = await transform()
  await host.request('previewInput', { key: '+' })
  await waitFor(async () => (await transform()) !== afterArrow, 'plus key zooms the 3D camera')
  assert.equal(
    await page('window.previewInputs?.length ?? 0'),
    pageInputs,
    'camera keys do not leak to the live page'
  )
  assert.deepEqual(
    await page('({width:innerWidth,height:innerHeight})'),
    viewport,
    'live viewport stays unchanged'
  )
  assert.ok(
    await page(`document.querySelector('#native-title').isConnected`),
    'live component remains mounted'
  )
  assert.equal(await host.request('threeDPerform', { action: 'front' }), true)
  await waitFor(async () => (await inspect()).separation === 0, 'Front syncs the slider')
  assert.match(await transform(), /rotateX\(0deg\) rotateY\(0deg\)/)
  await host.request('threeDPerform', { action: 'separation', value: 82 })
  await waitFor(async () => (await inspect()).separation === 82, 'native slider syncs the scene')
  await host.request('threeDPerform', { action: 'reset' })
  await waitFor(async () => (await inspect()).separation === 36, 'Reset syncs the slider')
  const selectedLayer = opened.layers.length > 1 ? 1 : 0
  await host.request('threeDPerform', { action: 'layer', value: selectedLayer })
  await waitFor(
    async () => (await inspect()).selected === selectedLayer,
    'native picker selects a layer'
  )
  await waitFor(
    async () => (await host.request('inspectorInspect')).visible,
    'picker opens the inspector'
  )
  if ((await inspect()).code) {
    await host.request('threeDPerform', { action: 'code' })
    await waitFor(
      async () => (await host.request('sourceInspect')).visible,
      'Code opens source drawer'
    )
    const capture = await host.request('threeDCapture', { dark: false })
    writeFileSync(join(artifacts, 'three-d-code.png'), Buffer.from(capture.png, 'base64'))
  }
  const withPanels = await inspect()
  for (const [hidden, frame] of [
    [withPanels.inspectorHidden, withPanels.inspectorRect],
    [withPanels.layersHidden, withPanels.layersRect]
  ] as const) {
    if (hidden) continue
    assert.ok(!intersects(withPanels.headerRect, frame), 'native header clears the panel')
    assert.ok(!intersects(withPanels.footerRect, frame), 'native footer clears the panel')
    assert.ok(withPanels.insets.left > 0 || withPanels.insets.right > 0, 'camera clears the panel')
  }
  const live = await inspect()
  host.send('deliver', {
    view: 'preview',
    message: {
      type: 'event',
      channel: PREVIEW_THREE_D_ACTION,
      args: [{ session: live.session, revision: live.revision - 1, action: 'layer', value: 0 }]
    }
  })
  await page('true', true)
  assert.equal((await inspect()).selected, live.selected, 'stale layer index is rejected')
  host.send('deliver', {
    view: 'preview',
    message: {
      type: 'event',
      channel: PREVIEW_THREE_D_ACTION,
      args: [
        { session: live.session, revision: live.revision - 1, action: 'separation', value: 41 }
      ]
    }
  })
  await waitFor(async () => (await inspect()).separation === 41, 'slider action survives a refresh')
  for (const [action, expected] of [
    ['front', 0],
    ['reset', 36]
  ] as const) {
    host.send('deliver', {
      view: 'preview',
      message: {
        type: 'event',
        channel: PREVIEW_THREE_D_ACTION,
        args: [{ session: live.session, revision: live.revision - 1, action }]
      }
    })
    await waitFor(
      async () => (await inspect()).separation === expected,
      `${action} survives a refresh`
    )
  }
  for (const [name, dark] of [
    ['light', false],
    ['dark', true]
  ] as const) {
    const image = await host.request('threeDCapture', { dark })
    writeFileSync(join(artifacts, `three-d-${name}.png`), Buffer.from(image.png, 'base64'))
  }
  const original = (await host.request('inspectorIsland')).window
  try {
    await host.request('inspectorIsland', { windowWidth: 850, windowHeight: 650 })
    const narrow = await inspect()
    assert.ok(
      narrow.active && narrow.compact && !narrow.headerHidden && !narrow.footerHidden,
      'native controls remain at narrow width'
    )
    const image = await host.request('threeDCapture', { dark: false })
    writeFileSync(join(artifacts, 'three-d-narrow.png'), Buffer.from(image.png, 'base64'))
  } finally {
    await host.request('inspectorIsland', {
      windowWidth: original.width,
      windowHeight: original.height
    })
  }
  assert.equal(await host.request('threeDFocus', { target: 'chat' }), true)
  assert.equal(await host.request('threeDEscape'), false, 'Escape remains with the composer')
  assert.equal((await inspect()).active, true, 'Escape in the composer leaves the scene open')
  assert.equal(await host.request('threeDFocus', { target: 'chrome' }), true)
  assert.equal(await host.request('threeDEscape'), true, 'Escape is handled from chrome focus')
  await waitFor(async () => !(await inspect()).active, 'Escape with native chrome focus closes')
  assert.equal((await inspect()).focus, 'preview', 'native focus returns to WebKit')
  assert.equal(await page(`document.querySelectorAll('[data-trezi-three-d]').length`, true), 0)

  const second = await open()
  assert.notEqual(second.session, opened.session, 'reopening creates a new session')
  assert.equal(await page(`document.querySelectorAll('[data-trezi-three-d]').length`, true), 1)
  await host.request('threeDPerform', { action: 'close' })
  await waitFor(async () => !(await inspect()).active, 'Back closes native chrome')
  assert.equal(await page(`document.querySelectorAll('[data-trezi-three-d]').length`, true), 0)

  const third = await open()
  await page(`(() => {
    const original = document.querySelector('#native-title');
    original.replaceWith(original.cloneNode(true));
    return true;
  })()`)
  await waitFor(async () => {
    const state = await inspect()
    return state.revision > third.revision && !state.status.includes('removed')
  }, 'unique HMR replacement recovers the selected layer')
  const beforeRemoval = await inspect()
  await page(`(() => { document.querySelector('#native-title').remove(); return true })()`)
  await waitFor(
    async () => (await inspect()).status.includes('removed'),
    'removed target invalidates the scene'
  )
  host.send('deliver', {
    view: 'preview',
    message: {
      type: 'event',
      channel: PREVIEW_THREE_D_ACTION,
      args: [
        {
          session: beforeRemoval.session,
          revision: beforeRemoval.revision,
          action: 'layer',
          value: 0
        }
      ]
    }
  })
  await page('true', true)
  assert.equal((await inspect()).selected, -1, 'old layer cannot select a removed node')
  await host.request('reload', { view: 'preview' })
  await waitFor(async () => !(await inspect()).active, 'navigation clears native chrome')
  const cleared = await inspect()
  assert.ok(cleared.headerHidden && cleared.footerHidden)
  await waitFor(() => page(`!!document.querySelector('#native-title')`), 'fixture after navigation')
  assert.deepEqual(await page('({width:innerWidth,height:innerHeight})'), viewport)
}
