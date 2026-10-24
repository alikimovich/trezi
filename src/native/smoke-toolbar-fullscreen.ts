import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { assertPublishLast, assertToolbar, pick } from './smoke-toolbar'
import { expandedIs, observe, slim } from './smoke-toolbar-overflow'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Passive = Record<string, any>
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** LKM-321: in full screen AppKit hosts the toolbar in its own window, which a capture of the
 *  main window does not contain; this captures that window in the foreground. */
async function shot(host: NativeBridge, artifacts: string, name: string) {
  try {
    const { png } = await host.request('captureToolbarWindow')
    writeFileSync(join(artifacts, `toolbar-fullscreen-${name}.png`), Buffer.from(png, 'base64'))
    return 'foreground toolbar window'
  } catch (error) {
    return `not captured: ${(error as Error).message}`
  }
}

/** Full screen with the menu bar hidden, revealed (programmatically, and as the toolbar window's
 *  slide by the menu bar's height) and hidden again, collapsed and expanded: the address block
 *  stays in the toolbar, the right groups stay at the trailing edge and nothing overflows. */
export async function checkToolbarFullScreen(host: NativeBridge, artifacts: string) {
  const results: Record<string, Passive> = {}
  const save = () =>
    writeFileSync(join(artifacts, 'toolbar-fullscreen.json'), JSON.stringify(results, null, 2))
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
    results.skipped = { reason: 'background test: full screen needs a foreground window' }
    return save()
  }
  const overflow = (params: Record<string, unknown> = {}): Promise<Passive> =>
    host.request('toolbarOverflow', params)
  const fullScreen = (value: boolean) =>
    host.request('previewOverlayTest', { action: 'fullscreen', value })
  const toggle = () => host.request('shellPerform', { action: 'expand' })
  const ensure = async (expanded: boolean) => {
    if (await expandedIs(host, expanded)()) return
    await toggle()
    await waitFor(expandedIs(host, expanded), `preview expanded ${expanded}`)
    await pause(300)
  }
  // Each transition as AppKit lays it out (`observe`), the toolbar window's pixels and the
  // forced-layout toolbar, whose frame assertions are the windowed ones (LKM-148, LKM-213).
  const record = async (
    name: string,
    act: () => Promise<unknown>,
    done: () => Promise<boolean> = async () => true
  ) => {
    const result = await observe(host, artifacts, `fullscreen-${name}`, act, done)
    const toolbarCapture = await shot(host, artifacts, name)
    const full: Passive = await host.request('shellInspect')
    results[name] = { ...result, toolbarCapture, full: pick(full) }
    save()
    return full
  }
  const menuBar = (value: boolean) => overflow({ action: 'menu-bar', value })
  const moved = async (value: boolean) => {
    const state = await overflow({ action: 'toolbar-window-move', value })
    assert.ok(
      state.moved,
      `Toolbar full screen: the toolbar is in its own window: ${JSON.stringify(state)}`
    )
  }
  const shown: Record<string, Passive> = {}
  try {
    await ensure(false)
    await record(
      'enter',
      () => fullScreen(true),
      async () => (await overflow()).fullScreen === true
    )
    await waitFor(async () => {
      const state = await overflow()
      return state.layout.measured && state.visibleItems.includes('address') && state
    }, 'toolbar full screen measured with the address shown')
    shown.enter = await host.request('shellInspect')
    const entered = await overflow()
    assert.equal(
      entered.toolbarInMainWindow,
      false,
      `Toolbar full screen: AppKit hosts the toolbar in its own window: ${JSON.stringify(slim(entered))}`
    )
    shown['menu-bar'] = await record('menu-bar', () => menuBar(true))
    await record('menu-bar-expand', toggle, expandedIs(host, true))
    shown['menu-bar-restore'] = await record('menu-bar-restore', toggle, expandedIs(host, false))
    shown['menu-bar-hidden'] = await record('menu-bar-hidden', () => menuBar(false))
    shown['toolbar-window-move'] = await record('toolbar-window-move', () => moved(true))
    await record('toolbar-window-move-expand', toggle, expandedIs(host, true))
    shown['toolbar-window-move-restore'] = await record(
      'toolbar-window-move-restore',
      toggle,
      expandedIs(host, false)
    )
    shown['toolbar-window-back'] = await record('toolbar-window-back', () => moved(false))
  } finally {
    await overflow({ action: 'toolbar-window-move', value: false }).catch(() => {})
    await menuBar(false).catch(() => {})
    await fullScreen(false).catch(() => {})
    await ensure(false)
    save()
  }
  for (const [name, result] of Object.entries(results)) {
    for (const stage of ['settled', 'afterForced']) {
      const state = result[stage]
      assert.ok(
        state.visibleItems.includes('address'),
        `Toolbar full screen ${name} (${stage}): the address block is in the toolbar: ${JSON.stringify(slim(state))}`
      )
      assert.deepEqual(
        state.actionableOverflow,
        [],
        `Toolbar full screen ${name} (${stage}): no control in the overflow menu: ${JSON.stringify(slim(state))}`
      )
      assert.equal(
        state.moreOverflowed,
        false,
        `Toolbar full screen ${name} (${stage}): "…" is not in the overflow menu: ${JSON.stringify(slim(state))}`
      )
    }
  }
  // Collapsed, the layout with the menu bar shown equals the one with it hidden.
  const base = shown.enter
  assertToolbar(base, 'full screen')
  assertPublishLast(base, 'full screen', base.publishTrailingInset)
  for (const [name, state] of Object.entries(shown)) {
    const stage = `full screen ${name}`
    assertToolbar(state, stage)
    assertPublishLast(state, stage, base.publishTrailingInset)
    assert.ok(
      Math.abs(state.rightGroupLeading - base.rightGroupLeading) <= 1,
      `Toolbar ${stage}: the right groups stay where they are with the menu bar hidden (${state.rightGroupLeading} vs ${base.rightGroupLeading}): ${JSON.stringify(pick(state))}`
    )
  }
}
