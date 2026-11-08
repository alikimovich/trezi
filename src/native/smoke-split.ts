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
      split.chatTrailing <= split.x - SPLIT_CLEARANCE + 0.5,
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
      split.previewLeading >= split.x + SPLIT_CLEARANCE - 0.5,
      `${stage}: the preview's toolbar controls start after the rule: ${detail}`
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
