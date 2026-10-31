import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chatThinking } from '../src/native/chat-snapshot.ts'
import { newChat } from '../src/native/chat-state.ts'
import {
  changedPixels,
  shimmerCaptureProblem,
  shimmers
} from '../src/native/smoke-sidebar-shimmer.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-389: a running chat's sidebar title shimmers like the in-chat status line, instead of a
// spinner at its left. The states come from the chat's own activity; the fixture hosts the real
// row, reads the real sweep and renders the real mask at several phases.
const chat = (fields) => ({ ...newChat('c'), isRunning: true, ...fields })
const permission = { id: 'p', sessionKey: 'c', title: 'Allow?' }
const cases = [
  ['idle', { isRunning: false }, false],
  ['completed or failed', { isRunning: false, phase: 'writing' }, false],
  [
    'a pending draft',
    { isRunning: false, text: 'Not sent', attachments: [{ name: 'a.txt' }] },
    false
  ],
  ['thinking', { phase: 'thinking' }, true],
  ['a progress step', { phase: 'working', progressStep: 'Reading files' }, true],
  ['a tool', { phase: 'working', activityDetail: 'Edit src/a.ts' }, true],
  ['writing', { phase: 'writing' }, true],
  ['stopping', { phase: 'working', stopping: true }, false],
  ['waiting for approval', { phase: 'working', permissions: [permission] }, false],
  ['waiting for an answer', { phase: 'thinking', questions: [{ id: 'q' }] }, false],
  ['landing', { phase: 'applying' }, false]
]
for (const [name, fields, expected] of cases)
  assert.equal(chatThinking(chat(fields)), expected, `${name}: shimmer ${expected ? 'on' : 'off'}`)

// A turn moving between its states takes the shimmer with it.
const turn = chat({ phase: 'thinking' })
const seen = [
  ['thinking', {}],
  ['working', { activityDetail: 'Bash ls' }],
  ['thinking', { activityDetail: '' }],
  ['working', { permissions: [permission] }],
  ['working', { permissions: [] }],
  ['writing', {}],
  ['applying', {}]
].map(([phase, fields]) => chatThinking(Object.assign(turn, { phase, ...fields })))
assert.deepEqual(seen, [true, true, true, false, true, true, false], 'transitions')

// The composer's beam reads the same state, so the two cannot disagree.
const source = readFileSync('src/native/chat-snapshot.ts', 'utf8')
assert.match(source, /const thinking = atWork\(currentActivity\)/)
assert.match(source, /chatThinking = \(chat: Chat\) => atWork\(activity\(chat\)\)/)

// The smoke's verdict on real captures, which only a native run produces.
assert.ok(shimmers({ shimmer: { mode: 'sweep' } }) && shimmers({ shimmer: { mode: 'still' } }))
assert.ok(!shimmers({ shimmer: { mode: 'none' } }) && !shimmers(undefined))
assert.equal(shimmerCaptureProblem([120, 88], true), '')
assert.equal(shimmerCaptureProblem([0, 704, 0], true), '', 'the band can be past the text')
assert.match(shimmerCaptureProblem([0, 0, 0], true), /did not change/)
assert.equal(shimmerCaptureProblem([0], false), '')
assert.match(shimmerCaptureProblem([4], false), /Reduce Motion moved/)

// LKM-392: the numbers of a real still sidebar. Its material drifted 7 levels below the rows and
// beside the text, which is not a moving title; a change in the title's clip is.
const flat = (paint) => ({
  width: 40,
  height: 40,
  rgb: (x, y) => paint(x, y) ?? [30, 32, 50]
})
const clip = { x: 5, y: 5, width: 5, height: 5, referenceWidth: 20 } // 10–20 px at 2×
const still = flat(() => undefined)
assert.equal(changedPixels(still, still, clip), 0)
assert.equal(
  changedPixels(
    still,
    flat(() => [37, 39, 57]),
    clip
  ),
  0,
  'the drift inside the clip is noise'
)
assert.equal(
  changedPixels(
    still,
    flat((x, y) => (y >= 20 ? [200, 200, 200] : undefined)),
    clip
  ),
  0,
  'a change below the title is not the title'
)
assert.equal(
  changedPixels(
    still,
    flat((x, y) => (x === 12 ? [48, 50, 68] : undefined)),
    clip
  ),
  10,
  'a dimmed column of the title counts, once per row of the clip'
)
assert.throws(() => changedPixels(still, { ...still, height: 41 }, clip), /differ in size/)

// The fixture must not read the host's Reduce Motion setting (a runner with it on shows "still"
// where the sweep is expected): the override is never nil, and is off before the first row.
const fixture = readFileSync('test/fixtures/sidebar-shimmer/main.swift', 'utf8')
assert.ok(
  !/reduceMotionOverride\s*=\s*nil/.test(fixture),
  'the fixture never reads the host setting'
)
assert.ok(
  fixture.indexOf('reduceMotionOverride = false') < fixture.indexOf('let idle = make('),
  'Reduce Motion is off before the first row'
)
// The native smoke likewise pins the sweep before each wait for it and hands the setting back to
// the host only in its `finally`.
const smoke = readFileSync('src/native/smoke-sidebar-shimmer.ts', 'utf8')
const handBack = smoke.match(/reduce\(\)/g) ?? []
assert.equal(handBack.length, 1, 'only one call hands Reduce Motion back to the host')
assert.ok(
  smoke.indexOf('reduce()') > smoke.indexOf('finally'),
  'Reduce Motion goes back to the host in the finally block'
)
assert.ok(
  smoke.indexOf("await reduce('off')") < smoke.indexOf("await both('unselected', false)"),
  'the sweep is pinned before the first wait for it'
)
assert.match(
  smoke,
  /-reduce-motion`, 2, false\)\s+await reduce\('off'\)\s+\}/,
  'the sweep is pinned again right after Reduce Motion, before the next row'
)

if (process.platform !== 'darwin') {
  console.log('SIDEBAR-SHIMMER SKIP — macOS AppKit required for the row')
} else {
  const binary = swiftBuild('sidebar-shimmer', [
    'test/fixtures/sidebar-shimmer/main.swift',
    'src/native/SidebarTitleShimmer.swift',
    'src/native/SidebarChats.swift',
    'src/native/SidebarChatsAccessibility.swift',
    'src/native/SidebarMarquee.swift',
    'src/native/SidebarIcon.swift',
    'src/native/ProjectCell.swift',
    'src/native/SourceList.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const near = (actual, expected, label, slack = 0.51) =>
    assert.ok(Math.abs(actual - expected) <= slack, `${label}: ${actual}, expected ${expected}`)
  const { idle, thinking, waiting, unread, history } = report

  // State: only `thinking` shimmers; a waiting row stays Running without it.
  assert.equal(thinking.mode, 'sweep')
  for (const [name, row] of Object.entries({ idle, waiting, unread, history })) {
    assert.equal(row.mode, 'none', `${name} has no shimmer`)
    assert.equal(row.alpha, 1, `${name} is not dimmed`)
  }

  // Accessibility: the row's label, not the animation, says Running.
  assert.equal(thinking.label, `${thinking.text}, Running`)
  assert.equal(waiting.label, `${waiting.text}, Running`)
  assert.equal(idle.label, idle.text)
  assert.equal(unread.label, `${unread.text}, Unread answer`)
  assert.equal(unread.dot, true, 'the unread dot stays')
  assert.equal(thinking.dot, false)
  assert.equal(thinking.archive, true, 'Archive stays on a running row')

  // Alignment: no spinner and no footprint, so every state starts and ends in the same place.
  for (const [name, row] of Object.entries({ idle, thinking, waiting, unread })) {
    assert.equal(row.spinners, 0, `${name} has no spinner`)
    assert.equal(row.titleX, idle.titleX, `${name} title x`)
    assert.equal(row.titleWidth, idle.titleWidth, `${name} title width`)
    assert.equal(row.labelX, idle.labelX, `${name} label x`)
  }

  // The chat's sweep: a 55 pt band, 2 s, linear, from off one edge to off the other.
  const { sweep } = report
  assert.equal(sweep.keyPath, 'position.x')
  assert.equal(sweep.band, 55)
  assert.equal(sweep.duration, 2)
  assert.equal(sweep.linear, true)
  assert.equal(sweep.removed, false)
  assert.equal(sweep.repeats, true, 'repeats for as long as the row thinks')
  near(sweep.from, -27.5, 'band centre at phase 0')
  near(sweep.to, sweep.width + 82.5, 'band centre at phase 1')
  assert.equal(sweep.maskWidth, sweep.width)

  // The mask at each phase: the title is dimmed, never hidden, and the band moves across it.
  const peaks = report.phases.map(({ phase, opacity }) => {
    assert.equal(opacity.length, Math.round(sweep.width))
    const peak = opacity.indexOf(Math.max(...opacity))
    assert.ok(
      Math.min(...opacity) >= 0.7,
      `phase ${phase} hides the title: ${Math.min(...opacity)}`
    )
    near(Math.min(...opacity), 0.72, `phase ${phase} rests`, 0.02)
    return { phase, peak, top: Math.max(...opacity) }
  })
  for (const { phase, top } of [peaks[0], peaks[4]])
    near(top, 0.72, `band off the title at ${phase}`, 0.03)
  for (const { phase, top } of peaks.slice(1, 4))
    near(top, 1, `full title under the band at ${phase}`, 0.03)
  assert.ok(peaks[1].peak < peaks[2].peak && peaks[2].peak < peaks[3].peak, JSON.stringify(peaks))
  for (const { phase, peak } of peaks.slice(1, 4))
    near(peak, phase * (sweep.width + 110) - 27.5, `band centre at ${phase}`, 3)

  // A selected row: stronger rest, same motion; back to normal afterwards.
  assert.equal(report.emphasized.inspect.mode, 'sweep')
  near(report.emphasized.inspect.resting, 0.9, 'emphasized rest', 0.001)
  near(Math.min(...report.emphasized.phase), 0.9, 'emphasized mask', 0.02)
  assert.equal(report.emphasized.sweep.duration, 2)
  near(report.normal.resting, 0.72, 'normal rest', 0.001)

  // Reduce Motion: a still, dimmed, readable title; nothing moves and no spinner stands in.
  for (const [name, row] of Object.entries({
    reduced: report.reduced,
    started: report.reducedStart
  })) {
    assert.equal(row.mode, 'still', `${name} mode`)
    assert.equal(row.shimmer.animated, false, `${name} has no animation`)
    assert.equal(row.shimmer.masked, false, `${name} has no mask`)
    near(row.alpha, 0.72, `${name} is dimmed`, 0.001)
    assert.equal(row.spinners, 0, `${name} has no spinner`)
    assert.ok(row.label.endsWith(', Running'), `${name} still reads Running`)
  }
  near(report.reducedEmphasized.alpha, 0.9, 'Reduce Motion on a selected row', 0.001)
  assert.equal(report.restored.mode, 'sweep')
  assert.equal(report.restored.shimmer.animated, true)
  assert.equal(report.restored.alpha, 1)

  // A narrow row and a truncated title.
  const { narrow } = report
  assert.equal(narrow.cell.mode, 'sweep')
  assert.equal(narrow.cell.truncates, true)
  assert.ok(narrow.sweep.width > 20 && narrow.sweep.width < 90, `${narrow.sweep.width} wide`)
  near(narrow.sweep.to, narrow.sweep.width + 82.5, 'narrow row')
  assert.equal(narrow.sweep.maskWidth, narrow.sweep.width)

  // The marquee: same one label, so the band follows Archive's width and the scroll's.
  const { hover, unhover } = report
  assert.equal(hover.marquee, true, 'the hovered long title scrolls')
  assert.equal(hover.archive, true)
  assert.equal(hover.cell.mode, 'sweep')
  assert.equal(hover.hovered.maskWidth, hover.hovered.width, 'the mask covers the scrolling label')
  assert.notEqual(hover.hovered.width, hover.rest.width, 'the label changed width')
  near(hover.hovered.to, hover.hovered.width + 82.5, 'hovered band')
  assert.equal(unhover.marquee, false)
  assert.equal(unhover.cell.truncates, true)
  near(unhover.sweep.width, hover.rest.width, 'back to the rest width', 0.01)
  assert.equal(unhover.sweep.maskWidth, unhover.sweep.width)

  // Cleanup: no window, nothing runs; a removed row's shimmer dies with it.
  for (const [name, row] of Object.entries({
    detached: report.detached,
    detachedReduced: report.detachedReduced
  })) {
    assert.equal(row.mode, 'off', `${name} mode`)
    assert.equal(row.shimmer.animated, false, `${name} leaves no animation`)
    assert.equal(row.shimmer.masked, false, `${name} leaves no mask`)
    assert.equal(row.alpha, 1, `${name} leaves no dimming`)
  }
  assert.equal(report.attached.mode, 'sweep', 'a row put back sweeps again')
  assert.equal(report.attached.shimmer.animated, true)
  assert.equal(report.released, true, 'nothing keeps a removed row’s shimmer alive')
  const [before, after] = report.offsets
  assert.ok(before >= 0 && before < 2 && after >= 0 && after < 2, `offsets ${report.offsets}`)
  const drift = Math.abs(after - before)
  assert.ok(Math.min(drift, 2 - drift) < 0.5, `a rebuilt row keeps the phase: ${report.offsets}`)

  // Contrast of the dimmed title, from the system's own colours (the band only raises it).
  for (const [name, ratio] of Object.entries(report.contrast))
    assert.ok(ratio >= 4.5, `${name}: ${ratio.toFixed(2)}:1`)

  // The product no longer has the loader, and the inspection no longer offers it.
  const cell = readFileSync('src/native/SidebarChats.swift', 'utf8')
  assert.doesNotMatch(cell, /NSProgressIndicator|spinner|spinning/)
  const ratios = Object.entries(report.contrast)
    .map(([name, ratio]) => `${name} ${ratio.toFixed(1)}`)
    .join(', ')
  console.log(`SIDEBAR-SHIMMER PASS — states, sweep, Reduce Motion, marquee, cleanup; ${ratios}`)
}
