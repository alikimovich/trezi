import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Inspect = (method: string, check: (state: any) => boolean) => Promise<any>

/** The toolbar reads back, forward, path, then "…" (LKM-192), pop out/dock and close on the right edge. */
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
function checkToolbar(toolbar: any, popped: boolean) {
  // biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
  const item = (id: string) => toolbar.items.find((entry: any) => entry.id === id)
  // biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
  assert.deepEqual(
    toolbar.items.map((entry: any) => entry.id).filter((id: string) => id !== 'edited'),
    ['back', 'forward', 'path', 'more', 'popout', 'hide']
  )
  assert.ok(
    item('back').maxX <= item('forward').minX && item('forward').maxX <= item('path').minX,
    'Back and forward sit left of the path'
  )
  assert.ok(
    item('path').maxX <= item('more').minX &&
      item('more').maxX <= item('popout').minX &&
      item('popout').maxX <= item('hide').minX
  )
  assert.ok(toolbar.width - item('hide').maxX <= 12, 'Close sits on the right edge')
  const expected: Record<string, [string, string]> = {
    back: ['chevron.left', 'Back'],
    forward: ['chevron.right', 'Forward'],
    more: ['ellipsis.circle', 'More'],
    hide: ['xmark', 'Close Editor'],
    popout: popped
      ? ['arrow.down.right.and.arrow.up.left', 'Dock Editor']
      : ['arrow.up.left.and.arrow.down.right', 'Pop Out Editor']
  }
  for (const [id, [symbol, label]] of Object.entries(expected))
    assert.deepEqual(
      [item(id).symbol, item(id).toolTip, item(id).label, item(id).title],
      [symbol, label, label, ''],
      `${id} icon`
    )
  assert.ok(toolbar.pathSelectable && !toolbar.pathEditable, 'The path is selectable, not editable')
}

/** Toolbar layout (popped out and docked) and the ⌘S/⌘R shortcuts, offered through
 *  the window's key-equivalent pass with focus in the code and outside the editor. */
export async function checkSourceEditor(
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  inspect: Inspect
) {
  const file = join(fixture, 'index.html'),
    read = () => readFileSync(file, 'utf8')
  const perform = (action: Record<string, unknown>) =>
    host.request('sourcePerform', { action: { root: fixture, ...action } })
  const verify = (params: Record<string, unknown>) =>
    host.request('sourceVerification', { root: fixture, ...params })
  let revision = 100
  const edit = async (marker: string) => {
    const { text } = await host.request('sourceInspect')
    revision += 100
    await perform({ action: 'edit', source: 'index.html', revision, text: text + marker })
    await inspect('sourceInspect', (s) => s.dirty)
  }
  // biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
  const capture = async (stem: string, toolbar: any) => {
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
      console.log(
        `SKIP foreground ${stem} capture: TREZI_NATIVE_BACKGROUND_TEST (offscreen capture saved instead)`
      )
      writeFileSync(
        join(artifacts, `${stem}.png`),
        Buffer.from(await host.request('captureSource', { root: fixture }), 'base64')
      )
      return
    }
    await waitFor(async () => {
      const s = await verify({ prepare: true })
      return s.active && s.key && s.visible
    }, `${stem} foreground`)
    await delay(350)
    const image = await verify({ capture: true })
    writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(image.png, 'base64'))
    writeFileSync(
      join(artifacts, `${stem}.json`),
      JSON.stringify({ toolbar, captureWidth: image.width, captureHeight: image.height }, null, 2)
    )
  }

  const popped = await verify({ focus: 'code' })
  checkToolbar(popped.toolbar, true)
  await capture('source-toolbar-popped', popped.toolbar)

  await edit('\n<!-- native editor save -->')
  let key = await verify({ key: 's', focus: 'code' })
  assert.ok(
    key.handled && key.focused && !key.guarded,
    `⌘S saves from the code: ${JSON.stringify(key)}`
  )
  await inspect('sourceInspect', (s) => !s.dirty && !s.error)
  assert.ok(read().includes('native editor save'))

  writeFileSync(file, `${read()}\n<!-- native editor reload -->`)
  key = await verify({ key: 'r', focus: 'code' })
  assert.ok(key.handled && !key.guarded, `⌘R reloads a clean file: ${JSON.stringify(key)}`)
  await inspect('sourceInspect', (s) => !s.dirty && s.text.includes('native editor reload'))

  // A draft over a file changed on disk: ⌘S refuses to overwrite, ⌘R asks before discarding.
  await edit('\n<!-- native editor draft -->')
  writeFileSync(file, `${read()}\n<!-- native editor external -->`)
  key = await verify({ key: 's', focus: 'code' })
  assert.ok(key.handled, '⌘S reaches the editor')
  await inspect('sourceInspect', (s) => s.dirty && /changed on disk/.test(s.error))
  assert.ok(!read().includes('native editor draft'), 'A conflicting save never overwrites the file')
  key = await verify({ key: 'r', focus: 'code' })
  assert.ok(
    key.handled && key.guarded,
    `⌘R over unsaved changes asks first: ${JSON.stringify(key)}`
  )
  await delay(300)
  const kept = await host.request('sourceInspect')
  assert.ok(
    kept.dirty && kept.text.includes('native editor draft'),
    'Cancelling the prompt keeps the draft'
  )
  await perform({ action: 'reload' })
  await inspect('sourceInspect', (s) => !s.dirty && s.text.includes('native editor external'))

  const path = await verify({ focus: 'path' })
  assert.ok(
    path.focused && path.copied === 'index.html',
    `The path selects and copies: ${JSON.stringify(path)}`
  )

  await perform({ action: 'dock' })
  await inspect('sourceInspect', (s) => s.visible && !s.popped)
  const docked = await verify({ focus: 'code' })
  checkToolbar(docked.toolbar, false)
  await capture('source-toolbar-docked', docked.toolbar)
  key = await verify({ key: 'r', focus: 'outside' })
  assert.ok(
    !key.handled && !key.focused,
    `⌘R outside the editor is left to the menu: ${JSON.stringify(key)}`
  )
  assert.deepEqual(key.menu, ['Reload Preview'])
  key = await verify({ key: 'r', focus: 'code' })
  assert.ok(key.handled && !key.guarded, `⌘R reloads in the docked editor: ${JSON.stringify(key)}`)

  // LKM-219: ⌘[ / ⌘] are the editor's own Back/Forward while it has focus, typed on a
  // Russian layout ("х" / "ъ" on the same keys); outside it they are View → Back/Forward.
  const shown = (await host.request('sourceInspect')).source
  key = await verify({ key: '[', focus: 'code', characters: 'х' })
  assert.ok(key.handled && key.focused, `Russian ⌘х is the editor's ⌘[: ${JSON.stringify(key)}`)
  await delay(300)
  const stepped = (await host.request('sourceInspect')).source !== shown
  key = await verify({ key: ']', focus: 'code', characters: 'ъ' })
  assert.ok(key.handled, `Russian ⌘ъ is the editor's ⌘]: ${JSON.stringify(key)}`)
  if (stepped) await inspect('sourceInspect', (s) => s.source === shown)
  key = await verify({ key: '[', focus: 'outside' })
  assert.ok(!key.handled && !key.focused, `⌘[ outside the editor: ${JSON.stringify(key)}`)
  assert.deepEqual(key.menu, ['Back'])
  console.log(
    'Native source editor: icon toolbar docked/popped, selectable path, ⌘S save, ⌘R reload, conflict and discard prompt, ⌘[ / ⌘] on a Russian layout pass.'
  )
}
