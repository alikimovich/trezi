import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { marqueeInkProblem } from '../src/native/smoke-sidebar-marquee.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-387: a hovered title showed a hard cut well before Archive and a blank stretch after it.
// The title's frame and travel were right: AppKit paints a layer-backed view only inside its
// visible rect, and the old layer transform dragged that painted edge across the clip. So these
// checks read what was painted, not flags. The fixture hosts the real row and hovers it.
const near = (actual, expected, slack, label) =>
  assert.ok(Math.abs(actual - expected) <= slack, `${label}: ${actual}, expected ${expected}`)

/** Text across the whole clip; `end` also needs the last glyph at the clip's right edge. */
function paintsClip(sample, label, { end = false } = {}) {
  assert.ok(sample.inkFrom >= 0, `${label}: no text at all ${JSON.stringify(sample)}`)
  assert.ok(sample.inkFrom <= 6, `${label}: text starts at ${sample.inkFrom}`)
  assert.ok(
    sample.width - sample.inkTo <= (end ? 3 : 6),
    `${label}: text stops at ${sample.inkTo} of ${sample.width}, a blank gap ${JSON.stringify(sample)}`
  )
  assert.ok(sample.gap <= 9, `${label}: a ${sample.gap} pt hole in the text`)
  if (sample.paintSeen) {
    near(sample.labelWidth, sample.natural + 4, 1, `${label}: label frame`)
    assert.ok(
      sample.paintFrom <= sample.offset + 2 && sample.paintTo >= sample.offset + sample.width,
      `${label}: AppKit painted ${sample.paintFrom}–${sample.paintTo}, the clip shows ${sample.offset}–${sample.offset + sample.width}`
    )
  }
}

function atEnd(sample, label) {
  paintsClip(sample, label, { end: true })
  assert.equal(sample.running, true, `${label}: still scrolling state`)
  near(sample.offset, sample.travel, 0.5, `${label}: holds at the end`)
  near(sample.travel, sample.natural - sample.width, 0.5, `${label}: travel for this width`)
}

function scrolls(group, label, archive = true) {
  const { start, mid, end } = group
  paintsClip(start, `${label} start`)
  assert.equal(start.offset, 0, `${label}: waits at the title's start`)
  paintsClip(mid, `${label} mid`)
  assert.ok(mid.offset > 1 && mid.offset < mid.travel - 1, `${label}: mid ${mid.offset}`)
  atEnd(end, `${label} end`)
  // Only the side with text beyond it fades, and the mask covers the clip.
  assert.deepEqual([start.edgeLeading, start.edgeTrailing], [1, 0], `${label}: start edges`)
  assert.deepEqual([mid.edgeLeading, mid.edgeTrailing], [0, 0], `${label}: mid edges`)
  assert.deepEqual([end.edgeLeading, end.edgeTrailing], [0, 1], `${label}: end edges`)
  assert.deepEqual([end.maskFrom, end.maskTo], [0, end.width], `${label}: the fade spans the clip`)
  for (const sample of [start, mid, end]) {
    if (archive) {
      assert.equal(sample.archiveShown, true, `${label}: Archive shows`)
      near(sample.archiveLeft - sample.titleRight, 4, 0.5, `${label}: title up to Archive`)
      assert.ok(end.archiveLeft - end.titleRight - (end.width - end.inkTo) <= 8, `${label}: gap`)
    } else near(sample.rowWidth - sample.titleRight, 8, 0.5, `${label}: title up to the row's edge`)
  }
}

function rests(sample, label) {
  assert.equal(sample.running, false, `${label}: not scrolling`)
  near(sample.offset, 0, 0.5, `${label}: at the title's start`)
  assert.equal(sample.truncated, true, `${label}: truncated`)
  near(sample.labelWidth, sample.width + 4, 1, `${label}: the label fits the title`)
  assert.equal(sample.edgeLeading, undefined, `${label}: no fade at rest`)
}

// The native smoke's pixel reading: a row with 8 pt wide glyphs every 12 pt in `from`–`to`.
const box = { x: 25, y: 5, width: 200, height: 18, referenceWidth: 300 }
const row = (from, to) => ({
  width: 600,
  height: 60,
  rgb: (x, y) => {
    const clip = x / 2 - box.x
    const glyph = y >= 16 && y < 40 && clip >= from && clip < to && clip % 12 < 8
    return glyph ? [255, 255, 255] : [0, 100, 255]
  }
})
for (const phase of ['start', 'mid', 'end'])
  assert.equal(marqueeInkProblem(row(0, 200), box, phase), null, `full clip, ${phase}`)
for (const phase of ['start', 'mid', 'end'])
  assert.match(marqueeInkProblem(row(0, 95), box, phase), /no text at/, `premature cut, ${phase}`)
assert.match(marqueeInkProblem(row(0, 0), box, 'mid'), /no text at/, 'an empty clip fails')
assert.match(marqueeInkProblem(row(0, 188), box, 'end'), /before the clip's edge/, 'end short')
assert.equal(marqueeInkProblem(row(0, 188), box, 'mid'), null, 'mid ignores the faded edge')

// The smoke reads pixels on selected, narrow and resized rows: it must not drop to flags again.
const smoke = readFileSync('src/native/smoke-sidebar-chats.ts', 'utf8')
for (const stage of ['unselected', 'selected', 'narrow-selected', 'narrow-unselected', 'resized'])
  assert.ok(smoke.includes(`'${stage}'`), `the smoke scrolls the ${stage} title`)

// Neither run may read the host's Reduce Motion setting (a runner with it on never scrolls): the
// smoke turns the override off before the scrolls, the fixture never leaves it nil.
const off = smoke.indexOf("perform('marquee-reduce-motion', 'off')")
assert.ok(off > 0 && off < smoke.indexOf('const sized'), 'the smoke sets Reduce Motion off first')
assert.ok(
  !smoke
    .slice(off, smoke.indexOf("await scroll('unselected')"))
    .includes("'marquee-reduce-motion')"),
  'nothing hands Reduce Motion back to the host before the scrolls'
)
const fixture = readFileSync('test/fixtures/sidebar-marquee/main.swift', 'utf8')
assert.ok(
  !/reduceMotionOverride\s*=\s*nil/.test(fixture),
  'the fixture never reads the host setting'
)
assert.ok(
  fixture.indexOf('reduceMotionOverride = false') < fixture.indexOf('.setHovered(true) }'),
  'Reduce Motion is off before the first hover'
)

if (process.platform !== 'darwin') {
  console.log('SIDEBAR-MARQUEE SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-marquee', [
    'test/fixtures/sidebar-marquee/main.swift',
    'src/native/SidebarChats.swift',
    'src/native/SidebarMarquee.swift',
    'src/native/SidebarTitleShimmer.swift',
    'src/native/SidebarChatsAccessibility.swift',
    'src/native/ProjectCell.swift',
    'src/native/SourceList.swift',
    'src/native/SidebarIcon.swift'
  ])
  const report = JSON.parse(runFixture(binary, [], { timeout: 60_000 }))

  for (const [name, archive] of [
    ['selected', true],
    ['unselected', true],
    ['bare', false],
    ['narrow', true],
    ['narrowUnselected', true]
  ])
    scrolls(report[name], name, archive)

  // 0.7 s, then 30 pt/s. The samples carry their own clock, so a slow host stays accurate.
  const { before, early, late } = report.timing
  assert.equal(before.offset, 0, 'still inside the 0.7 s delay')
  near(early.offset, (early.at - 0.7) * 30, 6, 'early in the scroll')
  near(late.offset, (late.at - 0.7) * 30, 6, 'later in the scroll')
  near((late.offset - early.offset) / (late.at - early.at), 30, 6, 'pt/s')

  // A width change around the start of the hover, and while it runs or holds.
  paintsClip(report.narrowedInDelay.mid, 'narrowed in the delay, mid')
  atEnd(report.narrowedInDelay.end, 'narrowed in the delay')
  paintsClip(report.narrowedMid.after, 'narrowed while scrolling')
  atEnd(report.narrowedMid.end, 'narrowed while scrolling')
  atEnd(report.narrowedAtEnd.held, 'held before narrowing')
  atEnd(report.narrowedAtEnd.end, 'narrowed at the end')
  atEnd(report.widenedAtEnd.end, 'widened at the end')
  rests(report.widenedToFit.end, 'widened until it fits')
  assert.equal(report.overflowsLater.start.running, false, 'a fitting title does not scroll')
  atEnd(report.overflowsLater.end, 'overflows only after the hover started')

  rests(report.fits.end, 'a title that fits')
  rests(report.still.end, 'Reduce Motion')
  rests(report.stillLeft.end, 'Reduce Motion after the hover')
  assert.equal(report.leaving.scrolling.running, true, 'scrolling before the pointer leaves')
  rests(report.leaving.end, 'un-hover')
  console.log('SIDEBAR-MARQUEE PASS — text paints the whole clip, at every width and on every row')
}
