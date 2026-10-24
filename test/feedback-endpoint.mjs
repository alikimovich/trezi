/**
 * LKM-336: Send Feedback goes privately to the Trezi feedback endpoint. The HTTP client
 * (`main/feedback-endpoint.ts`), the invite-code store's Bun side (`main/feedback-code.ts`,
 * with a mock service owner) and the feedback handlers (`main/feedback.ts`) run against
 * an injected `fetch`: no network, no listening port, no Keychain, no `gh`.
 * Run: bun run test:feedback-endpoint
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const logs = mkdtempSync(join(tmpdir(), 'trezi-feedback-logs-'))
process.env.TREZI_LOG_DIR = logs
const { FEEDBACK_ORIGIN, feedbackOrigin, feedbackTester, SCREENSHOT_NOT_ATTACHED, sendFeedback } =
  await import('../src/main/feedback-endpoint.ts')
const { feedbackCode, setFeedbackCodeOwner } = await import('../src/main/feedback-code.ts')
const { BAD_CODE, feedbackHandlers, NO_CODE, SCREENSHOT_TOO_LARGE } = await import(
  '../src/main/feedback.ts'
)
const { FEEDBACK_LIMITS, NETWORK_ERROR } = await import('../src/shared/feedback-body.ts')
const { initProductLog } = await import('../src/main/product-log.ts')
initProductLog('backend', { TREZI_LOG_DIR: logs })

const ORIGIN = 'https://feedback.test'
/** A scripted endpoint: `answer(url, init)` returns a Response (or throws, like a network). */
function endpoint(answer) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    )
    let body = init.body
    if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer())
    else if (typeof body === 'string') body = JSON.parse(body)
    calls.push({ url, method: init.method, headers, body, redirect: init.redirect })
    return answer(url, init)
  }
  return { calls, options: { fetch, origin: ORIGIN, timeoutMs: 1000 } }
}
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
const offline = () => {
  throw new TypeError('fetch failed')
}

// --- The origin: trezi.app, or a loopback mock; never another host from the environment. ---
assert.equal(FEEDBACK_ORIGIN, 'https://trezi.app')
assert.equal(feedbackOrigin({}), 'https://trezi.app')
assert.equal(
  feedbackOrigin({ TREZI_FEEDBACK_URL: 'http://127.0.0.1:4555/x' }),
  'http://127.0.0.1:4555'
)
assert.equal(feedbackOrigin({ TREZI_FEEDBACK_URL: 'http://localhost:9' }), 'http://localhost:9')
for (const bad of ['https://evil.example', 'http://127.0.0.1.evil.example', 'file:///tmp', 'nope'])
  assert.equal(feedbackOrigin({ TREZI_FEEDBACK_URL: bad }), 'https://trezi.app', bad)

// --- GET /me: the tester's name, with the code as the Bearer. ---
let e = endpoint(() => json({ ok: true, name: '  Ada Lovelace ' }))
assert.deepEqual(await feedbackTester('invite-1', e.options), { ok: true, name: 'Ada Lovelace' })
assert.equal(e.calls[0].url, `${ORIGIN}/api/feedback/me`)
assert.equal(e.calls[0].method, 'GET')
assert.equal(e.calls[0].headers.authorization, 'Bearer invite-1')
assert.equal(e.calls[0].redirect, 'error', 'A redirect never carries the code elsewhere')
e = endpoint(() => json({ ok: true, tester: { name: 'Grace' } }))
assert.deepEqual(await feedbackTester('c', e.options), { ok: true, name: 'Grace' })
e = endpoint(() => json({ ok: true }))
assert.deepEqual(await feedbackTester('c', e.options), { ok: true, name: null })
e = endpoint(() => json({ ok: false, error: 'This invite code was revoked.' }, 401))
assert.deepEqual(await feedbackTester('c', e.options), {
  ok: false,
  error: 'This invite code was revoked.',
  retry: false,
  code: true
})
e = endpoint(offline)
assert.deepEqual(await feedbackTester('c', e.options), { ok: false, ...NETWORK_ERROR })

// --- POST /api/feedback without a screenshot: one request, the Linear key back. ---
const request = { body: 'It broke', appVersion: 'Trezi 0.1.0', macOS: 'macOS 15.5' }
e = endpoint(() => json({ ok: true, issue: 'LKM-123' }))
assert.deepEqual(await sendFeedback('invite-1', request, null, e.options), {
  ok: true,
  issue: 'LKM-123'
})
assert.equal(e.calls.length, 1)
assert.equal(e.calls[0].url, `${ORIGIN}/api/feedback`)
assert.equal(e.calls[0].method, 'POST')
assert.equal(e.calls[0].headers.authorization, 'Bearer invite-1')
assert.equal(e.calls[0].headers['content-type'], 'application/json')
assert.deepEqual(e.calls[0].body, request)

// --- With a screenshot: PUT the bytes to the signed URL (no Bearer), then attach. ---
const shot = { ...request, screenshot: { contentType: 'image/png', size: 4 } }
const bytes = new Uint8Array([137, 80, 78, 71])
const upload = {
  url: 'https://storage.test/put?sig=1',
  headers: { 'x-amz-acl': 'private', Authorization: 'stolen', 'x-bad': 7 },
  assetUrl: 'https://assets.test/shot.png'
}
e = endpoint((url) =>
  url.startsWith('https://storage.test')
    ? new Response(null, { status: 200 })
    : url.endsWith('/attach')
      ? json({ ok: true })
      : json({ ok: true, issue: 'LKM-124', upload })
)
assert.deepEqual(await sendFeedback('invite-1', shot, bytes, e.options), {
  ok: true,
  issue: 'LKM-124'
})
assert.deepEqual(
  e.calls.map((c) => `${c.method} ${c.url}`),
  [
    `POST ${ORIGIN}/api/feedback`,
    'PUT https://storage.test/put?sig=1',
    `POST ${ORIGIN}/api/feedback/attach`
  ]
)
assert.deepEqual(e.calls[1].headers, { 'content-type': 'image/png', 'x-amz-acl': 'private' })
assert.deepEqual([...e.calls[1].body], [...bytes], 'The real image bytes, not a data URI')
assert.deepEqual(e.calls[2].body, { issue: 'LKM-124', assetUrl: 'https://assets.test/shot.png' })
assert.equal(e.calls[2].headers.authorization, 'Bearer invite-1')

// Once the report exists, a screenshot problem is a warning: Retry would file it twice.
for (const [label, answer] of [
  [
    'upload refused',
    (url) => (url.includes('storage') ? new Response(null, { status: 403 }) : null)
  ],
  ['upload offline', (url) => (url.includes('storage') ? offline() : null)],
  ['attach refused', (url) => (url.endsWith('/attach') ? json({ ok: false }, 500) : null)]
]) {
  e = endpoint(
    (url, init) =>
      answer(url, init) ??
      (url.endsWith('/attach')
        ? json({ ok: true })
        : url.includes('storage')
          ? new Response(null, { status: 200 })
          : json({ ok: true, issue: 'LKM-125', upload }))
  )
  assert.deepEqual(
    await sendFeedback('c', shot, bytes, e.options),
    { ok: true, issue: 'LKM-125', warning: SCREENSHOT_NOT_ATTACHED },
    label
  )
}
// An upload target that is not https (or no target) is never used.
for (const bad of [{ ...upload, url: 'http://storage.test/put' }, { url: upload.url }, undefined]) {
  e = endpoint(() => json({ ok: true, issue: 'LKM-126', upload: bad }))
  assert.deepEqual(await sendFeedback('c', shot, bytes, e.options), {
    ok: true,
    issue: 'LKM-126',
    warning: SCREENSHOT_NOT_ATTACHED
  })
  assert.equal(e.calls.length, 1)
}

// --- Failures: the endpoint's message; 429 says when; offline keeps Retry. ---
e = endpoint(() => json({ ok: false, error: 'Slow down.' }, 429, { 'retry-after': '120' }))
assert.deepEqual(await sendFeedback('c', request, null, e.options), {
  ok: false,
  error: 'Slow down. Try again in 2 minutes.',
  retry: true
})
e = endpoint(() => json({ ok: false, error: 'Report too large.' }, 413))
assert.deepEqual(await sendFeedback('c', request, null, e.options), {
  ok: false,
  error: 'Report too large.',
  retry: false
})
e = endpoint(() => json({ ok: false, error: 'Unknown invite code.' }, 401))
assert.equal((await sendFeedback('c', request, null, e.options)).code, true)
e = endpoint(offline)
assert.deepEqual(await sendFeedback('c', request, null, e.options), { ok: false, ...NETWORK_ERROR })
e = endpoint(() => new Response('<html>oops</html>', { status: 502 }))
assert.equal((await sendFeedback('c', request, null, e.options)).retry, true)
for (const odd of [{ ok: true }, { ok: true, issue: 'not a key' }, { issue: 'LKM-1' }]) {
  e = endpoint(() => json(odd))
  assert.equal((await sendFeedback('c', request, null, e.options)).ok, false, JSON.stringify(odd))
}

// --- The invite-code store's Bun side, against a mock service owner. ---
assert.equal(await feedbackCode.has(), false, 'No service: no code')
assert.equal(await feedbackCode.read(), null)
await assert.rejects(() => feedbackCode.save('x'), /service is not running/)
const owner = { code: null, saves: [] }
setFeedbackCodeOwner({
  feedbackCodeStatus: async () => ({ hasCode: owner.code !== null }),
  saveFeedbackCode: async (code) => {
    owner.saves.push(code)
    owner.code = code || null
    return owner.code !== null
  },
  feedbackCode: async () => owner.code
})
assert.equal(await feedbackCode.save('  invite-2 \n'), true)
assert.deepEqual(owner.saves, ['invite-2'], 'Saved trimmed')
assert.equal(await feedbackCode.has(), true)
assert.equal(await feedbackCode.read(), 'invite-2')
await feedbackCode.remove()
assert.deepEqual(owner.saves, ['invite-2', ''], 'Remove saves the empty code')
assert.equal(await feedbackCode.has(), false)
setFeedbackCodeOwner({
  feedbackCodeStatus: async () => {
    throw new Error('locked')
  },
  saveFeedbackCode: async () => {
    throw new Error('Trezi could not encrypt the invite code with your Keychain.')
  },
  feedbackCode: async () => {
    throw new Error('locked')
  }
})
assert.equal(await feedbackCode.has(), false, 'An unreadable status is no code')
assert.equal(await feedbackCode.read(), null, 'An undecryptable code is no code')
await assert.rejects(() => feedbackCode.save('x'), /encrypt the invite code/)
setFeedbackCodeOwner(null)

// --- The feedback handlers: account, the code check, and a send. ---
let saved = null
const memory = {
  has: async () => saved !== null,
  read: async () => saved,
  save: async (code) => {
    saved = code
    return true
  },
  remove: async () => {
    saved = null
  }
}
const stamps = { appVersion: () => 'Trezi test', macOS: () => 'macOS test' }
const server = (overrides = {}) =>
  endpoint((url, init) => {
    const auth = init.headers?.authorization
    if (url.includes('storage')) return new Response(null, { status: 200 })
    if (auth !== 'Bearer invite-3') return json({ ok: false, error: 'Unknown invite code.' }, 401)
    if (url.endsWith('/me')) return json({ ok: true, name: 'Tester Three' })
    if (url.endsWith('/attach')) return json({ ok: true })
    return overrides.post?.() ?? json({ ok: true, issue: 'LKM-200', upload })
  })
e = server()
let feedback = feedbackHandlers({ code: memory, endpoint: e.options, ...stamps })
assert.deepEqual(await feedback.account(), { hasCode: false })
assert.equal(e.calls.length, 0, 'No code: no request')
assert.deepEqual(await feedback.submit({ body: 'x' }), {
  ok: false,
  error: NO_CODE,
  retry: false,
  code: true
})
// A code that could never be one is refused before any request; a wrong one by the endpoint.
assert.deepEqual(await feedback.saveCode('has spaces in it'), { ok: false, error: BAD_CODE })
assert.deepEqual(await feedback.saveCode('x'.repeat(513)), { ok: false, error: BAD_CODE })
assert.equal(e.calls.length, 0)
assert.deepEqual(await feedback.saveCode('wrong-code'), {
  ok: false,
  error: 'Unknown invite code.'
})
assert.equal(saved, null, 'A refused code is not saved')
assert.deepEqual(await feedback.saveCode('  invite-3 '), { ok: true, name: 'Tester Three' })
assert.equal(saved, 'invite-3')
assert.deepEqual(await feedback.account(), { hasCode: true, name: 'Tester Three' })

// A send with every opt-in: the PNG goes as bytes, the conversation as text.
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
e.calls.length = 0
assert.deepEqual(
  await feedback.submit({
    body: '  Secret feedback text  ',
    conversation: 'You: hi',
    diagnostics: false,
    screenshot: { contentType: 'image/png', data: png.toString('base64') }
  }),
  { ok: true, issue: 'LKM-200' }
)
assert.deepEqual(e.calls[0].body, {
  body: 'Secret feedback text',
  conversation: 'You: hi',
  appVersion: 'Trezi test',
  macOS: 'macOS test',
  screenshot: { contentType: 'image/png', size: png.length }
})
assert.deepEqual([...e.calls[1].body], [...png])
assert.equal(e.calls.length, 3)
// A screenshot over 10 MB is left out, and the toast says so.
e.calls.length = 0
const big = Buffer.alloc(FEEDBACK_LIMITS.screenshot + 1, 1).toString('base64')
assert.deepEqual(
  await feedback.submit({ body: 'Big', screenshot: { contentType: 'image/jpeg', data: big } }),
  { ok: true, issue: 'LKM-200', warning: SCREENSHOT_TOO_LARGE }
)
assert.equal(e.calls.length, 1, 'No upload')
assert.equal(e.calls[0].body.screenshot, undefined)
// Input the endpoint would refuse never leaves the Mac.
e.calls.length = 0
assert.deepEqual(await feedback.submit({ body: '   ' }), {
  ok: false,
  error: 'Please describe your feedback first.',
  retry: false
})
assert.equal(e.calls.length, 0)
// A revoked code asks for a new one; a rate limit stays retryable.
saved = 'revoked'
assert.equal((await feedback.submit({ body: 'x' })).code, true)
saved = 'invite-3'
e = server({ post: () => json({ ok: false, error: 'Slow down.' }, 429, { 'retry-after': '5' }) })
feedback = feedbackHandlers({ code: memory, endpoint: e.options, ...stamps })
assert.deepEqual(await feedback.submit({ body: 'x' }), {
  ok: false,
  error: 'Slow down. Try again in 5 seconds.',
  retry: true
})
// Removing the code needs no request.
e.calls.length = 0
assert.deepEqual(await feedback.saveCode(''), { ok: true, name: null })
assert.equal(saved, null)
assert.equal(e.calls.length, 0)

// The product log counts the post and never holds the feedback or the code.
const logged = readdirSync(logs)
  .map((name) => readFileSync(join(logs, name), 'utf8'))
  .join('\n')
assert.ok(logged.includes('Feedback posted'), 'The Dreamer counts posted feedback')
assert.ok(!logged.includes('Secret feedback') && !logged.includes('invite-3'))
rmSync(logs, { recursive: true, force: true })

console.log('feedback-endpoint: origin, /me, send, upload, attach, errors, code store, handlers OK')
