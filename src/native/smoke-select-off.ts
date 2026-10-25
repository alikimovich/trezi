import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import type { NativeInspectorController } from './inspector-controller'
import { dispatchIPC, serviceEvents } from './platform'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** LKM-344: with the select tool on, a reload of the same page keeps the selection (LKM-216).
 *  Turning the tool off drops it from the page (outline, size badge, element toolbar), the
 *  editing island and the chat chip, and a reload does not bring it back. */
export async function checkSelectOff(
  host: NativeBridge,
  artifacts: string,
  inspector: NativeInspectorController
) {
  const invoke = (channel: string, ...args: unknown[]) =>
    dispatchIPC('main', { type: 'invoke', channel, args })
  const send = (channel: string, ...args: unknown[]) =>
    dispatchIPC('main', { type: 'send', channel, args })
  const page = (code: string, isolated = false) =>
    host.request('evaluate', { view: 'preview', code, isolated })
  const chip = () =>
    nativeChat.get(nativeWorkspace.active?.activeSessionKey ?? '')?.context?.selection ?? null
  // The shadow overlay's selection outlines, the size badge and the element toolbar (preload.ts).
  const overlay = () =>
    page(
      `(() => {
        const root = document.querySelector('[data-trezi-overlay]')?.shadowRoot
        const shown = (el) => !!el && el.style.display !== 'none'
        return {
          page: !!document.querySelector('#native-title'),
          boxes: root ? [...root.querySelectorAll('[data-trezi-selbox]')].filter(shown).length : 0,
          badge: !!root && shown(root.querySelector('[data-trezi-selbadge]')),
          toolbar: !!root && shown(root.querySelector('[data-trezi-toolbar]'))
        }
      })()`,
      true
    )
  const state = async () => ({
    tool: (await host.request('shellInspect')).selectMode === true,
    island: await host.request('inspectorInspect'),
    element: inspector.element?.tag ?? null,
    chip: chip()?.bubble?.tag ?? null,
    page: await overlay()
  })
  const setTool = async (on: boolean) => {
    if ((await host.request('shellInspect')).selectMode !== on)
      await host.request('shellPerform', { action: 'select-object' })
    await waitFor(
      async () =>
        (await host.request('shellInspect')).selectMode === on &&
        (await page(`document.documentElement.style.cursor === 'crosshair'`)) === on,
      `select tool ${on ? 'on' : 'off'}`
    )
  }
  const reload = async () => {
    await page('window.reloadSentinel = true')
    host.emit('menu', { action: 'reload' })
    await waitFor(
      () => page(`!!document.querySelector('#native-title') && !window.reloadSentinel`),
      'page reloaded'
    )
  }
  const selected = async (label: string) =>
    waitFor(
      async () => {
        const s = await state()
        return (
          s.island.visible &&
          s.element === 'h1' &&
          s.chip === 'h1' &&
          s.page.boxes > 0 &&
          s.page.badge &&
          s.page.toolbar &&
          s
        )
      },
      label,
      15000,
      state
    )
  const cleared = (s: Awaited<ReturnType<typeof state>>) =>
    s.page.page &&
    !s.island.visible &&
    s.element === null &&
    s.chip === null &&
    !s.page.boxes &&
    !s.page.badge &&
    !s.page.toolbar
  const evidence: Record<string, unknown> = {}
  try {
    // Start from the fixture's own document and stamps, whatever an earlier check injected.
    await reload()
    await setTool(true)
    const layers = await invoke('layers:read'),
      heading = layers?.nodes?.find((n: { id?: string }) => n.id === 'native-title')
    assert.ok(heading, 'the fixture heading is a Layers row')
    await send('layers:select', {
      path: heading.path,
      fingerprint: { tag: heading.tag, source: heading.source }
    })
    await waitFor(async () => inspector.element?.tag === 'h1', 'the heading selected')
    if (!(await host.request('inspectorInspect')).visible)
      serviceEvents.emit('event', 'preview:toolbar-action', 'props')
    evidence.selected = await selected('outline, badge, toolbar, island and chip on the heading')

    // The select tool stays on: a reload brings the same selection back.
    await reload()
    evidence.reloadedOn = await selected('the selection back after a reload with the tool on')

    // The select tool goes off: everything goes with it.
    await setTool(false)
    evidence.off = await waitFor(
      async () => {
        const s = await state()
        return cleared(s) && s
      },
      'no outline, badge, toolbar, island or chip once the tool is off',
      10000,
      state
    )

    // A reload does not bring it back, also after the page reports readiness and its stamps.
    await reload()
    const samples: unknown[] = []
    for (let i = 0; i < 8; i++) {
      await delay(250)
      const s = await state()
      samples.push(s)
      assert.ok(
        !s.tool && cleared(s),
        `the selection stays gone after a reload with the tool off ${JSON.stringify(s)}`
      )
    }
    evidence.reloadedOff = samples.at(-1)
    writeFileSync(
      join(artifacts, 'select-off-reload.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
  } finally {
    writeFileSync(join(artifacts, 'select-off.json'), JSON.stringify(evidence, null, 2))
  }
}

/** Leaves the select tool off and the editing island closed. */
export async function restoreSelectOff(host: NativeBridge) {
  if ((await host.request('shellInspect')).selectMode)
    await host.request('shellPerform', { action: 'select-object' })
  const island = await host.request('inspectorInspect')
  if (island.visible && nativeWorkspace.active)
    await host.request('inspectorPerform', {
      action: { root: nativeWorkspace.active.root, generation: island.generation, action: 'close' }
    })
}
