import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { restoreSidebarFocus } from './smoke-sidebar'
import { waitFor } from './smoke-wait'

const background = () => process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'
/** NSToolbar shifts the right groups once the address block comes closer than this (ToolbarAddress.swift). */
const PINNED_GAP = 16
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Toolbar = Record<string, any>

const gapOf = (state: Toolbar) => state.rightGroupLeading - state.addressTrailing
const pick = (state: Toolbar) => ({
  windowWidth: state.windowWidth,
  addressLeading: state.addressLeading,
  addressTrailing: state.addressTrailing,
  addressWidth: state.addressWidth,
  addressFormerWidth: state.addressFormerWidth,
  chatHeaderWidth: state.chatHeaderWidth,
  chatHeaderTrailing: state.chatHeaderTrailing,
  measuredRightInset: state.rightInset,
  rightInsetMeasured: state.rightInsetMeasured,
  addressVisible: state.addressVisible,
  rightGroupLeading: state.rightGroupLeading,
  gap: gapOf(state),
  rightInset: state.windowWidth - state.rightGroupLeading,
  addressTruncated: state.addressTruncated,
  branchTruncated: state.branchTruncated,
  addressTextWidth: state.addressTextWidth,
  addressTextRoom: state.addressTextRoom,
  addressTextLeading: state.addressTextLeading,
  branchTextLeading: state.branchTextLeading,
  addressInkLeading: state.addressInkLeading,
  branchInkLeading: state.branchInkLeading,
  branchTitleRectLeading: state.branchTitleRectLeading,
  branchFrameLeading: state.branchFrameLeading,
  branchFrameWidth: state.branchFrameWidth,
  branchTitleEnd: state.branchTitleEnd,
  branchChevronLeading: state.branchChevronLeading,
  branchChevronTrailing: state.branchChevronTrailing,
  branchChevronGap: state.branchChevronGap,
  windowAppearance: state.windowAppearance
})

/** LKM-184: the branch title starts on the address text's left edge (rendered text
 *  origins, window x), and the chevron follows the title inside the pop-up's frame. */
function assertTitles(state: Toolbar, stage: string) {
  const detail = JSON.stringify(pick(state))
  assert.ok(state.titleAlignmentMeasured, `Toolbar ${stage}: both titles render: ${detail}`)
  assert.ok(
    Math.abs(state.branchTextLeading - state.addressTextLeading) <= 0.5,
    `Toolbar ${stage}: branch and address text share one left edge: ${detail}`
  )
  // Untruncated, the stock cell left ~4.5 pt; a tail ellipsis can leave up to a glyph more.
  const maxGap = state.branchTruncated ? 16 : 6.5
  assert.ok(
    state.branchChevronGap >= 1 && state.branchChevronGap <= maxGap,
    `Toolbar ${stage}: the chevron follows the branch title (gap 1–${maxGap}pt): ${detail}`
  )
  assert.ok(
    state.branchFrameLeading <= state.branchInkLeading &&
      state.branchChevronTrailing <= state.branchFrameLeading + state.branchFrameWidth + 0.5,
    `Toolbar ${stage}: title and chevron stay inside the pop-up's click target: ${detail}`
  )
}

/** LKM-148 frame assertions for one laid-out toolbar. */
function assertToolbar(state: Toolbar, stage: string) {
  const detail = JSON.stringify(pick(state))
  assert.ok(
    state.addressVisible,
    `Toolbar ${stage}: the address block stays in the toolbar: ${detail}`
  )
  // Never narrower than the pre-LKM-148 layout made it at this geometry (180pt by default, less in a minimum-width window).
  assert.ok(
    state.addressWidth >= state.addressFormerWidth - 0.5,
    `Toolbar ${stage}: the address block keeps its former ${state.addressFormerWidth}pt: ${detail}`
  )
  assert.ok(
    gapOf(state) >= PINNED_GAP - 0.5,
    `Toolbar ${stage}: the right groups do not overlap or get pushed: ${detail}`
  )
  // Above its floor, the block fills the free space up to the fixed gap.
  if (state.addressWidth > state.addressFloor + 1)
    assert.ok(
      Math.abs(gapOf(state) - state.addressGap) <= 1,
      `Toolbar ${stage}: trailing edge ${state.addressGap}pt before the right groups: ${detail}`
    )
  assert.equal(
    state.addressTruncation,
    'middle',
    `Toolbar ${stage}: the URL truncates in the middle`
  )
  assert.equal(state.branchTruncation, 'tail', `Toolbar ${stage}: the branch truncates at the tail`)
}

export async function capture(host: NativeBridge, artifacts: string, name: string) {
  let png: string,
    how = 'foreground window'
  if (background()) {
    png = await host.request('captureShell')
    how = 'offscreen (TREZI_NATIVE_BACKGROUND_TEST=1: reduced coverage)'
  } else {
    await restoreSidebarFocus(host, `toolbar ${name}`)
    png = (await host.request('captureVisibleWindow')).png
  }
  writeFileSync(join(artifacts, `toolbar-${name}.png`), Buffer.from(png, 'base64'))
  return how
}

/** Minimum, default and wide window widths: the address block fills the free toolbar
 *  width, keeps its minimum, and the right groups stay pinned without overlap. Each
 *  resize is read synchronously inside the resize (`resizeSnapshot`) and again once
 *  settled; they must agree, so the width is final in the resize's own layout pass. */
export async function checkToolbarAddress(host: NativeBridge, artifacts: string) {
  // A startup underestimate of the right groups' inset overflows the block once; it backs off and measures.
  const initial: Toolbar = await waitFor(
    async () => {
      const state = await host.request('shellInspect')
      return state.addressVisible && state.rightInsetMeasured && state
    },
    'toolbar address visible with a measured inset',
    10000,
    async () => pick(await host.request('shellInspect'))
  )
  const defaultWidth = Math.round(initial.windowWidth)
  const evidence: Record<string, unknown> = {}
  let pinnedInset: number | undefined
  for (const [name, width] of [
    ['minimum', 850],
    ['wide', 1800],
    ['default', defaultWidth]
  ] as const) {
    assert.ok(
      await host.request('shellPerform', { action: 'window-width', row: String(width) }),
      `Toolbar ${name}: resize to ${width}`
    )
    const live: Toolbar = (await host.request('shellInspect')).resizeSnapshot
    await new Promise((resolve) => setTimeout(resolve, 300))
    const settled: Toolbar = await waitFor(async () => {
      const state = await host.request('shellInspect')
      return Math.abs(state.windowWidth - width) < 1 && state
    }, `toolbar ${name} window width`)
    assertToolbar(live, `${name} (inside the resize)`)
    assertToolbar(settled, name)
    // The layout works from the pinned inset it measured, not from its startup guess.
    assert.ok(
      settled.rightInsetMeasured &&
        Math.abs(settled.rightInset - (settled.windowWidth - settled.rightGroupLeading)) <= 1,
      `Toolbar ${name}: the right-group inset is measured from a pinned layout: ${JSON.stringify(pick(settled))}`
    )
    // The leading edge follows the chat column, which the backend may resize after the window.
    for (const key of ['addressTrailing', 'rightGroupLeading'] as const)
      assert.ok(
        Math.abs(live[key] - settled[key]) <= 1,
        `Toolbar ${name}: ${key} is final in the resize pass (no reflow later): ${JSON.stringify({ live: pick(live), settled: pick(settled) })}`
      )
    const inset = settled.windowWidth - settled.rightGroupLeading
    pinnedInset ??= inset
    assert.ok(
      Math.abs(inset - pinnedInset) <= 1,
      `Toolbar ${name}: the right groups stay pinned to the trailing edge (${inset} vs ${pinnedInset})`
    )
    if (name === 'wide') {
      assert.ok(
        settled.addressWidth > settled.addressMinimum + 1,
        `Toolbar wide: the block grows past its minimum: ${JSON.stringify(pick(settled))}`
      )
      assert.equal(settled.addressTruncated, false, 'Toolbar wide: the full URL shows when it fits')
      assert.equal(
        settled.branchTruncated,
        false,
        'Toolbar wide: the full branch shows when it fits'
      )
    }
    assertTitles(settled, name)
    const titles: Record<string, unknown> = {}
    // LKM-184: at two widths, the titles stay aligned in a light and a dark window.
    if (name !== 'minimum')
      for (const appearance of ['light', 'dark'] as const) {
        await host.request('shellPerform', { action: 'window-appearance', row: appearance })
        await new Promise((resolve) => setTimeout(resolve, 200))
        const state: Toolbar = await host.request('shellInspect')
        assert.equal(
          /dark/i.test(state.windowAppearance),
          appearance === 'dark',
          `Toolbar ${name} ${appearance}: window appearance forced (${state.windowAppearance})`
        )
        assertTitles(state, `${name} ${appearance}`)
        titles[appearance] = {
          ...pick(state),
          capture: await capture(host, artifacts, `${name}-${appearance}`)
        }
      }
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
    evidence[name] = {
      live: pick(live),
      settled: pick(settled),
      titles,
      capture: await capture(host, artifacts, name)
    }
  }
  writeFileSync(join(artifacts, 'toolbar-address.json'), JSON.stringify(evidence, null, 2))
}

/** Cleanup: the default window width and the system appearance. */
export async function restoreToolbarAddress(host: NativeBridge) {
  await host.request('shellPerform', { action: 'window-appearance', row: '' })
  await host.request('shellPerform', { action: 'window-width', row: '1320' })
}
