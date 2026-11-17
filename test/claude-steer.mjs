// LKM-709: "Steer now" on the Claude adapter (claude.ts + claude-steer.ts), against a
// stand-in Agent SDK whose turn stays open at a controlled boundary. No CLI, no network.
// The stand-in behaves like the CLI's documented streaming input: a user message pushed
// mid-turn with `priority: 'next'` is folded into the running turn and named in the turn's
// `user_message_uuids`; one the turn ended without stays queued (`cancelAsyncMessage`
// withdraws it) or runs on as the next step.
//  - SAME turn receives A once before its terminal event; nothing else is pushed;
//  - before the CLI ever echoed a uuid, or with no turn running: rejected, nothing pushed;
//  - a slash command, a repeated request id: rejected / ignored;
//  - the turn ends first: withdrawn → returned before done; not withdrawable → the turn
//    carries on, A admitted as `continued`, one done;
//  - Stop withdraws a steer the CLI has not taken.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The stand-in CLI: frames are yielded only when the test says so. */
const queries = []
function query({ prompt }) {
  const record = {
    messages: [],
    out: [],
    wake: null,
    cancel: async () => false,
    interrupted: 0,
    push(frame) {
      record.out.push(frame)
      record.wake?.()
    }
  }
  queries.push(record)
  void (async () => {
    for await (const message of prompt) record.messages.push(message)
  })()
  const stream = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'steer-session' }
    for (;;) {
      while (!record.out.length) await new Promise((resolve) => (record.wake = resolve))
      yield record.out.shift()
    }
  })()
  return Object.assign(stream, {
    supportedCommands: async () => [],
    supportedModels: async () => [],
    setModel: async () => {},
    setPermissionMode: async () => {},
    interrupt: async () => {
      record.interrupted++
    },
    cancelAsyncMessage: (uuid) => record.cancel(uuid)
  })
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query,
  createSdkMcpServer: () => ({ type: 'sdk', name: 'trezi' }),
  tool: (name) => ({ name })
}))

const { claudeProvider } = await import('../src/main/backends/claude.ts')
const { createClaudeSteers } = await import('../src/main/backends/claude-steer.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-claude-steer-')))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (ready, what) => {
  for (let i = 0; i < 300 && !ready(); i++) await sleep(10)
  assert.ok(ready(), what)
}
const assistant = (text, uuids) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }], usage: {} },
  ...(uuids ? { user_message_uuid: uuids.at(-1), user_message_uuids: uuids } : {})
})
const result = (uuids) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  usage: {},
  ...(uuids ? { user_message_uuid: uuids.at(-1), user_message_uuids: uuids } : {})
})

async function start() {
  const events = []
  const session = await claudeProvider.startSession(scratch, { provider: 'claude' }, () => null, {
    emitKey: 'steer',
    liveRoot: scratch,
    claudeCli: { executable: '/bin/true' },
    onEvent: (e) => events.push(e)
  })
  const cli = queries.at(-1)
  const kinds = () => events.map((e) => (e.type === 'steer' ? `steer:${e.id}:${e.state}` : e.type))
  const steer = (id) => events.find((e) => e.type === 'steer' && e.id === id)
  /** Starts a turn and lets the CLI echo its uuid (its first reply frame). */
  const turn = async (text) => {
    const before = cli.messages.length
    session.send(text)
    await until(() => cli.messages.length === before + 1, 'the turn reached the CLI')
    const uuid = cli.messages.at(-1).uuid
    assert.match(uuid, /^[0-9a-f-]{36}$/, 'every send is stamped')
    cli.push(assistant('working', [uuid]))
    await until(() => events.some((e) => e.type === 'delta' && e.text === 'working'), 'reply')
    events.length = 0
    return uuid
  }
  return { session, events, cli, kinds, steer, turn }
}

try {
  // 1. Queue A+B, steer A while the turn is held: the SAME turn gets A once, B is never
  //    sent, the outcome is `admitted` and comes before the turn's one `done`.
  {
    const { session, events, cli, kinds, steer, turn } = await start()
    const first = await turn('Build the page')
    session.steer('steer-A', 'A: keep the header')
    await until(() => cli.messages.length === 2, 'A reached the CLI')
    const pushed = cli.messages[1]
    assert.equal(pushed.priority, 'next', 'folded at the next input boundary, not a new turn')
    assert.equal(pushed.message.content, 'A: keep the header')
    assert.notEqual(pushed.uuid, first)
    assert.equal(steer('steer-A'), undefined, 'not admitted before the CLI says so')
    // The CLI folds A between tool rounds and names it on the next reply frame.
    cli.push(assistant('kept the header', [first, pushed.uuid]))
    await until(() => steer('steer-A'), 'A admitted')
    assert.equal(steer('steer-A').state, 'admitted')
    assert.equal(steer('steer-A').reason, undefined, 'admitted into the running turn')
    cli.push(result([first, pushed.uuid]))
    await until(() => kinds().includes('done'), 'turn ended')
    assert.deepEqual(kinds(), ['steer:steer-A:admitted', 'delta', 'done'])
    assert.equal(cli.messages.length, 2, 'A once; B never left Trezi’s queue')
    // A repeated request id while A was pending would have been ignored; after the turn
    // the session is idle and refuses.
    session.steer('steer-late', 'late')
    assert.deepEqual([steer('steer-late').state, steer('steer-late').reason], ['rejected', 'idle'])
    assert.equal(cli.messages.length, 2, 'nothing pushed for a refused steer')
    session.shutdown()
    void events
  }

  // 2. Before the CLI ever echoed a uuid it cannot confirm admission: refused, not sent.
  //    A slash command is its own turn. A repeated id while pending is sent once.
  {
    const { session, cli, steer, turn } = await start()
    session.send('Start')
    await until(() => cli.messages.length === 1, 'turn sent')
    session.steer('early', 'too early')
    assert.deepEqual([steer('early').state, steer('early').reason], ['rejected', 'unconfirmed'])
    const uuid = cli.messages[0].uuid
    cli.push(assistant('ok', [uuid]))
    await sleep(20)
    session.steer('cmd', '/compact')
    assert.deepEqual([steer('cmd').state, steer('cmd').reason], ['rejected', 'command'])
    session.steer('twice', 'once only')
    session.steer('twice', 'once only')
    await sleep(20)
    assert.equal(cli.messages.length, 2, 'a repeated request is pushed once')
    cli.push(result([uuid, cli.messages[1].uuid]))
    await sleep(20)
    void turn
    session.shutdown()
  }

  // 3. The turn ends before folding A; the CLI still holds it: withdrawn → `returned`
  //    (Trezi's queue keeps it), emitted before `done`. Nothing claims an in-turn success.
  {
    const { session, cli, kinds, steer, turn } = await start()
    const first = await turn('Finish up')
    session.steer('A', 'A')
    await until(() => cli.messages.length === 2, 'A pushed')
    const withdrawn = []
    cli.cancel = async (uuid) => {
      withdrawn.push(uuid)
      return true
    }
    cli.push(result([first]))
    await until(() => kinds().includes('done'), 'done')
    assert.deepEqual(withdrawn, [cli.messages[1].uuid])
    assert.deepEqual([steer('A').state, steer('A').reason], ['returned', 'turn-ended'])
    assert.deepEqual(kinds(), ['steer:A:returned', 'done'])
    session.shutdown()
  }

  // 4. The turn ends before folding A and the CLI already took it as its next step: the
  //    turn carries on (no `done` yet), A is admitted as `continued` when the CLI names it,
  //    and the continuation's result is the turn's one `done`.
  {
    const { session, cli, kinds, steer, turn } = await start()
    const first = await turn('Finish up')
    session.steer('A', 'A')
    await until(() => cli.messages.length === 2, 'A pushed')
    const a = cli.messages[1].uuid
    cli.cancel = async () => false
    cli.push(result([first]))
    await sleep(50)
    assert.ok(!kinds().includes('done'), 'the turn carries on')
    assert.equal(steer('A'), undefined)
    cli.push(assistant('on it', [a]))
    await until(() => steer('A'), 'A admitted')
    assert.deepEqual([steer('A').state, steer('A').reason], ['admitted', 'continued'])
    cli.push(result([a]))
    await until(() => kinds().includes('done'), 'done')
    assert.deepEqual(kinds(), ['steer:A:admitted', 'delta', 'done'])
    session.shutdown()
  }

  // 5. Stop withdraws a steer the CLI has not taken; it is never run after Stop.
  {
    const { session, cli, kinds, steer, turn } = await start()
    const first = await turn('Long job')
    session.steer('A', 'A')
    await until(() => cli.messages.length === 2, 'A pushed')
    cli.cancel = async () => true
    await session.interrupt()
    assert.equal(cli.interrupted, 1)
    assert.deepEqual([steer('A').state, steer('A').reason], ['returned', 'stopped'])
    cli.push(result([first]))
    await until(() => kinds().includes('done'), 'done')
    assert.equal(kinds().filter((k) => k === 'done').length, 1)
    session.shutdown()
  }

  // 6. The steer manager alone: a carried steer the CLI never names in time is
  //    `uncertain` and the turn ends; an abandoned session returns what it held.
  {
    const events = []
    let expired = 0
    let n = 0
    const steers = createClaudeSteers({
      emit: (e) => events.push(e),
      push: () => {},
      cancel: async () => {
        throw new Error('no answer')
      },
      expire: () => expired++,
      uuid: () => `u${++n}`,
      carryMs: 30
    })
    steers.turnStarted()
    steers.frame({ user_message_uuids: ['t'] })
    steers.steer('A', 'A')
    assert.equal(await steers.turnEnded({ user_message_uuids: ['t'] }), 'carry')
    await sleep(80)
    assert.deepEqual(events, [{ type: 'steer', id: 'A', state: 'uncertain', reason: 'unknown' }])
    assert.equal(expired, 1)
    steers.turnStarted()
    steers.steer('B', 'B')
    steers.abandon()
    assert.deepEqual(events.at(-1), {
      type: 'steer',
      id: 'B',
      state: 'returned',
      reason: 'stopped'
    })
    assert.equal(steers.pending, 0)
  }
  console.log('CLAUDE-STEER PASS')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
