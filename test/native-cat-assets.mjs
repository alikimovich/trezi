import assert from 'node:assert/strict'
import { nativeCatAssets } from '../scripts/native-cat-assets.mjs'

const artwork = nativeCatAssets(new URL('..', import.meta.url).pathname)
assert.deepEqual(Object.keys(artwork).sort(), ['appear', 'idle', 'jump', 'rest', 'run', 'think'])
assert.equal(artwork.run.length, 2)
assert.notDeepEqual(artwork.run[0].pixels, artwork.run[1].pixels)
for (const [pose, frames] of Object.entries(artwork)) {
  assert.ok(frames.length)
  for (const frame of frames) {
    assert.ok(pose === 'rest' || frame.duration > 0)
    for (const [x, y, w, h] of frame.pixels) {
      assert.ok([x, y, w, h].every(Number.isFinite))
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 32 && y + h <= 32)
    }
  }
}
console.log('Native cat artwork and animation frames validated')
