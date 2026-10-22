// LKM-302: the native composer queue is one frosted panel with flat rows. The chat smoke's
// geometry check (`src/native/smoke-queue.ts`) accepts that layout and rejects the LKM-294
// per-message cards, a missing or misplaced hairline, a glyph off the + button, a missing
// pause control, small hit targets and an empty queue that still shows its panel.
import assert from 'node:assert/strict'
import {
  emptyQueueProblems,
  queueGeometryProblems,
  queueHeight
} from '../src/native/smoke-queue.ts'

// A 420 pt composer: the panel is 10 pt inside it, + is centred at 25 and Send at 395.
const PANEL = { minX: 10, maxX: 410, radius: 18, textX: 44, ruleInset: 12, rule: 0.5 }
const box = (minX, maxX, top, bottom) => ({
  top,
  bottom,
  midY: (top + bottom) / 2,
  minX,
  midX: (minX + maxX) / 2,
  maxX,
  width: maxX - minX,
  height: bottom - top
})

function inspected({ rows, header = false, paused = false, row = 28, gap = 0, padding = 8 }) {
  let y = padding
  let headerFrame = null
  if (header) {
    const frame = box(10, 410, y, y + row)
    headerFrame = {
      frame,
      glyph: box(10, 40, y, y + row),
      divider: box(22, 398, y + row - 0.5, y + row),
      resume: paused ? box(330, 406, y, y + row) : null,
      paused
    }
    y += row + gap
  }
  const measured = []
  for (let index = 0; index < rows; index++) {
    const top = y
    const bottom = y + row
    measured.push({
      row: box(10, 410, top, bottom),
      glyph: box(10, 40, top, bottom),
      text: box(44, 200, top + 6, bottom - 6),
      edit: box(320, 350, top, bottom),
      remove: box(350, 380, top, bottom),
      more: box(380, 410, top, bottom),
      separator: index > 0 ? box(44, 398, top, top + 0.5) : null
    })
    y = bottom + gap
  }
  const visible = queueHeight(rows, header)
  return {
    queueCount: rows,
    queueHeight: visible,
    queueInset: 10,
    queueOverlap: 24,
    plusMidX: 25,
    sendMidX: 395,
    queueGeometry: {
      visible,
      height: visible + 24,
      hidden: false,
      panel: PANEL,
      header: headerFrame,
      rows: measured
    }
  }
}

// Same totals as LKM-198/294: 44 / 72 / 100 pt, +28 with a header.
assert.deepEqual(
  [queueHeight(1, false), queueHeight(2, false), queueHeight(3, false), queueHeight(5, false)],
  [44, 72, 100, 100]
)
assert.equal(queueHeight(3, true), 128)

for (const [rows, header, paused] of [
  [1, false, false],
  [2, false, false],
  [3, false, false],
  [3, true, true],
  [1, true, false],
  [5, false, false]
])
  assert.deepEqual(
    queueGeometryProblems(inspected({ rows, header, paused }), rows, header, paused),
    [],
    `${rows} rows, header ${header}, paused ${paused}`
  )

const fails = (payload, rows, header, paused, pattern, what) => {
  const problems = queueGeometryProblems(payload, rows, header, paused)
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `${what}: ${JSON.stringify(problems)}`
  )
}

// The LKM-294 layout: 24 pt rows, 4 pt apart, 10 pt padding.
const cards = inspected({ rows: 2, row: 24, gap: 4, padding: 10 })
cards.queueHeight = queueHeight(2, false)
fails(cards, 2, false, false, /row 0 height/, 'separate 24 pt cards')
fails(cards, 2, false, false, /gap above row 1/, 'gap between cards')

const unruled = inspected({ rows: 2 })
unruled.queueGeometry.rows[1].separator = null
fails(unruled, 2, false, false, /no separator above it/, 'missing hairline')

const ruledFirst = inspected({ rows: 2 })
ruledFirst.queueGeometry.rows[0].separator = box(44, 398, 8, 8.5)
fails(ruledFirst, 2, false, false, /row 0 has a separator/, 'hairline above the first row')

const thick = inspected({ rows: 2 })
thick.queueGeometry.rows[1].separator = box(44, 398, 36, 40)
fails(thick, 2, false, false, /wanted a hairline/, 'a thick separator')

const offGlyph = inspected({ rows: 1 })
offGlyph.queueGeometry.rows[0].glyph = box(14, 26, 8, 36)
fails(offGlyph, 1, false, false, /glyph over the \+ button/, 'glyph away from +')

const noGlyph = inspected({ rows: 1 })
noGlyph.queueGeometry.rows[0].glyph = null
fails(noGlyph, 1, false, false, /glyph or actions missing/, 'missing glyph')

const placeholderText = inspected({ rows: 1 })
placeholderText.queueGeometry.rows[0].text = box(19, 200, 14, 30)
fails(placeholderText, 1, false, false, /text after the glyph column/, 'text under the glyph')

const smallTarget = inspected({ rows: 1 })
smallTarget.queueGeometry.rows[0].remove = box(350, 370, 14, 30)
fails(smallTarget, 1, false, false, /row 0 remove: .*hit target/, 'small remove target')

fails(inspected({ rows: 3, header: true }), 3, true, true, /header paused false/, 'not paused')
const noResume = inspected({ rows: 3, header: true, paused: true })
noResume.queueGeometry.header.resume = null
fails(noResume, 3, true, true, /Send now: missing/, 'paused without Send now')
const resumeUnpaused = inspected({ rows: 1, header: true })
resumeUnpaused.queueGeometry.header.resume = box(330, 406, 8, 36)
fails(resumeUnpaused, 1, true, false, /Send now shown on an unpaused queue/, 'Send now unpaused')

const noDivider = inspected({ rows: 1, header: true })
noDivider.queueGeometry.header.divider = null
fails(noDivider, 1, true, false, /header divider missing/, 'missing divider')

const hidden = inspected({ rows: 1 })
hidden.queueGeometry.hidden = true
fails(hidden, 1, false, false, /hidden true/, 'hidden panel with rows')

assert.deepEqual(
  emptyQueueProblems({ queueCount: 0, queueHeight: 0, queueGeometry: { hidden: true } }),
  []
)
assert.ok(
  emptyQueueProblems({ queueCount: 0, queueHeight: 44, queueGeometry: { hidden: false } }).length
)

console.log(
  'Composer queue panel: flat rows, hairlines, + and Send columns, paused header and empty state checked'
)
