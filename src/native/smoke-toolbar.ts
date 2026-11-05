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
export const pick = (state: Toolbar) => ({
  fullAddress: state.address,
  renderedAddress: state.domain,
  windowWidth: state.windowWidth,
  addressLeading: state.addressLeading,
  addressTrailing: state.addressTrailing,
  viewportLeading: state.viewportLeading,
  viewportTrailing: state.viewportTrailing,
  addressWidth: state.addressWidth,
  addressHostWidth: state.addressHostWidth,
  addressFormerWidth: state.addressFormerWidth,
  addressConstant: state.addressConstant,
  addressExtra: state.addressExtra,
  sidebarInset: state.sidebarInset,
  chatLead: state.chatLead,
  chatHeaderWidth: state.chatHeaderWidth,
  chatHeaderAttached: state.chatHeaderAttached,
  chatHeaderTrailing: state.chatHeaderTrailing,
  chatNewFrame: state.chatNewFrame,
  chatTitleFrame: state.chatTitleFrame,
  chatTitleFont: state.chatTitleFont,
  addressFont: state.addressFont,
  branchFont: state.branchFont,
  branchTitleFont: state.branchTitleFont,
  publishFont: state.publishFont,
  publishTitleFits: state.publishTitleFits,
  publishControlGlass: state.publishControlGlass,
  publishGlassHover: state.publishGlassHover,
  publishControlWidth: state.publishControlWidth,
  publishIntrinsicWidth: state.publishIntrinsicWidth,
  chatNewStandalone: state.chatNewStandalone,
  detailLeading: state.detailLeading,
  chatWidth: state.chatWidth,
  measuredRightInset: state.rightInset,
  rightInsetMeasured: state.rightInsetMeasured,
  addressVisible: state.addressVisible,
  rightGroupLeading: state.rightGroupLeading,
  gap: gapOf(state),
  rightInset: state.windowWidth - state.rightGroupLeading,
  addressTruncated: state.addressTruncated,
  branchTruncated: state.branchTruncated,
  branchTitleCut: state.branchTitleCut,
  branchKeptSlots: state.branchKeptSlots,
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
  viewportSegments: state.viewportSegments,
  toolSegments: state.toolSegments,
  islandDividers: state.islandDividers,
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
export function assertPublishLast(state: Toolbar, stage: string, inset: number) {
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
  // LKM-440: `branchTruncated` compares the alignment-rect intrinsic width with the frame and
  // missed a cut title; `branchTitleCut` is the pop-up's own measure of the title it draws.
  const maxGap = state.branchTruncated || state.branchTitleCut ? 16 : 6.5
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
export function assertToolbar(state: Toolbar, stage: string) {
  const detail = JSON.stringify(pick(state))
  for (const key of ['chatTitle', 'address', 'branch', 'branchTitle', 'publish']) {
    assert.match(
      state[`${key}Font`],
      /Mono/i,
      `Toolbar ${stage}: ${key} uses system monospace: ${detail}`
    )
    assert.equal(
      state[`${key}FontSize`],
      key.startsWith('branch') ? state.topBarSmallFontSize : state.topBarSystemFontSize,
      `Toolbar ${stage}: ${key} keeps its native point size: ${detail}`
    )
  }
  assert.ok(
    state.publishControlGlass &&
      state.publishGlassHover &&
      state.publishTitleFits &&
      state.publishControlWidth + 0.5 >= state.publishIntrinsicWidth,
    `Toolbar ${stage}: Publish keeps native glass and its full monospace label: ${detail}`
  )
  if (state.chatHeaderContentVisible !== undefined && state.toolbar.includes('chat'))
    assert.equal(
      state.chatNewVisible,
      state.chatHeaderContentVisible,
      `Toolbar ${stage}: New Chat follows the title's visibility on every supported macOS: ${detail}`
    )
  assert.ok(
    state.addressVisible,
    `Toolbar ${stage}: the address block stays in the toolbar: ${detail}`
  )
  // The address keeps enough room for the host when space is available.
  assert.ok(
    state.addressWidth >= state.addressFloor - 0.5 &&
      state.addressWidth <= Math.max(state.addressMinimum, state.addressHostWidth) + 0.5,
    `Toolbar ${stage}: the address stays within its compact width range: ${detail}`
  )
  assert.ok(
    state.viewportTrailing <= state.addressLeading + 0.5 &&
      state.addressTrailing <= state.rightGroupLeading - PINNED_GAP + 0.5,
    `Toolbar ${stage}: viewport island precedes the address without overlap: ${detail}`
  )
  const order: string[] = state.toolbarItemOrder
  assert.equal(
    order.indexOf('viewport') + 1,
    order.indexOf('address'),
    `Toolbar ${stage}: viewport is immediately left of address: ${detail}`
  )
  if (state.chatNewVisible) {
    const rect = (value: string) => (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    const [titleX, , titleWidth] = rect(state.chatTitleFrame)
    const [buttonX, , buttonWidth] = rect(state.chatNewFrame)
    assert.ok(
      state.chatNewStandalone &&
        buttonWidth >= 28 &&
        buttonWidth <= 48 &&
        buttonX >= titleX + titleWidth + 7 &&
        buttonX >= state.chatHeaderTrailing &&
        Math.abs(buttonX + buttonWidth - (state.detailLeading + state.chatWidth - 4)) <= 3,
      `Toolbar ${stage}: New Chat stays on the chat column's trailing edge without clipping the title: ${detail}`
    )
  }
  assert.equal(
    state.addressTruncation,
    'tail',
    `Toolbar ${stage}: the resting URL elides its path after the host`
  )
  assert.equal(state.branchTruncation, 'tail', `Toolbar ${stage}: the branch truncates at the tail`)
}

/** LKM-319: on macOS 27 no divider draws between the buttons of a toolbar island (preview
 *  interaction, preview tools); earlier systems keep theirs. Read in the
 *  live toolbar after an island button was used or the window width changed a segment. */
export async function assertIslandDividers(host: NativeBridge, stage: string, state?: Toolbar) {
  const shell: Toolbar = state ?? (await host.request('shellInspect'))
  if (!shell.islandHidesDividers) return
  assert.deepEqual(
    shell.islandDividers,
    { interaction: 0, viewport: 0, tools: 0 },
    `Toolbar ${stage}: no divider inside an island: ${JSON.stringify(shell.islandDividers)}`
  )
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

/** Minimum, default and wide window widths: the viewport island and address fit
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
  const record = () =>
    writeFileSync(join(artifacts, 'toolbar-address.json'), JSON.stringify(evidence, null, 2))
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
      return (
        Math.abs(state.windowWidth - width) < 1 &&
        (!state.chatNewVisible || state.chatNewFrame !== '{{0, 0}, {0, 0}}') &&
        state
      )
    }, `toolbar ${name} window width and laid-out New Chat`)
    assertToolbar(live, `${name} (inside the resize)`)
    assertToolbar(settled, name)
    // LKM-319: slow motion left or came back with this width; the islands still show no divider.
    await assertIslandDividers(host, `${name} (${width} pt)`, settled)
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
    assert.ok(
      Math.abs(live.chatHeaderWidth - settled.chatHeaderWidth) <= 1,
      `Toolbar ${name}: chat header width is final in the resize pass: ${JSON.stringify({ live: pick(live), settled: pick(settled) })}`
    )
    const inset = settled.windowWidth - settled.rightGroupLeading
    const moreShown = Boolean(settled.moreVisible)
    assert.equal(
      moreShown,
      width >= MORE_MINIMUM_WINDOW,
      `Toolbar ${name}: the "…" item shows only in windows of ${MORE_MINIMUM_WINDOW} pt or more (${width} pt)`
    )
    // LKM-213: slow motion leaves the interaction group in the same windows as "…".
    // Mark up stays at every width, and the viewport controls stay left of the address.
    assert.deepEqual(
      settled.interactionSegments,
      ['select-object', 'overlay', ...(moreShown ? ['speed'] : []), 'markup'],
      `Toolbar ${name}: select | ruler${moreShown ? ' | slow motion' : ''} | mark up`
    )
    assert.deepEqual(
      settled.viewportSegments,
      ['device', 'expand'],
      `Toolbar ${name}: device | expand`
    )
    assert.deepEqual(settled.toolSegments, ['code', 'layers'], `Toolbar ${name}: code | layers`)
    const pinnedInset = pinnedInsets.get(moreShown) ?? inset
    pinnedInsets.set(moreShown, pinnedInset)
    assert.ok(
      Math.abs(inset - pinnedInset) <= 1,
      `Toolbar ${name}: the right groups stay pinned to the trailing edge (${inset} vs ${pinnedInset}, "…" ${moreShown ? 'shown' : 'in the overflow menu'})`
    )
    trailingInset ??= settled.publishTrailingInset
    assertPublishLast(settled, name, trailingInset as number)
    if (name === 'wide') {
      const [newX, , newWidth] = (settled.chatNewFrame.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
      assert.ok(
        Math.abs(newX + newWidth - (settled.detailLeading + settled.chatWidth - 4)) <= 3,
        `Toolbar wide: New Chat follows the actual chat pane boundary: ${JSON.stringify(pick(settled))}`
      )
      assert.ok(
        settled.addressTextRoom >= settled.addressHostWidth - 16,
        `Toolbar wide: scheme, host and port fit: ${JSON.stringify(pick(settled))}`
      )
      assert.ok(
        Math.abs(
          settled.addressWidth - Math.max(settled.addressMinimum, settled.addressHostWidth)
        ) <= 1,
        `Toolbar wide: the block fits the host without unused width: ${JSON.stringify(pick(settled))}`
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
  const originalURL: string = (await host.request('shellInspect')).address
  const longURL = `http://sub.t:7/${'long-path/'.repeat(35)}`
  for (const [stage, width] of [
    ['ordinary', 1320],
    ['narrow', 950]
  ] as const) {
    assert.equal(
      await host.request('shellPerform', { action: 'address-test-url', row: longURL }),
      true
    )
    assert.equal(
      await host.request('shellPerform', { action: 'window-width', row: String(width) }),
      true
    )
    const state: Toolbar = await host.request('shellInspect')
    assert.equal(
      state.address,
      longURL,
      `${stage}: the full URL is kept for editing and navigation`
    )
    assert.ok(
      state.domain.includes('sub.t:7'),
      `${stage}: rendered address keeps the host and port: ${state.domain}`
    )
    assert.ok(
      state.domain.endsWith('…'),
      `${stage}: the path elides after the host: ${state.domain}`
    )
    assert.ok(
      state.addressTextWidth <= state.addressTextRoom + 0.5,
      `${stage}: the rendered host and port fit without further cell clipping: ${JSON.stringify(pick(state))}`
    )
    evidence[`longPath-${stage}`] = pick(state)
  }
  const longHost = `${'preview'.repeat(6)}.example.test:7443`
  const hostURL = `http://${longHost}/${'path/'.repeat(30)}`
  assert.equal(
    await host.request('shellPerform', { action: 'address-test-url', row: hostURL }),
    true
  )
  assert.equal(await host.request('shellPerform', { action: 'window-width', row: '1800' }), true)
  const wideHost: Toolbar = await host.request('shellInspect')
  assert.ok(wideHost.addressHostWidth > 420, 'the long host exceeds the former fixed cap')
  assert.ok(wideHost.domain.includes(longHost), 'wide: the full long host and port render')
  assert.ok(
    wideHost.addressTextWidth <= wideHost.addressTextRoom + 0.5,
    `wide: the long host fits without cell clipping: ${JSON.stringify(pick(wideHost))}`
  )
  evidence.longHost = pick(wideHost)
  const roundtripURL = new URL(`/${'long-path/'.repeat(35)}`, originalURL).href
  assert.equal(
    await host.request('shellPerform', { action: 'address-test-url', row: roundtripURL }),
    true
  )
  assert.equal(await host.request('shellPerform', { action: 'window-width', row: '1320' }), true)
  const roundtripBefore: Toolbar = await host.request('shellInspect')
  assert.ok(roundtripBefore.domain.endsWith('…'), 'the roundtrip begins with an elided path')
  const roundtripCapture = await capture(host, artifacts, 'long-path-roundtrip')
  evidence.longPathRoundtrip = {
    before: pick(roundtripBefore),
    capture: 'toolbar-long-path-roundtrip.png',
    captureMode: roundtripCapture
  }
  record()
  const navigation = new Promise<{ action?: string; value?: string }>((resolve, reject) => {
    const listener = (event: { action?: string; value?: string }) => {
      if (event.action !== 'address') return
      clearTimeout(timer)
      host.off('shell-action', listener)
      resolve(event)
    }
    const timer = setTimeout(() => {
      host.off('shell-action', listener)
      reject(new Error('Address submit did not emit a shell action'))
    }, 5000)
    host.on('shell-action', listener)
  })
  const roundtrip = await host.request('shellAddressRoundtrip')
  const submitted = await navigation
  evidence.longPathRoundtrip = {
    ...(evidence.longPathRoundtrip as Record<string, unknown>),
    roundtrip,
    submitted
  }
  record()
  assert.equal(roundtrip.error, undefined, `address editor opened: ${roundtrip.error}`)
  assert.equal(roundtrip.editing, roundtripURL, 'editing restores the unelided URL')
  assert.equal(roundtrip.selectedAll, true, 'the full editor URL is selected for Copy')
  assert.equal(roundtrip.copied, roundtripURL, 'Copy writes the full URL to a private pasteboard')
  assert.equal(submitted.value, roundtripURL, 'navigation receives the full URL from the editor')
  await waitFor(
    async () => (await host.request('shellInspect')).address === roundtripURL,
    'the submitted full URL reaches the preview'
  )
  assert.equal(await host.request('shellPerform', { action: 'address', row: originalURL }), true)
  await waitFor(
    async () => (await host.request('shellInspect')).address === originalURL,
    'the preview returns to its original URL'
  )
  assert.equal(
    await host.request('shellPerform', { action: 'address-test-url', row: originalURL }),
    true
  )
  record()
}

/** Cleanup: the default window width and the system appearance. */
export async function restoreToolbarAddress(host: NativeBridge) {
  await host.request('shellPerform', { action: 'window-appearance', row: '' })
  await host.request('shellPerform', { action: 'window-width', row: '1320' })
}
