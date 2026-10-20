// LOCAL-WEBKIT-1: what an agent's private page is checked against. A worktree's exact
// source snapshot (HEAD plus every non-ignored change, excluding its node_modules and
// .env); the Bun registry of private runtimes over a fake runtime owner (shared
// starts, port-conflict retry, exits by generation, cleanup, no adoption); and the
// private identity, which only verifies a document the current server generation
// loaded from the worktree's current source.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import {
  agentBrowser,
  agentBrowserCount,
  closeAgentBrowser,
  privateName,
  registerChromiumBrowser,
  releaseAgentBrowsersFor,
  setAgentBrowserIdleMs
} from '../src/main/agent-browser.ts'
import { describeSource, privateIdentity, snapshotOf } from '../src/main/agent-identity.ts'
import {
  agentRuntime,
  agentRuntimeEnded,
  agentRuntimes,
  ensureAgentRuntime,
  installAgentRuntimes,
  stopAgentRuntime
} from '../src/main/agent-runtime.ts'
import { describeIdentity } from '../src/main/preview-identity.ts'
import { sourceSnapshot } from '../src/main/source-snapshot.ts'
import { NativeBridge, setBridge } from '../src/native/bridge.ts'
import { RuntimeServiceError } from '../src/native/runtime-service.ts'

const scratch = mkdtempSync(join(tmpdir(), 'trezi-agent-runtime-'))
const git = (...args) => execFileSync('git', args, { stdio: 'pipe' }).toString()
const commit = (repo, message) =>
  git('-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message)
const repo = (name) => {
  const path = join(scratch, name)
  mkdirSync(join(path, 'src'), { recursive: true })
  writeFileSync(join(path, 'index.html'), '<h1>A</h1>')
  writeFileSync(join(path, 'src/app.js'), 'export const a = 1\n')
  writeFileSync(join(path, '.gitignore'), 'dist/\n')
  git('init', '-q', path)
  git('-C', path, 'add', '-A')
  commit(path, 'init')
  return path
}

try {
  // ── Source snapshots ──
  const a = repo('a')
  const clean = await sourceSnapshot(a)
  assert.match(clean.id, /^[0-9a-f]{64}$/)
  assert.equal(clean.dirty, 0)
  assert.equal(clean.head, git('-C', a, 'rev-parse', 'HEAD').trim())
  const ids = new Set([clean.id])
  const changed = async (label, expectDirty) => {
    const snapshot = await sourceSnapshot(a)
    assert.ok(snapshot.id, label)
    assert.ok(!ids.has(snapshot.id), `${label} changes the snapshot`)
    if (expectDirty !== undefined) assert.equal(snapshot.dirty, expectDirty, label)
    ids.add(snapshot.id)
    return snapshot
  }
  writeFileSync(join(a, 'index.html'), '<h1>B</h1>')
  await changed('an unstaged edit', 1)
  writeFileSync(join(a, 'index.html'), '<h1>C</h1>')
  await changed('a second edit of the same path', 1)
  git('-C', a, 'add', 'index.html')
  const staged = await sourceSnapshot(a)
  assert.ok(ids.has(staged.id), 'staging the same bytes is the same source')
  writeFileSync(join(a, 'src/new.js'), 'export const b = 2\n')
  await changed('an untracked file', 2)
  unlinkSync(join(a, 'src/app.js'))
  await changed('a deleted file', 3)
  symlinkSync('index.html', join(a, 'link.html'))
  await changed('a symlink', 4)
  // Ignored output, the worktree's own dependencies and its .env are outside the source.
  const before = await sourceSnapshot(a)
  mkdirSync(join(a, 'dist'))
  writeFileSync(join(a, 'dist/out.js'), 'built')
  mkdirSync(join(a, 'node_modules/pkg'), { recursive: true })
  writeFileSync(join(a, 'node_modules/pkg/index.js'), 'dep')
  writeFileSync(join(a, '.env'), 'SECRET=1')
  assert.equal((await sourceSnapshot(a)).id, before.id, 'ignored, node_modules and .env excluded')
  // Back to HEAD's bytes is HEAD's source again.
  git('-C', a, 'reset', '-q', '--hard')
  git('-C', a, 'clean', '-qfd', '-e', 'node_modules', '-e', '.env', '-e', 'dist')
  assert.equal((await sourceSnapshot(a)).id, clean.id, 'restoring the bytes restores the id')
  // Two checkouts of the same commit with the same edits hold the same source.
  const b = join(scratch, 'b')
  git('clone', '-q', a, b)
  writeFileSync(join(a, 'index.html'), '<h1>same</h1>')
  writeFileSync(join(b, 'index.html'), '<h1>same</h1>')
  const [sa, sb] = await Promise.all([sourceSnapshot(a), sourceSnapshot(b)])
  assert.equal(sa.id, sb.id, 'same HEAD and bytes in two checkouts')
  writeFileSync(join(b, 'index.html'), '<h1>other</h1>')
  assert.notEqual((await sourceSnapshot(b)).id, sa.id)
  // A read already running is never shared (it may predate a change); later calls share
  // the one read queued behind it. Outside Git there is no snapshot.
  const [one, two, three] = await Promise.all([
    sourceSnapshot(a),
    sourceSnapshot(a),
    sourceSnapshot(a)
  ])
  assert.notEqual(one, two)
  assert.equal(two, three)
  assert.equal(one.id, two.id)
  const first = sourceSnapshot(a)
  writeFileSync(join(a, 'index.html'), '<h1>after the first read started</h1>')
  const second = await sourceSnapshot(a)
  await first
  assert.notEqual(second.id, sa.id, 'a call after a write sees the write')
  writeFileSync(join(a, 'index.html'), '<h1>same</h1>')
  const plain = join(scratch, 'plain')
  mkdirSync(plain)
  assert.deepEqual(
    { ...(await sourceSnapshot(plain)), takenAt: 0 },
    { id: null, tree: null, head: null, dirty: 0, takenAt: 0, reason: 'not-a-git-checkout' }
  )
  // LOCAL-WEBKIT-2: a path Git reports as a directory (an embedded repository or a
  // gitlink) has contents the snapshot does not read, so it never yields an id that
  // could stay the same while they change.
  const d = repo('d')
  const nested = join(d, 'vendor')
  mkdirSync(nested)
  git('init', '-q', nested)
  writeFileSync(join(nested, 'lib.js'), 'one')
  git('-C', nested, 'add', '-A')
  commit(nested, 'one')
  const untrackedRepo = await sourceSnapshot(d)
  assert.deepEqual(
    [untrackedRepo.id, untrackedRepo.reason, untrackedRepo.dirty],
    [null, 'unsupported-entry', 1],
    'an untracked embedded repository'
  )
  git('-C', d, 'add', 'vendor')
  commit(d, 'vendor gitlink')
  assert.equal((await sourceSnapshot(d)).dirty, 0, 'a committed gitlink at its commit is clean')
  assert.match((await sourceSnapshot(d)).id, /^[0-9a-f]{64}$/)
  writeFileSync(join(nested, 'lib.js'), 'two')
  git('-C', nested, 'add', '-A')
  commit(nested, 'two')
  const movedGitlink = await sourceSnapshot(d)
  assert.deepEqual(
    [movedGitlink.id, movedGitlink.reason],
    [null, 'unsupported-entry'],
    'a gitlink whose repository moved is dirty and has no exact id'
  )
  writeFileSync(join(nested, 'lib.js'), 'three')
  git('-C', nested, 'add', '-A')
  commit(nested, 'three')
  assert.equal(
    (await sourceSnapshot(d)).id,
    null,
    'still unavailable after its contents change again, never a repeated constant'
  )
  console.log('AGENT-RUNTIME source snapshot PASS')

  // ── The private runtime registry over a fake owner ──
  const calls = []
  const agentExits = new Set()
  let port = 5100
  let generation = 0
  let failNext = []
  let detected = { previewKind: 'web', framework: 'static', devCommand: '', setupRequired: false }
  let gate = null
  const fake = {
    async detect(root) {
      calls.push(['detect', root])
      return detected
    },
    async startAgent(opts) {
      calls.push(['startAgent', opts.agent, opts.root, opts.command, opts.framework])
      if (gate) await gate
      const failure = failNext.shift()
      if (failure) throw failure
      return {
        url: `http://127.0.0.1:${++port}`,
        pid: 4242,
        agent: opts.agent,
        generation: ++generation
      }
    },
    async stopAgent(agent, root) {
      calls.push(['stopAgent', agent, root])
    },
    async stopAgents(agent) {
      calls.push(['stopAgents', agent ?? null])
      return 0
    },
    onAgentExit(listener) {
      agentExits.add(listener)
    },
    onAgentLog() {}
  }
  const exit = (agent, root, url, reason, gen) => {
    for (const listener of agentExits) listener(agent, root, url, reason, gen)
  }
  await assert.rejects(ensureAgentRuntime('p0', a), /no Trezi runtime owner/)
  await installAgentRuntimes(fake)
  assert.deepEqual(calls.shift(), ['stopAgents', null], "a previous Bun's runtimes are stopped")
  // Concurrent calls share one start; the detected command and framework are used.
  const [r1, r2] = await Promise.all([ensureAgentRuntime('p1', a), ensureAgentRuntime('p1', a)])
  assert.equal(r1, r2)
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'startAgent'),
    [['startAgent', 'p1', a, '', 'static']]
  )
  assert.equal(agentRuntime('p1'), r1)
  assert.equal(await ensureAgentRuntime('p1', a), r1, 'a running runtime is reused')
  // A port lost to another process is retried once; any other failure is not.
  calls.length = 0
  failNext = [new RuntimeServiceError('conflict', 'port taken')]
  const retried = await ensureAgentRuntime('p2', b)
  assert.equal(calls.filter(([kind]) => kind === 'startAgent').length, 2)
  failNext = [new RuntimeServiceError('unavailable', 'exit 1'), new Error('never reached')]
  await assert.rejects(
    ensureAgentRuntime('p3', b),
    /^Error: The agent's private dev server did not start: exit 1$/
  )
  assert.equal(failNext.length, 1, 'no retry after a real failure')
  failNext = []
  // Projects a private runtime cannot serve are refused before anything starts.
  detected = { previewKind: 'web', framework: 'vite', devCommand: 'vite', setupRequired: true }
  await assert.rejects(ensureAgentRuntime('p3', b), /setup required/)
  detected = { previewKind: 'native', framework: 'swift', devCommand: '', setupRequired: false }
  await assert.rejects(ensureAgentRuntime('p3', b), /web projects only/)
  await assert.rejects(ensureAgentRuntime('p3', join(scratch, 'gone')), /no longer exists/)
  detected = { previewKind: 'web', framework: 'static', devCommand: '', setupRequired: false }
  // An exit from an older generation or another root is ignored; the current one is recorded.
  exit('p2', b, retried.url, 'old', retried.generation - 1)
  exit('p2', a, retried.url, 'elsewhere', retried.generation)
  assert.equal(agentRuntime('p2'), retried)
  exit('p2', b, retried.url, 'The dev server exited (code 2).\nError: boom', retried.generation)
  assert.equal(agentRuntime('p2'), null)
  assert.deepEqual(agentRuntimeEnded('p2'), {
    reason: 'The dev server exited (code 2).\nError: boom',
    generation: retried.generation
  })
  const restarted = await ensureAgentRuntime('p2', b)
  assert.ok(restarted.generation > retried.generation)
  assert.equal(agentRuntimeEnded('p2'), null, 'a new start clears the ended note')
  // Another root for the same id stops the old runtime first.
  calls.length = 0
  await ensureAgentRuntime('p2', a)
  assert.deepEqual(calls[0], ['stopAgent', 'p2', b])
  // A stop cancels a start in flight at once, without waiting for it: the owner is asked to
  // stop that agent while the start is still pending, and the late answer registers nothing.
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  let open
  gate = new Promise((resolve) => {
    open = resolve
  })
  calls.length = 0
  const pending = ensureAgentRuntime('p4', b)
  pending.catch(() => {})
  await tick()
  assert.ok(calls.some(([kind, agent]) => kind === 'startAgent' && agent === 'p4'))
  await stopAgentRuntime('p4') // resolves while the gate is still closed
  assert.deepEqual(calls.at(-1), ['stopAgents', 'p4'], 'the owner is told to stop the agent now')
  assert.equal(agentRuntime('p4'), null)
  // A start after that stop is a fresh one, never the cancelled start.
  const newer = ensureAgentRuntime('p4', b)
  await tick()
  assert.equal(calls.filter(([kind]) => kind === 'startAgent').length, 2)
  open()
  gate = null
  await assert.rejects(pending, /cancelled: its page was closed/)
  const brought = await newer
  assert.equal(agentRuntime('p4'), brought, 'only the newer start is registered')
  assert.deepEqual(
    agentRuntimes().filter(({ agent }) => agent === 'p4'),
    [brought]
  )
  // A stop with no start pending still stops the agent's runtimes.
  await stopAgentRuntime('p4')
  assert.equal(agentRuntime('p4'), null)
  assert.deepEqual(calls.at(-1), ['stopAgents', 'p4'])
  for (const { agent } of agentRuntimes()) await stopAgentRuntime(agent)
  assert.deepEqual(agentRuntimes(), [])

  // An agent page with an open in flight (a private start waits up to 150 s) is busy, never
  // idle; closing it during that start stops the start at once and leaves nothing behind.
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let releaseOpen
  const slowGate = new Promise((resolve) => {
    releaseOpen = resolve
  })
  let slowClosed = 0
  const slowBrowser = (key, root) => {
    const id = `idle-${key}`
    const browser = {
      id,
      root,
      runtime: 'private',
      url: null,
      navigation: 0,
      servedRevision: null,
      speed: 1,
      host: {},
      async capture() {
        return null
      },
      async setSpeed() {},
      async step() {},
      async open(path) {
        await ensureAgentRuntime(id, b)
        await slowGate
        browser.url = `http://localhost:3000${path}`
        return { url: browser.url, loaded: true, identity: await browser.identity() }
      },
      async identity() {
        return { session: id, navigation: 0, servedRevision: null, liveRevision: null }
      },
      async close() {
        slowClosed++
        await stopAgentRuntime(id)
      }
    }
    return Promise.resolve(browser)
  }
  registerChromiumBrowser(slowBrowser)
  setAgentBrowserIdleMs(40)
  try {
    const idle = await agentBrowser('idle', b, 'chromium')
    gate = new Promise((resolve) => {
      open = resolve
    })
    calls.length = 0
    const opening = idle.open('/')
    opening.catch(() => {})
    await settle(15)
    assert.ok(calls.some(([kind, agent]) => kind === 'startAgent' && agent === 'idle-idle'))
    await settle(150) // several idle periods pass with the start still pending
    assert.equal(slowClosed, 0, 'an open in flight is not reclaimed as idle')
    assert.equal(agentBrowserCount(), 1)
    // Closing during the pending start returns at once, without waiting for it.
    const closing = closeAgentBrowser('chromium:idle')
    const raced = await Promise.race([closing.then(() => 'closed'), settle(500).then(() => 'hung')])
    assert.equal(raced, 'closed', 'close does not wait for the pending start')
    assert.equal(slowClosed, 1)
    assert.equal(agentBrowserCount(), 0)
    assert.deepEqual(calls.at(-1), ['stopAgents', 'idle-idle'])
    // The late answers register no runtime and reopen no page.
    open()
    gate = null
    releaseOpen()
    await assert.rejects(opening, /cancelled: its page was closed/)
    assert.equal(agentRuntime('idle-idle'), null)
    assert.deepEqual(agentRuntimes(), [])
    assert.equal(agentBrowserCount(), 0)
    // Once the open settles, the page is idle again and is reclaimed on time.
    const again = await agentBrowser('again', b, 'chromium')
    await again.open('/')
    await settle(150)
    assert.equal(agentBrowserCount(), 0, 'a settled page is reclaimed after the idle limit')
    assert.equal(slowClosed, 2)
  } finally {
    setAgentBrowserIdleMs(null)
    registerChromiumBrowser(null)
  }
  for (const { agent } of agentRuntimes()) await stopAgentRuntime(agent)

  // The real WebKit page over a fake host: the host answers each request itself, and the
  // page creation can be held. A released or closed page never starts a private server.
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  setBridge(new NativeBridge({ input: fromHost, output: toHost }))
  const hostCalls = []
  let createGate = null
  let closeGate = null
  createInterface({ input: toHost }).on('line', async (line) => {
    const message = JSON.parse(line)
    hostCalls.push(message)
    if (message.id === undefined) return
    if (message.method === 'agentBrowserCreate' && createGate) await createGate
    if (message.method === 'agentBrowserClose' && closeGate) await closeGate
    fromHost.write(`${JSON.stringify({ event: 'reply', id: message.id, value: {} })}\n`)
  })
  const hostCount = (method) => hostCalls.filter((message) => message.method === method).length
  const started = () => calls.filter(([kind]) => kind === 'startAgent').length
  // A session that closes while its page is still being created: the page is closed on
  // arrival, never published, and nothing starts a server for it.
  let releaseCreate
  createGate = new Promise((resolve) => {
    releaseCreate = resolve
  })
  calls.length = 0
  const creating = agentBrowser('rel', b, 'webkit', a)
  creating.catch(() => {})
  await tick()
  assert.equal(agentBrowserCount(), 1)
  assert.equal(await releaseAgentBrowsersFor(b), 1, 'the pending page is released')
  assert.equal(await releaseAgentBrowsersFor(a), 0, 'another checkout is untouched')
  // A new call for the same page waits for the released one to close, then opens afresh.
  const again = agentBrowser('rel', b, 'webkit', a)
  again.catch(() => {})
  await tick()
  assert.equal(hostCount('agentBrowserCreate'), 1, 'no second page beside the released one')
  releaseCreate()
  createGate = null
  await assert.rejects(creating, /released before it opened/)
  assert.equal(hostCount('agentBrowserClose'), 1, 'the released page was closed')
  const reopened = await again
  assert.equal(hostCount('agentBrowserCreate'), 2)
  assert.equal(agentBrowserCount(), 1, 'only the fresh page is registered')
  assert.equal(started(), 0, 'no private server was started for a released page')
  // LOCAL-WEBKIT-2: the page's own height and scheme reach the host with its width, for
  // this agent view only.
  await reopened.host.setViewport(390, { height: 700, theme: 'dark' })
  const sized = hostCalls.filter((message) => message.method === 'previewViewport').at(-1)
  assert.deepEqual(
    [sized?.view?.startsWith('agent:'), sized?.width, sized?.height, sized?.theme],
    [true, 390, 700, 'dark']
  )
  // A late open on a closed page starts nothing.
  await closeAgentBrowser(privateName('rel', b))
  assert.equal(agentBrowserCount(), 0)
  calls.length = 0
  await assert.rejects(reopened.open('/'), /agent browser was closed/)
  assert.equal(started(), 0, 'open on a closed page never starts a server')
  assert.deepEqual(agentRuntimes(), [])
  // A close while open waits for its private server: the start is cancelled at once, the
  // open fails as closed, and no runtime survives the late answer.
  const mid = await agentBrowser('mid', b, 'webkit', a)
  let releaseStart
  gate = new Promise((resolve) => {
    releaseStart = resolve
  })
  calls.length = 0
  const midOpen = mid.open('/')
  midOpen.catch(() => {})
  await tick()
  assert.equal(started(), 1)
  await closeAgentBrowser(privateName('mid', b))
  assert.deepEqual(calls.at(-1), ['stopAgents', mid.id], 'the pending start is stopped at once')
  releaseStart()
  gate = null
  await assert.rejects(midOpen, /agent browser was closed/)
  assert.equal(agentRuntime(mid.id), null)
  assert.deepEqual(agentRuntimes(), [])
  assert.equal(agentBrowserCount(), 0)
  // LOCAL-WEBKIT-2: a page reopened while the same name is still closing waits for the
  // close, so the old teardown never stops the replacement's runtime or drops its view.
  const old = await agentBrowser('race', b, 'webkit', a)
  await ensureAgentRuntime(old.id, b)
  assert.ok(agentRuntime(old.id), 'the first page has its private server')
  let releaseClose
  closeGate = new Promise((resolve) => {
    releaseClose = resolve
  })
  const creates = hostCount('agentBrowserCreate')
  const closingOld = closeAgentBrowser(privateName('race', b))
  await tick()
  assert.equal(hostCount('agentBrowserClose') > 0, true, 'the close reached the host')
  const successor = agentBrowser('race', b, 'webkit', a)
  await tick()
  await settle(30)
  assert.equal(hostCount('agentBrowserCreate'), creates, 'no replacement while the old close runs')
  releaseClose()
  closeGate = null
  await closingOld
  const next = await successor
  assert.equal(hostCount('agentBrowserCreate'), creates + 1)
  assert.notEqual(next, old, 'a fresh page object')
  assert.equal(agentBrowserCount(), 1, 'only the replacement is registered')
  await ensureAgentRuntime(next.id, b)
  assert.ok(agentRuntime(next.id), 'the replacement keeps its private server')
  const { views: nativeViews } = await import('../src/native/platform.ts')
  assert.ok(nativeViews.has(`agent:${next.id}`), 'the replacement keeps its view')
  await closeAgentBrowser(privateName('race', b))
  assert.equal(agentRuntime(next.id), null)
  assert.equal(agentBrowserCount(), 0)
  console.log('AGENT-RUNTIME registry PASS')

  // ── The private identity ──
  const c = repo('c')
  const server = await ensureAgentRuntime('page', c)
  const record = async (overrides = {}) => {
    // The page records its snapshots as it starts and loads; here both are read now.
    const snapshot = Promise.resolve(await snapshotOf(c))
    return {
      navigation: 1,
      generation: server.generation,
      origin: new URL(server.url).origin,
      before: snapshot,
      after: snapshot,
      started: Promise.resolve(1000),
      ...overrides
    }
  }
  const page = async (overrides = {}) => ({
    id: 'page',
    root: c,
    url: `${server.url}/`,
    navigation: 1,
    served: await record(),
    documentStartedAt: async () => 1000,
    ...overrides
  })
  const verified = await privateIdentity(await page())
  assert.equal(verified.stale, false)
  assert.equal(verified.source.verified, true)
  assert.equal(verified.source.reason, null)
  assert.equal(verified.source.served, verified.source.current)
  assert.equal(verified.runtime.kind, 'private')
  assert.equal(verified.runtime.root, c)
  assert.equal(verified.runtime.url, server.url)
  assert.equal(verified.runtime.generation, server.generation)
  assert.equal(verified.session, `rt-page-g${server.generation}`)
  assert.equal(verified.documentStartedAt, new Date(1000).toISOString())
  assert.match(
    describeIdentity(verified),
    /Source verified: snapshot [0-9a-f]{12}, 0 uncommitted paths/
  )
  const reason = async (overrides) => (await privateIdentity(await page(overrides))).source.reason
  assert.equal(await reason({ navigation: 0, url: null }), 'not-loaded')
  assert.equal(await reason({ served: null }), 'unknown-navigation')
  assert.equal(await reason({ navigation: 2 }), 'unknown-navigation')
  assert.equal(await reason({ documentStartedAt: async () => 2000 }), 'document-replaced')
  assert.equal(await reason({ documentStartedAt: async () => null }), 'document-replaced')
  assert.equal(
    await reason({ served: await record({ generation: server.generation - 1 }) }),
    'runtime-restarted'
  )
  assert.equal(
    await reason({ served: await record({ origin: 'http://127.0.0.1:1' }) }),
    'runtime-restarted'
  )
  const loading = await record()
  writeFileSync(join(c, 'index.html'), '<h1>during</h1>')
  assert.equal(
    await reason({ served: { ...loading, after: snapshotOf(c) } }),
    'changed-during-load'
  )
  writeFileSync(join(c, 'index.html'), '<h1>A</h1>')
  // An edit after the load is stale until the page loads again; the same bytes verify again.
  const loaded = await page()
  writeFileSync(join(c, 'src/app.js'), 'export const a = 2\n')
  const edited = await privateIdentity(loaded)
  assert.equal(edited.stale, true)
  assert.equal(edited.source.reason, 'source-changed')
  assert.equal(edited.source.dirty, 1)
  assert.match(
    describeIdentity(edited),
    /Source NOT verified: the worktree changed after the page loaded/
  )
  assert.equal(await privateIdentity(await page()).then((id) => id.source.verified), true)
  writeFileSync(join(c, 'src/app.js'), 'export const a = 1\n')
  assert.equal((await privateIdentity(loaded)).source.verified, true)
  // A base change (a new commit with the same files) is a different source too.
  git(
    '-C',
    c,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base'
  )
  assert.equal((await privateIdentity(loaded)).source.reason, 'source-changed')
  // The runtime ending by itself is reported with its reason.
  const fresh = await page()
  exit('page', c, server.url, 'The dev server exited (code 1).', server.generation)
  const stopped = await privateIdentity(fresh)
  assert.equal(stopped.source.reason, 'runtime-stopped')
  assert.equal(stopped.runtime.ended, 'The dev server exited (code 1).')
  assert.match(describeSource(stopped), /not running.*It ended: The dev server exited \(code 1\)\./)
  // A restarted server (new generation) never verifies a document from the old one.
  await ensureAgentRuntime('page', c)
  assert.equal((await privateIdentity(fresh)).source.reason, 'runtime-restarted')
  // An unreadable snapshot is never treated as verified.
  const outside = await privateIdentity({ ...(await page()), root: plain })
  assert.equal(outside.source.verified, false)
  assert.equal(
    describeSource({ ...verified, runtime: undefined }),
    null,
    'live pages keep their line'
  )
  console.log('AGENT-RUNTIME identity PASS')

  // Private page names are per worktree, apart from the live page of the same key.
  assert.notEqual(privateName('chat', a), privateName('chat', b))
  assert.equal(privateName('chat', a), privateName('chat', `${a}/`))
  assert.notEqual(privateName('chat', a), 'webkit:chat')
  console.log('AGENT-RUNTIME PASS')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
