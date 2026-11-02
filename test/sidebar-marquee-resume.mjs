import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// The fixture must not read the host's Reduce Motion setting: a runner with it on never scrolls.
const fixture = readFileSync('test/fixtures/sidebar-marquee-resume/main.swift', 'utf8')
assert.ok(
  fixture.includes('reduceMotionOverride = false') &&
    !/reduceMotionOverride\s*=\s*nil/.test(fixture),
  'the fixture pins Reduce Motion off and never hands it back to the host'
)
assert.ok(
  fixture.indexOf('reduceMotionOverride = false') < fixture.indexOf('.start('),
  'Reduce Motion is off before the first title starts'
)

// LKM-433: a reload rebuilds the hovered row's title, and the scroll must not start over. The
// real SidebarMarqueeTitle runs offscreen; a new one takes over with the old one's start time.
if (process.platform !== 'darwin') {
  console.log('SIDEBAR-MARQUEE-RESUME SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-marquee-resume', [
    'test/fixtures/sidebar-marquee-resume/main.swift',
    'src/native/SidebarMarquee.swift',
    'src/native/SidebarIcon.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const dump = JSON.stringify(report)
  assert.ok(report.scrolled > 0, `the first title scrolled: ${dump}`)
  assert.equal(report.handed, true, `a running title reports when it began: ${dump}`)
  assert.equal(report.stoppedStart, true, `a stopped title reports none: ${dump}`)
  assert.ok(report.carried >= report.scrolled, `the new title carries on at once: ${dump}`)
  assert.equal(report.afresh, 0, `a title started afresh waits at its start: ${dump}`)
  assert.equal(report.resumedRunning, true, dump)
  assert.ok(report.resumedNow > report.carried, `and keeps moving: ${dump}`)
  // Hovered before a window: nothing to run yet, and it starts when it arrives.
  assert.equal(report.lateBeforeWindow, false, dump)
  assert.equal(report.lateRunning, true, `a title scrolls once it has a window: ${dump}`)
  console.log('SIDEBAR-MARQUEE-RESUME PASS')
}
