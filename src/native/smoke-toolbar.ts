import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { restoreSidebarFocus } from './smoke-sidebar'
import { waitFor } from './smoke-wait'

const background = () => process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'
/** NSToolbar shifts the right groups once the address block comes closer than this (ToolbarAddress.swift). */
const PINNED_GAP = 16
/** Below this window width the "…" item is not in the toolbar (`moreMinimumWindow`, ToolbarMore.swift). */
const MORE_MINIMUM_WINDOW = 1000
/** LKM-213: the unified toolbar's trailing inset is a few points of system margin. */
const MAX_TRAILING_INSET = 24
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
  moreVisible: state.moreVisible,
  interactionSegments: state.interactionSegments,
  publishVisible: state.publishVisible,
  publishMeasured: state.publishMeasured,
  publishLeading: state.publishLeading,
  publishTrailing: state.publishTrailing,
  publishTrailingInset: state.publishTrailingInset,
  beforePublishTrailing: state.beforePublishTrailing,
  toolbarItemOrder: state.toolbarItemOrder,
  windowAppearance: state.windowAppearance
})

/** LKM-213: Publish and its chevron are the last toolbar group, never in the overflow menu,
 *  its trailing edge on the toolbar's trailing inset (`inset`: measured at the first width). */
function assertPublishLast(state: Toolbar, stage: string, inset: number) {
  const detail = JSON.stringify(pick(state))
  assert.ok(
    state.publishVisible,
    `Toolbar ${stage}: Publish stays out of the overflow menu: ${detail}`
  )
  assert.ok(state.publishMeasured, `Toolbar ${stage}: Publish's frame is laid out: ${detail}`)
  const order: string[] = state.toolbarItemOrder
  assert.equal(order.at(-1), 'publish', `Toolbar ${stage}: Publish is the last item: ${detail}`)
  assert.ok(
    state.beforePublishTrailing <= state.publishLeading + 0.5,
    `Toolbar ${stage}: every other item ends before Publish: ${detail}`
  )
  if (state.moreVisible)
    assert.equal(order.at(-2), 'more', `Toolbar ${stage}: "…" sits just before Publish: ${detail}`)
  assert.ok(
    state.publishTrailingInset >= 0 && state.publishTrailingInset <= MAX_TRAILING_INSET,
    `Toolbar ${stage}: Publish is flush with the trailing inset (≤ ${MAX_TRAILING_INSET}pt): ${detail}`
  )
  assert.ok(
    Math.abs(state.publishTrailingInset - inset) <= 1,
    `Toolbar ${stage}: Publish's trailing edge equals the toolbar trailing inset (${state.publishTrailingInset} vs ${inset}): ${detail}`
  )
}

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
  // The "…" item (LKM-197) leaves a window narrower than MORE_MINIMUM_WINDOW, which
  // shortens the right groups' inset by its width: each state keeps its own pinned inset.
  const pinnedInsets = new Map<boolean, number>()
  let trailingInset: number | undefined
  for (const [name, width] of [
    ['minimum', 850],
    ['narrow', 950],
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
    const moreShown = Boolean(settled.moreVisible)
    assert.equal(
      moreShown,
      width >= MORE_MINIMUM_WINDOW,
      `Toolbar ${name}: the "…" item shows only in windows of ${MORE_MINIMUM_WINDOW} pt or more (${width} pt)`
    )
    // LKM-213: slow motion is the interaction group's last segment, in the same windows as "…".
    assert.deepEqual(
      settled.interactionSegments,
      ['select-object', 'device', 'overlay', ...(moreShown ? ['speed'] : [])],
      `Toolbar ${name}: select | device | ruler${moreShown ? ' | slow motion' : ''}`
    )
    const pinnedInset = pinnedInsets.get(moreShown) ?? inset
    pinnedInsets.set(moreShown, pinnedInset)
    assert.ok(
      Math.abs(inset - pinnedInset) <= 1,
      `Toolbar ${name}: the right groups stay pinned to the trailing edge (${inset} vs ${pinnedInset}, "…" ${moreShown ? 'shown' : 'in the overflow menu'})`
    )
    trailingInset ??= settled.publishTrailingInset
    assertPublishLast(settled, name, trailingInset as number)
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
    if (name !== 'minimum' && name !== 'narrow')
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
  const [hiddenInset, shownInset] = [pinnedInsets.get(false), pinnedInsets.get(true)]
  assert.ok(
    hiddenInset !== undefined && shownInset !== undefined && hiddenInset < shownInset,
    `Toolbar minimum: without the "…" item the right groups are narrower (${hiddenInset} vs ${shownInset})`
  )
  writeFileSync(join(artifacts, 'toolbar-address.json'), JSON.stringify(evidence, null, 2))
}

/** Cleanup: the default window width and the system appearance. */
export async function restoreToolbarAddress(host: NativeBridge) {
  await host.request('shellPerform', { action: 'window-appearance', row: '' })
  await host.request('shellPerform', { action: 'window-width', row: '1320' })
}
