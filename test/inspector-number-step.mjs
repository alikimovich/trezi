// LKM-601: Up/Down arrow stepping in the inspector's numeric fields. The real
// NativeEditingInspector (src/native/EditingInspector.swift, src/native/InspectorNumberStep.swift)
// runs in an off-screen window; each case focuses one production TextField and sends real
// arrow keys through the app's event path (queued, dequeued, sent). A step previews its value
// once and keeps focus and selection; Return or leaving a style field stages it once; nothing
// dispatches Apply; disabled, non-numeric and text fields are untouched.
import assert from 'node:assert/strict'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('INSPECTOR-NUMBER-STEP SKIP — macOS AppKit required')
  process.exit(0)
}
const binary = swiftBuild('inspector-number-step', [
  'test/fixtures/inspector-number-step/main.swift',
  ...[
    'EditingInspector',
    'EditUndo',
    'InspectorNumberStep',
    'FloatingIsland',
    'IslandLayout',
    'SnappedSlider'
  ].map((name) => `src/native/${name}.swift`)
])
const { table, cases: list } = JSON.parse(
  runFixture(binary, [], { timeout: 120_000 }).trim().split('\n').pop()
)

// Arithmetic: declared step/precision, inline units, bounds, negatives, non-numbers.
const expected = [
  ['0', 1, '1'],
  ['0', -1, '-1'],
  ['0', -1, null],
  ['0px', 1, '1px'],
  ['114.203125', 1, '115.203125'],
  ['0.5', 1, '0.51'],
  ['0.2', 1, '0.3'],
  ['-0.1', 1, '0'],
  ['400', 1, null],
  ['399.5', 1, '400'],
  ['1.5em', 1, '2.5em'],
  ['0.5em', -1, '0em'],
  ['200ms', 1, '210ms'],
  ['auto', 1, null],
  ['var(--space)', 1, null],
  ['calc(1px + 2px)', 1, null],
  ['', 1, null],
  ['1px 2px', 1, null],
  ['12', -1, '11'],
  ['.5', 1, '1.5'],
  ['700', 1, '800']
]
assert.deepEqual(
  table.map((row) => [row.text, row.direction, row.result]),
  expected,
  'stepped values'
)

const cases = Object.fromEntries(list.map((c) => [c.case, c]))
const all = JSON.stringify(cases)
const actions = (name) => cases[name].actions.map(([action, , value]) => `${action} ${value}`)
for (const c of list) {
  assert.ok(
    !c.actions.some(([action]) => action === 'apply-drafts'),
    `${c.case}: never Apply: ${all}`
  )
  if (c.case !== 'gap-disabled') {
    assert.ok(c.focused && c.kept, `${c.case}: the field keeps keyboard focus: ${all}`)
  }
}
// Margin allows negatives; one preview per press, the repeat included; Return stages once.
assert.deepEqual(actions('margin'), [
  'preview 4',
  'preview 5',
  'preview 4',
  'preview 3',
  'preview 2',
  'preview 1',
  'preview 0',
  'apply 0'
])
assert.equal(cases.margin.text, '0')
assert.ok(
  cases.margin.selections.every(([at, length]) => at === 0 && length === 1),
  'whole value stays selected'
)
// Padding keeps its inline unit and stops at 0 (the press at the bound sends nothing);
// leaving with the original value stages nothing.
assert.deepEqual(actions('padding'), ['preview 1px', 'preview 2px', 'preview 1px', 'preview 0px'])
assert.equal(cases.padding.text, '0px')
// A caret before the unit stays before it; leaving the field stages the draft once.
assert.deepEqual(cases['padding-caret'].selections, [
  [1, 0],
  [1, 0],
  [1, 0]
])
assert.deepEqual(actions('padding-caret'), [
  'preview 1px',
  'preview 2px',
  'preview 3px',
  'apply 3px'
])
// No declared step: one unit, decimals kept exactly.
assert.deepEqual(actions('width'), ['preview 115.203125'])
assert.equal(cases.width.text, '115.203125')
// auto and text fields keep the normal caret movement; disabled fields stay inert.
for (const name of ['auto', 'shadow-text', 'gap-disabled'])
  assert.deepEqual(cases[name].actions, [], `${name}: ${all}`)
assert.equal(cases.auto.text, 'auto')
assert.equal(cases['shadow-text'].text, '0 1px 2px black')
assert.equal(cases['gap-disabled'].text, '8px')
assert.ok(!cases['gap-disabled'].kept, 'a disabled field never takes the keyboard')
// The generic numeric field (Styles): 0.01 steps without float noise; leaving stages once.
assert.deepEqual(actions('opacity'), ['preview 0.51', 'preview 0.52', 'preview 0.53', 'apply 0.53'])
// Props write source on Return only, as when typing: leaving the field stages nothing.
assert.deepEqual(actions('prop-blur'), ['preview 8', 'preview 9'])
assert.deepEqual(actions('prop-return'), ['preview 8', 'apply 8'])
console.log(
  'INSPECTOR-NUMBER-STEP PASS — Up/Down step the focused numeric fields through preview, never Apply'
)
