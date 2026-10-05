import assert from 'node:assert/strict'
import { captureForegroundChat } from '../src/native/smoke-input.ts'
import { missingShadowCaptureSemantics } from '../src/native/smoke-shadow-semantics.ts'

const topShadow = ['Shadow Light', 'Light Source', 'Distance', 'Blur']
const bottomShadow = ['Layers', 'Decay', 'rgba(0, 0, 0, 0.35)', 'box-shadow', 'Undo']
assert.deepEqual(missingShadowCaptureSemantics(topShadow, bottomShadow), [])
assert.deepEqual(
  missingShadowCaptureSemantics(['Shadow', 'Light Source', 'Distance', 'Blur'], bottomShadow),
  ['shadow light'],
  'Light Source cannot masquerade as the Shadow Light title'
)
assert.deepEqual(
  missingShadowCaptureSemantics(
    ['Shadow Light', 'Preview', 'Light Source', 'Distance', 'Blur'],
    bottomShadow
  ),
  ['no preview box'],
  'The Shadow Light panel has no local Preview box (LKM-133)'
)

// No host or window: exercise the same readiness/capture sequencing as the smoke fixture.
const ready = { active: true, key: true, focused: true, visible: true }
const states = Object.keys(ready).map((key) => ({ ...ready, [key]: false }))
states.push(ready)
const calls = []
const pixels = { png: 'fixture', width: 400, height: 500, text: ['Shadow Light'] }
assert.equal(
  await captureForegroundChat({
    async request(method, payload) {
      calls.push(method)
      if (method === 'previewInput') {
        assert.deepEqual(payload, { prepare: true, preserveResponder: true })
        return states.shift()
      }
      assert.equal(method, 'captureVisibleChat')
      assert.equal(states.length, 0, 'capture waits until every readiness flag is true')
      return pixels
    }
  }),
  pixels
)
assert.deepEqual(calls, [...Array(5).fill('previewInput'), 'captureVisibleChat'])

let preparations = 0
await assert.rejects(
  captureForegroundChat({
    async request(method) {
      assert.equal(method, 'previewInput', 'never capture while foreground acquisition fails')
      preparations++
      return { ...ready, active: false }
    }
  }),
  /could not acquire the foreground window.*"active":false/
)
assert.equal(preparations, 100, 'foreground acquisition remains bounded')

const lostFocus = new Error('Chat lost foreground during capture')
let captures = 0
await assert.rejects(
  captureForegroundChat({
    async request(method) {
      if (method === 'previewInput') return ready
      assert.equal(method, 'captureVisibleChat')
      captures++
      throw lostFocus
    }
  }),
  (error) => error === lostFocus
)
assert.equal(captures, 3, 'persistent focus loss fails after three fresh capture attempts')
// Reproduce both time-of-check/time-of-use gaps: before dispatch and during SCK.
for (const message of ['Chat window is not in the foreground', lostFocus.message]) {
  const sequence = []
  let count = 0
  assert.equal(
    await captureForegroundChat({
      async request(method) {
        sequence.push(method)
        if (method === 'previewInput') return ready
        if (++count === 1) throw new Error(message)
        return pixels
      }
    }),
    pixels,
    'only the fresh foreground capture supplies evidence'
  )
  assert.deepEqual(sequence, [
    'previewInput',
    'captureVisibleChat',
    'previewInput',
    'captureVisibleChat'
  ])
}

for (const message of [
  'Chat screenshot crop failed',
  'ScreenCaptureKit denied',
  'Request timed out'
]) {
  const failure = new Error(message)
  let count = 0
  await assert.rejects(
    captureForegroundChat({
      async request(method) {
        if (method === 'previewInput') return ready
        count++
        throw failure
      }
    }),
    (error) => error === failure
  )
  assert.equal(count, 1, 'non-foreground errors must fail immediately')
}
console.log(
  'NATIVE-VISIBLE-CAPTURE PASS — readiness, transient focus recovery, bounded failure and capture error propagation'
)
