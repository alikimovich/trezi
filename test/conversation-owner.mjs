// S11 conversation coordinator: the real Swift ConversationOwner (compiled into a fixture
// process with the repository and source owners a chat's landing goes through), driven
// through Bun's real client, agent.ts and the native chat controller. No provider calls:
// sessions are a scripted fake provider.
// - parity: one scripted owner session (concurrent chats, busy, duplicate and late
//   terminals, continuation, cancellation, titles, handoff, approvals, spawns, History
//   writes and pruning) gives the answers and session files recorded from the Bun twin
//   before LKM-111 removed it (test/fixtures/conversation-owner/parity-golden.json);
// - agent: deterministic streaming through agent.ts on the Swift owner — concurrent chats,
//   queued turn order, an error→done race whose late `done` cannot complete the next
//   turn, a stray `done`, approvals, cancellation, titles, model handoff, reattach
//   mid-turn and restore after close; Git landing and Undo go through the Swift
//   repository and source owners;
// - crash: SIGKILL mid-turn, inside a checkpoint and inside a History write; the next
//   launch restores the chat, never over a newer record (kept, checkpoint copied aside);
// - schema, drain, and the adapter boundary. comment-agents runs on the owner itself.
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { projectKey } from '../src/shared/projectKey.ts'
import {
  compileConversationFixture,
  startConversationFixture
} from './helpers/conversation-fixture.mjs'
import { compileEditingFixture, startEditingFixture } from './helpers/editing-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-conversation-owner-')))
// agent.ts resolves its data directory once: the Swift phase's fixture shares it.
const agentProfile = join(scratch, 'agent-profile')
mkdirSync(agentProfile, { recursive: true })
process.env.TREZI_USER_DATA = agentProfile

// A scripted provider: the test streams each session's events (never a real SDK).
const providers = []
mock.module('../src/main/backends/index.ts', () => ({
  pickProvider: () => ({
    supportsSpawn: true,
    generateTitle: async () => 'Fixture title',
    startSession: async (cwd, options, getWindow, context) => {
      const cap = createRecordCapture(cwd, projectKey(cwd))
      let disposed = false
      const entry = { cwd, options, context, sent: [], settled: [] }
      const emit = (event) => {
        if (disposed) return
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
        dispose() {
          disposed = true
        },
        shutdown() {},
        send(text) {
          entry.sent.push(text)
        },
        // A graceful stop: the provider ends the turn with its `done`.
        interrupt: async () => {
          cap.finalize()
          emit({ type: 'done' })
          return undefined
        }
      }
      Object.assign(entry, {
        session,
        say: (text) => {
          cap.appendAssistant(text)
          emit({ type: 'delta', text })
        },
        tool: (name, input) => {
          cap.noteTool(name, input)
          emit({ type: 'status', text: `${name}` })
        },
        done: () => {
          cap.finalize()
          emit({ type: 'done' })
        },
        error: (message) => emit({ type: 'error', message }),
        ask: (id, toolName) => {
          session.pending.set(id, {
            toolName,
            settle: (behavior) => {
              session.pending.delete(id)
              entry.settled.push([id, behavior])
            }
          })
          emit({
            type: 'permission-request',
            request: { id, toolName, title: toolName, sessionKey: context.emitKey }
          })
        }
      })
      providers.push(entry)
      return session
    }
  })
}))

// No model-catalog discovery either (it would run the Codex CLI).
mock.module('../src/main/providers.ts', () => ({ registerProviderIpc: () => {} }))

const { registerAgentIpc } = await import('../src/main/agent.ts')
const { setConversationOwner } = await import('../src/main/conversation-owner.ts')
const { createSessionStore } = await import('../src/main/sessions-store.ts')
const { setRepositoryOwner } = await import('../src/main/repository-owner.ts')
const { setSourceOwner } = await import('../src/main/source-owner.ts')
const { setEditingOwner } = await import('../src/main/editing-owner.ts')
const { NativeChatController } = await import('../src/native/chat-controller.ts')

const handlers = new Map()
let window = () => {}
registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => window(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
const invoke = (name, ...args) => handlers.get(name)({}, ...args)

const fixtures = new Set()
let binary,
  count = 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// A deadline, not a poll count: landing a turn runs real Git and can take far longer on a loaded machine.
const until = async (condition, label) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(10)
  }
  throw new Error(`Timed out: ${label}`)
}
const profile = (name) => {
  const path = join(scratch, `profile-${name}-${++count}`)
  mkdirSync(path, { recursive: true })
  return path
}
async function fixture(home, env = {}) {
  const started = await startConversationFixture(binary, home, env)
  fixtures.add(started)
  return started
}
async function stop(started) {
  await started.stop()
  fixtures.delete(started)
}
const only = process.env.CONVERSATION_ONLY?.split(',')
async function section(name, run) {
  if (only && !only.includes(name)) return
  await run()
  console.log(`CONVERSATION-OWNER ${name} PASS`)
}
const files = (dir) =>
  existsSync(dir)
    ? Object.fromEntries(
        readdirSync(dir)
          .filter((n) => n.endsWith('.json'))
          .sort()
          .map((n) => [n, readFileSync(join(dir, n), 'utf8')])
      )
    : {}
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const R = (id, project, transcript = [], extra = {}) => ({
  id,
  projectKey: project,
  projectRoot: `/projects/${project}`,
  projectName: project,
  startedAt: 1000,
  endedAt: null,
  filesTouched: [],
  transcript,
  ...extra
})
const U = (text, at) => ({ role: 'user', text, at })
const A = (text, at) => ({ role: 'assistant', text, at })

/** One owner session, every answer logged (errors by code). */
async function ownerScript(o) {
  const log = []
  const step = async (name, run) => {
    try {
      log.push([name, await run()])
    } catch (error) {
      log.push([name, { error: error.code ?? String(error) }])
    }
  }
  await step('open c1', () => o.open('P1', 'P1', R('chat-1', 'P1'), { provider: 'claude' }, true))
  await step('open c2', () => o.open('P1#2', 'P1', R('chat-2', 'P1'), { provider: 'codex' }, false))
  await step('open c3', () => o.open('P2', 'P2', R('chat-3', 'P2'), {}, true))
  // One turn per chat; chats are independent.
  await step('begin c1', () => o.begin('P1', 't1'))
  await step('begin c1 again (busy)', () => o.begin('P1', 't1b'))
  await step('begin c2 (concurrent)', () => o.begin('P1#2', 'u1'))
  await step('send c1', () => o.send('P1', 't1', U('first', 2000)))
  await step('send c2', () => o.send('P1#2', 'u1', U('second', 2001)))
  await step('send unknown turn', () => o.send('P1', 'nope', U('x', 1)))
  const c1 = R('chat-1', 'P1', [U('first', 2000), A('partial', 2100)])
  await step('c1 error', () => o.terminal('P1', 't1', 0, 'error', c1))
  await step('c1 done after error (duplicate)', () => o.terminal('P1', 't1', 0, 'done', c1))
  await step('c1 late done of another turn (stale)', () => o.terminal('P1', 't0', 0, 'done', c1))
  await step('c1 landed', () => o.landed('P1', 't1', 5000))
  await step('c1 landed again', () => o.landed('P1', 't1', 6000))
  const c2 = R('chat-2', 'P1', [U('second', 2001), A('answer', 2200)])
  await step('c2 done', () => o.terminal('P1#2', 'u1', 0, 'done', c2))
  await step('c2 continue', () => o.continueTurn('P1#2', 'u1', 1))
  await step('c2 late run 0 (stale)', () => o.terminal('P1#2', 'u1', 0, 'done', c2))
  await step('c2 run 1 done', () => o.terminal('P1#2', 'u1', 1, 'done', c2))
  await step('c2 continue out of order', () => o.continueTurn('P1#2', 'u1', 3))
  await step('title generated', () => o.title('P1#2', 'Generated name', 'generated'))
  await step('title generated again', () => o.title('P1#2', 'Other', 'generated'))
  await step('title user', () => o.title('P1#2', '  Mine \n  here ', 'user'))
  await step('title user empty', () => o.title('P1#2', '   ', 'user'))
  await step('c2 landed', () => o.landed('P1#2', 'u1', 7000))
  await step('checkpoint without the title', () =>
    o.checkpoint(
      'P1#2',
      R('chat-2', 'P1', [U('second', 2001), A('answer', 2200)], { title: 'Stale' })
    )
  )
  // Cancellation before and after the provider has the message.
  await step('cancel idle', () => o.cancel('P2'))
  await step('begin c3', () => o.begin('P2', 'v1'))
  await step('cancel preparing', () => o.cancel('P2'))
  await step('send cancelled', () => o.send('P2', 'v1', U('never', 3000)))
  await step('abort', () => o.abort('P2', 'v1'))
  await step('abort again', () => o.abort('P2', 'v1'))
  await step('begin c3 v2', () => o.begin('P2', 'v2'))
  await step('send c3 v2', () => o.send('P2', 'v2', U('stop me', 3100)))
  await step('cancel running', () => o.cancel('P2'))
  const c3 = R('chat-3', 'P2', [U('stop me', 3100), A('halfway', 3200)])
  await step('c3 done after stop (failed)', () => o.terminal('P2', 'v2', 0, 'done', c3))
  await step('c3 continue after stop', () => o.continueTurn('P2', 'v2', 1))
  await step('c3 landed', () => o.landed('P2', 'v2', 8000))
  // Model handoff: waits for the turn; the next turn carries the history once.
  await step('handoff idle', () => o.handoff('P1', { provider: 'codex', model: 'm2' }, c1, 'model'))
  await step('begin c1 t2', () => o.begin('P1', 't2'))
  await step('handoff mid-turn (busy)', () => o.handoff('P1', { provider: 'claude' }, c1, 'model'))
  await step('send t2 (handoff)', () => o.send('P1', 't2', U('after switch', 9000)))
  await step('restart mid-turn', () =>
    o.handoff(
      'P1',
      { provider: 'codex', model: 'm2' },
      R('chat-1', 'P1', [U('first', 2000), A('partial', 2100), U('after switch', 9000)]),
      'restart'
    )
  )
  await step('begin after restart', () => o.begin('P1', 't3'))
  await step('send t3 (handoff again)', () => o.send('P1', 't3', U('again', 9100)))
  await step('t3 done', () =>
    o.terminal(
      'P1',
      't3',
      0,
      'done',
      R('chat-1', 'P1', [
        U('first', 2000),
        A('partial', 2100),
        U('after switch', 9000),
        U('again', 9100),
        A('ok', 9200)
      ])
    )
  )
  await step('t3 landed', () => o.landed('P1', 't3', 9300))
  await step('begin t4', () => o.begin('P1', 't4'))
  await step('send t4 (no handoff)', () => o.send('P1', 't4', U('plain', 9400)))
  // Approvals.
  await step('register p1', () => o.register('P1', 'perm-1', 'permission', 'Edit'))
  await step('register p2', () => o.register('P1', 'perm-2', 'permission', 'Bash'))
  await step('register q1', () => o.register('P1', 'ask-1', 'question', ''))
  await step('register for a closed chat', () => o.register('P9', 'perm-x', 'permission', 'Edit'))
  await step('resolve p1', () => o.resolve('perm-1', 'permission'))
  await step('resolve p1 late', () => o.resolve('perm-1', 'permission'))
  await step('resolve q1 as a permission', () => o.resolve('ask-1', 'permission'))
  await step('mode acceptEdits', () => o.mode('P1', 'acceptEdits'))
  await step('register p3', () => o.register('P1', 'perm-3', 'permission', 'Write'))
  await step('mode acceptEdits again', () => o.mode('P1', 'acceptEdits'))
  await step('mode bypass', () => o.mode('P1', 'bypassPermissions'))
  await step('mode unknown', () => o.mode('P1', 'yolo'))
  await step('release', () => o.release('P1'))
  // Spawn admission: 3 per project, FIFO, per project.
  for (const id of ['s1', 's2', 's3', 's4', 's5'])
    await step(`spawn ${id}`, () => o.spawn(id, 'P1'))
  await step('spawn other project', () => o.spawn('s6', 'P2'))
  await step('cancel queued', () => o.spawnCancel('s4'))
  await step('cancel running', () => o.spawnCancel('s2'))
  await step('s1 done', () => o.spawnDone('s1'))
  await step('s1 done again', () => o.spawnDone('s1'))
  await step('snapshot', () => o.snapshot())
  // History.
  await step('save legacy main slot', () =>
    o.save(R('old-current', 'P1', [U('x', 1)], { slot: 'main', unknown: { kept: [1, 2] } }))
  )
  await step('close c2 to History', () =>
    o.close(
      'P1#2',
      'history',
      R('chat-2', 'P1', [U('second', 2001), A('answer', 2200)], { endedAt: 9500, slot: 'current' })
    )
  )
  await step('close c1 as current', () =>
    o.close(
      'P1',
      'current',
      R('chat-1', 'P1', [U('first', 2000), U('plain', 9400)], { endedAt: 9600 })
    )
  )
  await step('close c3 unsaved', () => o.close('P2', 'none', c3))
  await step('close unknown', () => o.close('P9', 'history', R('chat-9', 'P9', [U('y', 1)])))
  await step('send after close', () => o.send('P1', 't4', U('z', 1)))
  await step('rename', () => o.rename('chat-2', '  Renamed\tchat '))
  await step('rename missing', () => o.rename('nope', 'x'))
  await step('rename empty', () => o.rename('chat-2', ' '))
  await step('remove', () => o.remove('chat-9'))
  for (let i = 0; i < 52; i++)
    await step(`history ${i}`, () =>
      o.save(R(`h-${i}`, 'P3', [U(`q${i}`, i)], { startedAt: 100 + i, endedAt: 200 + i }))
    )
  await step('save current P3', () =>
    o.save(R('h-current', 'P3', [U('c', 1)], { startedAt: 1 }), true)
  )
  await step('snapshot after', () => o.snapshot())
  return log
}

try {
  binary = compileConversationFixture()

  await section('parity', async () => {
    // The answers and session files are pinned to the ones the in-process twin gave
    // before LKM-111 removed it (test/fixtures/conversation-owner/parity-golden.json).
    const golden = JSON.parse(
      readFileSync(join(root, 'test/fixtures/conversation-owner/parity-golden.json'), 'utf8')
    )
    const home = profile('swift')
    const started = await fixture(home)
    const swift = JSON.parse(JSON.stringify(await ownerScript(started.owner())))
    for (let i = 0; i < golden.log.length; i++)
      assert.deepEqual(swift[i], golden.log[i], `step ${golden.log[i][0]}`)
    assert.equal(swift.length, golden.log.length)
    const goldenFiles = golden.files,
      swiftFiles = files(join(home, 'trezi/sessions'))
    assert.deepEqual(Object.keys(swiftFiles), Object.keys(goldenFiles))
    for (const name of Object.keys(goldenFiles))
      assert.equal(swiftFiles[name], goldenFiles[name], `bytes of ${name}`)
    // Spot checks on the recorded answers.
    const at = (name) => swift.find((entry) => entry[0] === name)[1]
    assert.deepEqual(at('begin c1 again (busy)'), { error: 'busy' })
    assert.deepEqual(at('c1 late done of another turn (stale)'), {
      claimed: false,
      reason: 'stale'
    })
    assert.deepEqual(at('c1 done after error (duplicate)'), { claimed: false, reason: 'duplicate' })
    assert.deepEqual(at('c2 done'), {
      claimed: true,
      outcome: 'success',
      title: true,
      memory: true
    })
    assert.deepEqual(at('c2 run 1 done'), {
      claimed: true,
      outcome: 'success',
      title: false,
      memory: true
    })
    assert.deepEqual(at('c3 done after stop (failed)'), {
      claimed: true,
      outcome: 'failed',
      title: false,
      memory: false
    })
    assert.deepEqual(at('send t2 (handoff)'), { handoff: true })
    assert.deepEqual(at('send t4 (no handoff)'), { handoff: false })
    assert.deepEqual(at('mode acceptEdits again'), ['perm-3'])
    assert.deepEqual(at('s1 done'), ['s5'])
    assert.equal(at('snapshot after').chats.length, 0)
    assert.equal(
      Object.keys(goldenFiles).filter((name) => name.startsWith('h-') && name !== 'h-current.json')
        .length,
      50
    )
    assert.ok(
      !goldenFiles['h-0.json'] && !goldenFiles['h-1.json'],
      'the two oldest History records are pruned'
    )
    assert.ok(
      !goldenFiles['old-current.json'],
      'a new current record replaces the old (main-slot) one'
    )
    assert.equal(JSON.parse(goldenFiles['chat-2.json']).title, 'Renamed chat')
    assert.equal(JSON.parse(goldenFiles['chat-1.json']).slot, 'current')
    await stop(started)
  })

  /** Streams a scripted conversation through agent.ts and the native chat controller. */
  async function agentScenario(repo) {
    const events = []
    const controller = new NativeChatController({ invoke, render() {}, effect() {} })
    window = (event) => {
      events.push(event)
      controller.event(event)
    }
    const context = (chat) => ({
      chat,
      root: repo,
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    })
    const key = projectKey(repo)
    const opened = providers.length
    await invoke('agent:open-project', repo, { provider: 'claude' })
    const p1 = providers[opened]
    assert.notEqual(p1.cwd, repo, 'a repository chat runs in its own worktree')
    const second = await invoke('agent:new-chat', repo, { provider: 'claude' })
    assert.equal(second.ok, true)
    // LKM-182: the new chat's provider starts in the background.
    await until(() => providers.length === opened + 2, 'second chat provider')
    const key2 = second.sessionKey,
      p2 = providers.at(-1)
    await controller.command({ type: 'context', context: context(key2) })
    await controller.command({ type: 'context', context: context(key) })
    const chat = controller.get(key),
      chat2 = controller.get(key2)
    const submit = (text, target = key) =>
      controller.command({ type: 'submit', chat: target, text })
    const text = (prompt) => prompt.split('\n').at(-1)

    // Concurrent chats stream independently; later messages queue in order.
    await submit('one')
    await until(() => p1.sent.length === 1, 'first send')
    await submit('two')
    await submit('three')
    await submit('parallel', key2)
    await until(() => p2.sent.length === 1, 'parallel send')
    p1.say('Hello')
    p2.say('Par')
    p1.tool('Read', { file_path: 'a.txt' })
    writeFileSync(join(p1.cwd, 'a.txt'), 'from chat one\n')
    p1.tool('Edit', { file_path: 'a.txt' })
    p2.say('allel')
    p1.say(' world')
    p2.done()
    p1.done()
    await until(() => p1.sent.length === 2, 'queued second send after landing')
    assert.equal(text(p1.sent[1]), 'two')
    assert.equal(
      readFileSync(join(repo, 'a.txt'), 'utf8'),
      'from chat one\n',
      'the turn landed on the live checkout'
    )
    await until(() => !chat2.isRunning, 'parallel chat idle')
    const turnOne = events.find((e) => e.type === 'done' && e.projectKey === key)?.turn
    assert.ok(turnOne)
    assert.equal(
      events.filter((e) => e.type === 'landing-finished' && e.turn === turnOne).length,
      1
    )
    await until(
      () => events.some((e) => e.type === 'title' && e.projectKey === key),
      'generated title'
    )

    // Approvals: the owner settles each once; a permissive mode releases the rest.
    p1.ask('perm-a', 'Edit')
    p1.ask('perm-b', 'Bash')
    await sleep(20)
    await invoke('agent:respond-permission', 'perm-a', 'allow')
    await invoke('agent:respond-permission', 'perm-a', 'deny')
    await invoke('agent:set-permission-mode', 'bypassPermissions', key)
    assert.deepEqual(p1.settled, [
      ['perm-a', 'allow'],
      ['perm-b', 'allow']
    ])

    // Codex-style error→done: the error ends "two"; its `done` arrives after "three" began.
    const turnTwo = chat.turn
    p1.error('Provider hiccup')
    await until(
      () => events.some((e) => e.type === 'landing-finished' && e.turn === turnTwo),
      'errored turn landed'
    )
    assert.equal(chat.paused, true, 'an error pauses the queue')
    await controller.action({ chat: key, action: 'queue-resume' })
    await until(() => p1.sent.length === 3, 'third send')
    assert.equal(text(p1.sent[2]), 'three')
    const turnThree = chat.turn
    p1.done() // the late `done` of "two"
    await sleep(50)
    assert.equal(chat.isRunning, true, 'a late done cannot complete the next turn')
    assert.equal(
      events.filter((e) => e.type === 'landing-finished' && e.turn === turnThree).length,
      0
    )
    // Reattach mid-turn: a fresh controller (a new host connection) sees the running turn.
    const reattached = new NativeChatController({ invoke, render() {}, effect() {} })
    await reattached.command({ type: 'context', context: context(key) })
    assert.equal(reattached.get(key).isRunning, true)
    assert.equal(reattached.get(key).turn, turnThree)
    reattached.event({ type: 'done', projectKey: key, turn: 'someone-else', landingPending: false })
    assert.equal(reattached.get(key).isRunning, true)
    p1.say('Three')
    p1.done()
    await until(() => !chat.isRunning, 'third turn landed')
    // A stray `done` with nothing outstanding completes nothing.
    await submit('four')
    await until(() => p1.sent.length === 4, 'fourth send')
    p1.done()
    await until(() => !chat.isRunning, 'fourth landed')
    p1.done()
    await sleep(30)
    assert.equal(events.filter((e) => e.type === 'done' && e.stale).length, 1)

    // Rename wins over generation for good.
    const renamed = await invoke('agent:rename-chat', key, '  My   chat ')
    assert.deepEqual(renamed, { ok: true, title: 'My chat' })

    // Stop while running: lands failed, pauses, never continues.
    await submit('stop me', key2)
    await until(() => p2.sent.length === 2, 'stoppable send')
    await controller.stop(chat2)
    await until(() => !chat2.isRunning, 'stopped')
    assert.equal(chat2.paused, true)

    // Model handoff: the next turn carries the recorded conversation, once.
    const restart = await invoke('agent:restart-chat', repo, key2, { provider: 'codex' })
    assert.equal(restart.ok, true)
    const p3 = providers.at(-1)
    chat2.paused = false
    await submit('after switch', key2)
    await until(() => p3.sent.length === 1, 'handoff send')
    assert.ok(p3.sent[0].includes('This chat switched models') && p3.sent[0].includes('Parallel'))
    p3.done()
    await until(() => !chat2.isRunning, 'handoff landed')
    await submit('plain', key2)
    await until(() => p3.sent.length === 2, 'plain send')
    assert.ok(!p3.sent[1].includes('This chat switched models'))
    p3.done()
    await until(() => !chat2.isRunning, 'plain landed')

    // Close and reopen: the active chat is restored in place from its record.
    await invoke('agent:set-active', repo, key)
    await invoke('agent:close-project', repo)
    const restored = await invoke('agent:open-project', repo, { provider: 'claude' })
    assert.equal(restored.title, 'My chat')
    const summary = {
      transcript: restored.transcript.map((entry) => `${entry.role}:${entry.text}`),
      sends: providers.slice(opened).map((p) => p.sent.map(text)),
      titles: events.filter((e) => e.type === 'title').map((e) => e.title),
      stale: events.filter((e) => e.stale).length
    }
    await invoke('agent:close-project', repo)
    window = () => {}
    return summary
  }

  // What the in-process twin streamed before LKM-111 removed it (LKM-102 proved the
  // Swift owner identical); pinned here since there is no second owner to compare with.
  const AGENT_SUMMARY = {
    transcript: [
      'user:one',
      'assistant:Hello',
      'status:Read · a.txt',
      'status:Edit · a.txt',
      'assistant:world',
      'user:two',
      'user:three',
      'assistant:Three',
      'user:four'
    ],
    sends: [
      ['one', 'two', 'three', 'four'],
      ['parallel', 'stop me'],
      ['after switch', 'plain'],
      []
    ],
    titles: ['Fixture title', 'Fixture title', 'My chat', 'My chat'],
    stale: 1
  }

  const repository = (name) => {
    const repo = join(scratch, name)
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Fixture')
    git(repo, 'config', 'user.email', 'fixture@example.test')
    writeFileSync(join(repo, 'a.txt'), 'start\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Initial')
    return repo
  }

  await section('agent', async () => {
    // The editing fixture: the same conversation owner plus the editing owner a chat
    // worktree's setup helpers go through.
    const started = await startEditingFixture(compileEditingFixture(), agentProfile)
    fixtures.add(started)
    const sent = { conversation: 0, repository: 0, source: 0 }
    const send = started.link.sendService
    started.link.sendService = (frame) => {
      sent[frame.service]++
      send(frame)
    }
    const owners = started.owners()
    setConversationOwner(owners.conversation)
    setRepositoryOwner(owners.repository)
    setSourceOwner(owners.source)
    setEditingOwner(owners.editing)
    const repo = repository('repo-swift')
    const swift = await agentScenario(repo)
    // Let fire-and-forget work (the orphan sweep after reopening, close-project's Undo
    // reset) be answered before the fixture stops.
    await started.settled()
    setConversationOwner(null)
    setRepositoryOwner(null)
    setSourceOwner(null)
    setEditingOwner(null)
    assert.deepEqual(swift, AGENT_SUMMARY)
    assert.ok(
      sent.conversation > 50 && sent.repository > 0 && sent.source > 0,
      `frames ${JSON.stringify(sent)}`
    )
    // LKM-189: described by its change (the fixture provider has no model: the fallback).
    assert.match(
      git(repo, 'log', '--format=%s', '-n', '8'),
      /^Update a\.txt$/m,
      'the landed turn is committed by the repository owner'
    )
    const saved = Object.values(files(join(agentProfile, 'trezi/sessions'))).map((text) =>
      JSON.parse(text)
    )
    const current = saved.find(
      (record) => record.projectKey === projectKey(repo) && record.slot === 'current'
    )
    assert.equal(
      current?.title,
      'My chat',
      "the Swift owner saved the chat as the project's current record"
    )
    assert.equal(current.projectRoot, repo)
    await stop(started)
  })

  await section('crash', async () => {
    // SIGKILL mid-turn: the checkpoint keeps the user entry and the text so far.
    const home = profile('crash')
    let started = await fixture(home)
    let o = started.owner()
    await o.open('K', 'K', R('crash-1', 'K'), {}, true)
    await o.begin('K', 't1')
    await o.send('K', 't1', U('build it', 1000))
    await o.checkpoint('K', R('crash-1', 'K', [U('build it', 1000), A('Working on', 1100)]))
    await started.kill()
    fixtures.delete(started)
    started = await fixture(home)
    let status = await started.owner().status()
    assert.deepEqual(
      status.recovered.map(({ chat, id, interrupted, outcome }) => ({
        chat,
        id,
        interrupted,
        outcome
      })),
      [{ chat: 'K', id: 'crash-1', interrupted: true, outcome: 'restored' }]
    )
    const saved = JSON.parse(readFileSync(join(home, 'trezi/sessions/crash-1.json'), 'utf8'))
    assert.deepEqual(
      saved.transcript.map((e) => `${e.role}:${e.text}`),
      [
        'user:build it',
        'assistant:Working on',
        'status:Trezi stopped before this turn finished. Send the message again to continue.'
      ]
    )
    assert.equal(saved.slot, 'current')
    assert.equal(
      createSessionStore(join(home, 'trezi')).current('K').id,
      'crash-1',
      "Bun's reader restores it in place"
    )
    assert.deepEqual(readdirSync(join(home, 'service/conversation/live')), [])
    await stop(started)

    // SIGKILL inside a checkpoint write (the 4th: open, begin, send, terminal): the previous one stands.
    const torn = profile('torn')
    started = await fixture(torn, {
      CONVERSATION_FAULT: 'checkpoint.write',
      CONVERSATION_FAULT_COUNT: '4'
    })
    o = started.owner({ timeout: 2000 })
    await o.open('T', 'T', R('torn-1', 'T'), {}, true)
    await o.begin('T', 't1')
    await o.send('T', 't1', U('question', 1000))
    await o
      .terminal('T', 't1', 0, 'done', R('torn-1', 'T', [U('question', 1000), A('answer', 1100)]))
      .catch(() => {})
    await started.exited
    fixtures.delete(started)
    started = await fixture(torn)
    status = await started.owner().status()
    assert.equal(status.recovered[0].interrupted, true)
    assert.deepEqual(
      JSON.parse(readFileSync(join(torn, 'trezi/sessions/torn-1.json'), 'utf8')).transcript.map(
        (e) => e.role
      ),
      ['user', 'status']
    )
    await stop(started)

    // SIGKILL inside the History write of a clean close: the checkpoint is still there.
    const closing = profile('closing')
    started = await fixture(closing, { CONVERSATION_FAULT: 'session.write' })
    o = started.owner({ timeout: 2000 })
    await o.open('C', 'C', R('close-1', 'C'), {}, true)
    await o.begin('C', 't1')
    await o.send('C', 't1', U('hi', 1000))
    await o.terminal('C', 't1', 0, 'done', R('close-1', 'C', [U('hi', 1000), A('hello', 1100)]))
    await o.landed('C', 't1', 1200)
    await o
      .close(
        'C',
        'current',
        R('close-1', 'C', [U('hi', 1000), A('hello', 1100)], { endedAt: 1300 })
      )
      .catch(() => {})
    await started.exited
    fixtures.delete(started)
    started = await fixture(closing)
    status = await started.owner().status()
    assert.deepEqual(
      status.recovered.map((r) => [r.outcome, r.interrupted]),
      [['restored', false]]
    )
    const closed = JSON.parse(readFileSync(join(closing, 'trezi/sessions/close-1.json'), 'utf8'))
    assert.equal(closed.transcript[0].completedAt, 1200)
    assert.equal(closed.slot, 'current')
    await stop(started)

    // A newer record (another launch continued the chat) is never replaced by the checkpoint.
    const newer = profile('newer')
    started = await fixture(newer)
    o = started.owner()
    await o.open('N', 'N', R('newer-1', 'N'), {}, true)
    await o.begin('N', 't1')
    await o.send('N', 't1', U('old', 1000))
    await started.kill()
    fixtures.delete(started)
    const later = R('newer-1', 'N', [U('old', 1000), U('continued elsewhere', 2000)], {
      endedAt: Date.now() + 60_000,
      slot: 'current'
    })
    mkdirSync(join(newer, 'trezi/sessions'), { recursive: true })
    writeFileSync(join(newer, 'trezi/sessions/newer-1.json'), JSON.stringify(later))
    const before = readFileSync(join(newer, 'trezi/sessions/newer-1.json'), 'utf8')
    // A damaged checkpoint beside it is moved aside, not read.
    writeFileSync(join(newer, 'service/conversation/live/zz-damaged.json'), '{not json')
    started = await fixture(newer)
    status = await started.owner().status()
    const kept = status.recovered.find((r) => r.id === 'newer-1'),
      damaged = status.recovered.find((r) => r.outcome === 'damaged')
    assert.equal(kept.outcome, 'kept')
    assert.ok(existsSync(kept.copy) && existsSync(damaged.copy))
    assert.equal(readFileSync(join(newer, 'trezi/sessions/newer-1.json'), 'utf8'), before)
    assert.deepEqual(readdirSync(join(newer, 'service/conversation/live')), [])
    await stop(started)
  })

  await section('schema', async () => {
    const home = profile('schema')
    const started = await fixture(home)
    const code = (result) => (result.kind === 'failed' ? result.payload.code : 'succeeded')
    assert.equal(code(await started.frame('explode', {})), 'invalidRequest')
    assert.equal(code(await started.frame('snapshot', {}, { mode: 'mutation' })), 'invalidRequest')
    assert.equal(code(await started.frame('remove', { id: 'x', extra: 1 })), 'invalidRequest')
    assert.equal(
      code(
        await started.frame(
          'remove',
          { id: 'x' },
          { expectedRevision: { epoch: 'e', counter: '1' } }
        )
      ),
      'invalidRequest'
    )
    assert.equal(
      code(await started.frame('remove', { id: 'x' }, { scope: { projectID: 'p' } })),
      'unauthorized'
    )
    assert.equal(code(await started.frame('save', { record: R('../evil', 'P') })), 'invalidRequest')
    assert.equal(
      code(
        await started.frame('save', {
          record: { ...R('ok', 'P'), transcript: [{ role: 'system', text: 'x', at: 1 }] }
        })
      ),
      'invalidRequest'
    )
    assert.equal(
      code(await started.frame('save', { record: { id: 'ok', transcript: [] } })),
      'invalidRequest'
    )
    assert.equal(
      code(
        await started.frame('open', {
          chat: 'S',
          project: 'S',
          root: 'relative',
          record: R('s', 'S'),
          options: {},
          active: true,
          sequence: 1
        })
      ),
      'invalidRequest'
    )
    assert.equal(
      code(
        await started.frame('open', {
          chat: 'S',
          project: 'S',
          root: '/s',
          record: R('s', 'S'),
          options: {},
          active: true,
          sequence: 1
        })
      ),
      'succeeded'
    )
    assert.equal(code(await started.frame('begin', { chat: 'S', turn: 'a' })), 'succeeded')
    assert.equal(
      code(await started.frame('send', { chat: 'S', turn: 'a', entry: A('not a user', 1) })),
      'invalidRequest'
    )
    assert.equal(
      code(
        await started.frame('terminal', {
          chat: 'S',
          turn: 'a',
          run: 0,
          kind: 'maybe',
          record: R('s', 'S'),
          sequence: 2
        })
      ),
      'invalidRequest'
    )
    assert.equal(
      code(await started.frame('checkpoint', { chat: 'S', record: R('s', 'S'), sequence: 1.5 })),
      'invalidRequest'
    )
    // An older record never replaces a newer one.
    assert.equal(
      (
        await started.frame('checkpoint', {
          chat: 'S',
          record: R('s', 'S', [U('new', 2)]),
          sequence: 5
        })
      ).payload.accepted,
      true
    )
    assert.equal(
      (
        await started.frame('checkpoint', {
          chat: 'S',
          record: R('s', 'S', [U('old', 1)]),
          sequence: 4
        })
      ).payload.accepted,
      false
    )
    assert.deepEqual((await started.owner().snapshot()).chats[0].record.transcript, [U('new', 2)])
    assert.ok(
      !existsSync(join(home, 'trezi/sessions/../evil.json')) && !existsSync(join(home, 'evil.json'))
    )
    await stop(started)
  })

  await section('drain', async () => {
    const started = await fixture(profile('drain'))
    const o = started.owner()
    await o.open('D', 'D', R('drain-1', 'D'), {}, true)
    assert.deepEqual(await started.cmd({ cmd: 'close' }), { closed: true })
    await assert.rejects(o.begin('D', 't1'), (error) => error.code === 'unavailable')
    await stop(started)
  })

  await section('adapters', async () => {
    // The provider adapters stay separate: no backend knows the owner, and agent.ts
    // no longer writes History or decides terminals itself.
    for (const name of readdirSync(join(root, 'src/main/backends'))) {
      assert.ok(
        !readFileSync(join(root, 'src/main/backends', name), 'utf8').includes('conversation-owner'),
        name
      )
    }
    const agent = readFileSync(join(root, 'src/main/agent.ts'), 'utf8')
    for (const banned of [
      'store().saveCurrent(',
      'TurnTerminalTracker',
      'spawnQueue',
      'titling.add',
      'closeSession(existing'
    ])
      assert.ok(!agent.includes(banned), banned)
  })

  console.log(
    'Conversation owner: parity, agent streaming, crash recovery, schema, drain and adapter boundary passed; no provider calls'
  )
} finally {
  for (const started of fixtures) await started.kill().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
