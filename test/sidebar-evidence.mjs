import assert from 'node:assert/strict'
import { assertSidebarCapture } from '../src/native/smoke-sidebar.ts'

const row = (id, selected) => ({
  id,
  title: id,
  folder: true,
  template: true,
  scaling: true,
  tintCorrect: true,
  contained: true,
  iconWidth: 16,
  iconHeight: 16,
  iconX: 18,
  iconY: 6,
  textGap: 7,
  textWidth: 80,
  matchesOpenProject: true,
  selected,
  moreAlpha: selected ? 1 : 0,
  actionsLabel: `Actions for ${id}`,
  menu: ['Project Memory…', 'Close Project']
})
const state = { foreground: true, collapsed: false, rows: [row('Alpha', true), row('Beta', false)] }
const image = { width: 260, height: 700, text: ['Open Project', 'Alpha', 'Beta'] }
const check = (s = state, i = image, hover = false) =>
  assertSidebarCapture(s, i, 260, 'Alpha', hover, 'fixture')
check()
const change = (mutate) => {
  const copy = structuredClone(state)
  mutate(copy)
  assert.throws(() => check(copy))
}
assert.throws(() => check(state, { ...image, text: [] }), /Blank\/missing/)
assert.throws(
  () => check(state, { ...image, text: ['Open Project', 'Alpha'] }),
  /Missing visible project/
)
change((s) => {
  s.foreground = false
})
change((s) => {
  s.collapsed = true
})
change((s) => {
  s.rows.pop()
})
for (const field of ['folder', 'template', 'scaling', 'tintCorrect', 'contained'])
  change((s) => {
    s.rows[1][field] = false
  })
change((s) => {
  s.rows[1].textGap = 2
})
// The half-point frame the native suite measured before SidebarIconView.
change((s) => {
  s.rows[1].iconWidth = 16.5
})
change((s) => {
  s.rows[1].iconHeight = 21
})
change((s) => {
  s.rows[1].iconY = 3.5
})
change((s) => {
  s.rows[1].matchesOpenProject = false
})
change((s) => {
  s.rows[1].iconX += 1
})
change((s) => {
  s.rows[1].moreAlpha = 1
})
change((s) => {
  s.rows[1].selected = true
})
change((s) => {
  s.rows[1].menu = []
})
const hovered = structuredClone(state)
hovered.rows[1].moreAlpha = 1
check(hovered, image, true)
assert.throws(() => check(state, image, true))
console.log(
  'SIDEBAR EVIDENCE PASS — rejects blank/missing pixels, artwork, clipping, misalignment, incorrect selection/hover and menus'
)
