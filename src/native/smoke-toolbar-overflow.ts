import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { capture, pick } from './smoke-toolbar'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Passive = Record<string, any>
/** Each transition is sampled every frame this long (sidebar and chat column animate for 240 ms). */
const TRACE_MS = 900
/** From this window width "…" is in the toolbar on purpose (`moreMinimumWindow`, ToolbarMore.swift). */
const MORE_MINIMUM_WINDOW = 1000
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The fields of a passive toolbar read (`toolbarPassiveInspect`) that the evidence keeps per frame. */
const slim = (state: Passive) => ({
  ms: state.ms,
  windowWidth: state.windowWidth,
  visibleItems: state.visibleItems,
  hiddenItems: state.hiddenItems,
  overflowItems: state.overflowItems,
  actionableOverflow: state.actionableOverflow,
  moreOverflowed: state.moreOverflowed,
  itemFrames: state.itemFrames,
  addressFrame: state.addressFrame,
  addressConstant: state.addressConstant,
  layout: state.layout,
  rightGroupInWindow: state.rightGroupInWindow,
  chatHeaderAttached: state.chatHeaderAttached,
  sidebarWidth: state.sidebarWidth,
  sidebarCollapsed: state.sidebarCollapsed
})

/** Foreground pixels before anything else touches the window (no layout pass, no focus repair). */
async function shot(host: NativeBridge, artifacts: string, name: string) {
  try {
    const background = process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'
    const png = background
      ? await host.request('captureShell')
      : (await host.request('captureVisibleWindow')).png
    writeFileSync(join(artifacts, `toolbar-overflow-${name}.png`), Buffer.from(png, 'base64'))
    return background ? 'offscreen (reduced coverage)' : 'foreground window'
  } catch (error) {
    return `not captured: ${(error as Error).message}`
  }
}

/** LKM-296: one transition as AppKit lays it out. A per-frame passive trace runs from just
 *  before `act`; the window is captured right after it and once settled, each time before
 *  `shellInspect` (which forces a layout and could repair a stale toolbar) is read last. */
export async function observe(
  host: NativeBridge,
  artifacts: string,
  name: string,
  act: () => Promise<unknown>,
  done: () => Promise<boolean>
) {
  const before: Passive = await host.request('toolbarOverflow', {})
  await host.request('toolbarOverflow', { action: 'trace-start', ms: TRACE_MS })
  await act()
  const transitionCapture = await shot(host, artifacts, `${name}-transition`)
  const transition: Passive = await host.request('toolbarOverflow', {})
  await waitFor(done, `toolbar ${name} settles`)
  await pause(TRACE_MS)
  const settled: Passive = await host.request('toolbarOverflow', {})
  const settledCapture = await capture(host, artifacts, `overflow-${name}`)
  const samples: Passive[] = (await host.request('toolbarOverflow', { action: 'trace' })).samples
  const forced: Passive = await host.request('shellInspect')
  const afterForced: Passive = await host.request('toolbarOverflow', {})
  return {
    before: slim(before),
    transition: { ...slim(transition), capture: transitionCapture },
    settled: { ...settled, capture: settledCapture },
    forced: pick(forced),
    afterForced: slim(afterForced),
    trace: {
      frames: samples.length,
      framesWithActionableOverflow: samples.filter((s) => s.actionableOverflow.length).length,
      framesWithMoreOverflowed: samples.filter((s) => s.moreOverflowed).length,
      samples: samples.map(slim)
    }
  }
}

const expandedIs = (host: NativeBridge, want: boolean) => async () =>
  ((await host.request('layoutInspect')).fraction === 0) === want

let sessionFirst: Passive | undefined
/** The session's first expansion (shell-layout), before any expanded toolbar was measured. */
export async function observeFirstExpansion(host: NativeBridge, artifacts: string) {
  sessionFirst = await observe(
    host,
    artifacts,
    'session-first-expand',
    () => host.request('shellPerform', { action: 'expand' }),
    expandedIs(host, true)
  )
  writeFileSync(
    join(artifacts, 'toolbar-overflow-session-first.json'),
    JSON.stringify(sessionFirst, null, 2)
  )
}

/** Expanding and restoring the preview, after a fresh launch's measurements, at three sidebar
 *  widths, after a genuinely narrow window and in rapid toggles: at ample width no control
 *  goes to AppKit's overflow menu; below the minimum window width real controls still do. */
export async function checkToolbarOverflow(host: NativeBridge, artifacts: string) {
  const results: Record<string, Passive> = {}
  if (sessionFirst) results['session-first-expand'] = sessionFirst
  const save = () =>
    writeFileSync(join(artifacts, 'toolbar-overflow.json'), JSON.stringify(results, null, 2))
  const toggle = () => host.request('shellPerform', { action: 'expand' })
  const resize = (width: number) =>
    host.request('shellPerform', { action: 'window-width', row: String(width) })
  const record = async (
    name: string,
    act: () => Promise<unknown>,
    done: () => Promise<boolean> = async () => true
  ) => {
    results[name] = await observe(host, artifacts, name, act, done)
    save()
  }
  const flip = (name: string, expanded: boolean, toggles = 1) =>
    record(
      name,
      async () => {
        for (let i = 0; i < toggles; i++) await toggle()
      },
      expandedIs(host, expanded)
    )
  const ensure = async (expanded: boolean) => {
    if (await expandedIs(host, expanded)()) return
    await toggle()
    await waitFor(expandedIs(host, expanded), `preview expanded ${expanded}`)
    await pause(300)
  }
  // Later checks expect the sidebar as this one found it (narrow windows and rapid toggles change it).
  const initial: Passive = await host.request('toolbarOverflow', {})
  try {
    await ensure(false)
    for (const width of [1320, 1810]) {
      assert.ok(await resize(width), `resize to ${width}`)
      // The address layout as a fresh launch has it: the right groups get measured with the
      // chat header in the toolbar, the leading edge without it never was.
      await host.request('toolbarOverflow', { action: 'launch-layout' })
      results[`launch-${width}`] = {
        settled: await waitFor(async () => {
          const state = await host.request('toolbarOverflow', {})
          return state.layout.measured && state.visibleItems.includes('address') && state
        }, `toolbar ${width} launch layout measured`)
      }
      await flip(`launch-expand-${width}`, true)
      await flip(`launch-restore-${width}`, false)
      await flip(`expand-again-${width}`, true)
      await flip(`restore-again-${width}`, false)
    }
    assert.ok(await resize(1320), 'resize to 1320')
    for (const sidebar of [340, 180, 230]) {
      // Before the fix the block stayed overflowed at 340 pt with nothing to measure it again.
      await record(`sidebar-${sidebar}`, async () =>
        assert.ok(
          await host.request('shellPerform', { action: 'sidebar-width', row: String(sidebar) }),
          `sidebar width ${sidebar}`
        )
      )
      await flip(`sidebar-${sidebar}-expand`, true)
      await flip(`sidebar-${sidebar}-restore`, false)
      // At rest the block fills up to the gap again: offsets learned from a resizing split's
      // transient frames once left it 8 pt short for the rest of the session.
      await waitFor(
        async () => {
          const rest = await host.request('shellInspect')
          return (
            rest.addressWidth <= rest.addressFloor + 1 ||
            Math.abs(rest.rightGroupLeading - rest.addressTrailing - rest.addressGap) <= 1
          )
        },
        `toolbar sidebar ${sidebar}: block ends 20 pt before the right groups at rest`,
        2000,
        async () => pick(await host.request('shellInspect'))
      )
    }
    // Below the 850 pt minimum the toolbar genuinely cannot fit; then widen while expanded.
    await record('narrow-collapsed', () =>
      host.request('toolbarOverflow', { action: 'narrow-width', width: 650 })
    )
    await flip('narrow-expand', true)
    await record('narrow-widened-expanded', () => resize(1320))
    await flip('narrow-widened-restore', false)
    // Rapid toggles: an odd number lands expanded, then collapsed.
    await flip('rapid-expand', true, 5)
    await flip('rapid-restore', false, 5)
  } finally {
    await host.request('toolbarOverflow', { action: 'narrow-width' })
    await resize(1320)
    await ensure(false)
    const sidebar = async () => (await host.request('toolbarOverflow', {})).sidebarCollapsed
    if ((await sidebar()) !== initial.sidebarCollapsed) {
      await host.request('shellPerform', { action: 'toggle-sidebar' })
      await waitFor(
        async () => (await sidebar()) === initial.sidebarCollapsed,
        'toolbar overflow restores the sidebar'
      )
    }
    await host.request('shellPerform', {
      action: 'sidebar-width',
      row: String(Math.round(initial.sidebarWidth))
    })
    await pause(300)
    save()
  }
  for (const [name, result] of Object.entries(results)) {
    // Every frame of the transition, not only the settled toolbar: the controls must not
    // flash into the overflow menu while the sidebar and chat column animate.
    const samples = result.trace?.samples ?? []
    const frames = samples.map((sample: Passive) => [`frame ${sample.ms} ms`, sample])
    for (const [stage, state] of [
      ['settled', result.settled],
      ['afterForced', result.afterForced],
      ...frames
    ]) {
      if (!state || state.windowWidth < MORE_MINIMUM_WINDOW) continue
      assert.deepEqual(
        state.actionableOverflow,
        [],
        `Toolbar ${name} (${stage}, ${state.windowWidth} pt): no control in the overflow menu: ${JSON.stringify(slim(state))}`
      )
      assert.equal(
        state.moreOverflowed,
        false,
        `Toolbar ${name} (${stage}, ${state.windowWidth} pt): "…" is not in the overflow menu: ${JSON.stringify(slim(state))}`
      )
    }
  }
  const narrow = results['narrow-collapsed'].settled
  assert.ok(
    narrow.windowWidth < 850 && narrow.hiddenItems.includes('more'),
    `Toolbar narrow: below the minimum, with "…" hidden on purpose: ${JSON.stringify(slim(narrow))}`
  )
  assert.ok(
    narrow.actionableOverflow.length > 0,
    `Toolbar narrow: real controls overflow when they cannot fit: ${JSON.stringify(slim(narrow))}`
  )
}
