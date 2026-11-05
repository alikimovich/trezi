import assert from 'node:assert/strict'
import {
  NEW_CHAT_INTERACTION_STAGES,
  paintedButtonDifference
} from '../src/native/smoke-toolbar-actions.ts'

// The foreground fixture compares native toolbar pixels, including the focus ring
// outside the button frame. Keep that detector sensitive to each interaction state.
assert.deepEqual(NEW_CHAT_INTERACTION_STAGES, [
  'hover',
  'pressed',
  'focus-new',
  'focus-more',
  'focus-sidebar'
])
const geometry = { window: '{{0, 0}, {120, 60}}', crop: '{0, 0}' }
const frame = '{{30, 14}, {32, 32}}'
const raster = (paint = () => false) => ({
  width: 120,
  height: 60,
  rgb: (x, y) => (paint(x, y) ? [120, 120, 120] : [100, 100, 100])
})
const idle = raster()
const hover = raster((x, y) => x >= 31 && x <= 61 && y >= 15 && y <= 45)
const focus = raster((x, y) => (x === 26 || x === 64) && y >= 13 && y <= 47)
assert.equal(paintedButtonDifference(idle, idle, geometry, frame).changed, 0)
for (const image of [hover, focus]) {
  const change = paintedButtonDifference(idle, image, geometry, frame)
  assert.ok(
    change.changed >= 8 && change.peak >= 5,
    `painted state stays observable: ${JSON.stringify(change)}`
  )
}
assert.throws(() => paintedButtonDifference(idle, raster(), geometry, '{{0, 0}, {0, 0}}'))
console.log('TOOLBAR-BUTTON-PIXELS PASS')
