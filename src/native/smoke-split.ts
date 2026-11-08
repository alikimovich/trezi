import assert from 'node:assert/strict'
import type { NativeBridge } from './bridge'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Inspect = Record<string, any>

/** LKM-559: the least room between the chat/preview rule and either side's toolbar
 *  control, so neither rounded glass background touches or covers the rule. */
export const SPLIT_CLEARANCE = 3

const rect = (value: unknown) => (String(value ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
const right = (value: unknown) => {
  const [x, , width] = rect(value)
  return width > 0 ? x + width : null
}

/** Where the chat/preview rule draws and what lies either side of it in the top bar, in
 *  window points: from `shellInspect` and `previewSurfaceInspect`. */
export function chatPreviewSplit(shell: Inspect, surface: Inspect) {
  const frames: Record<string, string> = shell.toolbarItemFrames ?? {}
  return {
    drawn: surface.dividerDrawn === true,
    spansTopBar: surface.dividerSpansTopBar === true,
    top: surface.dividerTop as number,
    surfaceTop: surface.surfaceHeight as number,
    contentTop: surface.contentTop as number,
    x: surface.dividerWindowX as number,
    // LKM-587: the rule as drawn (one point thick, centred on the edge), in window points.
    ruleMinX: surface.dividerWindowMinX as number,
    ruleMaxX: surface.dividerWindowMaxX as number,
    scale: Number(surface.backingScale) || 2,
    column: (shell.detailLeading as number) + Number(shell.chatWidth ?? 0),
    chatNewVisible: shell.chatNewVisible === true,
    // The last chat-side control as drawn: New Chat's button when it shows, else the title header.
    chatTrailing: shell.chatNewVisible
      ? right(shell.chatNewRenderedFrame)
      : (shell.chatHeaderTrailing as number),
    // The first preview-side control as drawn: the viewport island's segmented control.
    previewLeading: shell.viewportLeading as number,
    // AppKit's item slots, which abut: the rule belongs on their shared edge.
    chatSlotTrailing: right(frames['chat-new']),
    previewSlotLeading: rect(frames.viewport)[0] ?? null,
    frames
  }
}
export type ChatPreviewSplit = ReturnType<typeof chatPreviewSplit>

/** The rule draws at the chat column's edge (loading or ready). The chat's toolbar controls
 *  stay left of it, clear of it. Where the preview's controls fit right of it, they stay clear
 *  of it and the rule runs through the top bar; where they cannot (a narrow window: AppKit lays
 *  them over the chat column), the rule stops at the top bar instead of running under them. */
export function assertChatPreviewSplit(split: ChatPreviewSplit, stage: string) {
  const detail = JSON.stringify(split)
  assert.ok(split.drawn, `${stage}: the chat/preview rule draws: ${detail}`)
  assert.ok(
    Math.abs(split.x - split.column) <= 1,
    `${stage}: the rule sits on the chat column's edge: ${detail}`
  )
  if (split.chatTrailing != null)
    assert.ok(
      split.chatTrailing <= split.ruleMinX - SPLIT_CLEARANCE + 0.5,
      `${stage}: the chat's toolbar controls end before the rule: ${detail}`
    )
  const fits = split.previewSlotLeading == null || split.previewSlotLeading >= split.column - 0.5
  assert.equal(
    split.spansTopBar,
    fits,
    `${stage}: the rule spans the top bar exactly when it splits there: ${detail}`
  )
  if (fits) {
    assert.ok(
      split.previewLeading >= split.ruleMaxX + SPLIT_CLEARANCE - 0.5,
      `${stage}: the preview's toolbar controls start after the rule: ${detail}`
    )
    // LKM-587: New Chat's glass and the viewport island's sit the same distance from the rule
    // as drawn (it ran 4 pt left of a hairline and 3.5 pt right of it: 7 px against 6 px).
    // At an odd backing scale the rule is an odd number of pixels in an even gap, so one
    // side may differ by one device pixel.
    const slack = Math.round(split.scale) % 2 === 0 ? 0.25 : 1 / split.scale + 0.01
    if (split.chatNewVisible && split.chatTrailing != null)
      assert.ok(
        Math.abs(split.ruleMinX - split.chatTrailing - (split.previewLeading - split.ruleMaxX)) <
          slack,
        `${stage}: the rule sits centred between New Chat and the viewport island: ${detail}`
      )
    assert.ok(
      Math.abs(split.top - split.surfaceTop) <= 0.5,
      `${stage}: the rule runs through the top bar: ${detail}`
    )
  } else
    assert.ok(
      Math.abs(split.top - split.contentTop) <= 0.5,
      `${stage}: the rule stops at the top bar's lower edge: ${detail}`
    )
}

/** LKM-587: the visible gaps, in device pixels, between the rule and the nearest glass edge on
 *  either side, read along one row of a foreground capture through the toolbar's middle (the
 *  capsules' widest point). The gap is the run of pixels next to the rule that match the pixel
 *  just beside it; it ends at the first that differs (the glass outline). Pure: `rgb` reads the
 *  capture, y down. */
export function splitGapsInPixels(
  rgb: (x: number, y: number) => readonly number[],
  row: number,
  ruleMin: number,
  ruleMax: number,
  limit = 40
) {
  const luma = (x: number) => {
    const [r, g, b] = rgb(x, row)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const run = (from: number, step: 1 | -1) => {
    const base = luma(from)
    let count = 0
    while (count < limit && Math.abs(luma(from + step * count) - base) < 12) count++
    return count
  }
  return { left: run(ruleMin - 1, -1), right: run(ruleMax, 1) }
}

/** LKM-587: in a foreground capture, the gap left of the rule (to New Chat's glass) equals the
 *  gap right of it (to the viewport island's), in device pixels. */
export function assertSplitGapPixels(
  split: ChatPreviewSplit,
  rgb: (x: number, y: number) => readonly number[],
  stage: string
) {
  const viewport = rect(split.frames.viewport)
  const scale = split.scale
  if (!split.chatNewVisible || !split.spansTopBar || viewport.length < 4) return null
  if (Math.round(scale) % 2 !== 0) return null
  // Window points are y up from the content bottom; the capture is y down from the window top.
  const row = Math.round((split.surfaceTop - (viewport[1] + viewport[3] / 2)) * scale)
  const gaps = splitGapsInPixels(
    rgb,
    row,
    Math.round(split.ruleMinX * scale),
    Math.round(split.ruleMaxX * scale),
    Math.round(8 * scale)
  )
  const limit = Math.round(8 * scale)
  assert.ok(
    gaps.left < limit && gaps.right < limit,
    `${stage}: a glass edge lies within 8 pt either side of the rule: ${JSON.stringify({ ...gaps, row, scale })}`
  )
  assert.equal(
    gaps.left,
    gaps.right,
    `${stage}: the toolbar gap is the same either side of the rule (device px): ${JSON.stringify({ ...gaps, row, scale })}`
  )
  return gaps
}

/** The split as laid out after a resize: the rule's top-bar extent follows the toolbar's
 *  measure, a layout behind the window, so it is read once that settled. */
export async function assertSplitSettles(host: NativeBridge, stage: string, timeout = 3000) {
  const read = async () =>
    chatPreviewSplit(
      await host.request('shellInspect'),
      await host.request('previewSurfaceInspect')
    )
  let split = await read()
  for (const end = Date.now() + timeout; Date.now() < end; split = await read())
    try {
      assertChatPreviewSplit(split, stage)
      return split
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  assertChatPreviewSplit(split, stage)
  return split
}

/** Review of LKM-559: in the mobile viewport with the chat hidden, the rule edges the pane, never
 *  the phone screen centred in it (that line would cross the device surround and the top bar).
 *  Hides the chat, reads the rule as laid out, then restores the chat. */
export async function assertMobileChatHiddenSplit(host: NativeBridge, timeout = 3000) {
  const fraction = async (target: number) => {
    for (const end = Date.now() + timeout; Date.now() < end; )
      if ((await host.request('layoutInspect')).fraction === target) return
      else await new Promise((resolve) => setTimeout(resolve, 100))
    assert.fail(`mobile, chat hidden: the split reaches fraction ${target}`)
  }
  await host.request('shellPerform', { action: 'expand' })
  await fraction(0)
  let surface: Inspect = {}
  let ok = false
  for (const end = Date.now() + timeout; !ok && Date.now() < end; ) {
    surface = await host.request('previewSurfaceInspect')
    ok =
      surface.pageX > surface.paneX + 1 &&
      (surface.dividerDrawn !== true || Math.abs(surface.dividerX - surface.paneX) <= 0.5)
    if (!ok) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const detail = JSON.stringify(surface)
  assert.ok(
    surface.pageX > surface.paneX + 1,
    `mobile, chat hidden: the phone sits inset: ${detail}`
  )
  assert.ok(
    surface.dividerDrawn !== true || Math.abs(surface.dividerX - surface.paneX) <= 0.5,
    `mobile, chat hidden: the rule edges the pane, not the phone screen: ${detail}`
  )
  await host.request('shellPerform', { action: 'expand' })
  await fraction(1)
  return surface
}
