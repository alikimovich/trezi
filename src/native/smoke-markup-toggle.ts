import assert from 'node:assert/strict'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>
type Rect = { x: number; y: number; width: number; height: number }

/**
 * LKM-448: the top bar Mark up segment is a real toggle, and the controls float in an island
 * over the preview. Each cycle takes posted clicks on the segment itself: the first enters, the
 * second cancels through the overlay's own Cancel (nothing is attached, sent or saved), and the
 * next enters again. Before, during and after each, the WKWebView and its container keep their
 * window frames and the page keeps innerWidth, innerHeight and scrollY: no row, inset or
 * resize. Select and Mark up show their on state alike. The native proof itself (a real pointer,
 * 850 pt, resize while active, the light/dark matrix) is the operator's
 * `markup-toggle-overlay-native`; this smoke records the same states for it.
 */
export function markupToggleChecks(
  host: NativeBridge,
  click: (segment: string) => Promise<unknown>,
  shot: (name: string) => Promise<void>,
  results: State
) {
  const shell = (): Promise<State> => host.request('shellInspect')
  const markup = (): Promise<State> => host.request('previewMarkupInspect')
  const composer = (): Promise<State> => host.request('composerInspect')
  const chat = (): Promise<State> => host.request('chatInspect')
  const page = async (): Promise<State> =>
    JSON.parse(
      (await host.request('evaluate', {
        view: 'preview',
        code: 'JSON.stringify({innerWidth, innerHeight, scrollY})'
      })) as string
    )
  const geometry = async () => {
    const { geometry } = await markup()
    return { webView: geometry.webView, container: geometry.container, page: await page() }
  }
  const unchanged = (now: State, was: State, label: string) =>
    assert.deepEqual(now, was, `${label}: the preview keeps its frames, viewport and scroll`)
  const near = (a: number, b: number, label: string) =>
    assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} vs ${b}`)
  /** The island floats at the top of the snapshot, which lies exactly on the live page. */
  const island = (open: State, frames: State, label: string) => {
    const { frame, snapshot, hitIsland, hitBeside } = open.island as {
      frame: Rect
      snapshot: Rect
      hitIsland: boolean
      hitBeside: boolean
    }
    const web = frames.webView as Rect
    for (const key of ['x', 'y', 'width', 'height'] as const)
      near(snapshot[key], web[key], `${label}: the snapshot's ${key} is the page's`)
    // Window points run up: the island's top edge sits 10 pt under the page's.
    near(frame.y + frame.height, snapshot.y + snapshot.height - 10, `${label}: island at the top`)
    near(frame.x + frame.width / 2, snapshot.x + snapshot.width / 2, `${label}: island centred`)
    assert.ok(frame.x >= snapshot.x && frame.x + frame.width <= snapshot.x + snapshot.width)
    assert.equal(hitIsland, true, `${label}: the island takes its own clicks`)
    assert.equal(hitBeside, true, `${label}: the pen draws right beside it`)
  }
  const resting = async (label: string) => {
    const rest = await waitFor(async () => {
      const state = await shell()
      return !state.markupActive && state
    }, `${label}: the button returns to rest`)
    assert.deepEqual(
      [
        rest.markupProminent,
        rest.markupSegmentProminent,
        rest.markupToolTip,
        rest.markupAccessibility,
        rest.markupEnabled
      ],
      [false, false, 'Mark up', 'Mark up', true],
      `${label}: no accent, the idle tooltip and label, and still clickable`
    )
  }
  const enter = async (label: string) => {
    await click('markup')
    const open = await waitFor(async () => {
      const state = await markup()
      return state.open && state
    }, `${label}: a click enters Mark up`)
    const on = await shell()
    assert.deepEqual(
      [on.markupActive, on.markupProminent, on.markupSegmentProminent, on.markupToolTip],
      [true, true, true, 'Cancel Mark up'],
      `${label}: the segment shows Mark up on and says a click cancels`
    )
    assert.equal(on.markupAccessibility, 'Cancel Mark up', `${label}: VoiceOver too`)
    return open
  }
  /** The second click: the same guarded Cancel, with nothing attached, sent or asked. */
  const leave = async (label: string) => {
    const [draft, messages] = [await composer(), (await chat()).messages?.length ?? 0]
    await click('markup')
    await waitFor(async () => !(await markup()).open, `${label}: a second click cancels`)
    await resting(label)
    const after = await composer()
    assert.equal(after.attachments.length, draft.attachments.length, `${label}: nothing attached`)
    assert.equal(after.text, draft.text, `${label}: the draft is kept`)
    assert.equal((await chat()).messages?.length ?? 0, messages, `${label}: nothing is sent`)
    assert.equal((await host.request('sheetInspect')).visible, false, `${label}: no dialog`)
  }

  /** `cycles` enter → stroke → cancel rounds at the current width, then one more entry works. */
  const cycle = async (stage: string, cycles: number) => {
    const before = await geometry()
    const runs: State[] = []
    for (let round = 1; round <= cycles; round++) {
      const label = `${stage} #${round}`
      const open = await enter(label)
      const during = await geometry()
      unchanged(during, before, `${label} open`)
      island(open, during, label)
      await host.request('previewMarkupTest', { action: 'button', label: 'Pen' })
      await host.request('previewMarkupTest', {
        action: 'pointer',
        points: [
          [60, 200],
          [140, 240],
          [220, 200]
        ]
      })
      assert.equal((await markup()).undoEnabled, true, `${label}: the stroke is a mark`)
      if (round === 1) await shot(`markup-${stage}-open`)
      await leave(label)
      unchanged(await geometry(), before, `${label} closed`)
      runs.push({ session: open.session, island: open.island.frame, geometry: during })
    }
    assert.equal(new Set(runs.map((run) => run.session)).size, cycles, `${stage}: new sessions`)
    results.markupToggle ??= {}
    results.markupToggle[stage] = { before, runs }
  }

  /** While Mark up is on, the window resizes: the island follows the page, then closes cleanly. */
  const resize = async (from: number, to: number) => {
    const width = async (size: number) => {
      await host.request('shellPerform', { action: 'window-width', row: String(size) })
      await waitFor(async () => Math.abs((await shell()).windowWidth - size) < 1, `width ${size}`)
    }
    const closed = await geometry()
    const open = await enter(`resize ${from}`)
    await width(to)
    const resized = await waitFor(async () => {
      const state = await markup()
      const frames = await geometry()
      return state.open && Math.abs(state.island.snapshot.width - frames.webView.width) <= 1
        ? { state, frames }
        : false
    }, `resize ${from} → ${to}: the snapshot follows the page`)
    island(resized.state, resized.frames, `resized to ${to}`)
    assert.equal(resized.state.session, open.session, 'a resize keeps the session')
    await shot(`markup-resized-${to}`)
    await width(from)
    await leave(`resize back to ${from}`)
    unchanged(await geometry(), closed, `resize back to ${from}`)
  }

  /** Select and Mark up on: the same accent glyph on each segment, and no fill left after. */
  const states = async () => {
    await click('select-object')
    const selecting = await waitFor(async () => {
      const state = await shell()
      return state.selectMode && state
    }, 'Select turns on')
    await click('select-object')
    await waitFor(async () => !(await shell()).selectMode, 'Select turns off')
    const off = await shell()
    assert.deepEqual(
      [selecting.selectProminent, selecting.selectSegmentProminent],
      [true, true],
      'Select on: the accent glyph, as Mark up'
    )
    assert.deepEqual(
      [off.selectProminent, off.selectSegmentProminent],
      [false, false],
      'Select off: no accent left'
    )
    results.markupToggleStates = {
      select: [selecting.selectProminent, selecting.selectSegmentProminent],
      selectOff: [off.selectProminent, off.selectSegmentProminent]
    }
  }

  return { cycle, resize, states }
}
