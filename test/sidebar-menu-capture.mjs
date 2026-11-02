import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-441: the sidebar "…" menu capture always ends in `shot` or `shotError`, and leaves no
// observer, timer or task behind. A pipe command runs in a main-queue block, and a nested run
// loop inside one never drains the main queue: the capture's main-actor task waited for the 3 s
// fallback and the result had neither key (native runs 34 to 51). The fixture drives the real
// `SidebarMenuRun` through a tracking run loop like a popped-up menu's, both ways.
if (process.platform !== 'darwin') {
  console.log('SIDEBAR-MENU-CAPTURE SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-menu-capture', [
    'test/fixtures/sidebar-menu-capture/main.swift',
    'src/native/SidebarMenuCapture.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const dump = (name) => `${name}: ${JSON.stringify(report[name])}`
  const clean = (name) => {
    const { capture, after, opened, closed } = report[name]
    assert.ok(opened && closed, `${dump(name)}: the menu opened and closed`)
    assert.equal(capture.observers, 2, `${dump(name)}: both tracking observers`)
    assert.equal(capture.observersRemoved, 2, `${dump(name)}: both observers removed`)
    assert.equal(capture.timersValid, false, `${dump(name)}: the timers are invalidated`)
    assert.equal(capture.taskPending, false, `${dump(name)}: no capture task is left`)
    assert.equal(after.staleObserver, false, `${dump(name)}: a later menu is not observed`)
    assert.equal(after.taskPending, false, `${dump(name)}: no task later either`)
    assert.equal(after.sameShot, true, `${dump(name)}: a late task does not change the result`)
    assert.equal(after.lateCancels, 0, `${dump(name)}: a late task does not close a menu`)
  }
  const receipt = (name) => {
    const { shot, shotError } = report[name]
    assert.ok(shot !== undefined || shotError !== undefined, `${dump(name)}: shot or shotError`)
  }

  // The broker's path: the capture runs while the menu is open, then closes it.
  const deferred = report.deferred
  receipt('deferred')
  assert.equal(deferred.shot?.png, 'fixture', `${dump('deferred')}: the capture's image`)
  assert.equal(deferred.shotError, undefined, dump('deferred'))
  assert.ok(deferred.capture.started && deferred.capture.completed, dump('deferred'))
  assert.equal(deferred.capture.fallbackCancel, false, `${dump('deferred')}: no fallback`)
  assert.ok(
    deferred.seconds < 2,
    `${dump('deferred')}: closed by the capture, not the 3 s fallback`
  )
  clean('deferred')

  // Called inside a main-queue block, as on 01a19bee: the task cannot start before the fallback,
  // and the result says so instead of leaving both keys out.
  const starved = report.mainQueue
  receipt('mainQueue')
  assert.equal(starved.shot, undefined, dump('mainQueue'))
  assert.match(
    starved.shotError,
    /did not finish before the 3 s fallback cancel/,
    dump('mainQueue')
  )
  assert.ok(starved.capture.fallbackCancel && starved.capture.taskCancelled, dump('mainQueue'))
  assert.ok(starved.seconds >= 2.9, `${dump('mainQueue')}: the fallback closed it`)
  clean('mainQueue')

  // A capture that outlasts the fallback is cancelled and recorded as an error.
  const slow = report.slow
  receipt('slow')
  assert.match(slow.shotError, /did not finish before the 3 s fallback cancel/, dump('slow'))
  assert.ok(
    slow.capture.started && slow.capture.fallbackCancel && slow.capture.taskCancelled,
    dump('slow')
  )
  assert.ok(slow.seconds >= 2.9 && slow.seconds < 5, `${dump('slow')}: the 3 s fallback`)
  clean('slow')

  // No capture requested: closed after 0.3 s, with no shot keys, as before.
  const plain = report.plain
  assert.equal(plain.capture.requested, false, dump('plain'))
  assert.ok(plain.shot === undefined && plain.shotError === undefined, dump('plain'))
  assert.ok(plain.seconds < 2, dump('plain'))
  clean('plain')

  // The pipe delivers a menu command outside the main-queue block.
  const broker = readFileSync(new URL('../src/native/HostInspect.swift', import.meta.url), 'utf8')
  assert.match(
    broker,
    /case "sidebarVerification":[\s\S]*?SidebarMenuRun\.outsideMainQueue \{[^}]*verifySidebar\(c\)/,
    'HostInspect.swift runs a sidebar menu command outside the main queue'
  )
  console.log('SIDEBAR-MENU-CAPTURE PASS')
}
