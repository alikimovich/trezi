/**
 * LKM-456: the rules of the opt-in `fullscreen-popout-close-native` acceptance for LKM-444
 * (`bun run acceptance:source-popout`, docs/TESTING.md). `smoke-source-popout-acceptance.ts`
 * applies them to the real host; `test/source-popout-acceptance.mjs` checks them against
 * GREEN and RED inputs without a desktop.
 */

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>

/** RED modes. `legacy-order-out`: the input's hide orders the full-screen pop-out out at once,
 *  as `sourceState` did before LKM-444 (252f23a5^ `Host.swift`), in the test profile only. */
export const SOURCE_POPOUT_RED_MODES = ['legacy-order-out'] as const

/** How the check's input reaches the app, as every receipt states it. */
export const SOURCE_POPOUT_INPUT_ROUTE = 'NSApp.postEvent'
export const SOURCE_POPOUT_INPUT_ORIGIN =
  'programmatic: window-targeted NSEvents posted to the app event queue (NSApplication.sendEvent, window hit-testing, menu key equivalents); not OS or HID hardware input'

/** The full-screen close the RED must fail on, with the stranded state it must record. */
export const SOURCE_POPOUT_RED_STEP = 'fullscreen-close-control'

/** Every lifecycle assertion of the `source-popout` smoke's `closed` (smoke-source-popout.ts),
 *  in its order, as problems; empty when the closed pop-out left a usable main window. */
export function closedProblems(
  state: State,
  label: string,
  expected: { full: boolean; text: string; selection: [number, number] }
): string[] {
  const problems: string[] = []
  const fail = (ok: unknown, what: string) => {
    if (!ok) problems.push(`${label}: ${what}`)
  }
  fail(state.settled, 'not settled')
  fail(state.visible === false, 'the pop-out is still on screen')
  fail(state.fullScreen === false, 'the pop-out is still in full screen')
  fail(state.phase === 'windowed', `phase ${state.phase}, not windowed`)
  fail(state.pendingHide === false, 'a hide is still pending')
  fail(state.strayFullScreenWindows === 0, 'a full-screen window is left')
  fail(state.mainVisible, 'the main window is not visible')
  fail(state.mainKey && state.keyIsMain, 'the main window is not key')
  fail(state.mainOnActiveSpace, 'the main window is not on the active Space')
  fail(
    state.composerFocus && state.hitTest && !state.ignoresMouse,
    'keyboard and pointer do not reach the main window'
  )
  const steps: string[] = Array.isArray(state.steps) ? state.steps : []
  const out = steps.lastIndexOf('order-out')
  fail(out >= 0, 'never ordered out')
  if (expected.full && out >= 0)
    fail(steps[out - 1] === 'windowed', 'ordered out before didExitFullScreen')
  fail(state.text === expected.text, 'the draft changed')
  fail(
    Array.isArray(state.selection) &&
      state.selection[0] === expected.selection[0] &&
      state.selection[1] === expected.selection[1],
    `the selection is ${JSON.stringify(state.selection)}`
  )
  return problems
}

/** The input receipt of a close or probe: posted through the stated route, after a preflight
 *  that found the app active, the target window key and the point on the intended control. */
export function receiptProblems(receipt: State | undefined, label: string): string[] {
  if (!receipt) return [`${label}: no input receipt`]
  if (receipt.refused) return [`${label}: input refused before posting: ${receipt.refused}`]
  const problems: string[] = []
  if (receipt.posted !== true) problems.push(`${label}: no event was posted`)
  if (receipt.route !== SOURCE_POPOUT_INPUT_ROUTE)
    problems.push(`${label}: route ${receipt.route}, not ${SOURCE_POPOUT_INPUT_ROUTE}`)
  if (receipt.origin !== SOURCE_POPOUT_INPUT_ORIGIN) problems.push(`${label}: unlabelled origin`)
  if (!receipt.preflight?.appActive) problems.push(`${label}: the app was not active`)
  if (receipt.kind === 'pointer' && !receipt.preflight?.hitIsTarget)
    problems.push(`${label}: the point did not hit-test to ${receipt.target}`)
  if (receipt.kind === 'keyboard' && !receipt.preflight?.targetKey)
    problems.push(`${label}: ${receipt.target} was not the key window`)
  return problems
}

/** The main window after a close, reached through posted pointer and keyboard input: the click
 *  lands on the composer and focuses it, a typed character reaches it and Delete takes it back. */
export function probeProblems(probe: State | undefined, label: string): string[] {
  if (!probe) return [`${label}: no main-window input probe`]
  const problems = [
    ...receiptProblems(probe.click, `${label} click`),
    ...receiptProblems(probe.type, `${label} type`),
    ...receiptProblems(probe.erase, `${label} delete`)
  ]
  if (problems.length) return problems
  if (!probe.focused) problems.push(`${label}: the click did not focus the composer`)
  if (!probe.typed) problems.push(`${label}: the typed key did not reach the composer`)
  if (!probe.restored) problems.push(`${label}: Delete did not restore the composer`)
  if (!probe.mainKey || !probe.appActive)
    problems.push(`${label}: the main window was not key in the active app`)
  return problems
}

/** RED is met only when the run failed on the first full-screen close with the pop-out left in
 *  full screen off screen (the stranded Space), and recorded that state. */
export function redMet(failure: string | null | undefined, stranded: State | undefined): boolean {
  if (!failure || !stranded) return false
  const onStep = failure.includes(`${SOURCE_POPOUT_RED_STEP}:`)
  const lifecycle = /not settled|still in full screen|full-screen window is left/.test(failure)
  return onStep && lifecycle && stranded.visible === false && stranded.fullScreen === true
}

/** The evidence folder of one run: short SHA, mode and start time, so no run overwrites another. */
export function evidenceFolder(sha: string, mode: string, startedAt: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a full commit SHA: ${sha}`)
  return `${sha.slice(0, 12)}-${mode.replace(/[^a-z0-9-]/g, '-')}-${startedAt.replace(/[:.]/g, '-')}`
}
