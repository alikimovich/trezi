// LKM-599: the inspector's draft actions are pinned at the island's foot. The real
// NativeEditingInspector (src/native/EditingInspector.swift) runs in an off-screen window
// with 40 Styles fields at the default width (300) and the narrowest (220), a normal and a
// short island. Apply, Undo draft and Revert draft must be inside the island, below the
// scrolling fields, at the same place before and after the fields scroll to their end, and
// a real click on each must send its action. LKM-638: a running Apply never disables the
// fields; the draft actions act on the next draft and are enabled when one is staged.
import assert from 'node:assert/strict'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('INSPECTOR-FOOTER SKIP — macOS AppKit required')
  process.exit(0)
}
const binary = swiftBuild('inspector-footer', [
  'test/fixtures/inspector-footer/main.swift',
  ...[
    'EditingInspector',
    'EditUndo',
    'InspectorNumberStep',
    'FloatingIsland',
    'IslandLayout',
    'SnappedSlider'
  ].map((name) => `src/native/${name}.swift`)
])
const output = runFixture(binary, [], { timeout: 120_000 })
const cases = Object.fromEntries(
  JSON.parse(output.trim().split('\n').pop()).map((c) => [c.case, c])
)
const all = JSON.stringify(cases)
for (const name of ['normal', 'short', 'narrow-short', 'short-applying-next']) {
  const c = cases[name]
  assert.ok(c, `${name} ran: ${all}`)
  assert.ok(c.scrolls && c.offset > 0, `${name}: the fields scroll and were scrolled: ${all}`)
  assert.equal(c.before.length, 3, `${name}: three draft actions below the fields: ${all}`)
  assert.deepEqual(c.after, c.before, `${name}: the row does not move with the fields`)
  assert.ok(c.inFace, `${name}: the row is inside the island`)
  assert.ok(c.belowFields, `${name}: the row never covers the fields`)
  assert.ok(c.hittable, `${name}: nothing covers the buttons`)
  assert.deepEqual(c.clicked, ['apply-drafts', 'undo-draft', 'revert-draft'], `${name}: ${all}`)
  assert.ok(c.scroll[3] >= 100, `${name}: the fields keep room to scroll: ${all}`)
}
// Default width: one row. Narrowest: stacked, each button drawn in full.
assert.ok(new Set(cases.normal.before.map((f) => f[1])).size === 1)
assert.ok(cases['narrow-short'].before.every((f) => f[0] + f[2] <= 20 + 220 - 14 + 0.5))
// LKM-638: a running Apply with nothing new staged leaves nothing to Apply, Undo or Revert,
// but never locks the fields; with the next draft staged its actions are live (above).
const applying = cases['short-applying']
assert.equal(applying.before.length, 0, `no draft action while nothing new is staged: ${all}`)
assert.equal(applying.pressDisabled, '', 'a press on the disabled Apply sends nothing')
for (const name of ['short-applying', 'short-applying-next'])
  assert.ok(cases[name].fieldsEnabled > 0, `${name}: the fields stay editable: ${all}`)
console.log('INSPECTOR-FOOTER PASS — pinned, in view and clickable at 300×720, 300×300 and 220×300')
