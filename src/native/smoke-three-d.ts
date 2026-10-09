import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PREVIEW_THREE_D_ACTION } from '../shared/preview-channels'
import type { NativeBridge } from './bridge'
import { preparePreviewInput } from './smoke-input'
import { waitFor } from './smoke-wait'

/** The real isolated preview opens the scene; actions go through native Swift. */
export async function checkThreeD(host: NativeBridge, artifacts: string) {
  const page = (code: string, isolated = false) =>
    host.request('evaluate', { view: 'preview', code, isolated })
  const inspect = () => host.request('threeDInspect')
  await preparePreviewInput(host)
  if ((await page('document.documentElement.style.cursor')) !== 'crosshair')
    await host.request('shellPerform', { action: 'select-object' })
  await waitFor(
    () => page(`document.documentElement.style.cursor === 'crosshair'`),
    '3D select mode'
  )
  const viewport = await page('({width:innerWidth,height:innerHeight})')
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
  const opened = await waitFor(async () => {
    const state = await inspect()
    return state.active && state.layers.length && state
  }, 'native exploded chrome')
  assert.match(opened.headerType, /ThreeDBar/)
  assert.match(opened.footerType, /ThreeDBar/)
  assert.ok(opened.header.includes('48') && opened.footer.includes('76'))
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
  await host.request('threeDPerform', { action: 'separation', value: 82 })
  await waitFor(async () => (await inspect()).separation === 82, 'native slider syncs the scene')
  await host.request('threeDPerform', { action: 'reset' })
  await waitFor(async () => (await inspect()).separation === 36, 'Reset syncs the slider')
  if (opened.layers.length > 1) {
    await host.request('threeDPerform', { action: 'layer', value: 1 })
    await waitFor(async () => (await inspect()).selected === 1, 'native picker selects a layer')
  }
  if ((await inspect()).code) {
    await host.request('threeDPerform', { action: 'code' })
    await waitFor(
      async () => (await host.request('sourceInspect')).visible,
      'Code opens source drawer'
    )
  }
  const live = await inspect()
  host.send('deliver', {
    view: 'preview',
    message: {
      type: 'event',
      channel: PREVIEW_THREE_D_ACTION,
      args: [{ session: live.session, revision: live.revision - 1, action: 'separation', value: 1 }]
    }
  })
  await page('true', true)
  assert.equal((await inspect()).separation, 36, 'stale revision is rejected')
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
      narrow.active && narrow.header !== opened.header,
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
  await host.request('threeDPerform', { action: 'close' })
  await waitFor(async () => !(await inspect()).active, 'Back closes native chrome')
  assert.ok(await page(`document.querySelector('#native-title').isConnected`))
}
