import assert from 'node:assert/strict'
import { crc32, deflateSync } from 'node:zlib'
import { assertFaviconRows, assertSidebarCapture } from '../src/native/smoke-sidebar.ts'

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

/** LKM-374: a 2× capture of a 260×828 pt sidebar, painted like the real one: Alpha's selection
 *  highlight and each label as glyph-like strokes at its measured origin. `labels` overrides
 *  one row's painting: null leaves it blank, { dx, dy } moves it (points). The default OCR
 *  text has Gamma's title truncated, as a long title is at 180 pt. */
const capture = (labels = {}, text = ['Open Project', 'Alpha', 'Beta', 'Gam…']) => {
  const scale = 2
  const width = 260 * scale
  const height = 828 * scale
  const pixels = Buffer.alloc(width * height * 3)
  const fill = (x0, y0, x1, y1, rgb) => {
    for (let y = Math.round((828 - y1) * scale); y < Math.round((828 - y0) * scale); y++)
      for (let x = Math.round(x0 * scale); x < Math.round(x1 * scale); x++)
        pixels.set(rgb, (y * width + x) * 3)
  }
  fill(0, 0, 260, 828, [235, 235, 237])
  fill(10, MID.Alpha - 12, 250, MID.Alpha + 12, [214, 215, 216])
  for (const r of state.rows) {
    const label = r.id in labels ? labels[r.id] : {}
    if (!label) continue
    const left = r.iconX + r.iconWidth + r.textGap + (label.dx ?? 0)
    const mid = r.textMidY + (label.dy ?? 0)
    for (let i = 0; i < 30; i++)
      fill(left + i * 2, mid - 4.5, left + i * 2 + 1.5, mid + 4.5, [30, 30, 30])
  }
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++)
    pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
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
  header[9] = 2 // RGB
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
check(state, capture({}, ['Open Project']))
assert.throws(() => check(state, capture({ Gamma: null })), /Missing visible project Gamma/)
// Painted in the empty slot below its row, or 6 pt right of its measured origin.
assert.throws(() => check(state, capture({ Gamma: { dy: -28 } })), /Missing visible project/)
assert.throws(() => check(state, capture({ Gamma: { dx: 6 } })), /Missing visible project/)
assert.throws(() => check(state, capture({ Beta: { dy: 9 } })), /Missing visible project/)
assert.throws(() => check(state, { ...image, png: undefined }), /Not a PNG/)
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
  'SIDEBAR EVIDENCE PASS — finds row labels by geometry in the capture (truncated titles pass); rejects blank, misplaced or missing label pixels, folder-for-favicon, shown invalid favicons, clipping, misalignment, incorrect selection/hover and menus'
)
