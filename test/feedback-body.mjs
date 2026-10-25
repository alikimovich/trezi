/**
 * Unit test for the pure Send Feedback request builder and the endpoint's error mapping
 * (LKM-27, LKM-336: the private Trezi feedback endpoint, no GitHub). Run via bun so the
 * .ts import transpiles: bun run test:feedback-body
 */
import assert from 'node:assert/strict'
import {
  buildFeedbackRequest,
  CONVERSATION_CUT,
  DIAGNOSTICS_CUT,
  endpointMessage,
  FEEDBACK_LIMITS,
  FeedbackInputError,
  feedbackError,
  NETWORK_ERROR,
  retryWhen
} from '../src/shared/feedback-body.ts'

const base = { appVersion: 'Trezi 0.1.0 (build 1, abc)', macOS: 'macOS 15.5' }

// --- The request: the trimmed body and the stamps; nothing else unless opted in. ---
assert.deepEqual(buildFeedbackRequest({ ...base, body: '  please fix \n' }), {
  body: 'please fix',
  appVersion: 'Trezi 0.1.0 (build 1, abc)',
  macOS: 'macOS 15.5'
})
assert.deepEqual(
  buildFeedbackRequest({
    ...base,
    body: 'hi',
    conversation: 'You: hello\n\nTrezi: hi',
    diagnostics: '## Logs\nok',
    screenshot: { contentType: 'image/png', size: 1234 }
  }),
  {
    body: 'hi',
    conversation: 'You: hello\n\nTrezi: hi',
    diagnostics: '## Logs\nok',
    appVersion: base.appVersion,
    macOS: base.macOS,
    screenshot: { contentType: 'image/png', size: 1234 }
  }
)
// No data URI or GitHub markup anywhere: the screenshot is only its type and size.
const json = JSON.stringify(
  buildFeedbackRequest({ ...base, body: 'x', screenshot: { contentType: 'image/jpeg', size: 9 } })
)
assert.ok(!json.includes('data:image') && !json.includes('<details>'))
// Empty attachments are left out.
assert.deepEqual(
  Object.keys(buildFeedbackRequest({ ...base, body: 'x', conversation: ' ', diagnostics: '' })),
  ['body', 'appVersion', 'macOS']
)

// --- Limits. The body is never cut: empty or too long is refused with a plain message. ---
assert.throws(() => buildFeedbackRequest({ ...base, body: '   ' }), FeedbackInputError)
assert.ok(buildFeedbackRequest({ ...base, body: 'x'.repeat(FEEDBACK_LIMITS.body) }))
assert.throws(
  () => buildFeedbackRequest({ ...base, body: 'x'.repeat(FEEDBACK_LIMITS.body + 1) }),
  (error) =>
    error instanceof FeedbackInputError && /20,001 characters.*limit is 20,000/.test(error.message)
)
// A long conversation keeps its latest messages, within the limit.
const conversation = `first message ${'a'.repeat(FEEDBACK_LIMITS.conversation)} latest message`
const cut = buildFeedbackRequest({ ...base, body: 'x', conversation }).conversation
assert.equal(cut.length, FEEDBACK_LIMITS.conversation)
assert.ok(cut.startsWith(CONVERSATION_CUT) && cut.endsWith('latest message'))
assert.ok(!cut.includes('first message'))
// Long diagnostics keep their start, within the limit.
const diagnostics = `## Trezi ${'d'.repeat(FEEDBACK_LIMITS.diagnostics)}`
const diag = buildFeedbackRequest({ ...base, body: 'x', diagnostics }).diagnostics
assert.equal(diag.length, FEEDBACK_LIMITS.diagnostics)
assert.ok(diag.startsWith('## Trezi') && diag.endsWith(DIAGNOSTICS_CUT))
// A screenshot over 10 MB, empty, or of another type is left out.
for (const screenshot of [
  { contentType: 'image/png', size: FEEDBACK_LIMITS.screenshot + 1 },
  { contentType: 'image/png', size: 0 },
  { contentType: 'image/gif', size: 10 },
  { contentType: 'image/jpeg', size: 1.5 }
])
  assert.equal(buildFeedbackRequest({ ...base, body: 'x', screenshot }).screenshot, undefined)
assert.deepEqual(
  buildFeedbackRequest({
    ...base,
    body: 'x',
    screenshot: { contentType: 'image/jpeg', size: FEEDBACK_LIMITS.screenshot }
  }).screenshot,
  { contentType: 'image/jpeg', size: FEEDBACK_LIMITS.screenshot }
)

// --- The endpoint's own message, on one line and bounded. ---
assert.equal(
  endpointMessage({ ok: false, error: '  Code revoked.\n\u0007Ask again. ' }),
  'Code revoked. Ask again.'
)
assert.equal(endpointMessage({ ok: false }), null)
assert.equal(endpointMessage('nope'), null)
assert.equal(endpointMessage({ error: 'e'.repeat(900) }).length, 500)

// --- Error mapping. ---
const now = Date.parse('2026-10-24T12:00:00Z')
assert.deepEqual(feedbackError(401, { ok: false, error: 'Unknown invite code.' }), {
  error: 'Unknown invite code.',
  retry: false,
  code: true
})
const unauthorized = feedbackError(401, null)
assert.equal(unauthorized.code, true)
assert.match(unauthorized.error, /invite code was not accepted/)
assert.deepEqual(feedbackError(413, { ok: false, error: 'Too large.' }), {
  error: 'Too large.',
  retry: false
})
assert.match(feedbackError(413, null).error, /too large/)
assert.deepEqual(feedbackError(400, { ok: false, error: 'body is required' }), {
  error: 'body is required',
  retry: false
})
// 429 says when to retry, from seconds or an HTTP date, and stays retryable.
assert.deepEqual(feedbackError(429, { ok: false, error: 'Slow down.' }, '30', now), {
  error: 'Slow down. Try again in 30 seconds.',
  retry: true
})
assert.equal(
  feedbackError(429, null, '300', now).error,
  'Too many reports were sent in a short time. Try again in 5 minutes.'
)
assert.equal(
  feedbackError(429, null, new Date(now + 2 * 3600_000).toUTCString(), now).error,
  'Too many reports were sent in a short time. Try again in 2 hours.'
)
assert.equal(
  feedbackError(429, null, null, now).error,
  'Too many reports were sent in a short time. Try again later.'
)
assert.equal(retryWhen('1', now), 'in 1 second')
assert.equal(retryWhen('soon', now), null)
assert.equal(retryWhen(new Date(now - 5000).toUTCString(), now), 'in 1 second')
// Server errors retry; any other status does not.
assert.deepEqual(feedbackError(503, { ok: false, error: 'Down for maintenance.' }), {
  error: 'Down for maintenance.',
  retry: true
})
assert.match(feedbackError(502, '<html>').error, /HTTP 502/)
assert.equal(feedbackError(404, null).retry, false)
assert.equal(NETWORK_ERROR.retry, true)
assert.match(NETWORK_ERROR.error, /could not reach the feedback service/)

console.log('feedback-body: request builder, limits and error mapping OK')
