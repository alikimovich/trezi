import assert from 'node:assert/strict'
import { crc32, deflateSync } from 'node:zlib'
import { decodePng } from '../src/native/smoke-png.ts'
import {
  assertFaviconRows,
  assertSidebarCapture,
  captureContentScale
} from '../src/native/smoke-sidebar.ts'
import { assertSidebarRows } from './helpers/sidebar-rows.mjs'

// Rows top to bottom in sidebar points (y up), 28 pt apart, as the native suite measures them.
const MID = { Alpha: 680, Beta: 652, Gamma: 624 }
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
  iconY: MID[id] - 8,
  iconMidY: MID[id],
  textMidY: MID[id],
  textGap: 7,
  textWidth: 80,
  matchesOpenProject: true,
  selected,
  moreAlpha: selected ? 1 : 0,
  actionsLabel: `Actions for ${id}`,
  menu: ['Project Memory…', 'Show History', 'Close Project']
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

/** LKM-374: a 2× RGBA capture of a 260×828 pt sidebar, painted like the real one: Alpha's
 *  selection highlight and each label as glyph-like strokes at its measured origin. `labels`
 *  overrides one row's painting: null leaves it blank, { dx, dy } moves it (points). The
 *  default OCR text has Gamma's title truncated, as a long title is at 180 pt. `content` < 1
 *  draws the window that much smaller from its top-left corner and leaves the rest
 *  transparent, as ScreenCaptureKit returned the 260 pt captures in native runs 23–29;
 *  `opaque` fills that rest instead, so the drift cannot be measured. */
const capture = ({
  labels = {},
  text = ['Open Project', 'Alpha', 'Beta', 'Gam…'],
  content = 1,
  opaque = false,
  rows = state.rows
} = {}) => {
  const scale = 2
  const width = 260 * scale
  const height = 828 * scale
  const pixels = Buffer.alloc(width * height * 4)
  const fill = (x0, y0, x1, y1, rgb, k = content) => {
    for (let y = Math.round((828 - y1) * scale * k); y < Math.round((828 - y0) * scale * k); y++)
      for (let x = Math.round(x0 * scale * k); x < Math.round(x1 * scale * k); x++)
        pixels.set([...rgb, 255], (y * width + x) * 4)
  }
  if (opaque) fill(0, 0, 260, 828, [235, 235, 237], 1)
  fill(0, 0, 260, 828, [235, 235, 237])
  fill(10, MID.Alpha - 12, 250, MID.Alpha + 12, [214, 215, 216])
  for (const r of rows) {
    const label = r.id in labels ? labels[r.id] : {}
    if (!label) continue
    const left = r.iconX + r.iconWidth + r.textGap + (label.dx ?? 0)
    const mid = r.textMidY + (label.dy ?? 0)
    for (let i = 0; i < 30; i++)
      fill(left + i * 2, mid - 4.5, left + i * 2 + 1.5, mid + 4.5, [30, 30, 30])
  }
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++)
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
  return { png: png.toString('base64'), text, width, height }
}
const image = capture()
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
// LKM-374: a row's label is found by its geometry in the pixels; OCR of the title is not used.
check(state, capture({ text: ['Open Project'] }))
assert.throws(
  () => check(state, capture({ labels: { Gamma: null } })),
  /Missing visible project Gamma/
)
// Painted in the empty slot below its row, or 6 pt right of its measured origin.
assert.throws(
  () => check(state, capture({ labels: { Gamma: { dy: -28 } } })),
  /Missing visible project/
)
assert.throws(
  () => check(state, capture({ labels: { Gamma: { dx: 6 } } })),
  /Missing visible project/
)
assert.throws(
  () => check(state, capture({ labels: { Beta: { dy: 9 } } })),
  /Missing visible project/
)
assert.throws(() => check(state, { ...image, png: undefined }), /Not a PNG/)
// A window drawn 2.5% small with a transparent rest: a row low in the sidebar (below the chat
// rows main now lists under the selected project) sits 19 pt above its measured place
// unless the drawn scale is measured from the transparent rest.
assert.equal(captureContentScale(decodePng(Buffer.from(image.png, 'base64'))), 1)
const low = structuredClone(state)
Object.assign(low.rows[2], { iconY: 92, iconMidY: 100, textMidY: 100 })
const scaled = capture({ content: 0.9746, rows: low.rows })
const content = captureContentScale(decodePng(Buffer.from(scaled.png, 'base64')))
assert.ok(Math.abs(content - 0.9746) < 0.001, `content scale ${content}`)
check(low, scaled)
assert.throws(
  () => check(low, capture({ content: 0.9746, rows: low.rows, labels: { Gamma: null } })),
  /Missing visible project Gamma/
)
// Drawn small over an opaque rest, the drift is not measurable: the rows are reported missing.
assert.throws(
  () => check(low, capture({ content: 0.9746, rows: low.rows, opaque: true })),
  /Missing visible project/
)
// A window that fills less than 90% of its capture is not evidence of anything.
assert.throws(() => check(state, capture({ content: 0.85 })), /the window fills/)
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
// LKM-374: the launcher's check of the recorded `sidebar-*.json` rows (test/native-runtime.mjs)
// expected two folder rows, which the favicon fixture of LKM-372 made three. It now expects the
// one favicon row (no folder, no template) and folder-template fallbacks for the others.
const recorded = () => structuredClone(state.rows)
assertSidebarRows(recorded(), 'fixture')
assert.throws(() => assertSidebarRows(recorded().slice(0, 2), 'fixture'), /rows/)
{
  const folderForFavicon = recorded()
  Object.assign(folderForFavicon[0], { favicon: false, folder: true, template: true })
  assert.throws(() => assertSidebarRows(folderForFavicon, 'fixture'), /favicon rows/)
  const shownFolderAsFavicon = recorded()
  shownFolderAsFavicon[1].favicon = true
  assert.throws(() => assertSidebarRows(shownFolderAsFavicon, 'fixture'), /favicon rows/)
  const templateless = recorded()
  templateless[2].template = false
  assert.throws(() => assertSidebarRows(templateless, 'fixture'), /folder rows/)
  const faviconAsTemplate = recorded()
  faviconAsTemplate[0].template = true
  assert.throws(() => assertSidebarRows(faviconAsTemplate, 'fixture'), /no folder/)
}
console.log(
  'SIDEBAR EVIDENCE PASS — finds row labels by geometry in the capture (truncated titles and windows drawn small pass); rejects blank, misplaced or missing label pixels, folder-for-favicon, shown invalid favicons, clipping, misalignment, incorrect selection/hover and menus'
)
