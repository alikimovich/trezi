/**
 * LKM-587: the chat-gate smoke's pixel reading of the toolbar gaps either side of the
 * chat/preview rule (src/native/smoke-split.ts). Synthetic rows at 2x in the measured
 * layout: New Chat's glass outline at px 1332 and the viewport island's at px 1347, i.e.
 * an even 14 px between them. A one-pixel hairline at px 1340 (the old rule) reads 7 and 6;
 * the one-point rule centred on the edge (px 1339-1340) reads 6 and 6.
 *
 * Run with: bun test/split-gap-pixels.mjs
 */
import assert from 'node:assert/strict'
import { assertSplitGapPixels, splitGapsInPixels } from '../src/native/smoke-split.ts'

const row = (rule) => (x) => {
  if (x === 1332 || x === 1347) return [191, 191, 191]
  if (x < 1332 || x > 1347) return [249, 249, 249]
  if (rule.includes(x)) return [220, 220, 220]
  return [255, 255, 255]
}

assert.deepEqual(splitGapsInPixels(row([1340]), 52, 1340, 1341), { left: 7, right: 6 })
assert.deepEqual(splitGapsInPixels(row([1339, 1340]), 52, 1339, 1341), { left: 6, right: 6 })

const split = {
  chatNewVisible: true,
  spansTopBar: true,
  surfaceTop: 828,
  scale: 2,
  ruleMinX: 669.5,
  ruleMaxX: 670.5,
  frames: { viewport: '{{670, 776}, {85, 52}}' }
}
assert.deepEqual(assertSplitGapPixels(split, row([1339, 1340]), 'centred'), {
  left: 6,
  right: 6
})
assert.throws(
  () => assertSplitGapPixels({ ...split, ruleMinX: 670, ruleMaxX: 670.5 }, row([1340]), 'hairline'),
  /same either side/
)
// No glass edge within reach on one side fails closed instead of comparing two limits.
const bare = (x) => (x === 1339 || x === 1340 ? [220, 220, 220] : [255, 255, 255])
assert.throws(() => assertSplitGapPixels(split, bare, 'no glass'), /glass edge lies within/)
// Nothing to compare when New Chat is hidden or the rule stops at the top bar.
assert.equal(assertSplitGapPixels({ ...split, chatNewVisible: false }, row([1340]), 'x'), null)
assert.equal(assertSplitGapPixels({ ...split, spansTopBar: false }, row([1340]), 'x'), null)
// An odd backing scale cannot centre the rule; the pixel check does not apply.
assert.equal(assertSplitGapPixels({ ...split, scale: 1 }, row([1340]), 'x'), null)
console.log('SPLIT-GAP-PIXELS PASS — 7/6 px hairline rejected, centred 1 pt rule reads 6/6 px')
