// LKM-406 review repair: `peer_wait` at its advertised maximum answers `timeout`, never the
// transport's "The tool did not answer in time." The real Swift ProviderOwner relays the
// call from a helper-hosted session (the real helper host, a scripted fake provider) to
// Bun's `peer_wait`, with the service's own tool deadline, against a real peer feed of two
// comments that name one file. A real 100 s wait: no clock is faked. Stub providers only.
import './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { swiftConversationOwner } from '../src/main/conversation-owner.ts'
import { projectKey } from '../src/shared/projectKey.ts'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-peer-wait-deadline-')))
process.env.TREZI_USER_DATA = join(temp, 'profile')

const providers = [],
  events = [],
  handlers = new Map()
mock.module('../src/main/backends/index.ts', () => ({
  pickProvider: () => ({
    supportsSpawn: true,
    generateTitle: async () => 'Fixture title',
    startSession: async (cwd, options, getWindow, context) => {
      const cap = createRecordCapture(cwd, projectKey(cwd))
      const emit = (event) => {
        const tagged = {
          ...event,
          projectKey: context.emitKey,
          ...(context.sessionId ? { sessionId: context.sessionId } : {})
        }
        context.onEvent?.(tagged)
        getWindow()?.webContents.send('agent:event', tagged)
      }
      providers.push({ cwd, context })
      return {
        key: projectKey(cwd),
        root: cwd,
        options,
        record: cap.record,
        pending: new Map(),
        pendingQuestions: new Map(),
        finalize: cap.finalize,
        emit,
        dispose() {},
        shutdown() {},
        send() {},
        interrupt: async () => {
          cap.finalize()
          emit({ type: 'done' })
        }
      }
    }
  })
}))
const { registerAgentIpc } = await import('../src/main/agent.ts')
const { helperProvider } = await import('../src/main/backends/helper-session.ts')
const { PEER_WAIT_LIMITS, peerWaitBound } = await import('../src/main/peer-wait.ts')
registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
const invoke = (name, ...args) => handlers.get(name)({}, ...args)
const until = async (condition, what, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await condition()
    if (value) return value
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const failures = []
const check = async (name, run) => {
  const started = performance.now()
  try {
    await run()
    console.log(`  ok: ${name} (${Math.round(performance.now() - started)} ms)`)
  } catch (error) {
    failures.push(name)
    console.log(`  FAILED: ${name}: ${String(error?.message ?? error).slice(0, 400)}`)
  }
}

// The service's own deadline for a tool call, read from the source that sets it.
const SERVICE_TOOL_TIMEOUT_MS =
  Number(
    /var toolTimeout: TimeInterval = (\d+)/.exec(
      readFileSync(new URL('../src/service/ProviderOwner.swift', import.meta.url), 'utf8')
    )?.[1]
  ) * 1000
// What Bun may spend before its own bound starts: the peer read, then the owner's begin.
const BEGIN_LATENCY_MS = 10_000

await check('the longest bound and its begin latency end before the service deadline', () => {
  assert.ok(SERVICE_TOOL_TIMEOUT_MS >= 60_000, 'the service tool deadline was read')
  assert.ok(
    PEER_WAIT_LIMITS.maxMs + BEGIN_LATENCY_MS <= SERVICE_TOOL_TIMEOUT_MS,
    `${PEER_WAIT_LIMITS.maxMs} ms + ${BEGIN_LATENCY_MS} ms latency vs ${SERVICE_TOOL_TIMEOUT_MS} ms`
  )
})

await check('a requested bound is clamped to the limits', () => {
  const max = PEER_WAIT_LIMITS.maxMs / 1000
  assert.equal(peerWaitBound(9999), max)
  assert.equal(peerWaitBound(max + 1), max)
  assert.equal(peerWaitBound(max), max)
  assert.equal(peerWaitBound(0.2), PEER_WAIT_LIMITS.minMs / 1000)
  assert.equal(peerWaitBound(-5), PEER_WAIT_LIMITS.minMs / 1000)
  assert.equal(peerWaitBound(undefined), PEER_WAIT_LIMITS.defaultMs / 1000)
  assert.equal(peerWaitBound(Number.NaN), PEER_WAIT_LIMITS.defaultMs / 1000)
})

await check('a wait at the advertised maximum answers timeout through the service', async () => {
  const repo = join(temp, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(repo, 'src/Hero.tsx'), 'export const Hero = () => null\n')
  git('add', '.')
  git('commit', '-qm', 'Initial')
  const spawn = async (goal) => {
    const started = await invoke('agent:spawn-comment', repo, goal, 'parent', { provider: 'codex' })
    assert.equal(started.ok, true)
    return started.spawnId
  }
  const peer = await spawn('Update src/Hero.tsx heading')
  const waiter = await spawn('Update src/Hero.tsx subtitle')
  const owner = swiftConversationOwner()
  await until(
    async () => (await owner.peers(repo, waiter)).advisories.some((item) => item.peer === peer),
    'the overlap in the feed'
  )

  // The waiter's tools run in a helper under the real Swift ProviderOwner.
  const seen = []
  const session = await helperProvider('fake').startSession(repo, { model: 'm1' }, () => null, {
    emitKey: projectKey(repo),
    liveRoot: repo,
    sessionId: waiter,
    onEvent: (event) => seen.push(event)
  })
  const started = performance.now()
  session.send(`tool peer_wait ${JSON.stringify({ peer, seconds: PEER_WAIT_LIMITS.maxMs / 1000 })}`)
  await until(() => seen.some((e) => e.type === 'done'), 'the wait to answer', 150_000)
  const waitedMs = performance.now() - started
  const said = seen
    .filter((e) => e.type === 'delta')
    .map((e) => e.text)
    .join('')
  assert.doesNotMatch(said, /did not answer in time|tool-error/, said)
  const answer = JSON.parse(said.replace(/^result /, ''))
  assert.equal(answer.waited, true, said)
  assert.equal(answer.outcome, 'timeout', said)
  assert.match(answer.guidance, /do not wait on this peer again/)
  assert.ok(waitedMs >= PEER_WAIT_LIMITS.maxMs - 1000, `waited ${waitedMs} ms`)
  assert.ok(
    waitedMs < SERVICE_TOOL_TIMEOUT_MS,
    `waited ${waitedMs} ms of ${SERVICE_TOOL_TIMEOUT_MS}`
  )
  console.log(
    `Measured on this run: wait at the maximum bound ms=${Math.round(waitedMs)}, service tool deadline ms=${SERVICE_TOOL_TIMEOUT_MS}, answer bytes=${Buffer.byteLength(said)}`
  )
  session.dispose?.()
  assert.equal(providers.length >= 2, true)
})

if (failures.length) {
  console.log(`Peer wait deadline FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(
  'Peer wait deadline: the longest wait answers timeout before the service deadline; no provider calls'
)
process.exit(0)
