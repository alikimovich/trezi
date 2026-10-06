// Pure scheduling contract. The native sent-attachments smoke measures real
// WebContent hover, selection and bridge time with the rendered chat open.
import assert from 'node:assert/strict'
import { coalesceHover } from '../src/preview/coalesce-hover.ts'

let callback
let scheduled = 0
let cancelled = 0
const painted = []
const hover = coalesceHover(
  (target) => painted.push(target),
  (next) => {
    scheduled++
    callback = next
    return scheduled
  },
  () => {
    cancelled++
    callback = undefined
  }
)
for (let i = 0; i < 100; i++) hover.move({ index: i })
assert.equal(scheduled, 1, 'only one layout pass is queued per frame')
assert.equal(painted.length, 1, 'the first target paints without waiting for a frame')
assert.equal(painted[0].index, 0)
callback()
assert.equal(painted.length, 2)
assert.equal(painted[1].index, 99, 'the latest pointer target wins the next frame')
hover.move({ index: 100 })
hover.clear()
assert.equal(cancelled, 1)
assert.equal(callback, undefined, 'a click or mode switch cancels stale hover work')
console.log('PREVIEW HOVER COALESCE OK — first move paints now; 99 later moves queue one frame')
