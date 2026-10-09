import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

type Rect = { x: number; y: number; width: number; height: number }
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Report = any
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const empty = (r: Rect) => r.width <= 0 || r.height <= 0
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5
const overlap = (a: Rect, b: Rect) =>
  !empty(a) &&
  !empty(b) &&
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5

/** The frame assertion (window coordinates): the docked inspector lies within the preview
 *  area, clear of the chat column and the page; the chat still takes the pointer. */
function problems(state: Report): string[] {
  const { inspector, area, page, chat, island } = state
  const found: string[] = []
  if (!state.visible || !state.attached || empty(inspector)) found.push('not docked')
  if (!inside(inspector, area)) found.push('inspector outside the preview area')
  if (overlap(inspector, chat)) found.push('inspector overlaps the chat column')
  if (area.x < chat.x + chat.width - 0.5) found.push('preview area overlaps the chat column')
  if (area.y + area.height > state.contentTop + 0.5) found.push('preview area under the toolbar')
  if (!inside(page, area) || overlap(page, inspector)) found.push('page not beside the inspector')
  if (overlap(island, inspector) || overlap(island, chat))
    found.push('editing island not over the page only')
  if (!empty(chat) && state.hits.chat !== 'chat') found.push(`chat point hits ${state.hits.chat}`)
  if (state.hits.inspector !== 'inspector')
    found.push(`inspector point hits ${state.hits.inspector}`)
  return found
}

/** LKM-129: a docked Web Inspector stays in the preview area at the default and minimum
 *  window sizes, with the LKM-122 island open, and open/close/show still work. */
export async function checkPreviewInspector(
  host: NativeBridge,
  artifacts: string,
  toggleIsland: () => void
) {
  const report = (): Promise<Report> => host.request('previewInspector')
  const perform = (action: string): Promise<boolean> => host.request('previewInspector', { action })
  const resize = (size: { windowWidth: number; windowHeight: number }) =>
    host.request('inspectorIsland', size)
  const evidence: Record<string, unknown> = {}
  let last: Report = null
  // WebKit docks and resizes asynchronously: wait for the frames to settle, then assert.
  const confined = async (stage: string) => {
    await waitFor(
      async () => {
        last = await report()
        return problems(last).length === 0
      },
      `docked Web Inspector confined (${stage})`,
      10000,
      () => ({ problems: problems(last), last })
    )
    evidence[stage] = last
    console.log(
      'Native Web Inspector frame',
      stage,
      JSON.stringify({
        inspector: last.inspector,
        area: last.area,
        page: last.page,
        chat: last.chat
      })
    )
    return last
  }
  const island = async (open: boolean) => {
    if (!empty((await report()).island) !== open) toggleIsland()
    await waitFor(
      async () => !empty((await report()).island) === open,
      `editing island ${open ? 'open' : 'closed'}`
    )
  }
  const initial = await waitFor(async () => {
    const state = await report()
    return !state.visible && !state.attached && state
  }, 'Web Inspector closed before the check')
  const restore = { windowWidth: initial.window.width, windowHeight: initial.window.height }
  const closed = initial.page
  try {
    assert.ok(await perform('show'), 'The Web Inspector opens')
    await waitFor(async () => (await report()).visible, 'Web Inspector open')
    // Dock deterministically (WebKit may open it detached); ask again only while it has not docked.
    await waitFor(
      async () => (await report()).attached || ((await perform('attach')) && false),
      'Web Inspector docked',
      10000,
      report,
      500
    )
    const docked = await confined('default')
    assert.ok(
      docked.page.height < closed.height || docked.page.width < closed.width,
      'The page makes room for the docked inspector'
    )
    await island(true)
    await confined('default with editing island')
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
      console.log(
        'Reduced coverage: docked Web Inspector captured offscreen (TREZI_NATIVE_BACKGROUND_TEST).'
      )
      writeFileSync(
        join(artifacts, 'preview-inspector-docked.png'),
        Buffer.from(await host.request('captureShell'), 'base64')
      )
    } else {
      await host.request('inspectorIsland', { prepare: true })
      await delay(350)
      const image = await host.request('inspectorIsland', { capture: true })
      writeFileSync(
        join(artifacts, 'preview-inspector-docked.png'),
        Buffer.from(image.png, 'base64')
      )
    }
    await island(false)
    await resize({ windowWidth: initial.minWindow.width, windowHeight: initial.minWindow.height })
    await confined('minimum window')
    await resize({ windowWidth: restore.windowWidth + 160, windowHeight: restore.windowHeight })
    await confined('wider window')
    await resize(restore)
    await confined('restored window')
    assert.ok(await perform('close'), 'The Web Inspector closes')
    const reopened = await waitFor(async () => {
      const state = await report()
      return !state.visible && !state.attached && state
    }, 'Web Inspector closed')
    for (const key of ['x', 'y', 'width', 'height'] as const)
      assert.ok(
        Math.abs(reopened.page[key] - closed[key]) < 0.5,
        `The page takes the whole preview area again: ${JSON.stringify({ page: reopened.page, closed })}`
      )
    // Show after close reopens it, docked again as WebKit remembers the choice.
    assert.ok(await perform('show'))
    await waitFor(async () => (await report()).visible, 'Web Inspector reopened')
    if ((await report()).attached) await confined('reopened')
    assert.ok(await perform('close'))
    await waitFor(async () => !(await report()).visible, 'Web Inspector closed again')
  } finally {
    if (!empty((await report()).island)) toggleIsland()
    await perform('close')
    await resize(restore)
    writeFileSync(join(artifacts, 'preview-inspector.json'), JSON.stringify(evidence, null, 2))
  }
  console.log(
    'Native Web Inspector: docked frame inside the preview area and clear of the chat at default, minimum and wider windows, with the editing island open; open/close/reopen pass.'
  )
}
