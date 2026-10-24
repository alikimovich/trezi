// LKM-328: the page's handler for the host's "pointer entered an island" message drops the
// select-mode hover like a move onto a shield does, and the Swift half proves the island's own
// tracking area reports the entry. Real WebKit delivery is covered by the native core group.
import assert from 'node:assert/strict'
import { coalesceHover } from '../src/preview/coalesce-hover.ts'
import { createHoverDrop } from '../src/preview/hover-drop.ts'
import { PREVIEW_ISLAND_ENTERED } from '../src/shared/preview-channels.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

const frames = []
let cancelled = 0
const painted = []
const hover = coalesceHover(
  (target) => painted.push(target),
  (callback) => frames.push(callback),
  () => {
    cancelled++
    frames.length = 0
  }
)
const state = { last: 'h1', box: 'block', measure: true, frozen: false }
const drop = createHoverDrop({
  hover,
  forget: () => {
    state.last = null
  },
  hideBox: () => {
    state.box = 'none'
  },
  clearMeasure: () => {
    state.measure = false
  },
  frozen: () => state.frozen
})

// A hover is painted and a second target waits for its frame.
hover.move({ el: 'h1' })
hover.move({ el: 'p' })
assert.equal(painted.length, 1)
assert.equal(frames.length, 1, 'a frame is pending')
drop.entered()
assert.equal(state.box, 'none', 'the hover box hides')
assert.equal(state.last, null, 'the last hovered element is forgotten')
assert.equal(state.measure, false, 'the measurement clears')
assert.equal(cancelled, 1, 'the pending coalesced hover is cancelled')
assert.equal(frames.length, 0)
assert.equal(painted.length, 1, 'the cancelled frame never paints')

// With a frame in flight, a late hover is not painted after the clear either.
hover.move({ el: 'a' })
hover.move({ el: 'b' })
drop.entered()
assert.equal(painted.length, 2, 'only the first target of the second run paints')

// An inline edit or comment composer keeps its frozen highlight.
Object.assign(state, { box: 'block', last: 'h1', measure: true, frozen: true })
drop.entered()
assert.equal(state.box, 'block', 'a frozen highlight stays')
assert.equal(state.last, 'h1')
// The move over a shield (drop) is unconditional, as before.
drop.drop()
assert.equal(state.box, 'none')

assert.equal(PREVIEW_ISLAND_ENTERED, 'trezi:preview:island-entered')

if (process.platform !== 'darwin') {
  console.log('PREVIEW HOVER DROP SKIP (Swift half) — macOS AppKit required')
} else {
  const binary = swiftBuild('island-pointer', [
    'test/fixtures/island-pointer/main.swift',
    'src/native/FloatingIsland.swift'
  ])
  console.log(runFixture(binary).trim())
}
console.log(
  'PREVIEW HOVER DROP OK — island entry hides the box and cancels a pending hover; a frozen highlight stays'
)
