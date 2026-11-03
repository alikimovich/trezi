import assert from 'node:assert/strict'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-444: closing or docking the code editor's pop-out while it is in full screen ordered the
// window out with its full-screen Space still up, leaving a black, empty Space and no usable main
// window. The real `SourcePopout` must leave full screen first and order the window out only
// after AppKit's exit, whether the hide comes in full screen, while entering or while exiting,
// and then hand the key back to the main window. The fixture scripts AppKit's notifications.
if (process.platform !== 'darwin') {
  console.log('SOURCE-POPOUT SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('source-popout', [
    'test/fixtures/source-popout/main.swift',
    'src/native/SourcePopout.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const dump = (name) => `${name}: ${JSON.stringify(report[name])}`
  const closed = (name, toggles) => {
    const r = report[name]
    assert.equal(r.stranded, 0, `${dump(name)}: never ordered out in full screen`)
    assert.equal(r.toggles, toggles, `${dump(name)}: full-screen toggles`)
    assert.equal(r.orderOuts, 1, `${dump(name)}: ordered out once`)
    assert.equal(r.visible, false, `${dump(name)}: not on screen`)
    assert.equal(r.phase, 'windowed', `${dump(name)}: left full screen`)
    assert.equal(r.pendingHide, false, `${dump(name)}: nothing left pending`)
    assert.equal(r.mainKeyed, 1, `${dump(name)}: the main window is made key`)
    const out = r.steps.indexOf('order-out')
    if (toggles > 0 || name === 'exiting')
      assert.equal(r.steps[out - 1], 'windowed', `${dump(name)}: ordered out after the exit`)
  }

  // Negative control: a windowed pop-out closes at once, as before, without a toggle.
  closed('windowed', 0)
  assert.equal(report.hidden.orderOuts, 0, dump('hidden'))
  assert.equal(report.hidden.mainKeyed, 0, dump('hidden'))

  // In full screen: one exit toggle (a second hide does not toggle back in), no order-out
  // until the exit finished.
  assert.deepEqual(report.fullWaiting, { toggles: 1, orderOuts: 0, visible: true }, dump('full'))
  closed('full', 1)
  // Entering: the toggle waits for didEnter (AppKit ignores one mid-transition).
  assert.deepEqual(report.enteringWaiting, { toggles: 0, orderOuts: 0 }, dump('entering'))
  closed('entering', 1)
  // Exiting already: no new toggle, ordered out on didExit.
  assert.deepEqual(report.exitingWaiting, { toggles: 0, orderOuts: 0 }, dump('exiting'))
  closed('exiting', 0)
  // A failed enter is windowed: ordered out then.
  closed('enterFailed', 0)

  // Shown again before the exit finished: it stays up, windowed.
  const reshown = report.reshown
  assert.deepEqual(
    [reshown.orderOuts, reshown.visible, reshown.phase, reshown.pendingHide, reshown.stranded],
    [0, true, 'windowed', false, 0],
    dump('reshown')
  )

  // A failed exit keeps the window up (ordering out would strand the Space); the next close retries.
  assert.deepEqual(
    report.exitFailedFirst,
    { toggles: 1, orderOuts: 0, visible: true, pendingHide: false },
    dump('exitFailed')
  )
  closed('exitFailed', 2)

  // open → full screen → close → reopen, five times.
  const repeated = report.repeated
  assert.deepEqual(
    [repeated.toggles, repeated.orderOuts, repeated.stranded, repeated.mainKeyed, repeated.visible],
    [5, 5, 0, 5, false],
    dump('repeated')
  )
  console.log('SOURCE-POPOUT PASS')
}
