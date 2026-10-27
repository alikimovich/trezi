import assert from 'node:assert/strict'
import { assertFaviconRows, assertSidebarCapture } from '../src/native/smoke-sidebar.ts'

const row = (id, selected, icon = 'folder') => ({
  id,
  title: id,
  // LKM-372: 'favicon' decoded and shown; 'missing' none sent; 'invalid' sent but undecodable.
  storedArtwork: icon === 'favicon',
  offeredIcon: icon !== 'missing' && icon !== 'folder',
  favicon: icon === 'favicon',
  folder: icon !== 'favicon',
  template: icon !== 'favicon',
  imageWidth: 16,
  imageHeight: 16,
  inkFraction: icon === 'favicon' ? 0.56 : 0.2,
  centerColor: icon === 'favicon' ? '#F06A1C' : '#000000',
  scaling: true,
  tintCorrect: true,
  contained: true,
  iconWidth: 16,
  iconHeight: 16,
  iconX: 18,
  iconY: 6,
  iconMidY: 14,
  textMidY: 14,
  textGap: 7,
  textWidth: 80,
  matchesOpenProject: true,
  selected,
  moreAlpha: selected ? 1 : 0,
  actionsLabel: `Actions for ${id}`,
  menu: ['Project Memory…', 'Close Project']
})
const state = {
  foreground: true,
  collapsed: false,
  rows: [
    row('Alpha', true, 'favicon'),
    row('Beta', false, 'missing'),
    row('Gamma', false, 'invalid')
  ]
}
const titles = { favicon: 'Alpha', missing: 'Beta', invalid: 'Gamma' }
const image = { width: 260, height: 700, text: ['Open Project', 'Alpha', 'Beta', 'Gamma'] }
const check = (s = state, i = image, hovered = '') => {
  assertSidebarCapture(s, i, 260, 'Alpha', hovered, 'fixture')
  assertFaviconRows(s, titles, 'fixture')
}
check()
const change = (mutate) => {
  const copy = structuredClone(state)
  mutate(copy)
  assert.throws(() => check(copy))
}
assert.throws(() => check(state, { ...image, text: [] }), /Blank\/missing/)
assert.throws(
  () => check(state, { ...image, text: ['Open Project', 'Alpha', 'Beta'] }),
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
for (const index of [0, 1, 2])
  for (const field of ['scaling', 'tintCorrect', 'contained'])
    change((s) => {
      s.rows[index][field] = false
    })
// Folder rows must stay template folders; the favicon row must not be one.
for (const index of [1, 2])
  for (const field of ['folder', 'template'])
    change((s) => {
      s.rows[index][field] = false
    })
change((s) => {
  s.rows[0].folder = true
})
change((s) => {
  s.rows[0].template = true
})
// The pre-LKM-372 sidebar: the favicon was decoded but the folder was drawn.
change((s) => {
  Object.assign(s.rows[0], { favicon: false, folder: true, template: true })
})
// An undecodable favicon must never be shown, nor leave the slot blank.
change((s) => {
  Object.assign(s.rows[2], { storedArtwork: true, favicon: true, folder: false, template: false })
})
for (const index of [0, 1, 2])
  change((s) => {
    s.rows[index].inkFraction = 0
  })
change((s) => {
  s.rows[0].centerColor = '#FFFFFF'
})
change((s) => {
  s.rows[0].imageWidth = 1
})
change((s) => {
  s.rows[2].offeredIcon = false
})
change((s) => {
  s.rows[1].offeredIcon = true
})
change((s) => {
  s.rows[2].iconMidY = 16
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
  s.rows[2].iconX += 1
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
check(hovered, image, 'Beta')
assert.throws(() => check(state, image, 'Beta'))
assert.throws(() => check(hovered, image, 'Gamma'))
console.log(
  'SIDEBAR EVIDENCE PASS — rejects blank/missing pixels, folder-for-favicon, shown invalid favicons, clipping, misalignment, incorrect selection/hover and menus'
)
