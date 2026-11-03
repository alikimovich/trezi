import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStamp } from './app-version'
import type { NativeBridge } from './bridge'
import { cleanupSourcePopout } from './smoke-source-popout'
import {
  closedProblems,
  probeProblems,
  receiptProblems,
  SOURCE_POPOUT_INPUT_ORIGIN,
  SOURCE_POPOUT_INPUT_ROUTE,
  SOURCE_POPOUT_RED_MODES,
  SOURCE_POPOUT_RED_STEP
} from './source-popout-acceptance'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>
type Inspect = (method: string, check: (state: State) => boolean) => Promise<State>
type Input = 'editor-close' | 'editor-dock' | 'window-close' | 'cmd-w'

export const SOURCE_POPOUT_ACCEPTANCE_DIR = 'source-popout-acceptance'
const SELECTION: [number, number] = [5, 7]

/**
 * LKM-456: LKM-444's `fullscreen-popout-close-native`, opt-in (`--source-popout-acceptance`;
 * the operator command is `bun run acceptance:source-popout`, docs/TESTING.md). Every close,
 * dock and main-window probe is a click or key press posted to the app's event queue
 * (SourcePopoutAcceptance.swift) after a preflight; nothing is closed through a control's
 * callback, `performClick` or the menu directly. Covered: the editor's ×, the red button and
 * ⌘W from full screen, dock from full screen, close and dock while entering and while leaving
 * full screen, three repeated rounds, and the windowed pop-out and a docked editor in a
 * full-screen main window as negative controls. After each: every `source-popout` lifecycle
 * assertion, then the main window reached by a click and typed keys. Each step's state is saved
 * before its fallible part. Evidence: test/artifacts/native/source-popout-acceptance/.
 */
export async function checkSourcePopoutAcceptance(
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  inspect: Inspect,
  open: (source?: string) => Promise<unknown>
) {
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1')
    throw new Error(
      'The pop-out acceptance needs the foreground; unset TREZI_NATIVE_BACKGROUND_TEST'
    )
  const red = process.env.TREZI_SOURCE_POPOUT_ACCEPTANCE_RED || ''
  if (red && !(SOURCE_POPOUT_RED_MODES as readonly string[]).includes(red))
    throw new Error(`Unknown TREZI_SOURCE_POPOUT_ACCEPTANCE_RED: ${red}`)
  const dir = join(artifacts, SOURCE_POPOUT_ACCEPTANCE_DIR)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const build = buildStamp()
  const prefix = build?.sha ? build.sha.slice(0, 12) : 'unstamped'
  const steps: State = {}
  const evidence: State = {
    check: 'fullscreen-popout-close-native',
    ticket: 'LKM-444',
    fixture: 'LKM-456',
    build,
    red: red || null,
    startedAt: new Date().toISOString(),
    input: { route: SOURCE_POPOUT_INPUT_ROUTE, origin: SOURCE_POPOUT_INPUT_ORIGIN },
    setup:
      'draft and selection are set through the sourceVerification test hook (select, type); full screen is entered with toggleFullScreen; reopening is source:popout. None of these is input proof.',
    outcome: 'running',
    steps,
    captures: []
  }
  const record = () =>
    writeFileSync(join(dir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  const acceptance = (op: string, extra: State = {}): Promise<State> =>
    host.request('sourcePopoutAcceptance', { root: fixture, op, ...extra })
  const verification = (popout: string, extra: State = {}): Promise<State> =>
    host.request('sourceVerification', { root: fixture, popout, key: true, ...extra })
  const perform = (action: string) =>
    host.request('sourcePerform', { action: { root: fixture, action } })
  const shot = async (name: string, window = 'main') => {
    const image = await verification('capture', { window })
    const file = `${prefix}-${name}.png`
    writeFileSync(join(dir, file), Buffer.from(image.png, 'base64'))
    evidence.captures.push(file)
    record()
  }
  /** LKM-457: a PNG of a step that is about to fail, taken right before its assertion (never
   *  before the input: a capture makes its window key). A capture error is recorded and never
   *  replaces the step's own failure. */
  const failureShot = async (label: string, window: 'main' | 'popout') => {
    try {
      await shot(`failure-${label}`, window)
    } catch (error) {
      steps[label].failureCapture = error instanceof Error ? error.message : String(error)
      record()
    }
  }
  const popped = () => inspect('sourceInspect', (s) => s.visible && s.popped)
  let draft = ''
  const keeps = (state: State, label: string) => {
    assert.equal(state.text, draft, `${label}: the draft survives`)
    assert.deepEqual(state.selection, SELECTION, `${label}: the selection survives`)
  }
  const reopen = async (label: string) => {
    await open()
    await popped()
    const state = await verification('inspect')
    steps[label].reopened = state
    record()
    const kept =
      state.text === draft && JSON.stringify(state.selection) === JSON.stringify(SELECTION)
    if (!(state.editorInPopout && state.visible && kept)) await failureShot(label, 'popout')
    assert.ok(state.editorInPopout && state.visible, `${label}: reopened in the pop-out`)
    keeps(state, `${label} reopened`)
  }

  /** One close or dock by `input`; `before` is how full screen stands when the input lands. */
  const close = async (
    label: string,
    input: Input,
    before: 'windowed' | 'full' | 'entering' | 'exiting',
    redArmed = false
  ) => {
    const entry: State = { input, before, red: redArmed }
    steps[label] = entry
    if (before === 'full') await verification('enter')
    if (before === 'entering') await verification('enter-start')
    if (before === 'exiting') {
      await verification('enter')
      await verification('exit-start')
    }
    if (label === SOURCE_POPOUT_RED_STEP) await shot('fullscreen', 'popout')
    // The state right before the input, recorded before anything that can fail.
    entry.preInput = await acceptance('inspect')
    record()
    // The receipt carries the control's and window's geometry as the preflight read it.
    const sent = await acceptance('input', { input, red: redArmed })
    Object.assign(entry, { receipt: sent.receipt, afterInput: sent.after })
    record()
    const refused = receiptProblems(sent.receipt, label)
    if (refused.length) await failureShot(label, entry.preInput?.visible ? 'popout' : 'main')
    assert.deepEqual(refused, [], `${label}: ${JSON.stringify(sent.receipt)}`)
    entry.closed = await acceptance('wait-closed')
    if (redArmed) evidence.stranded = entry.closed
    record()
    entry.probe = await acceptance('probe')
    record()
    entry.settle = await verification('settle')
    record()
    const closedShot = before !== 'windowed' || redArmed
    if (closedShot) await shot(`closed-${label}`)
    const problems = closedProblems(entry.settle, label, {
      full: before !== 'windowed',
      text: draft,
      selection: SELECTION
    })
    const unusable = probeProblems(entry.probe, label)
    const undocked =
      input === 'editor-dock' &&
      (entry.settle.editorInPopout !== false || entry.settle.editorHidden !== false)
    if (!closedShot && (problems.length || unusable.length || undocked))
      await failureShot(label, 'main')
    assert.deepEqual(problems, [], problems.join('; '))
    assert.deepEqual(unusable, [], `${label}: ${JSON.stringify(entry.probe)}`)
    if (input === 'editor-dock') {
      assert.equal(entry.settle.editorInPopout, false, `${label}: docked into the main window`)
      assert.equal(entry.settle.editorHidden, false, `${label}: the docked editor shows`)
    }
  }
  const popOutAgain = async () => {
    await perform('popout')
    await popped()
  }

  try {
    await open('index.html')
    await popped()
    await verification('select', { location: 0, length: 0 })
    await verification('type', { text: '<!-- LKM-456 pop-out draft -->\n' })
    await inspect('sourceInspect', (s) => s.dirty)
    const selected = await verification('select', { location: SELECTION[0], length: SELECTION[1] })
    draft = selected.text
    assert.ok(draft.startsWith('<!-- LKM-456 pop-out draft -->'), 'the draft was typed')
    evidence.draftLength = draft.length

    // Negative controls: a windowed pop-out closes (×, red button) and docks as before.
    await close('windowed-close-control', 'editor-close', 'windowed')
    await reopen('windowed-close-control')
    await close('windowed-close-button', 'window-close', 'windowed')
    await reopen('windowed-close-button')
    await close('windowed-dock', 'editor-dock', 'windowed')
    await popOutAgain()

    // From full screen: ×, red button, ⌘W, Dock. RED arms only the first, where it must fail.
    await close(SOURCE_POPOUT_RED_STEP, 'editor-close', 'full', !!red)
    await reopen(SOURCE_POPOUT_RED_STEP)
    await close('fullscreen-close-button', 'window-close', 'full')
    await reopen('fullscreen-close-button')
    await close('fullscreen-close-key', 'cmd-w', 'full')
    await reopen('fullscreen-close-key')
    await close('fullscreen-dock', 'editor-dock', 'full')
    await popOutAgain()
    // During the transitions.
    await close('entering-close-control', 'editor-close', 'entering')
    await reopen('entering-close-control')
    await close('entering-dock', 'editor-dock', 'entering')
    await popOutAgain()
    await close('exiting-close-key', 'cmd-w', 'exiting')
    await reopen('exiting-close-key')
    await close('exiting-dock', 'editor-dock', 'exiting')
    await popOutAgain()
    // open → full screen → close → reopen, three rounds through each close path.
    const rounds: Input[] = ['editor-close', 'window-close', 'cmd-w']
    for (const [round, input] of rounds.entries()) {
      await close(`repeat-${round}`, input, 'full')
      await reopen(`repeat-${round}`)
    }

    // Negative control: a docked editor in a full-screen main window closes by its × and shows again.
    await close('docked-for-main-fullscreen', 'editor-dock', 'windowed')
    await host.request('previewOverlayTest', { action: 'fullscreen', value: true })
    try {
      const entry: State = { input: 'editor-close', before: 'main-fullscreen-docked' }
      steps['main-fullscreen-docked'] = entry
      entry.preInput = await acceptance('inspect')
      record()
      const sent = await acceptance('input', { input: 'editor-close' })
      entry.receipt = sent.receipt
      record()
      const refused = receiptProblems(sent.receipt, 'main-fullscreen-docked')
      if (refused.length) await failureShot('main-fullscreen-docked', 'main')
      assert.deepEqual(refused, [])
      await inspect('sourceInspect', (s) => !s.visible)
      // Reopened where it was, docked: `open` without a location keeps `popped`.
      await perform('open')
      entry.shown = await inspect(
        'sourceInspect',
        (s) => s.visible && !s.popped && s.height > 0 && s.width > 0
      )
      entry.mainFullScreen = await host.request('fullscreen')
      entry.probe = await acceptance('probe')
      entry.state = await verification('inspect')
      record()
      const unusable = probeProblems(entry.probe, 'main-fullscreen-docked')
      const kept =
        entry.state.text === draft &&
        JSON.stringify(entry.state.selection) === JSON.stringify(SELECTION)
      if (entry.mainFullScreen !== true || unusable.length || !kept)
        await failureShot('main-fullscreen-docked', 'main')
      assert.equal(entry.mainFullScreen, true, 'the main window stays full screen')
      assert.deepEqual(unusable, [])
      keeps(entry.state, 'docked in a full-screen main window')
      await shot('main-fullscreen-docked')
    } finally {
      await host.request('previewOverlayTest', { action: 'fullscreen', value: false })
    }
    evidence.outcome = 'pass'
  } catch (error) {
    evidence.outcome = 'fail'
    evidence.failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    evidence.finishedAt = new Date().toISOString()
    record()
  }
  console.log(
    `Native source pop-out acceptance${red ? ` (RED ${red})` : ''}: ×, red button, ⌘W and Dock by posted input from full screen, while entering and leaving, repeats and the negative controls left a key, usable main window.`
  )
}

/** Leaves no full-screen pop-out or Space behind (RED strands one on purpose), then the
 *  `source-popout` cleanup; writes what it did to cleanup.json. */
export async function cleanupSourcePopoutAcceptance(
  host: NativeBridge,
  fixture: string,
  artifacts: string
) {
  const cleanup: State = { startedAt: new Date().toISOString() }
  const dir = join(artifacts, SOURCE_POPOUT_ACCEPTANCE_DIR)
  const record = () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`)
  }
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      cleanup[name] = (await run()) ?? 'ok'
    } catch (error) {
      cleanup[name] = { error: error instanceof Error ? error.message : String(error) }
    }
    record()
  }
  await step('recover', () =>
    host.request('sourcePopoutAcceptance', { root: fixture, op: 'recover' })
  )
  await step('mainWindowed', () =>
    host.request('previewOverlayTest', { action: 'fullscreen', value: false })
  )
  await step('sourcePopout', () => cleanupSourcePopout(host, fixture))
  await step('final', () =>
    host.request('sourcePopoutAcceptance', { root: fixture, op: 'inspect' })
  )
  await step('mainFullScreen', () => host.request('fullscreen'))
  const final = cleanup.final as State
  cleanup.clean =
    cleanup.mainFullScreen === false &&
    final?.visible === false &&
    final?.fullScreen === false &&
    final?.phase === 'windowed' &&
    final?.strayFullScreenWindows === 0 &&
    final?.redArmed === false
  cleanup.finishedAt = new Date().toISOString()
  record()
  if (!cleanup.clean)
    throw new Error(`Pop-out acceptance cleanup left state: ${JSON.stringify(final)}`)
}
