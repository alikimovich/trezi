// LKM-406 Coordinated parallel work 5: overlap, wait, reconciliation and decision feedback
// and the bounded named-peer wait, through the real lifecycle: `agent:send` and
// `agent:spawn-comment`, the Swift owners, disposable Git repos and real `run_checks`.
// Stub providers only: every edit is scripted, so nothing here measures model judgement.
import './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { setConversationOwner, swiftConversationOwner } from '../src/main/conversation-owner.ts'
import { peerChanged, peerRow } from '../src/main/peer-work.ts'
import { newChat, reduce } from '../src/native/chat-state.ts'
import { projectKey } from '../src/shared/projectKey.ts'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-peer-feedback-')))
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
      const entry = { cwd, context, sent: [] }
      const emit = (event) => {
        const tagged = {
          ...event,
          projectKey: context.emitKey,
          ...(context.sessionId ? { sessionId: context.sessionId } : {})
        }
        context.onEvent?.(tagged)
        getWindow()?.webContents.send('agent:event', tagged)
      }
      const session = {
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
        send: (text) => entry.sent.push(text),
        interrupt: async () => {
          cap.finalize()
          emit({ type: 'done' })
        }
      }
      Object.assign(entry, {
        session,
        say: (text) => cap.appendAssistant(text),
        done: () => {
          cap.finalize()
          emit({ type: 'done' })
        }
      })
      providers.push(entry)
      return session
    }
  })
}))
const { registerAgentIpc } = await import('../src/main/agent.ts')
const { runTreziTool } = await import('../src/main/session-tools.ts')
registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
const invoke = (name, ...args) => handlers.get(name)({}, ...args)
const wait = async (condition, what) => {
  for (let i = 0; i < 500; i++) {
    const value = await condition()
    if (value) return value
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const CHECK = `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync('.runs', 'x')
if (/^(<{7}|>{7})/m.test(readFileSync('page.txt', 'utf8'))) process.exit(2)
`
const LINES = Array.from({ length: 30 }, (_, i) => `line ${i}`)
const page = (changes = {}) => `${LINES.map((line, i) => changes[i] ?? line).join('\n')}\n`

let repos = 0
function project() {
  const repo = join(temp, `repo-${++repos}`)
  mkdirSync(join(repo, 'src'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(repo, 'package.json'), '{"scripts":{"test":"bun check.mjs"}}\n')
  writeFileSync(join(repo, 'check.mjs'), CHECK)
  writeFileSync(join(repo, '.gitignore'), '.runs\n')
  writeFileSync(join(repo, 'page.txt'), page())
  writeFileSync(join(repo, 'src/Hero.tsx'), 'export const Hero = () => null\n')
  writeFileSync(join(repo, 'src/Pricing.tsx'), 'export const Pricing = () => null\n')
  git('add', '.')
  git('commit', '-qm', 'Initial')
  return {
    repo,
    git,
    parent: projectKey(repo),
    live: () => readFileSync(join(repo, 'page.txt'), 'utf8')
  }
}

const scope = (p, worker) => ({
  root: worker.cwd,
  liveRoot: p.repo,
  emitKey: worker.key ?? p.parent,
  background: !worker.key,
  ...(worker.id ? { peerId: worker.id } : {}),
  notify() {}
})
const tool = (p, worker, name, args = {}) => runTreziTool(name, args, scope(p, worker))
const check = async (p, worker) => {
  const answer = await tool(p, worker, 'run_checks', { checks: ['test'] })
  assert.equal(answer.results?.[0]?.receipt?.verified, true, JSON.stringify(answer).slice(0, 400))
}
const put = (worker, file, text) => {
  mkdirSync(dirname(join(worker.cwd, file)), { recursive: true })
  writeFileSync(join(worker.cwd, file), text)
}
async function comment(p, goal) {
  const started = await invoke('agent:spawn-comment', p.repo, goal, 'parent', { provider: 'codex' })
  assert.equal(started.ok, true)
  assert.ok(!started.queued)
  const worker = providers.at(-1)
  worker.id = started.spawnId
  return worker
}
const finished = (id) => events.find((e) => e.type === 'spawn-finished' && e.sessionId === id)
async function finish(worker) {
  const sent = worker.sent.length
  worker.done()
  await wait(() => finished(worker.id) || worker.sent.length > sent, 'the comment to settle')
  return finished(worker.id) ?? { continued: worker.sent.at(-1) }
}
const applied = (result) => assert.equal(result.outcome, 'applied', result.summary)
async function openChat(p) {
  const opened = await invoke('agent:open-project', p.repo, { provider: 'codex' })
  assert.notEqual(opened.ok, false, opened.error)
  const worker = providers.at(-1)
  worker.key = p.parent
  return worker
}
let turns = 0
async function send(worker, text) {
  const id = `turn-${++turns}`
  const sent = worker.sent.length
  const queued = await invoke('agent:send', text, [], worker.key, {}, id)
  assert.notEqual(queued?.ok, false, queued?.error)
  await wait(() => worker.sent.length > sent, 'the chat turn to reach its provider')
  return id
}
const landed = (id) => events.some((e) => e.type === 'landing-finished' && e.turn === id)

/** What one task's card was told, in order. */
const states = (worker) =>
  events.filter(
    (e) =>
      e.type === 'peer-state' &&
      (worker.id ? e.sessionId === worker.id : !e.sessionId && e.projectKey === worker.key)
  )
const shown = (worker) => states(worker).at(-1)?.lines ?? []
const showing = (worker, kind) => shown(worker).some((line) => line.kind === kind)
const told = (worker, kind) =>
  states(worker).filter((state) => state.lines.some((line) => line.kind === kind)).length
const bounded = () => {
  for (const event of events.filter((e) => e.type === 'peer-state'))
    measure('peer-state event bytes', Buffer.byteLength(JSON.stringify(event)))
}
/** Past the feedback's debounce, so anything it was going to say has been said. */
const quiet = () => pause(120)

const measured = {}
const measure = (name, value) => {
  measured[name] = Math.max(measured[name] ?? 0, value)
}
const failures = []
async function scenario(name, run) {
  const started = performance.now()
  try {
    await run(project())
    measure(`${name} ms`, Math.round(performance.now() - started))
    console.log(`  ok: ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  FAILED: ${name}: ${String(error?.message ?? error).slice(0, 300)}`)
  }
}

/** Two comments that name one file: `waiter` is about to wait on `peer`. */
async function overlapping(p) {
  const peer = await comment(p, 'Update src/Hero.tsx heading')
  const waiter = await comment(p, 'Update src/Hero.tsx subtitle')
  await wait(() => showing(waiter, 'overlap'), 'the overlap to show')
  return { peer, waiter }
}
const waitOn = (p, waiter, peer, seconds = 30) => {
  const started = performance.now()
  const answer = tool(p, waiter, 'peer_wait', { peer: peer.id, seconds })
  return { answer, ms: async () => (await answer, performance.now() - started) }
}
const waiting = (worker) => wait(() => showing(worker, 'waiting'), 'the wait to show')

try {
  await scenario('overlap renders once per change, uncertain, and clears', async (p) => {
    const a = await comment(p, 'Update src/Hero.tsx heading')
    const b = await comment(p, 'Update src/Hero.tsx subtitle')
    await wait(() => showing(b, 'overlap'), 'the possible overlap')
    assert.equal(shown(b)[0].certainty, 'uncertain', 'unobserved files are not known overlap')
    assert.equal(shown(b)[0].peer, a.id)
    const before = states(b).length
    // Reads, identical status and heartbeat-like repeats are not state changes.
    for (let i = 0; i < 6; i++) {
      await tool(p, b, 'workspace_state')
      b.session.emit({ type: 'status', text: 'Reading' })
      a.session.emit({ type: 'status', text: 'Reading' })
    }
    await quiet()
    assert.equal(states(b).length, before, 'no repeat of an unchanged state')
    put(a, 'src/Hero.tsx', 'export const Hero = () => "a"\n')
    put(b, 'src/Hero.tsx', 'export const Hero = () => "b"\n')
    a.session.emit({ type: 'status', text: 'Edit' })
    b.session.emit({ type: 'status', text: 'Edit' })
    await wait(() => shown(b)[0]?.certainty === 'known', 'the known overlap')
    await quiet()
    assert.equal(states(b).length, before + 1, 'the upgrade to known renders once')
    assert.deepEqual(shown(b)[0].files, ['src/Hero.tsx'])
    await check(p, a)
    applied(await finish(a))
    await wait(() => !shown(b).length, 'the overlap to clear when the peer ends')
    await quiet()
    assert.equal(states(b).length, before + 2, 'the clear renders once')
  })

  // The owner lists advisories newest peer version first, and every upsert bumps a version.
  // Two peers publishing alternately must not reorder, and so re-send, an unchanged state.
  const churn = async (p, peers, rounds) => {
    for (let round = 0; round < rounds; round++)
      for (const peer of peers) {
        if (round % 2) {
          // An unrelated observed file: a real version bump, no change to the overlap.
          put(peer, `notes/${round}-${peer.id.slice(0, 6)}.md`, `round ${round}\n`)
          peer.session.emit({ type: 'status', text: 'Edit' })
        } else {
          // The 60 s heartbeat: the same row published again.
          await swiftConversationOwner().peerUpsert(peerRow(p.repo, peer.id))
          peerChanged(p.repo)
        }
        await pause(40)
      }
    await quiet()
  }
  const peersOf = (worker) => shown(worker).map((line) => line.peer)

  await scenario('lines keep one order while peers publish alternately', async (p) => {
    const peers = [
      await comment(p, 'Update src/Hero.tsx heading'),
      await comment(p, 'Update src/Hero.tsx subtitle')
    ]
    const waiter = await comment(p, 'Update src/Hero.tsx footer')
    await wait(() => shown(waiter).length === 2, 'both overlaps to show')
    await quiet()
    const first = peersOf(waiter)
    assert.deepEqual(first, peers.map((peer) => peer.id).sort(), 'ordered by peer, not by recency')
    const before = states(waiter).length
    await churn(p, peers, 6)
    assert.deepEqual(peersOf(waiter), first, 'the same order')
    assert.equal(states(waiter).length, before, 'publishing alternately renders nothing')
  })

  await scenario('more lines than fit keep showing the same peers', async (p) => {
    // A project runs three comments at once, so the other peers are rows of the waiter's own
    // kind published straight to the owner: five peers, one more than the card shows.
    const waiter = await comment(p, 'Update src/Hero.tsx footer')
    const template = peerRow(p.repo, waiter.id)
    const owner = swiftConversationOwner()
    const ghosts = ['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e'].map((id) => ({
      ...template,
      id,
      goal: `Update src/Hero.tsx part ${id}`
    }))
    const publish = async (rows) => {
      for (const row of rows) await owner.peerUpsert(row)
      peerChanged(p.repo)
      await quiet()
    }
    try {
      await publish(ghosts)
      await wait(() => shown(waiter).length === 4, 'the bounded lines to show')
      await quiet()
      const first = peersOf(waiter)
      assert.deepEqual(first, ['peer-a', 'peer-b', 'peer-c', 'peer-d'], 'the first four by peer')
      const before = states(waiter).length
      // Each round makes the opposite peer the newest, ending with the one left out.
      for (let round = 0; round < 4; round++)
        await publish(round % 2 ? ghosts : [...ghosts].reverse())
      assert.deepEqual(peersOf(waiter), first, 'the same four peers')
      assert.equal(states(waiter).length, before, 'no re-render for a bound of lines')
    } finally {
      for (const row of ghosts) await owner.peerRemove(row.id)
    }
  })

  await scenario('a shared word reads as uncertain, never as safe or known', async (p) => {
    await comment(p, 'Rework the checkout pricing copy in src/Hero.tsx')
    const b = await comment(p, 'Rework the checkout pricing copy in src/Pricing.tsx')
    await wait(() => showing(b, 'overlap'), 'the uncertain overlap')
    assert.equal(shown(b)[0].certainty, 'uncertain')
  })

  await scenario('a wait ends on the peer landing, shown once and cleared', async (p) => {
    const { peer, waiter } = await overlapping(p)
    put(peer, 'src/Hero.tsx', 'export const Hero = () => "peer"\n')
    const held = waitOn(p, waiter, peer)
    await waiting(waiter)
    await quiet()
    assert.equal(told(waiter, 'waiting'), 1, 'the wait renders once')
    await check(p, peer)
    applied(await finish(peer))
    const answer = await held.answer
    assert.equal(answer.waited, true)
    assert.equal(answer.outcome, 'landed')
    assert.ok(answer.revision, 'names the revision to reconcile against')
    await wait(() => !showing(waiter, 'waiting'), 'the wait to clear')
    await quiet()
    assert.equal(told(waiter, 'waiting'), 1, 'and it does not render again')
    assert.equal(shown(waiter).length, 0, 'the peer ended: nothing stays on the card')
    bounded()
  })

  await scenario('a wait ends when the waiting comment is stopped', async (p) => {
    const { peer, waiter } = await overlapping(p)
    const held = waitOn(p, waiter, peer)
    await waiting(waiter)
    await invoke('agent:spawn-interrupt', waiter.id)
    assert.equal((await held.answer).outcome, 'stopped')
    const elapsed = await held.ms()
    assert.ok(elapsed < 2000, `released in ${elapsed} ms`)
    measure('stop release ms', Math.round(elapsed))
    assert.equal(
      (await swiftConversationOwner().peers(p.repo, waiter.id)).wait,
      undefined,
      'the owner holds no edge'
    )
  })

  await scenario('a wait ends when the waiting chat is stopped', async (p) => {
    const chat = await openChat(p)
    await send(chat, 'Update src/Hero.tsx heading')
    const peer = await comment(p, 'Update src/Hero.tsx subtitle')
    await wait(() => showing(chat, 'overlap'), 'the overlap in the chat')
    const held = waitOn(p, chat, peer)
    await waiting(chat)
    await invoke('agent:interrupt', chat.key)
    assert.equal((await held.answer).outcome, 'stopped')
    await wait(() => !shown(chat).some((l) => l.kind === 'waiting'), 'the chat card to clear')
  })

  await scenario('a wait ends when the peer is stopped', async (p) => {
    const { peer, waiter } = await overlapping(p)
    const held = waitOn(p, waiter, peer)
    await waiting(waiter)
    await invoke('agent:spawn-interrupt', peer.id)
    const answer = await held.answer
    assert.equal(answer.outcome, 'ended', 'a stopped peer did not land')
    assert.equal(answer.revision, undefined)
  })

  await scenario('a wait ends when the peer provider crashes', async (p) => {
    const { peer, waiter } = await overlapping(p)
    const held = waitOn(p, waiter, peer)
    await waiting(waiter)
    peer.session.emit({ type: 'error', message: 'provider crashed' })
    assert.equal((await held.answer).outcome, 'ended')
  })

  await scenario('a wait ends when the waiting provider crashes', async (p) => {
    const chat = await openChat(p)
    const turn = await send(chat, 'Update src/Hero.tsx heading')
    const peer = await comment(p, 'Update src/Hero.tsx subtitle')
    await wait(() => showing(chat, 'overlap'), 'the overlap in the chat')
    const held = waitOn(p, chat, peer)
    await waiting(chat)
    chat.session.emit({ type: 'error', message: 'provider crashed' })
    assert.equal((await held.answer).outcome, 'stopped')
    await wait(() => landed(turn), 'the failed turn to settle')
    await wait(() => !shown(chat).length, 'the chat card to clear')
  })

  await scenario('a wait ends when the owner loses it (service restart)', async (p) => {
    const { peer, waiter } = await overlapping(p)
    const owner = swiftConversationOwner()
    const held = waitOn(p, waiter, peer)
    await waiting(waiter)
    // The restart path against the real process is in test/peer-work-feed.mjs.
    setConversationOwner(
      new Proxy(owner, {
        get: (target, key) =>
          key === 'peers'
            ? async () => ({ rows: [], advisories: [] })
            : typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key]
      })
    )
    try {
      assert.equal((await held.answer).outcome, 'restart')
    } finally {
      setConversationOwner(owner)
    }
  })

  await scenario('a wait ends at its timeout, and the bound is the request', async (p) => {
    const { peer, waiter } = await overlapping(p)
    const held = waitOn(p, waiter, peer, 1)
    await waiting(waiter)
    assert.equal((await held.answer).outcome, 'timeout')
    const elapsed = await held.ms()
    assert.ok(elapsed >= 950 && elapsed < 2000, `timed out in ${elapsed} ms`)
    measure('timeout ms', Math.round(elapsed))
    await wait(() => !showing(waiter, 'waiting'), 'the wait to clear')
    assert.ok(showing(waiter, 'overlap'), 'the overlap outlives the wait: the peer still runs')
    const again = waitOn(p, waiter, peer, 1)
    assert.equal((await again.answer).outcome, 'timeout', 'a timed-out wait left no edge behind')
  })

  await scenario('two agents waiting on each other do not deadlock', async (p) => {
    const { peer, waiter } = await overlapping(p)
    const started = performance.now()
    const [left, right] = [waitOn(p, waiter, peer), waitOn(p, peer, waiter)]
    const first = await Promise.race([left.answer, right.answer])
    assert.equal(first.waited, false)
    assert.equal(first.refused, 'cycle')
    assert.match(first.guidance, /do not wait/i)
    const refusedAfter = performance.now() - started
    assert.ok(refusedAfter < 1000, `refused in ${refusedAfter} ms`)
    measure('cycle refusal ms', Math.round(refusedAfter))
    // The refused side carries on and ends; that releases the side that waited.
    const blocked = (await peek(left.answer)) ? peer : waiter
    const other = blocked === peer ? waiter : peer
    await invoke('agent:spawn-interrupt', other.id)
    const released = await (blocked === waiter ? left.answer : right.answer)
    assert.equal(released.outcome, 'ended')
  })

  await scenario('a longer wait cycle is refused too', async (p) => {
    const a = await comment(p, 'Update src/Hero.tsx heading')
    const b = await comment(p, 'Update src/Hero.tsx subtitle')
    const c = await comment(p, 'Update src/Hero.tsx footer')
    await wait(() => showing(c, 'overlap'), 'the overlap')
    const ab = waitOn(p, a, b)
    await waiting(a)
    const bc = waitOn(p, b, c)
    await waiting(b)
    const ca = await tool(p, c, 'peer_wait', { peer: a.id, seconds: 30 })
    assert.equal(ca.refused, 'cycle')
    await invoke('agent:spawn-interrupt', c.id)
    assert.equal((await bc.answer).outcome, 'ended')
    await invoke('agent:spawn-interrupt', b.id)
    assert.equal((await ab.answer).outcome, 'ended')
  })

  await scenario('one wait at a time, on a named peer of this project', async (p) => {
    const { peer, waiter } = await overlapping(p)
    const other = project()
    const stranger = await comment(other, 'Update src/Hero.tsx elsewhere')
    for (const [name, args] of [
      ['an unknown peer', { peer: 'no-such-peer' }],
      ['itself', { peer: waiter.id }],
      ['a peer of another project', { peer: stranger.id }],
      ['no peer', {}]
    ]) {
      const answer = await tool(p, waiter, 'peer_wait', args)
      assert.equal(answer.waited, false, name)
      assert.equal(answer.refused, 'unknown', name)
    }
    const third = await comment(p, 'Update src/Hero.tsx footer')
    const held = waitOn(p, waiter, peer)
    await waiting(waiter)
    const second = await tool(p, waiter, 'peer_wait', { peer: third.id, seconds: 1 })
    assert.equal(second.refused, 'busy')
    await invoke('agent:spawn-interrupt', peer.id)
    await held.answer
  })

  await scenario('disjoint scopes run with no added wait', async (p) => {
    const a = await comment(p, 'Update src/Hero.tsx heading')
    const b = await comment(p, 'Update src/Pricing.tsx table')
    const started = performance.now()
    const answer = await tool(p, b, 'peer_wait', { peer: a.id, seconds: 30 })
    const elapsed = performance.now() - started
    assert.equal(answer.waited, false)
    assert.equal(answer.refused, 'different-scope')
    assert.ok(elapsed < 500, `answered in ${elapsed} ms`)
    measure('disjoint refusal ms', Math.round(elapsed))
    put(a, 'src/Hero.tsx', 'export const Hero = () => "a"\n')
    put(b, 'src/Pricing.tsx', 'export const Pricing = () => "b"\n')
    await check(p, a)
    await check(p, b)
    const startedLanding = performance.now()
    const [left, right] = await Promise.all([finish(a), finish(b)])
    applied(left)
    applied(right)
    measure('disjoint landing ms', Math.round(performance.now() - startedLanding))
    await quiet()
    assert.equal(states(a).length, 0, 'nothing to show on disjoint work')
    assert.equal(states(b).length, 0, 'nothing to show on disjoint work')
  })

  await scenario('reconciliation renders once, for the task and its peer', async (p) => {
    const a = await comment(p, 'Show the price in page.txt')
    const b = await comment(p, 'Show the sale badge in page.txt')
    const c = await comment(p, 'Show the footer in page.txt')
    put(a, 'page.txt', page({ 5: 'header price=10' }))
    put(b, 'page.txt', page({ 5: 'header badge=sale' }))
    await check(p, a)
    await check(p, b)
    applied(await finish(a))
    const { continued } = await finish(b)
    assert.match(continued, /conflict markers/)
    await wait(() => showing(b, 'reconciling'), 'the task to show it is combining')
    await wait(() => showing(c, 'reconciling'), 'the peer to see the combining')
    await quiet()
    assert.equal(told(b, 'reconciling'), 1)
    assert.equal(told(c, 'reconciling'), 1)
    const current = readFileSync(join(b.cwd, 'page.txt'), 'utf8')
    put(
      b,
      'page.txt',
      current.replace(/<<<<<<< [^\n]*\n[\s\S]*?>>>>>>> [^\n]*\n/g, 'header price=10 badge=sale\n')
    )
    await check(p, b)
    applied(await finish(b))
    await wait(() => !showing(c, 'reconciling'), 'the peer line to clear')
    await wait(() => !shown(b).length, 'the task line to clear')
    await quiet()
    assert.equal(told(b, 'reconciling'), 1, 'it did not render again')
    assert.equal(told(c, 'reconciling'), 1, 'it did not render again')
  })

  await scenario('an incompatible chat reaches its card with the kept branch', async (p) => {
    const chat = await openChat(p)
    const turn = await send(chat, 'Make the theme dark only')
    put(chat, 'page.txt', page({ 7: 'theme=dark' }))
    await check(p, chat)
    const b = await comment(p, 'Make the theme light only')
    put(b, 'page.txt', page({ 7: 'theme=light' }))
    await check(p, b)
    applied(await finish(b))
    const before = p.live()
    const sent = chat.sent.length
    chat.done()
    await wait(() => chat.sent.length > sent, 'the reconciliation turn')
    assert.ok(showing(chat, 'reconciling') || (await waitFor(chat, 'reconciling')))
    put(chat, 'page.txt', page({ 7: 'theme=dark' }))
    const question = 'Should the site be dark or light?'
    chat.say(`They conflict.\nDECISION NEEDED: ${question}`)
    chat.done()
    await wait(() => landed(turn), 'the held turn')
    assert.equal(p.live(), before, 'nothing landed')
    const parks = events.filter(
      (e) => e.type === 'isolation' && e.projectKey === chat.key && e.decision
    )
    assert.equal(parks.length, 1, 'the decision is announced once')
    assert.equal(parks[0].decision, question)
    assert.match(parks[0].branch, /trezi\//)
    assert.equal(
      execFileSync('git', ['-C', p.repo, 'show', `${parks[0].branch}:page.txt`], {
        encoding: 'utf8'
      }).includes('theme=dark'),
      true,
      'the kept branch holds the work'
    )
    await wait(() => !shown(chat).length, 'the feed lines to clear')

    // The user's answer turn ends quietly and holds the same question again. That is a real
    // new hold: it must reach the chat so the queue pauses again, not be taken for a repeat.
    const native = newChat('decision-chat')
    reduce(native, parks[0])
    assert.equal(native.paused, true, 'the first hold pauses the queue')
    native.paused = false
    native.queue = [{ id: 'later', text: 'one more thing', attachments: [] }]
    const answer = await send(chat, 'Can you say more about the options?')
    chat.done()
    await wait(() => landed(answer), 'the quiet answer turn')
    const holds = events.filter(
      (e) => e.type === 'isolation' && e.projectKey === chat.key && e.decision
    )
    assert.equal(holds.length, 2, 'a re-hold with the same question is announced')
    assert.equal(holds[1].decision, question)
    assert.equal(holds[1].reason, 'failed')
    assert.equal(p.live(), before, 'the quiet answer released nothing')
    reduce(native, holds[1])
    assert.equal(native.paused, true, 'the queue is paused again')
    assert.equal(native.queue.length, 1, 'and the queued message was not sent onto held work')
  })

  await scenario('an incompatible comment keeps its branch and its question', async (p) => {
    const a = await comment(p, 'Make the theme dark only')
    const b = await comment(p, 'Make the theme light only')
    put(a, 'page.txt', page({ 7: 'theme=dark' }))
    put(b, 'page.txt', page({ 7: 'theme=light' }))
    await check(p, a)
    await check(p, b)
    applied(await finish(a))
    await finish(b)
    const question = 'Should the site be dark or light?'
    put(b, 'page.txt', page({ 7: 'theme=dark' }))
    b.say(`Both set one theme.\nDECISION NEEDED: ${question}`)
    const result = await finish(b)
    assert.equal(result.outcome, 'review')
    assert.equal(result.decision, question)
    assert.ok(result.branch, 'the work stays on its branch')
    await wait(() => !shown(b).length, 'the feed lines to clear')
  })

  bounded()
  assert.ok(
    (measured['peer-state event bytes'] ?? 0) <= 1536,
    `peer-state event ${measured['peer-state event bytes']} bytes`
  )
  console.log(
    `Measured on this run: ${Object.entries(measured)
      .map(([name, value]) => `${name}=${value}`)
      .join(', ')}`
  )
  if (failures.length)
    throw new Error(`${failures.length} scenario(s) failed: ${failures.join('; ')}`)
  console.log('Peer feedback: overlap, wait, reconciliation and decision passed; no provider calls')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
process.exit(failures.length ? 1 : 0)

/** Whether `promise` has settled yet. */
async function peek(promise) {
  const open = Symbol('open')
  return (await Promise.race([promise, Promise.resolve(open)])) !== open
}
async function waitFor(worker, kind) {
  await wait(() => told(worker, kind) > 0, `${kind} to show`)
  return true
}
