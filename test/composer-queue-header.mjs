import assert from 'node:assert/strict'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-436: the queue header's `resume` is a numeric frame when Send now is shown and JSON null
// when it is not, and no header value is an Optional boxed in `Any`. The real ComposerQueueHost
// is measured offscreen, so the frames come from its SwiftUI layout pass.
if (process.platform !== 'darwin') {
  console.log('COMPOSER-QUEUE-HEADER SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('composer-queue-header', [
    'test/fixtures/composer-queue-header/main.swift',
    ...['ChatScrollStyle', 'ChatEnvironment', 'ComposerQueue'].map(
      (name) => `src/native/${name}.swift`
    )
  ])
  const report = JSON.parse(runFixture(binary))
  const dump = JSON.stringify(report)
  const frame = (value, what) => {
    assert.equal(typeof value, 'object', `${what} is a frame: ${dump}`)
    assert.notEqual(value, null, `${what} is measured: ${dump}`)
    for (const key of ['top', 'bottom', 'midY', 'minX', 'midX', 'maxX', 'width', 'height'])
      assert.equal(typeof value[key], 'number', `${what}.${key} is a number: ${dump}`)
    assert.ok(value.width > 0 && value.height > 0, `${what} has a size: ${dump}`)
  }
  for (const [name, paused] of [
    ['present', true],
    ['absent', false]
  ]) {
    const { inspect, optionals, isDictionary } = report[name]
    assert.equal(isDictionary, true, `${name}: the header is a [String: Any]: ${dump}`)
    assert.deepEqual(optionals, [], `${name}: no Optional is boxed in the header: ${dump}`)
    const header = inspect.header
    assert.deepEqual(
      Object.keys(header).sort(),
      ['divider', 'frame', 'glyph', 'paused', 'resume'],
      `${name}: the header's keys: ${dump}`
    )
    assert.strictEqual(header.paused, paused, `${name}: paused stays a bool: ${dump}`)
    frame(header.frame, `${name} frame`)
    frame(header.glyph, `${name} glyph`)
    frame(header.divider, `${name} divider`)
  }
  frame(report.present.inspect.header.resume, 'Send now')
  assert.strictEqual(
    report.absent.inspect.header.resume,
    null,
    `no Send now is JSON null, not a missing key: ${dump}`
  )
  console.log('COMPOSER-QUEUE-HEADER PASS')
}
