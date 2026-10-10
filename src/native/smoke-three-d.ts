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

/** Nested fixture for the exploded view: section > div > h2, section > p > b (5 layers). */
const CARD = `(() => {
  document.querySelector('#three-d-card')?.remove();
  const card = document.createElement('section');
  card.id = 'three-d-card';
  card.style.cssText = 'margin:12px;padding:16px;width:320px;background:#f4e3c1;border-radius:12px';
  card.innerHTML = '<div id="three-d-head" style="padding:8px;background:#2f6fde;color:#fff"><h2 id="three-d-heading" style="margin:0;font:600 18px system-ui">Layered card</h2></div><p id="three-d-copy" style="margin:12px 0 0">Nested copy <b id="three-d-bold">bold</b></p>';
  document.body.prepend(card);
  card.scrollIntoView({ block: 'nearest' });
  return true;
})()`
export const removeThreeDCard = `(() => { document.querySelector('#three-d-card')?.remove(); return true })()`

/** The real isolated preview opens the scene; the host renders it natively (LKM-227). */
export async function checkThreeD(host: NativeBridge, artifacts: string, fixture: string) {
  const page = (code: string, isolated = false) =>
    host.request('evaluate', { view: 'preview', code, isolated })
  const inspect = () => host.request('threeDInspect')
  const perform = (action: string, value?: number) =>
    host.request('threeDPerform', value === undefined ? { action } : { action, value })
  const open = async (selector: string) => {
    await preparePreviewInput(host)
    if ((await page('document.documentElement.style.cursor')) !== 'crosshair')
      await host.request('shellPerform', { action: 'select-object' })
    await waitFor(
      () => page(`document.documentElement.style.cursor === 'crosshair'`),
      '3D select mode'
    )
    // Inside the element's own padding, so the element itself is picked.
    const point = await page(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+6,y:r.y+Math.min(6,r.height/2)} })()`
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
    await waitFor(async () => (await inspect()).active, 'exploded view opened from the toolbar')
    return waitFor(async () => {
      const state = await inspect()
      return (
        state.active &&
        state.layers.length &&
        state.capturedRevision === state.revision &&
        state.rendered === state.layers.length &&
        state
      )
    }, 'native exploded scene rendered')
  }
  // Clicks go through native hit testing: a guide left near the toolbar would take them.
  await host.request('previewOverlayTest', { action: 'set', state: {} })
  const viewport = await page('({width:innerWidth,height:innerHeight})')
  await page(CARD)
  const opened = await open('#three-d-card')
  assert.match(opened.headerType, /ThreeDBar/)
  assert.match(opened.footerType, /ThreeDBar/)
  assert.match(opened.sceneType, /ThreeDSceneView/)
  assert.deepEqual([opened.insets.top, opened.insets.bottom], [48, 76])
  // N layers render natively, each a Core Animation plane holding its capture.
  assert.deepEqual(opened.layers, [
    'section#three-d-card',
    'div#three-d-head',
    'h2#three-d-heading',
    'p#three-d-copy',
    'b#three-d-bold'
  ])
  assert.equal(opened.planes, 5)
  assert.equal(opened.rendered, 5, 'every layer renders natively')
  assert.equal(opened.sceneHidden, false)
  assert.equal(opened.message, '', 'no fallback message over a captured scene')
  assert.equal(opened.countLabel, '5 layers')
  assert.match(opened.status, /^5 layers · /)
  // Captured at the backing scale: the card's surface keeps its pixel density.
  assert.ok(
    opened.imageSizes[0][0] >=
      Math.floor(opened.layerWidths[0] * opened.atlasScale * opened.backing * 0.95),
    `Retina capture (${JSON.stringify(opened.imageSizes[0])}, scale ${opened.atlasScale}, backing ${opened.backing})`
  )
  const sceneRect: Rect = opened.sceneRect
  assert.ok(
    sceneRect.y >= opened.headerRect.y + opened.headerRect.height - 0.5 &&
      sceneRect.y + sceneRect.height <= opened.footerRect.y + 0.5,
    'the native scene fills the preview between the bars'
  )
  await waitFor(async () => (await inspect()).focus === 'scene', 'native scene focused on open')
  assert.equal(
    await page(
      `getComputedStyle(document.querySelector('[data-trezi-three-d]').shadowRoot.querySelector('dialog')).backgroundColor`,
      true
    ),
    'rgba(0, 0, 0, 0)',
    'the capture dialog paints nothing between snapshots'
  )
  assert.equal(
    await page(
      `document.querySelector('[data-trezi-three-d]').shadowRoot.querySelectorAll('.scene,.stage').length`,
      true
    ),
    0,
    'no in-page CSS scene'
  )
  const pageInputs = await page('window.previewInputs?.length ?? 0')
  await host.request('previewInput', { key: 'ArrowRight' })
  await page('true', true)
  assert.equal(
    await page('window.previewInputs?.length ?? 0'),
    pageInputs,
    'keys do not leak to the live page'
  )
  assert.deepEqual(
    await page('({width:innerWidth,height:innerHeight})'),
    viewport,
    'live viewport stays unchanged'
  )
  assert.ok(
    await page(`document.querySelector('#three-d-card').isConnected`),
    'live component remains mounted'
  )
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5
  // Front assembles the layers face-on, Reset restores the camera; the slider follows.
  assert.equal(await perform('front'), true)
  const front = await waitFor(async () => {
    const s = await inspect()
    return s.pitch === 0 && s.yaw === 0 && s.separation === 0 && near(s.spacing, 0) && s
  }, 'Front assembles the layers')
  assert.equal(front.sceneSeparation, 0)
  await perform('separation', 82)
  await waitFor(async () => {
    const s = await inspect()
    return s.separation === 82 && near(s.spacing, 82)
  }, 'separation changes the native layer spacing')
  await perform('separation', 20)
  await waitFor(async () => near((await inspect()).spacing, 20), 'spacing follows the slider live')
  await perform('reset')
  await waitFor(async () => {
    const s = await inspect()
    return s.pitch === 48 && s.yaw === -28 && s.separation === 36 && near(s.spacing, 36)
  }, 'Reset restores the camera and spacing')
  // Clicking a layer (the scene's own hit test) selects the element; the inspector follows.
  const leaf = opened.layers.indexOf('b#three-d-bold')
  assert.equal(await perform('hover', leaf), 'b#three-d-bold', 'hover shows the layer label')
  assert.equal((await inspect()).hovered, leaf, 'hover highlights the layer')
  await perform('hover')
  assert.equal(await perform('click', leaf), leaf, 'click hits the front-most layer')
  await waitFor(async () => {
    const s = await inspect()
    return s.selected === leaf && s.sceneSelected === leaf
  }, 'clicked layer is selected in the scene and the picker')
  await waitFor(
    async () => (await host.request('inspectorInspect')).visible,
    'clicking a layer opens the inspector'
  )
  const heading = opened.layers.indexOf('h2#three-d-heading')
  await perform('layer', heading)
  await waitFor(async () => (await inspect()).sceneSelected === heading, 'picker selects a layer')
  if ((await inspect()).code) {
    await perform('code')
    await waitFor(
      async () => (await host.request('sourceInspect')).visible,
      'Code opens source editor'
    )
    // The drawer is the docked editor: dock it when Code popped it out.
    if ((await host.request('sourceInspect')).popped)
      await host.request('sourcePerform', { action: { root: fixture, action: 'dock' } })
    const docked = await waitFor(async () => {
      const editor = await host.request('sourceInspect')
      return editor.visible && !editor.popped && editor.height > 0 && editor
    }, 'Code editor docked under the page')
    const withDrawer = await waitFor(async () => {
      const state = await inspect()
      return state.active && state.dockedSourceRect.height > 0 && state
    }, 'exploded view stays open with the docked editor')
    assert.ok(!withDrawer.headerHidden && !withDrawer.footerHidden, 'native bars stay visible')
    assert.ok(
      withDrawer.footerRect.y + withDrawer.footerRect.height <= withDrawer.dockedSourceRect.y + 0.5,
      `footer ends above the docked editor (${JSON.stringify(withDrawer.footerRect)} vs ${JSON.stringify(withDrawer.dockedSourceRect)})`
    )
    assert.ok(docked.height > 0)
    const capture = await host.request('threeDCapture', { dark: false })
    writeFileSync(join(artifacts, 'three-d-code.png'), Buffer.from(capture.png, 'base64'))
    await host.request('sourcePerform', { action: { root: fixture, action: 'hide' } })
    await waitFor(async () => !(await host.request('sourceInspect')).visible, 'editor hidden again')
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
  const backgrounds: string[] = []
  for (const [name, dark] of [
    ['light', false],
    ['dark', true]
  ] as const) {
    const image = await host.request('threeDCapture', { dark })
    writeFileSync(join(artifacts, `three-d-${name}.png`), Buffer.from(image.png, 'base64'))
    backgrounds.push(image.background)
  }
  assert.notEqual(backgrounds[0], backgrounds[1], 'scene background follows light and dark')
  // Capture failure: a clear native message, never a blank scene; a new capture recovers.
  await host.request('threeDPerform', { action: 'recapture', fail: true })
  const failed = await waitFor(async () => {
    const s = await inspect()
    return s.message.includes("couldn't capture") && s
  }, 'capture failure shows the native fallback message')
  assert.equal(failed.planes, 0, 'no blank planes behind the fallback message')
  const imageFailed = await host.request('threeDCapture', { dark: false })
  writeFileSync(join(artifacts, 'three-d-failed.png'), Buffer.from(imageFailed.png, 'base64'))
  await perform('recapture')
  await waitFor(async () => {
    const s = await inspect()
    return s.message === '' && s.rendered === s.layers.length
  }, 'a later capture replaces the fallback message')
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
  assert.equal((await inspect()).sceneHidden, true, 'native scene hidden after close')
  assert.equal(await page(`document.querySelectorAll('[data-trezi-three-d]').length`, true), 0)
  await page(removeThreeDCard)

  // A single element: one layer, singular label.
  const second = await open('#native-title')
  assert.notEqual(second.session, opened.session, 'reopening creates a new session')
  assert.equal(second.countLabel, '1 layer')
  assert.match(second.status, /^1 layer · /)
  assert.equal(await page(`document.querySelectorAll('[data-trezi-three-d]').length`, true), 1)
  host.send('deliver', {
    view: 'preview',
    message: {
      type: 'event',
      channel: PREVIEW_THREE_D_ACTION,
      args: [{ session: second.session, revision: second.revision + 5, action: 'layer', value: 0 }]
    }
  })
  await page('true', true)
  await waitFor(async () => {
    const s = await inspect()
    return s.selected === second.selected && s.sceneSelected === second.selected
  }, 'stale-revision layer action is rejected and the scene matches the picker')
  await perform('close')
  await waitFor(async () => !(await inspect()).active, 'Back closes native chrome')
  assert.equal(await page(`document.querySelectorAll('[data-trezi-three-d]').length`, true), 0)

  const samePage = await open('#native-title')
  assert.notEqual(samePage.session, second.session, 'reopening creates a new session')
  await page(`(() => { history.pushState({}, '', '#x'); return true })()`)
  await waitFor(
    async () => !(await inspect()).active,
    'same-document URL change clears native chrome'
  )
  await waitFor(
    async () =>
      (await page(`document.querySelectorAll('[data-trezi-three-d]').length`, true)) === 0,
    'same-document URL change closes the modal scene'
  )

  const third = await open('#native-title')
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
  const removed = await waitFor(async () => {
    const s = await inspect()
    return s.status.includes('removed') && s.message.includes('removed') && s
  }, 'removed target invalidates the scene with a native message')
  assert.equal(removed.planes, 0)
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
  assert.ok(cleared.headerHidden && cleared.footerHidden && cleared.sceneHidden)
  await waitFor(() => page(`!!document.querySelector('#native-title')`), 'fixture after navigation')
  assert.deepEqual(await page('({width:innerWidth,height:innerHeight})'), viewport)
}
