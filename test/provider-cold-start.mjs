// LKM-135, a Claude chat's cold first turn: the real Swift ProviderOwner (compiled fixture)
// with the real Claude adapter in the real helper host, driven by stand-in `claude` CLIs
// (the SDK's stream-json protocol; no model, network or credential). The owner's deadlines
// are scaled down: PROVIDER_FIRST_EVENT 0.5 s stands for the 90 s "CLI did not start"
// deadline, PROVIDER_REPLY 2.5 s for the 10 min wait for the model once the CLI is up.
// - prewarm: opening a chat starts the helper and the CLI before anything is sent;
// - probes: the bundled and installed CLIs' `auth status` run in parallel, once per app
//   session (a second chat reuses the owner's cached choice), and again after a sign-in failure;
// - slow: an init 3x longer than the short deadline, a long think and a long but
//   progressing turn end normally, with "Still …" shown instead of an error;
// - hangs: a CLI that never starts, a session that never inits and a model that never
//   answers still end with the no-response card, each naming its phase;
// - log: the phase timings are in the service log at debug level.
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { helperProvider } from '../src/main/backends/helper-session.ts'
import { setProviderOwner } from '../src/main/provider-owner.ts'
import { compileProviderFixture, startProviderFixture } from './helpers/provider-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const binary = compileProviderFixture()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-cold-start-')))
const WT = join(scratch, 'wt'),
  LIVE = join(scratch, 'app'),
  BIN = join(scratch, 'bin'),
  PROFILE = join(scratch, 'profile')
for (const dir of [WT, LIVE, BIN, PROFILE]) mkdirSync(dir)
const PROBES = join(scratch, 'probes.log'),
  MODE = join(scratch, 'mode')
writeFileSync(PROBES, '')
writeFileSync(MODE, 'normal')

// --- the stand-in `claude` ---------------------------------------------------------------
// `auth status` takes 0.5 s (a cold probe) and is logged. In stream-json mode it answers
// `initialize` unless MODE says `hang`, then plays each user message:
//   say X · slow MS X (init after MS) · think MS X (init, MS of silence) · busy MS X (init,
//   then MS of `status` system messages) · noinit · stall (init, then nothing) · auth.
const standIn = (name, loggedIn) => {
  const path = join(BIN, name, 'claude')
  mkdirSync(join(BIN, name))
  writeFileSync(
    path,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const args = process.argv.slice(2)
if (args[0] === 'auth') {
  const start = Date.now()
  await sleep(500)
  appendFileSync(${JSON.stringify(PROBES)}, JSON.stringify({ name: ${JSON.stringify(name)}, start, end: Date.now() }) + '\\n')
  console.log(JSON.stringify({ loggedIn: ${loggedIn}, authMethod: 'claude.ai' }))
  process.exit(${loggedIn ? 0 : 1})
}
if (args[0] === '--version') { console.log('0.0.0 (Claude Code)'); process.exit(0) }
const hang = readFileSync(${JSON.stringify(MODE)}, 'utf8').trim() === 'hang'
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const meta = { session_id: 'cold-claude', uuid: '00000000-0000-4000-8000-000000000000' }
const init = () => out({ type: 'system', subtype: 'init', slash_commands: [], tools: [], mcp_servers: [], model: 'fake', permissionMode: 'default', cwd: process.cwd(), apiKeySource: 'none', ...meta })
const reply = (text, model = 'fake') => {
  out({ type: 'assistant', message: { id: 'msg', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, ...meta })
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: text, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, ...meta })
}
const turn = async (text) => {
  const [verb, a, ...rest] = text.split(' ')
  const ms = Number(a), said = rest.join(' ')
  if (verb === 'say') { init(); return reply([a, ...rest].join(' ')) }
  if (verb === 'slow') { await sleep(ms); init(); return reply(said) }
  if (verb === 'think') { init(); await sleep(ms); return reply(said) }
  if (verb === 'busy') {
    init()
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) out({ type: 'system', subtype: 'status', status: 'requesting', ...meta })
    return reply(said)
  }
  if (verb === 'stall') return init()
  if (verb === 'auth') { init(); return reply('Not logged in · Please run /login', '<synthetic>') }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (hang) return
  const m = JSON.parse(line)
  if (m.type === 'control_request') {
    const response = m.request.subtype === 'initialize' ? { commands: [], models: [], account: {}, output_style: 'default', available_output_styles: ['default'] } : {}
    return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } })
  }
  if (m.type !== 'user') return
  const content = m.message.content
  void turn(typeof content === 'string' ? content : content.map((b) => b.text ?? '').join(''))
}).on('close', () => process.exit(0))
`
  )
  chmodSync(path, 0o755)
  return path
}
const BUNDLED = standIn('bundled', false),
  INSTALLED = standIn('installed', true)
const probes = () =>
  readFileSync(PROBES, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let fixture
const until = async (condition, label, ms = 30_000) => {
  const deadline = Date.now() + ms
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}\n${fixture?.stderr ?? ''}`)
    await sleep(20)
  }
}
/** How a turn ended: its error and done events. */
const ends = (list) =>
  list.filter((e) => e.type === 'error' || e.type === 'done').map((e) => [e.type, e.code])
const debugLines = (text) =>
  fixture.stderr
    .split('\n')
    .filter((line) => line.startsWith('debug provider claude') && line.includes(text))

const sessions = []
let chats = 0
async function chat() {
  const events = []
  const s = await helperProvider('claude').startSession(WT, { model: 'm1' }, () => null, {
    emitKey: `cold-${++chats}`,
    liveRoot: LIVE,
    onEvent: (e) => events.push(e)
  })
  sessions.push(s)
  const turn = async (text) => {
    const start = events.length
    s.send(text)
    await until(() => events.slice(start).some((e) => e.type === 'done'), `turn ${text}`)
    return events.slice(start)
  }
  const said = (list) =>
    list
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join('')
  const errors = (list) => list.filter((e) => e.type === 'error')
  // LKM-147: "Still …" is a progress step, never a transcript status; heartbeats carry no step.
  const still = (list) => {
    assert.deepEqual(
      list.filter((e) => e.type === 'status' && /^Still /.test(e.text)),
      [],
      'no "Still …" status row'
    )
    return list.filter((e) => e.type === 'progress' && e.step).map((e) => e.step)
  }
  const beats = (list) => list.filter((e) => e.type === 'progress' && !e.step).length
  return { s, turn, said, errors, still, beats, events }
}

try {
  fixture = await startProviderFixture(binary, PROFILE, {
    PROVIDER_HELPER_ARGS: [join(root, 'test/fixtures/cold-helper.mjs'), BUNDLED, INSTALLED].join(
      '\u001f'
    ),
    PROVIDER_HELPER_PROVIDERS: 'claude',
    // The helper loads the real adapter and its SDK; a cold transpile cache is slow.
    PROVIDER_READY: '60',
    PROVIDER_FIRST_EVENT: '0.5',
    PROVIDER_REPLY: '2.5',
    PROVIDER_STILL: '0.3'
  })
  setProviderOwner(fixture.owner())

  // --- prewarm and probes -------------------------------------------------------------------
  const a = await chat()
  await until(() => debugLines('CLI started').length === 1, 'the CLI started before any message')
  const first = probes()
  assert.deepEqual(
    first.map((p) => p.name).sort(),
    ['bundled', 'installed'],
    'both CLIs were probed once'
  )
  const [p, q] = first
  assert.ok(
    p.start < q.end && q.start < p.end,
    `the probes ran in parallel: ${JSON.stringify(first)}`
  )
  assert.equal(debugLines('auth probe').length, 1)
  assert.match(debugLines('auth probe')[0], /auth probe \d+ ms \(probed\)/)
  assert.match(debugLines('helper ready')[0], /helper ready \d+ ms after launch/)
  console.log('PROVIDER-COLD-START prewarm PASS')

  // --- slow but healthy turns -------------------------------------------------------------------
  // An init three times the short deadline (120 s against 90 s, scaled): no error.
  const slow = await a.turn('slow 1500 hello after a slow init')
  assert.deepEqual(a.errors(slow), [], JSON.stringify(slow))
  assert.equal(a.said(slow), 'hello after a slow init')
  assert.deepEqual(a.still(slow), ['Still starting Claude…'])
  // The model thinks longer than the short deadline after init: "Still thinking…".
  const think = await a.turn('think 1500 an answer')
  assert.deepEqual(a.errors(think), [], JSON.stringify(think))
  assert.equal(a.said(think), 'an answer')
  assert.deepEqual(a.still(think), ['Still thinking…'])
  // Longer than the reply deadline, but the CLI reports progress: never cut off.
  const busy = await a.turn('busy 4000 done working')
  assert.deepEqual(a.errors(busy), [], JSON.stringify(busy))
  assert.equal(a.said(busy), 'done working')
  // The helper's heartbeat (200 ms here) reaches the chat through the owner while the
  // turn is open, and stops with its `done`.
  assert.ok(a.beats(busy) >= 10, `heartbeats during a 4 s turn: ${a.beats(busy)}`)
  const ended = a.events.length
  await sleep(700)
  assert.equal(a.beats(a.events.slice(ended)), 0, 'no heartbeat after the turn ended')
  assert.ok(
    debugLines('session init').length >= 3 && debugLines('first model event').length >= 3,
    fixture.stderr
  )
  console.log('PROVIDER-COLD-START slow PASS')

  // --- the cache: a second chat probes nothing; a sign-in failure drops the choice -----------
  const b = await chat()
  await until(() => debugLines('CLI started').length === 2, 'the second CLI started')
  assert.equal(probes().length, 2, 'the second chat reused the cached CLI choice')
  assert.match(debugLines('auth probe')[1], /auth probe 0 ms \(cached choice\)/)
  assert.equal(
    b.said(await b.turn('say from the cached CLI')),
    'from the cached CLI',
    'the cached installed CLI ran the turn'
  )
  const auth = await b.turn('auth')
  assert.deepEqual(ends(auth), [
    ['error', 'auth'],
    ['done', undefined]
  ])
  await chat()
  await until(() => probes().length === 4, 'the chat after a sign-in failure probed again')
  await until(() => debugLines('CLI started').length === 3, 'the third CLI started')
  console.log('PROVIDER-COLD-START probes PASS')

  // --- real hangs still end with the card, naming the phase -----------------------------------
  const MESSAGE = 'Claude did not respond — check login (claude auth status) and retry'
  const stall = await a.turn('stall')
  assert.deepEqual(a.still(stall), ['Still thinking…'])
  // Heartbeats kept arriving, yet they are not output: the deadline still ended the turn.
  assert.ok(a.beats(stall) >= 5, `heartbeats during the stall: ${a.beats(stall)}`)
  assert.deepEqual(ends(stall), [
    ['error', 'no-response'],
    ['done', undefined]
  ])
  assert.equal(
    a.errors(stall)[0].message,
    `${MESSAGE}. Stopped while waiting for the model's first reply (no answer in 2.5 s).`
  )
  const c = await chat()
  await until(() => debugLines('CLI started').length === 4, 'a fresh CLI')
  const noInit = await c.turn('noinit')
  assert.equal(
    c.errors(noInit)[0]?.message,
    `${MESSAGE}. Stopped while waiting for the session to start (no answer in 2.5 s).`
  )
  writeFileSync(MODE, 'hang')
  const hung = await chat()
  const started = Date.now()
  const never = await hung.turn('say never')
  assert.ok(Date.now() - started < 2000, 'a CLI that never starts gets the short deadline')
  assert.deepEqual(ends(never), [
    ['error', 'no-response'],
    ['done', undefined]
  ])
  assert.deepEqual(hung.still(never), [], 'no "Still …" for a CLI that never started')
  assert.equal(
    hung.errors(never)[0]?.message,
    `${MESSAGE}. Stopped while starting the Claude CLI (no answer in 0.5 s).`
  )
  writeFileSync(MODE, 'normal')
  assert.equal(debugLines('no-response while').length, 3)
  console.log('PROVIDER-COLD-START hangs PASS')

  // Nothing secret or unbounded in the log: one line per timing, all debug-prefixed.
  for (const line of debugLines('')) assert.ok(line.length < 300, line)
  console.log(
    'PROVIDER-COLD-START OK — slow cold starts are waited out, real hangs are named, probes run once and in parallel'
  )
} finally {
  for (const s of sessions) s.shutdown()
  await fixture?.stop().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
