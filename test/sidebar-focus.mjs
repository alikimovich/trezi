import assert from 'node:assert/strict'
import {
  assertSidebarFocusClean,
  restoreSidebarFocus,
  withSidebarCleanup
} from '../src/native/smoke-sidebar.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// Fake host: each sidebarFocus request pops the next report; cleanup requests are recorded.
const host = (reports) => {
  const calls = []
  return {
    calls,
    request: async (method, args = {}) => {
      calls.push(args.cleanup ? `${method}:cleanup` : method)
      return reports.length > 1 ? reports.shift() : reports[0]
    }
  }
}
const dirty = {
  problems: [
    'menu still tracking: Project Memory…',
    "main window is not key (key window: NSWindow 'Project Memory')"
  ]
}
const clean = { problems: [] }

assertSidebarFocusClean(clean, 'fixture')
assert.throws(() => assertSidebarFocusClean(undefined, 'fixture'), /no focus report/)
assert.throws(
  () => assertSidebarFocusClean(dirty, 'reorder at 180'),
  /reorder at 180 left the foreground dirty: menu still tracking: Project Memory….*key window: NSWindow 'Project Memory'/
)

// Cleanup is requested first, then the report is polled until AppKit settles.
const settling = host([dirty, dirty, clean])
await restoreSidebarFocus(settling, 'menu')
assert.deepEqual(settling.calls, ['sidebarFocus:cleanup', 'sidebarFocus', 'sidebarFocus'])
// A leftover that never clears fails with its name; no capture is retried.
await assert.rejects(
  restoreSidebarFocus(host([dirty]), 'menu', 200),
  /menu left the foreground dirty: menu still tracking/
)

// Teardown and cleanup run after a failing body, and the original error survives.
let torn = false
const failing = host([dirty])
await assert.rejects(
  withSidebarCleanup(
    failing,
    async () => {
      throw new Error('Chat window is not in the foreground')
    },
    async () => {
      torn = true
    }
  ),
  (err) =>
    /^Chat window is not in the foreground\n\(sidebar teardown also failed: .*menu still tracking/.test(
      err.message
    )
)
assert.ok(torn && failing.calls[0] === 'sidebarFocus:cleanup', 'Teardown path runs on failure')
// A passing body that leaves the foreground dirty still fails.
await assert.rejects(
  withSidebarCleanup(host([dirty]), async () => {}),
  /teardown left the foreground dirty/
)
await withSidebarCleanup(host([clean]), async () => {})

if (process.platform !== 'darwin') {
  console.log('SIDEBAR-FOCUS SKIP (Swift half) — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-focus', [
    'test/fixtures/sidebar-focus/main.swift',
    'src/native/SidebarFocus.swift'
  ])
  console.log(runFixture(binary).trim())
}
console.log(
  'SIDEBAR FOCUS CLEANUP PASS — teardown runs on failure, leftovers are named, the capture guard is never retried'
)
