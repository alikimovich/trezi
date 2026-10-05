// Native smoke timeouts must name what never became ready. The manager's
// `composerInspect; false` failure (TIFF paste) could not say whether the
// attachment count, the send button's `enabled` or the draft text was wrong.
import assert from 'node:assert/strict'
import { inspectUntil, summarizeState, waitFor } from '../src/native/smoke-wait.ts'

// The failing paste predicate, fed the composer state that times out.
const state = {
  attachments: [{ name: 'Pasted image.png', data: 'A'.repeat(5000) }],
  enabled: false,
  text: '',
  windowKey: false,
  appActive: false,
  inputIsFirstResponder: true,
  bounds: { x: 10, y: 530, width: 420, height: 236 }
}
const predicate = (s) => s.attachments.length === 1 && s.enabled && s.text === ''
const context = () => ({ ready: false, switching: true, textLength: 0, attachments: 1 })

let message = ''
try {
  await inspectUntil(async () => state, 'composerInspect', predicate, context, 120, 10)
} catch (error) {
  message = error.message
}
assert.match(
  message,
  /^Native check timed out: composerInspect; false /,
  'Keeps the original label and predicate result'
)
const detail = JSON.parse(message.slice(message.indexOf('{')))
assert.equal(detail.lastState.enabled, false, 'Reports the field that never became ready')
assert.equal(
  detail.lastState.attachments,
  '[1 items]',
  'Reports attachment count without the image payload'
)
assert.equal(detail.lastState.text, '')
assert.equal(detail.lastState.windowKey, false, 'Reports focus state')
assert.equal(detail.lastState.bounds, '{…}')
assert.deepEqual(detail.context, context(), 'Includes the Bun-side chat inputs to enabled')
assert.ok(!message.includes('AAAA'), 'Payloads stay out of the log')

// Negative control: the helper this replaced reported only the predicate result.
const legacy = async (check, label, timeout) => {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Native check timed out: ${label}; ${String(last)}`)
}
let legacyMessage = ''
try {
  await legacy(async () => predicate(state) && state, 'composerInspect', 120)
} catch (error) {
  legacyMessage = error.message
}
assert.equal(
  legacyMessage,
  'Native check timed out: composerInspect; false',
  'Reproduces the uninformative manager failure'
)
assert.ok(!legacyMessage.includes('enabled'), 'Old message cannot name the failing field')

// Success, thrown checks and broken diagnostics behave as before.
assert.equal(
  await inspectUntil(
    async () => ({ ...state, enabled: true }),
    'composerInspect',
    predicate,
    undefined,
    120,
    10
  ).then((s) => s.enabled),
  true
)
await assert.rejects(
  waitFor(
    () => {
      throw new Error('host closed')
    },
    'layoutInspect',
    60,
    undefined,
    10
  ),
  /timed out: layoutInspect; Error: host closed$/
)
await assert.rejects(
  waitFor(
    () => false,
    'x',
    60,
    () => {
      throw new Error('boom')
    },
    10
  ),
  /diagnostics unavailable: Error: boom/
)
assert.equal(summarizeState('x'.repeat(200)).endsWith('(200 chars)'), true)
console.log(
  'NATIVE-SMOKE-WAIT OK — timeouts report last state, focus and chat context; legacy message reproduced as negative control'
)
