import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  claudeManagedLogin,
  codexAuthUrl,
  codexManagedLogin
} from '../src/main/provider-sign-in.ts'
import { loginAction, loginCard, startLoginCard } from '../src/native/chat-login.ts'
import { newChat } from '../src/native/chat-state.ts'
import {
  anyProviderReady,
  initialProviderReadiness,
  readinessFromLogin
} from '../src/shared/provider-readiness.ts'

function fakeServer(complete = true) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {
    child.emit('exit', null)
    return true
  }
  const requests = []
  child.stdin.on('data', (chunk) => {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line)
      requests.push(message)
      if (message.method === 'initialize')
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`)
      if (message.method === 'account/login/start')
        child.stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: {
              loginId: 'test-login',
              authUrl: 'https://auth.openai.com/oauth/authorize?state=private'
            }
          })}\n`
        )
      if (message.method === 'account/login/cancel')
        child.stdout.write(
          `${JSON.stringify({
            method: 'account/login/completed',
            params: {
              loginId: 'test-login',
              success: false,
              error: 'cancelled'
            }
          })}\n`
        )
    }
  })
  return {
    child,
    requests,
    finish: () =>
      child.stdout.write(
        `${JSON.stringify({
          method: 'account/login/completed',
          params: { loginId: 'test-login', success: complete, error: complete ? null : 'expired' }
        })}\n`
      )
  }
}

assert.equal(codexAuthUrl('https://trezi.invalid/oauth?token=secret'), null)
assert.equal(codexAuthUrl('http://auth.openai.com/oauth'), null)
assert.equal(codexAuthUrl('https://auth.openai.com.evil.test/oauth'), null)
assert.ok(codexAuthUrl('https://auth.openai.com/oauth'))

for (const success of [true, false]) {
  const server = fakeServer(success)
  let opened = false
  const result = await codexManagedLogin(
    'fixture-codex',
    new AbortController().signal,
    async (url) => {
      opened = url.startsWith('https://auth.openai.com/')
      server.finish()
    },
    () => server.child
  )
  assert.equal(opened, true)
  assert.equal(result.ok, success)
  if (!success) assert.equal(result.reason, 'expired')
  assert.ok(
    server.requests.some((r) => r.method === 'account/login/start' && r.params.type === 'chatgpt')
  )
  assert.ok(!JSON.stringify(result).includes('private'), 'OAuth URL stays out of the result')
}
{
  const server = fakeServer()
  const abort = new AbortController()
  const result = await codexManagedLogin(
    'fixture-codex',
    abort.signal,
    async () => abort.abort(),
    () => server.child
  )
  assert.equal(result.ok, false)
  assert.ok(server.requests.some((r) => r.method === 'account/login/cancel'))
}
{
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  queueMicrotask(() => child.emit('error', new Error('private CLI error')))
  const result = await codexManagedLogin(
    'missing',
    new AbortController().signal,
    async () => {},
    () => child
  )
  assert.equal(result.reason, 'missing')
  assert.ok(!JSON.stringify(result).includes('private'))
}
for (const code of [0, 1]) {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', code))
  const result = await claudeManagedLogin(
    'fixture-claude',
    new AbortController().signal,
    () => child
  )
  assert.equal(result.ok, code === 0)
}

const states = initialProviderReadiness()
assert.equal(anyProviderReady(states), false)
states.claude = readinessFromLogin(false)
states.codex = readinessFromLogin(true)
assert.equal(states.claude.status, 'signed_out')
assert.equal(anyProviderReady(states), true, 'one connected provider remains usable')
states.codex = readinessFromLogin(null)
assert.equal(states.codex.status, 'failed')
assert.deepEqual(initialProviderReadiness().claude, { status: 'checking' }, 'restart checks again')
const chat = newChat('fixture')
chat.text = 'draft remains'
chat.attachments = [
  {
    id: 'image',
    name: 'image.png',
    path: '/fixture/image.png',
    type: 'image/png',
    data: 'private-image'
  }
]
states.codex = readinessFromLogin(false)
assert.deepEqual(
  startLoginCard(chat, states)
    .actions.slice(0, 2)
    .map((x) => x.action),
  ['sign-in-claude', 'sign-in-codex']
)
const calls = []
const controller = {
  services: {
    invoke: async (...args) => {
      calls.push(args)
      return { ok: true }
    }
  },
  changed: () => {},
  refreshReadiness: async () => {},
  choice: async (_chat, label, value) => {
    calls.push(['choice', label, value])
  },
  run: () => {
    throw new Error('No automatic send')
  }
}
await loginAction(controller, chat, 'sign-in-codex')
assert.deepEqual(calls, [
  ['providers:sign-in', 'codex', ''],
  ['choice', 'Provider', 'codex']
])
assert.equal(chat.text, 'draft remains')
assert.equal(chat.attachments[0].data, 'private-image')
assert.equal(chat.messages.length, 0)
assert.ok(!JSON.stringify(startLoginCard(chat, states)).includes('private-image'))
const failed = newChat('failed')
failed.root = '/fixture'
failed.last = {
  id: 'turn-1',
  text: 'saved prompt',
  attachments: [...chat.attachments],
  selection: null,
  turn: {}
}
failed.login = { code: 'auth', message: 'secret-token must not appear' }
assert.ok(!JSON.stringify(loginCard(failed)).includes('secret-token'))
const before = calls.length
await loginAction(controller, failed, 'sign-in-claude')
assert.equal(calls.length, before + 1, 'auth does not send or restart a failed turn')
assert.equal(failed.last.text, 'saved prompt')
assert.equal(failed.last.attachments[0].data, 'private-image')

console.log('provider-sign-in: OK')
