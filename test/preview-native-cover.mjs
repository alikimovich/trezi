// LKM-330: a pointer over a covered rect is the native view's, whatever element WebKit
// resolved for the move. The shield drawing itself is checked by the native inspector smoke.
import assert from 'node:assert/strict'
import { createNativeCover } from '../src/preview/native-cover.ts'

// Before the document exists the cover only stores its rects (it draws on DOMContentLoaded).
globalThis.document = { documentElement: null, addEventListener() {} }
const cover = createNativeCover()
assert.equal(cover.covers(10, 10), false, 'nothing is covered before a report')
cover.set([
  { x: 340, y: 10, width: 300, height: 756 },
  { x: 337, y: 34, width: 6, height: 708 },
  { x: 0, y: 0, width: 0, height: 20 },
  { x: Number.NaN, y: 0, width: 10, height: 10 }
])
assert.equal(cover.covers(490, 388), true, "the island's centre")
assert.equal(cover.covers(338, 40), true, 'the resize edge')
assert.equal(cover.covers(340, 10), true, 'the top-left corner')
assert.equal(cover.covers(640, 388), false, 'the right edge is outside')
assert.equal(cover.covers(200, 388), false, 'the page beside the island')
assert.equal(cover.covers(5, 5), false, 'empty and invalid rects cover nothing')
cover.set([])
assert.equal(cover.covers(490, 388), false, 'a cleared report covers nothing')
console.log(
  'PREVIEW NATIVE COVER OK — moves over covered rects are native, the page beside them is not'
)
