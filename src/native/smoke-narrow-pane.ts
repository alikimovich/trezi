import assert from 'node:assert/strict'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { SPLIT_CLEARANCE } from './smoke-split'
import { nativeWorkspace } from './workspace-runtime'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Inspect = Record<string, any>

/** The chat pane's minimum width (`NativeChatDivider.drag`); the check never widens it. */
export const MINIMUM_CHAT_WIDTH = 320
export const NARROW_PANE_TITLE = 'A conversation title far too long for a narrowed chat pane'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const rect = (value: unknown) => (String(value ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

async function settle(host: NativeBridge, label: string, check: (shell: Inspect) => boolean) {
  let shell: Inspect = {}
  for (const end = Date.now() + 5000; Date.now() < end; await pause(100)) {
    shell = await host.request('shellInspect')
    if (check(shell)) return shell
  }
  assert.fail(`Narrow pane: ${label} did not settle: ${JSON.stringify(shell)}`)
}

/** New Chat sits in its slot on the column edge and the viewport island's slot starts there:
 *  the island (glass and hit region) lies entirely right of the chat/preview rule. */
function splitSettled(shell: Inspect, width: number) {
  const column = shell.detailLeading + Number(shell.chatWidth)
  const viewport = rect(shell.toolbarItemFrames?.viewport)
  const [newX, , newWidth] = rect(shell.chatNewFrame)
  return (
    Math.abs(Number(shell.chatWidth) - width) <= 0.5 &&
    shell.chatNewVisible === true &&
    viewport.length === 4 &&
    viewport[0] >= column - 0.5 &&
    newWidth > 0 &&
    Math.abs(newX + newWidth - column) <= 0.5
  )
}

/** LKM-588: the narrowed chat pane keeps New Chat and the viewport island in their own panes. */
export function assertNarrowPane(shell: Inspect, state: Inspect, ready: boolean, stage: string) {
  const split = state.divider
  const detail = JSON.stringify({
    shell: { ...shell, rows: undefined, sidebarChats: undefined },
    split
  })
  assert.equal(
    shell.chatWidth,
    MINIMUM_CHAT_WIDTH,
    `${stage}: the pane is at its minimum: ${detail}`
  )
  assert.equal(shell.chatNewVisible, true, `${stage}: New Chat stays in the toolbar: ${detail}`)
  assert.equal(shell.chatNewEnabled, ready, `${stage}: New Chat is enabled once ready: ${detail}`)
  assert.equal(shell.chatNewGlyph, 'New Chat', `${stage}: New Chat keeps its symbol: ${detail}`)
  assert.equal(shell.chatNewAccessibilityRole, 'AXButton', `${stage}: New Chat is a button`)
  assert.equal(shell.chatNewAccessibilityLabel, 'New Chat', `${stage}: New Chat keeps its label`)
  assert.equal(
    shell.chatNewHit?.hittable,
    true,
    `${stage}: a click on New Chat reaches it: ${detail}`
  )
  const [buttonX, , buttonWidth] = rect(shell.chatNewRenderedFrame)
  assert.ok(buttonWidth >= 28, `${stage}: New Chat keeps its full size: ${detail}`)
  assert.ok(
    buttonX + buttonWidth <= split.ruleMinX - SPLIT_CLEARANCE + 0.5,
    `${stage}: New Chat stays left of the rule: ${detail}`
  )
  // The viewport island's whole slot (its glass and every hit region inside it) starts at the
  // pane edge, and its drawn control the shared 3 pt right of the rule (LKM-587).
  assert.ok(
    split.previewSlotLeading >= split.column - 0.5,
    `${stage}: the viewport island's slot starts at or right of the column edge: ${detail}`
  )
  assert.ok(
    split.previewLeading >= split.ruleMaxX + SPLIT_CLEARANCE - 0.5,
    `${stage}: the viewport island is drawn right of the rule: ${detail}`
  )
  assert.equal(split.spansTopBar, true, `${stage}: the rule runs through the top bar: ${detail}`)
  // The title gives way first: truncated inside its header, or hidden; never over New Chat.
  if (shell.chatHeaderContentVisible) {
    const [titleX, , titleWidth] = rect(shell.chatTitleFrame)
    assert.ok(
      titleX + titleWidth <= shell.chatHeaderTrailing + 0.5 && titleX + titleWidth <= buttonX,
      `${stage}: the title truncates inside its header, before New Chat: ${detail}`
    )
  }
}

/** Narrows the chat pane with the split's own divider (sidebar collapsed, as reported, then
 *  open), checks the toolbar in that state and after widening it again, then restores the
 *  sidebar and the pane's width. `capture` is the chat gate's capture (geometry, rule, PNG). */
export async function checkNarrowPaneToolbar(
  host: NativeBridge,
  capture: (stage: string) => Promise<Inspect>,
  stage: string,
  ready: boolean,
  longTitle = false
) {
  const original = await host.request('shellInspect')
  const width = Number(original.chatWidth)
  const collapsed = original.sidebarCollapsed === true
  assert.ok(width > MINIMUM_CHAT_WIDTH, `${stage}: the pane starts wider than its minimum`)
  const key = nativeWorkspace.active?.activeSessionKey
  const rename = async (title: string) => {
    assert.ok(key, `${stage}: a selected chat to rename`)
    const renamed = await nativeChat.services.invoke('agent:rename-chat', key, title)
    assert.ok(renamed.ok, `${stage}: renamed the chat to "${title}"`)
    const live = nativeChat.chats.get(key)
    if (live) live.title = renamed.title
    nativeWorkspace.changed()
    await settle(
      host,
      `title "${title}"`,
      (shell) => String(shell.chatTitle).trim() === String(renamed.title).trim()
    )
  }
  if (longTitle) await rename(NARROW_PANE_TITLE)
  try {
    return await narrowAndWiden(host, capture, stage, ready, width, collapsed)
  } finally {
    // Later checks may key on the chat's title: give it back its own.
    if (longTitle) await rename(String(original.chatTitle))
  }
}

async function narrowAndWiden(
  host: NativeBridge,
  capture: (stage: string) => Promise<Inspect>,
  stage: string,
  ready: boolean,
  width: number,
  collapsed: boolean
) {
  const results: Inspect[] = []
  try {
    for (const sidebar of ['collapsed', 'open'] as const) {
      if (
        ((await host.request('shellInspect')).sidebarCollapsed === true) !==
        (sidebar === 'collapsed')
      )
        await host.request('shellPerform', { action: 'toggle-sidebar' })
      // Drag past the minimum: the divider clamps at it.
      await host.request('dividerPerform', { delta: -2000 })
      const shell = await settle(
        host,
        `${sidebar} sidebar narrow pane`,
        (state) =>
          state.sidebarCollapsed === (sidebar === 'collapsed') &&
          splitSettled(state, MINIMUM_CHAT_WIDTH)
      )
      const name = `${stage}-narrow-pane-${sidebar}`
      const state = await capture(name)
      assertNarrowPane(await host.request('shellInspect'), state, ready, `Narrow pane ${name}`)
      results.push({
        name,
        shell: { chatWidth: shell.chatWidth, title: shell.chatHeaderContentVisible }
      })
    }
  } finally {
    if (((await host.request('shellInspect')).sidebarCollapsed === true) !== collapsed)
      await host.request('shellPerform', { action: 'toggle-sidebar' })
    // From wherever the pane got to (a failure may come before it reached the minimum).
    const current = Number((await host.request('shellInspect')).chatWidth)
    await host.request('dividerPerform', { delta: width - current })
  }
  // Widened again: the title returns and New Chat follows the column edge.
  await settle(
    host,
    'widened pane',
    (state) => splitSettled(state, width) && state.chatHeaderContentVisible === true
  )
  const restored = await capture(`${stage}-pane-restored`)
  const shell = await host.request('shellInspect')
  assert.equal(shell.chatHeaderContentVisible, true, `${stage}: the title returns when widened`)
  assert.equal(shell.chatNewVisible, true, `${stage}: New Chat stays when widened`)
  assert.equal(
    shell.chatNewHit?.hittable,
    true,
    `${stage}: New Chat stays hittable when widened: ${JSON.stringify(shell.chatNewHit)}`
  )
  return { results, restored: restored.divider }
}
