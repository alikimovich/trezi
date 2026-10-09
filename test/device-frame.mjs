import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-217: the mobile bezel's screen opening and continuous corner, measured from the asset.
// The build writes the asset as device.png (scripts/build-native.mjs); so does this test.
const source = readFileSync('src/shared/iphone-frame.ts', 'utf8').match(
  /FRAME_DATA_URI =\s*'([^']+)'/
)[1]
const png = Buffer.from(source.split(',')[1], 'base64')

/** RGBA 8-bit PNG → alpha(x, y), y down. Independent of the Swift measurement. */
function decode(buffer) {
  let at = 8
  let width = 0
  let height = 0
  const chunks = []
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('ascii', at + 4, at + 8)
    const data = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      assert.deepEqual([data[8], data[9], data[12]], [8, 6, 0], 'the asset is non-interlaced RGBA')
    }
    if (type === 'IDAT') chunks.push(data)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0
      const p = a + b - c
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter]
      out[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255
    }
  }
  return { width, height, alpha: (x, y) => out[(y * width + x) * 4 + 3] }
}

// The straight edges of the opening: anti-aliased pixels count by their transparency.
const image = decode(png)
const coverage = (x, y) => 1 - image.alpha(x, y) / 255
const along = (x, y, dx, dy, length) => {
  let sum = 0
  for (let i = 0; i < length; i++) sum += coverage(x + dx * i, y + dy * i)
  return sum
}
const midX = image.width >> 1
const midY = image.height >> 1
// Bezel pixels are opaque and the opening fully clear; the edge is where the clear run ends.
const edge = (x, y, dx, dy) => {
  let i = 0
  while (image.alpha(x + dx * i, y + dy * i) < 255) i++
  return along(x, y, dx, dy, i)
}
const bottomMid = Math.round(image.width * 0.25)
const independent = {
  x: midX - edge(midX - 1, midY, -1, 0),
  y: midY - edge(bottomMid, midY - 1, 0, -1),
  right: midX + edge(midX, midY, 1, 0),
  bottom: midY + edge(bottomMid, midY, 0, 1)
}

if (process.platform !== 'darwin') {
  console.log('DEVICE-FRAME SKIP — macOS Swift toolchain required')
} else {
  const directory = mkdtempSync(join(tmpdir(), 'trezi-device-frame-'))
  try {
    writeFileSync(join(directory, 'device.png'), png)
    const binary = swiftBuild('device-frame', [
      'test/fixtures/device-frame/main.swift',
      'src/native/DeviceFrame.swift'
    ])
    const frames = JSON.parse(runFixture(binary, [directory]))
    assert.equal(frames.length, 1, 'one device frame is offered')
    for (const frame of frames) {
      assert.deepEqual([frame.width, frame.height], [image.width, image.height])
      const { screen } = frame
      for (const [name, swift, js] of [
        ['left', screen.x, independent.x],
        ['top', screen.y, independent.y],
        ['right', screen.x + screen.width, independent.right],
        ['bottom', screen.y + screen.height, independent.bottom]
      ])
        assert.ok(Math.abs(swift - js) < 0.02, `${frame.name}: ${name} edge ${swift} vs ${js}`)
      // iPhone 16 Pro: 62 pt display corners on a 402 pt wide screen.
      const points = (frame.radius / screen.width) * 402
      assert.ok(Math.abs(points - 62) < 1, `${frame.name}: corner ${points.toFixed(2)} pt ≈ 62 pt`)
      console.log(
        `${frame.name}: opening ${screen.x.toFixed(2)},${screen.y.toFixed(2)} ${screen.width.toFixed(2)}×${screen.height.toFixed(2)} px, continuous radius ${frame.radius.toFixed(2)} px (edge rms ${frame.rms.toFixed(3)} px, max ${frame.max.toFixed(2)}; circular rms ${frame.circularRms.toFixed(3)})`
      )
    }
    console.log('DEVICE-FRAME PASS')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
