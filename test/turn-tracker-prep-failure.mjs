// LKM-582: a chat turn whose preparation fails after its send was reserved in the
// session's turn tracker, but before the provider got it, must leave no reservation.
// `agent:send` pushes the turn onto the tracker, then awaits the peer snapshot. When
// that read rejects (or Stop cancels the turn while it waits), the turn is never sent;
// if its entry stayed at the tracker's head, the next real send's deltas and terminal
// would be credited to the unsent turn. The real agent.ts and Swift conversation owner,
// a scripted provider (never a real SDK) and a peer read held or failed by hand: no
// sleeps decide an ordering, no provider or network calls.
import './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { TurnTracker } from '../src/main/chat-turns.ts'
import { swiftConversationOwner } from '../src/main/conversation-owner.ts'
import { projectKey } from '../src/shared/projectKey.ts'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-turn-tracker-prep-')))
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
      // `stop`: how Stop is answered. 'done' at once; 'silent' never (a provider with
      // nothing in flight may answer nothing); a promise: a `done` once it resolves.
      const entry = { cwd, context, sent: [], stop: 'done', stops: 0 }
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
          entry.stops++
          entry.stopped?.()
          if (entry.stop === 'silent') return
          if (entry.stop !== 'done') await entry.stop
          cap.finalize()
          emit({ type: 'done' })
        }
      }
      Object.assign(entry, {
        say: (text) => {
          cap.appendAssistant(text)
          emit({ type: 'delta', text })
        },
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
const { registerAgentIpc, currentTurn } = await import('../src/main/agent.ts')
registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
const invoke = (name, ...args) => handlers.get(name)({}, ...args)
const until = async (condition, what, ms = 20_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await condition()
    if (value) return value
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

// The owner's peer query, as the turn-start snapshot (`peerContext` → `peerView`) reaches
// it. A turn named in `hooks` gets its hook instead of the owner's answer there; every
// other query (other turns, the background peer-feedback flush) goes to the real owner.
const owner = swiftConversationOwner()
const realPeers = owner.peers.bind(owner)
const hooks = new Map()
owner.peers = (project, self) => {
  const hook = hooks.get(self)
  if (!hook || !/\bpeerView\b/.test(new Error().stack ?? '')) return realPeers(project, self)
  hooks.delete(self)
  return hook(project, self)
}

let repos = 0
async function openChat() {
  const repo = join(temp, `repo-${++repos}`)
  mkdirSync(join(repo, 'src'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(repo, 'src/Hero.tsx'), 'export const Hero = () => null\n')
  git('add', '.')
  git('commit', '-qm', 'Initial')
  const opened = await invoke('agent:open-project', repo, { provider: 'codex' })
  assert.notEqual(opened.ok, false, opened.error)
  const worker = providers.at(-1)
  worker.key = projectKey(repo)
  return worker
}
const of = (turn) => events.filter((e) => e.turn === turn)
const landed = (turn) => events.some((e) => e.type === 'landing-finished' && e.turn === turn)

/** A real send after the failed one: only it is current, and its events name it alone. */
async function realTurnAfter(worker, failed, turn) {
  const sent = worker.sent.length
  const failedEvents = of(failed).length
  await invoke('agent:send', 'Make the hero bold', [], worker.key, {}, turn)
  await until(() => worker.sent.length > sent, 'the real turn to reach its provider')
  assert.equal(currentTurn(worker.key), turn, 'the provider is working on the real turn')
  worker.say('Bold.')
  const delta = events.findLast((e) => e.type === 'delta' && e.text === 'Bold.')
  assert.equal(delta?.turn, turn, 'the real turn’s delta is credited to it')
  worker.done()
  const done = events.findLast((e) => e.type === 'done')
  assert.equal(done?.turn, turn, 'the real turn’s terminal is credited to it')
  assert.notEqual(done?.stale, true, 'the real terminal is not late')
  await until(() => landed(turn), 'the real turn to land')
  assert.equal(currentTurn(worker.key), null, 'nothing left at the tracker’s head')
  assert.equal(of(failed).length, failedEvents, 'no later event names the unsent turn')
  // A late `done` with no send outstanding is still stale and completes nothing.
  worker.done()
  const late = events.findLast((e) => e.type === 'done')
  assert.equal(late.stale, true)
  assert.equal(late.turn, undefined)
}

const failures = []
const check = async (name, run) => {
  try {
    await run()
    console.log(`  ok: ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  FAILED: ${name}: ${String(error?.stack ?? error).slice(0, 600)}`)
  }
}

await check('withdraw forgets only the named run of a turn', () => {
  const tracker = new TurnTracker()
  tracker.push('t', 0)
  tracker.push('t', 1)
  tracker.withdraw('t', 0)
  assert.deepEqual(tracker.current, { turn: 't', run: 1 }, 'a sent continuation run stays')
  tracker.withdraw('t', 0)
  assert.deepEqual(tracker.current, { turn: 't', run: 1 }, 'nothing else is removed')
})

await check('a rejected peer read before send leaves no reservation', async () => {
  const worker = await openChat()
  let reserved
  hooks.set('turn-a', async () => {
    reserved = currentTurn(worker.key)
    throw new Error('scripted peer query failure')
  })
  await assert.rejects(
    invoke('agent:send', 'Make the hero red', [], worker.key, {}, 'turn-a'),
    /scripted peer query failure/
  )
  assert.equal(reserved, 'turn-a', 'the failure is after the tracker reservation')
  assert.equal(worker.sent.length, 0, 'the failed turn never reached its provider')
  assert.equal(currentTurn(worker.key), null, 'the unsent turn left no tracker entry')
  await realTurnAfter(worker, 'turn-a', 'turn-b')
})

// Stop while the peer read is held: the send is cancelled before the provider gets it.
// The provider answers that Stop never, with a `done` before the read is released, or
// with a `done` only after the send was cancelled.
let stopTurns = 0
for (const mode of ['silent', 'done during the read', 'done after the cancel']) {
  await check(`Stop during the peer read, provider answers ${mode}: no reservation`, async () => {
    const worker = await openChat()
    const turn = `turn-stop-${++stopTurns}`
    let release, answer
    const reached = new Promise((resolve) => {
      hooks.set(turn, (project, self) => {
        resolve()
        return new Promise((r) => {
          release = r
        }).then(() => realPeers(project, self))
      })
    })
    worker.stop =
      mode === 'silent'
        ? 'silent'
        : mode === 'done during the read'
          ? 'done'
          : new Promise((r) => {
              answer = r
            })
    const interrupted = new Promise((r) => {
      worker.stopped = r
    })
    const sending = invoke('agent:send', 'Make the hero blue', [], worker.key, {}, turn)
    await reached
    assert.equal(currentTurn(worker.key), turn, 'Stop arrives after the reservation')
    const stopping = invoke('agent:interrupt', worker.key)
    if (mode === 'done during the read') await interrupted
    release()
    await assert.rejects(sending, /cancelled before sending/)
    answer?.()
    await stopping
    assert.equal(worker.stops, 1, 'the provider was asked to stop')
    assert.equal(worker.sent.length, 0, 'the stopped turn never reached its provider')
    assert.equal(currentTurn(worker.key), null, 'the stopped turn left no tracker entry')
    await until(
      async () => !(await invoke('agent:turn-state', worker.key)).running,
      'the stopped chat to be idle'
    )
    await realTurnAfter(worker, turn, `${turn}-next`)
  })
}

// Control: an ordinary turn and an independent chat are unaffected.
await check('an ordinary send lands on its own turn', async () => {
  const worker = await openChat()
  await realTurnAfter(worker, 'none', 'turn-f')
})

if (failures.length) {
  console.log(`Turn tracker preparation failure FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(
  'Turn tracker preparation failure: unsent turns leave no reservation; no provider calls'
)
process.exit(0)
