import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { codexSeatAuthFailure } from '../src/main/backends/codex-auth.ts'
import { setProviderDataOwner } from '../src/main/provider-data.ts'
import {
  cancelProviderSignIn,
  checkCodexLogin,
  claudeManagedLogin,
  codexAuthUrl,
  codexManagedLogin,
  signInProvider
} from '../src/main/provider-sign-in.ts'
import { loginAction, loginCard, startLoginCard } from '../src/native/chat-login.ts'
import { newChat, reduce } from '../src/native/chat-state.ts'
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

// Claude adapter: success, failure, cancel, expiry (timeout) and a missing executable.
const claudeChild = (settle) => {
  const child = new EventEmitter()
  child.kill = () => true
  queueMicrotask(() => settle(child))
  return child
}
{
  const abort = new AbortController()
  const result = await claudeManagedLogin('fixture-claude', abort.signal, () =>
    claudeChild((child) => {
      abort.abort()
      child.emit('exit', null)
    })
  )
  assert.deepEqual([result.ok, result.reason], [false, 'cancelled'])
}
{
  const result = await claudeManagedLogin(
    'fixture-claude',
    new AbortController().signal,
    () => claudeChild(() => {}),
    undefined,
    10
  )
  assert.deepEqual([result.ok, result.reason], [false, 'expired'])
}
{
  const result = await claudeManagedLogin('missing-claude', new AbortController().signal, () =>
    claudeChild((child) => child.emit('error', new Error('ENOENT /private/path')))
  )
  assert.deepEqual([result.ok, result.reason], [false, 'missing'])
  assert.ok(!JSON.stringify(result).includes('private'))
}
{
  const abort = new AbortController()
  const result = await claudeManagedLogin('fixture-claude', abort.signal, () =>
    claudeChild((child) => {
      abort.abort()
      child.emit('error', new Error('AbortError'))
    })
  )
  assert.equal(result.reason, 'cancelled')
}
// Codex adapter: no sign-in page answer in time is expiry.
{
  const server = fakeServer()
  const result = await codexManagedLogin(
    'fixture-codex',
    new AbortController().signal,
    async () => {},
    () => server.child,
    20
  )
  assert.deepEqual([result.ok, result.reason], [false, 'expired'])
}

// `codex login status`: the CLI prints to stderr and exits 1 when signed out.
const fixtures = mkdtempSync(join(tmpdir(), 'trezi-sign-in-'))
const script = (name, body) => {
  const path = join(fixtures, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
const savedCodexBin = process.env.TREZI_CODEX_BIN
try {
  const statusWith = async (bin) => {
    process.env.TREZI_CODEX_BIN = bin
    return checkCodexLogin()
  }
  assert.equal(await statusWith(script('ready-err', 'echo "Logged in using ChatGPT" >&2')), true)
  assert.equal(await statusWith(script('ready-out', 'echo "Logged in using ChatGPT"')), true)
  assert.equal(
    await statusWith(script('signed-out', 'echo "Not logged in" >&2; exit 1')),
    false,
    'signed out is not unknown'
  )
  assert.equal(await statusWith(script('garbled', 'echo "something else" >&2')), null)
  assert.equal(await statusWith(script('crash', 'exit 2')), null, 'offline/unknown')
  assert.equal(await statusWith(join(fixtures, 'absent')), null, 'missing CLI is unknown')

  // signInProvider routes Claude through the chat's own executable and config folder, then
  // re-checks that same identity, and refuses a second concurrent sign-in.
  const record = join(fixtures, 'record')
  const claude = script('claude', `echo "$CLAUDE_CONFIG_DIR|$*" > "${record}"`)
  const checks = []
  let afterLogin = true
  setProviderDataOwner({
    kind: 'swift',
    checkLogin: async (provider, root) => {
      checks.push([provider, root])
      return {
        provider,
        loggedIn: checks.length > 1 ? afterLogin : false,
        source: 'installed',
        executable: claude,
        configDir: '/fixture/config'
      }
    }
  })
  const signedIn = await signInProvider('claude', '/fixture/root')
  assert.equal(signedIn.ok, true)
  assert.equal(readFileSync(record, 'utf8').trim(), '/fixture/config|auth login')
  assert.deepEqual(checks, [
    ['claude', '/fixture/root'],
    ['claude', '/fixture/root']
  ])
  checks.length = 0
  afterLogin = false
  const unconfirmed = await signInProvider('claude', '/fixture/root')
  assert.deepEqual([unconfirmed.ok, unconfirmed.reason], [false, 'expired'])

  // A browser flow still open blocks a second one; Cancel then ends the first.
  checks.length = 0
  setProviderDataOwner({
    kind: 'swift',
    checkLogin: async (provider) => ({
      provider,
      loggedIn: false,
      executable: script('claude-wait', 'exec sleep 30')
    })
  })
  const first = signInProvider('claude', '/fixture/root')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const second = await signInProvider('claude', '/fixture/root')
  assert.deepEqual([second.ok, second.reason], [false, 'failed'])
  cancelProviderSignIn('claude')
  const cancelled = await first
  assert.deepEqual([cancelled.ok, cancelled.reason], [false, 'cancelled'])

  // A Claude executable that cannot be launched is a missing CLI.
  setProviderDataOwner({
    kind: 'swift',
    checkLogin: async (provider) => ({
      provider,
      loggedIn: false,
      executable: join(fixtures, 'absent-claude')
    })
  })
  const missing = await signInProvider('claude', '/fixture/root')
  assert.deepEqual([missing.ok, missing.reason], [false, 'missing'])
} finally {
  setProviderDataOwner(null)
  if (savedCodexBin === undefined) delete process.env.TREZI_CODEX_BIN
  else process.env.TREZI_CODEX_BIN = savedCodexBin
  rmSync(fixtures, { recursive: true, force: true })
}

// Codex auth failures reach the sign-in card; a custom connection's never do.
for (const message of [
  'Codex backend unavailable. Run `codex login`.',
  'the `codex` CLI was not found. Install it and run `codex login`.',
  'unexpected status 401 Unauthorized',
  'spawn codex ENOENT'
])
  assert.equal(codexSeatAuthFailure(message), true, message)
assert.equal(codexSeatAuthFailure('unexpected status 401 Unauthorized', 'conn-1'), false)
assert.equal(codexSeatAuthFailure('stream disconnected: socket hang up'), false)
assert.equal(codexSeatAuthFailure('model is at capacity'), false)

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

// A Codex auth failure mid-conversation shows the card with both sign-in actions, naming Codex.
{
  const codexChat = newChat('codex-auth')
  codexChat.settings = { ...codexChat.settings, provider: 'codex' }
  codexChat.messages = [{ id: 'm1', role: 'user', text: 'hi', statuses: [] }]
  codexChat.last = { id: 't', text: 'saved prompt', attachments: [], selection: null, turn: {} }
  reduce(codexChat, {
    type: 'error',
    code: 'auth',
    message: 'Codex backend unavailable. Run `codex login`.'
  })
  assert.equal(codexChat.login?.code, 'auth')
  assert.ok(!codexChat.messages.some((m) => /codex login/.test(m.text ?? '')))
  const card = loginCard(codexChat)
  assert.match(card.title, /Codex/)
  assert.ok(card.actions.some((a) => a.action === 'sign-in-codex'))
  assert.ok(card.actions.some((a) => a.action === 'sign-in-claude'))

  // Retry only helps when the provider that signed in is the chat's own.
  const hints = []
  const hintController = {
    services: { invoke: async () => ({ ok: true }) },
    changed: () => {},
    refreshReadiness: async () => {},
    choice: async () => {},
    run: () => {
      throw new Error('No automatic send')
    }
  }
  await loginAction(hintController, codexChat, 'sign-in-claude')
  hints.push(codexChat.signInMessage)
  await loginAction(hintController, codexChat, 'sign-in-codex')
  hints.push(codexChat.signInMessage)
  assert.ok(!/Retry/.test(hints[0]), hints[0])
  assert.match(hints[0], /uses Codex/)
  assert.match(hints[1], /Choose Retry/)
  assert.equal(codexChat.settings.provider, 'codex', 'provider is not switched behind the user')
}

console.log('provider-sign-in: OK')
