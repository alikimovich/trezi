import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>
type Inspect = (method: string, check: (state: State) => boolean) => Promise<State>

/** LKM-444: closing or docking the code editor's pop-out in full screen left a black, empty
 *  full-screen Space and no usable main window. Each close path (the editor's ×, the red
 *  button, ⌘W), docking, a hide while entering or leaving full screen and repeated rounds must
 *  leave the pop-out off screen and out of full screen, the main window key and usable on the
 *  active Space, and the draft and selection as they were. Windowed close/dock and a docked
 *  editor in a full-screen main window are the negative controls. `open` reopens the pop-out
 *  without a location (`source:popout`). */
export async function checkSourcePopout(
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  inspect: Inspect,
  open: (source?: string) => Promise<unknown>
) {
  const background = process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'
  const results: State = { background }
  const save = () =>
    writeFileSync(join(artifacts, 'source-popout.json'), JSON.stringify(results, null, 2))
  const perform = (action: string) =>
    host.request('sourcePerform', { action: { root: fixture, action } })
  const step = (popout: string, extra: State = {}): Promise<State> =>
    host.request('sourceVerification', { root: fixture, popout, key: !background, ...extra })
  const shot = async (name: string, window = 'main') => {
    if (background) return
    const image = await step('capture', { window })
    writeFileSync(join(artifacts, `source-popout-${name}.png`), Buffer.from(image.png, 'base64'))
  }
  const popped = () => inspect('sourceInspect', (s) => s.visible && s.popped)

  await open('index.html')
  await popped()
  // A draft and a selection that must survive every close, reopen and dock.
  await step('select', { location: 0, length: 0 })
  await step('type', { text: '<!-- LKM-444 pop-out draft -->\n' })
  await inspect('sourceInspect', (s) => s.dirty)
  const selected = await step('select', { location: 5, length: 7 })
  const draft = selected.text as string
  assert.ok(draft.startsWith('<!-- LKM-444 pop-out draft -->'), 'the draft was typed')
  const keeps = (state: State, label: string) => {
    assert.equal(state.text, draft, `${label}: the draft survives`)
    assert.deepEqual(state.selection, [5, 7], `${label}: the selection survives`)
  }
  const reopen = async (label: string) => {
    await open()
    await popped()
    const state = await step('inspect')
    assert.ok(state.editorInPopout && state.visible, `${label}: reopened in the pop-out`)
    keeps(state, `${label} reopened`)
  }
  const closed = (state: State, label: string, full: boolean) => {
    results[label] = state
    save()
    const dump = `${label}: ${JSON.stringify(state)}`
    assert.ok(state.settled, `${dump}: settled`)
    assert.equal(state.visible, false, `${dump}: the pop-out is off screen`)
    assert.equal(state.fullScreen, false, `${dump}: the pop-out left full screen`)
    assert.equal(state.phase, 'windowed', dump)
    assert.equal(state.pendingHide, false, dump)
    assert.equal(state.strayFullScreenWindows, 0, `${dump}: no full-screen window is left`)
    assert.ok(state.mainVisible, `${dump}: the main window is visible`)
    if (!background) {
      assert.ok(state.mainKey && state.keyIsMain, `${dump}: the main window is key`)
      assert.ok(state.mainOnActiveSpace, `${dump}: the main window is on the active Space`)
    }
    assert.ok(
      state.composerFocus && state.hitTest && !state.ignoresMouse,
      `${dump}: keyboard and pointer reach it`
    )
    const steps = state.steps as string[]
    const out = steps.lastIndexOf('order-out')
    assert.ok(out >= 0, `${dump}: ordered out`)
    if (full) {
      // Ordered out only after the exit finished, never while in full screen.
      assert.equal(steps[out - 1], 'windowed', `${dump}: ordered out after didExitFullScreen`)
    }
    keeps(state, label)
  }

  // Negative controls: a windowed pop-out closes and docks as before.
  await step('close', { via: 'control' })
  closed(await step('settle'), 'windowed-close', false)
  await reopen('windowed-close')
  await perform('dock')
  await inspect('sourceInspect', (s) => s.visible && !s.popped)
  const docked = await step('settle')
  closed(docked, 'windowed-dock', false)
  assert.equal(docked.editorInPopout, false, 'docked into the main window')
  await perform('popout')
  await popped()

  if (background) {
    results.fullScreen = { skipped: 'background test: full screen needs a foreground window' }
    save()
  } else {
    // Each close path from full screen.
    for (const via of ['control', 'button', 'key']) {
      await step('enter')
      if (via === 'control') await shot('fullscreen', 'popout')
      const close = await step('close', { via })
      if (via === 'key') assert.equal(close.handled, true, '⌘W reached Close Window')
      closed(await step('settle'), `fullscreen-close-${via}`, true)
      await shot(`closed-${via}`)
      await reopen(`fullscreen-close-${via}`)
    }
    // Docking from full screen: the editor moves into the main window.
    await step('enter')
    await perform('dock')
    await inspect('sourceInspect', (s) => s.visible && !s.popped)
    const dock = await step('settle')
    closed(dock, 'fullscreen-dock', true)
    assert.equal(dock.editorInPopout, false, 'docked from full screen')
    await shot('docked')
    await perform('popout')
    await popped()
    // Hidden while entering, and while leaving, full screen.
    await step('enter-start')
    await perform('hide')
    closed(await step('settle'), 'hide-entering', true)
    await reopen('hide-entering')
    await step('enter')
    await step('exit-start')
    await perform('hide')
    closed(await step('settle'), 'hide-exiting', true)
    await reopen('hide-exiting')
    // open → full screen → close → reopen, several times.
    for (let round = 0; round < 3; round++) {
      await step('enter')
      await step('close', { via: 'control' })
      closed(await step('settle'), `repeat-${round}`, true)
      await reopen(`repeat-${round}`)
    }

    // Negative control: a docked editor in a full-screen main window hides and shows.
    await perform('dock')
    await inspect('sourceInspect', (s) => s.visible && !s.popped)
    await host.request('previewOverlayTest', { action: 'fullscreen', value: true })
    try {
      await perform('hide')
      await inspect('sourceInspect', (s) => !s.visible)
      // Reopened where it was, docked: `open` without a location keeps `popped`.
      await perform('open')
      const shown = await inspect(
        'sourceInspect',
        (s) => s.visible && !s.popped && s.height > 0 && s.width > 0
      )
      results.mainFullScreenDocked = shown
      assert.equal(await host.request('fullscreen'), true, 'the main window stays full screen')
      const state = await step('inspect')
      keeps(state, 'docked in a full-screen main window')
      await shot('main-fullscreen-docked')
    } finally {
      await host.request('previewOverlayTest', { action: 'fullscreen', value: false })
    }
  }
  save()
  console.log(
    `Native source pop-out: windowed close and dock${background ? '' : ', full-screen close (×, red button, ⌘W), dock, hide while entering and leaving, repeats and a docked editor in a full-screen main window'} keep the draft and leave the main window key.`
  )
}

/** Leaves the pop-out windowed, docked and hidden with its draft dropped. */
export async function cleanupSourcePopout(host: NativeBridge, fixture: string) {
  const perform = (action: string) =>
    host.request('sourcePerform', { action: { root: fixture, action } })
  await host.request('sourceVerification', { root: fixture, popout: 'exit' }).catch(() => {})
  if ((await host.request('sourceInspect')).popped) await perform('dock')
  if ((await host.request('sourceInspect')).dirty) await perform('reload')
  if ((await host.request('sourceInspect')).visible) await perform('hide')
}
