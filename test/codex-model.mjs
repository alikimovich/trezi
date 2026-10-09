// LKM-126, the Codex seat, with no model request, network or real credential: a
// stand-in `codex` CLI that rejects `gpt-6.1-sol` (the CLI's own default, priority 1)
// with the ChatGPT-account 400, drives the real Codex adapter in-process and in the
// real helper host under the Swift ProviderOwner fixture.
// - fallback: the turn retries on the next listed model, says so in a status line and
//   answers; later turns and chats skip the rejected model, and the picker drops it;
// - where it is said (LKM-128): the real CLI's stream `error` events, `turn.failed`
//   only, the exec error only, after a warning item, with and without a model asked for;
// - clear message: with every listed model rejected, the turn ends in a visible error;
// - MCP: every CLI run gets a config under which the real Codex CLI loads none of the
//   fixture user's `~/.codex` MCP servers (declared or plugin-provided), only Trezi's.
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
import { Codex } from '@openai/codex-sdk'
import {
  codexFallbackNotice,
  codexModelUnavailable,
  nextCodexModel,
  parseCodexFallback,
  rejectedCodexModels,
  rememberCodexFallback,
  resetCodexModelMemory,
  supportedCodexModel,
  unsupportedCodexModel
} from '../src/main/backends/codex-model.ts'
import { harnessStamp, installedVersion } from '../src/main/model-catalog.ts'
import { compileProviderFixture, startProviderFixture } from './helpers/provider-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-codex-model-')))
const HOME = join(scratch, 'codex-home'),
  DATA = join(scratch, 'data'),
  WT = join(scratch, 'wt')
for (const dir of [HOME, DATA, WT]) mkdirSync(dir)
const LOG = join(scratch, 'exec.log'),
  REJECT = join(scratch, 'reject.json')
const MODELS = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']
/**
 * Which models the stand-in rejects, and where it says so (LKM-128): `stream` is the
 * real CLI 0.159.1 (two `error` events carrying the API's JSON body, then exit 1 with
 * only "Reading prompt from stdin..." on stderr); `turn.failed` and `exec` put the body
 * only in that event or only in the exec error. `warn` first emits the CLI's
 * skills-budget warning item, which is not output.
 */
const reject = (models, via = 'stream', warn = false) =>
  writeFileSync(REJECT, JSON.stringify({ models, via, warn }))
const RULE = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."
const body = (message) =>
  JSON.stringify({
    type: 'error',
    status: 400,
    error: { type: 'invalid_request_error', message }
  })

// --- the pure rules ---------------------------------------------------------------
assert.equal(
  unsupportedCodexModel(`Codex Exec exited with code 1: {"detail":"${RULE}"}`),
  'gpt-6.1-sol'
)
assert.equal(
  unsupportedCodexModel({ type: 'error', message: body(RULE) }),
  'gpt-6.1-sol',
  'a stream error'
)
assert.equal(unsupportedCodexModel(JSON.parse(body(RULE))), 'gpt-6.1-sol', 'the body as the event')
assert.equal(unsupportedCodexModel({ message: body(RULE) }), 'gpt-6.1-sol', "turn.failed's error")
assert.equal(
  unsupportedCodexModel({ message: body(RULE).replaceAll("'", '\\u0027') }),
  'gpt-6.1-sol',
  'escaped quotes'
)
assert.equal(
  unsupportedCodexModel(`Codex Exec exited with code 1: ${body(RULE)}\n`),
  'gpt-6.1-sol',
  'the exec error'
)
assert.equal(
  unsupportedCodexModel('Codex Exec exited with code 1: Reading prompt from stdin...'),
  null
)
assert.equal(unsupportedCodexModel({ type: 'error', message: body('Rate limited') }), null)
assert.equal(unsupportedCodexModel('unexpected status 401 Unauthorized'), null)
assert.equal(unsupportedCodexModel(RULE.replace('gpt-6.1-sol', 'x; rm')), null, 'only a model slug')
const notice = codexFallbackNotice('gpt-6.1-sol', 'gpt-6-sol')
assert.deepEqual(parseCodexFallback(notice), { rejected: 'gpt-6.1-sol', fallback: 'gpt-6-sol' })
assert.equal(parseCodexFallback(`${notice} Also`), null, 'only the exact status line')
assert.equal(nextCodexModel(MODELS, new Set(['gpt-6.1-sol']), 'gpt-6.1-sol'), 'gpt-6-sol')
assert.equal(
  nextCodexModel(MODELS, new Set(['gpt-6-astra']), 'gpt-6-astra'),
  'gpt-6.1-sol',
  'wraps'
)
assert.equal(nextCodexModel(MODELS, new Set(MODELS), 'gpt-6-sol'), null)
resetCodexModelMemory()
assert.equal(supportedCodexModel(undefined, MODELS), undefined, 'nothing rejected: the CLI default')
rememberCodexFallback('gpt-6.1-sol', 'gpt-6-sol', true)
assert.equal(
  supportedCodexModel(undefined, MODELS),
  'gpt-6-sol',
  'the default is the last fallback'
)
assert.equal(supportedCodexModel('gpt-6.1-sol', MODELS), 'gpt-6-sol')
assert.equal(supportedCodexModel('gpt-6-astra', MODELS), 'gpt-6-astra', 'a usable pick is kept')
rememberCodexFallback('gpt-6-sol', 'gpt-6-astra', false)
assert.equal(supportedCodexModel(undefined, MODELS), 'gpt-6-astra', 'a rejected fallback moves on')
resetCodexModelMemory()

// --- the user's own Codex config: a declared MCP server and a plugin's server -----------
const plugin = join(HOME, 'plugins/cache/fixture/vercel/1.0.0')
mkdirSync(join(plugin, '.codex-plugin'), { recursive: true })
writeFileSync(
  join(plugin, '.codex-plugin/plugin.json'),
  JSON.stringify({ name: 'vercel', version: '1.0.0', mcpServers: './.mcp.json' })
)
writeFileSync(
  join(plugin, '.mcp.json'),
  JSON.stringify({
    mcpServers: { 'vercel-plugin': { type: 'http', url: 'https://mcp.vercel.com' } }
  })
)
writeFileSync(
  join(HOME, 'config.toml'),
  '[mcp_servers.personal]\nurl = "http://127.0.0.1:9/mcp"\n\n[plugins."vercel@fixture"]\nenabled = true\n'
)

// --- the stand-in CLI -----------------------------------------------------------------
// `debug models` is the catalog probe; each `exec` asks the real CLI which MCP servers
// its `--config` leaves on, logs it with the model, and fails a rejected model like the
// real one (see `reject`), before any output.
const REAL = new Codex().exec.executablePath
const CLI = join(scratch, 'codex.mjs')
writeFileSync(
  CLI,
  `#!${process.execPath}
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
if (args[0] === '--version') { console.log('codex-cli 0.0.0-test'); process.exit(0) }
const models = ${JSON.stringify(MODELS)}
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({ models: models.map((slug, i) => ({ slug, display_name: slug, visibility: 'list', priority: i + 1 })) }))
  process.exit(0)
}
if (args[0] !== 'exec') process.exit(2)
readFileSync(0)
const configs = args.flatMap((arg, i) => (arg === '--config' ? ['--config', args[i + 1]] : []))
const listed = JSON.parse(execFileSync(${JSON.stringify(REAL)}, [...configs, 'mcp', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
const at = args.indexOf('--model'), resumed = args.indexOf('resume')
const model = at < 0 ? null : args[at + 1], resume = resumed < 0 ? null : args[resumed + 1]
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ model, resume, mcp: Object.fromEntries(listed.map((s) => [s.name, s.enabled])) }) + '\\n')
const effective = model ?? models[0]
out({ type: 'thread.started', thread_id: resume ?? 'thread-' + process.pid })
out({ type: 'turn.started' })
const { models: rejected, via, warn } = JSON.parse(readFileSync(${JSON.stringify(REJECT)}, 'utf8'))
if (rejected.includes(effective)) {
  if (warn) out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Skill descriptions were shortened to fit the skills context budget.' } })
  const message = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The '" + effective + "' model is not supported when using Codex with a ChatGPT account." } })
  if (via === 'stream') for (let i = 0; i < 2; i++) out({ type: 'error', message })
  if (via === 'turn.failed') out({ type: 'turn.failed', error: { message } })
  process.stderr.write('Reading prompt from stdin...\\n' + (via === 'exec' ? message + '\\n' : ''))
  process.exit(1)
}
out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'PONG from ' + effective } })
out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })
`
)
chmodSync(CLI, 0o755)
const runs = () =>
  (() => {
    try {
      return readFileSync(LOG, 'utf8')
    } catch {
      return ''
    }
  })()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

process.env.TREZI_CODEX_BIN = CLI
process.env.CODEX_HOME = HOME
const { codexProvider } = await import('../src/main/backends/codex.ts')
const { helperProvider } = await import('../src/main/backends/helper-session.ts')
const { setProviderOwner } = await import('../src/main/provider-owner.ts')
const { setProviderDataDir } = await import('../src/main/provider-data.ts')
const { choices } = await import('../src/main/providers.ts')
const { startProviderSession } = await import('../src/main/provider-sessions.ts')
const { shutdownTreziAgentTools } = await import('../src/main/trezi-agent-tools.ts')
const { newChat, reduce } = await import('../src/native/chat-state.ts')

// The picker's catalog, as the service's `codex debug models` probe persisted it with
// the installed Codex SDK/CLI (an entry from another version is ignored, LKM-164).
const probed = () => {
  writeFileSync(
    join(DATA, 'model-catalog.json'),
    JSON.stringify({
      version: 1,
      entries: {
        codex: {
          at: Date.now(),
          models: MODELS.map((id) => ({ id, label: id })),
          harness: harnessStamp('codex', (pkg) => installedVersion(root, pkg))
        }
      }
    })
  )
  setProviderDataDir(() => DATA)
}
probed()
const picker = () =>
  choices()
    .filter((c) => c.provider === 'codex' && !c.connectionId)
    .map((c) => c.modelId)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, label, ms = 30_000) => {
  const deadline = Date.now() + ms
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await sleep(20)
  }
}
const sessions = []
async function chat(provider, options = {}) {
  const events = []
  const s = await startProviderSession(
    provider,
    WT,
    { provider: 'codex', ...options },
    () => null,
    {
      emitKey: `chat-${sessions.length}`,
      liveRoot: WT,
      onEvent: (e) => events.push(e)
    }
  )
  sessions.push(s)
  const turn = async (text) => {
    const start = events.length,
      ran = runs().length
    s.send(text)
    await until(() => events.slice(start).some((e) => e.type === 'done'), `turn ${text}`)
    await sleep(100) // a second `done` would land here
    return { events: events.slice(start), runs: runs().slice(ran) }
  }
  return { s, turn }
}
const said = (events) =>
  events
    .filter((e) => e.type === 'delta')
    .map((e) => e.text)
    .join('')
const of = (events, type) => events.filter((e) => e.type === type)
const statuses = (events) => of(events, 'status').map((e) => e.text)
/** The real CLI, under the run's config, loads none of the user's servers. */
const isolated = (run) => {
  assert.equal(run.mcp.personal, false, 'the declared server is switched off')
  assert.equal(run.mcp['vercel-plugin'], undefined, 'the plugin server is not loaded')
  assert.equal(run.mcp.trezi, true, "only Trezi's server runs")
}

async function fallbackChat(provider, where, warn = false) {
  reject(['gpt-6.1-sol'], 'stream', warn)
  const first = await chat(provider)
  const one = await first.turn('ping')
  assert.deepEqual(
    one.runs.map((r) => r.model),
    [null, 'gpt-6-sol'],
    `${where}: the default, then the next listed model; events ${JSON.stringify(one.events)}`
  )
  one.runs.forEach(isolated)
  assert.deepEqual(
    statuses(one.events).filter((t) => t.startsWith('Codex:')),
    [notice],
    `${where}: says so`
  )
  assert.equal(said(one.events), 'PONG from gpt-6-sol', `${where}: answers`)
  assert.equal(of(one.events, 'error').length, 0, `${where}: no error`)
  assert.equal(of(one.events, 'done').length, 1, `${where}: one done`)
  assert.equal(first.s.options.model, undefined, `${where}: the chat keeps the model it asked for`)
  assert.ok(rejectedCodexModels().has('gpt-6.1-sol'), `${where}: main remembers the rejection`)
  assert.deepEqual(
    picker(),
    ['default', 'gpt-6-sol', 'gpt-6-astra'],
    `${where}: the picker drops it`
  )

  const two = await first.turn('again')
  assert.deepEqual(
    two.runs.map((r) => [r.model, !!r.resume]),
    [['gpt-6-sol', true]],
    `${where}: turn 2 resumes on the fallback`
  )
  assert.equal(said(two.events), 'PONG from gpt-6-sol')
  const next = await (await chat(provider)).turn('ping')
  assert.deepEqual(
    next.runs.map((r) => r.model),
    ['gpt-6-sol'],
    `${where}: a new chat skips the rejected default`
  )
  const picked = await (await chat(provider, { model: 'gpt-6.1-sol' })).turn('ping')
  assert.deepEqual(
    picked.runs.map((r) => r.model),
    ['gpt-6-sol'],
    `${where}: and the rejected pick`
  )
  assert.equal(
    statuses(next.events)
      .concat(statuses(picked.events))
      .filter((t) => t.startsWith('Codex:')).length,
    0
  )
}

let fixture
try {
  // --- in-process, under a stand-in owner ---------------------------------------------
  const ok = async () => {}
  setProviderOwner({
    kind: 'swift',
    open: async () => ({ tools: ['workspace_state'] }),
    authorize: ok, // the bridge's startup `workspace_state` check
    turn: ok,
    terminal: ok,
    resume: ok,
    close: ok,
    settled: ok,
    cancel: async () => ({ escalate: false })
  })
  await fallbackChat(codexProvider, 'in-process')

  // Every listed model rejected: a clear error, not an empty turn.
  resetCodexModelMemory()
  reject(MODELS)
  const none = await (await chat(codexProvider)).turn('ping')
  assert.deepEqual(
    none.runs.map((r) => r.model),
    [null, 'gpt-6-sol', 'gpt-6-astra']
  )
  assert.deepEqual(
    of(none.events, 'error').map((e) => e.message),
    [codexModelUnavailable('gpt-6-astra')]
  )
  assert.equal(of(none.events, 'error')[0].code, undefined, 'not a login problem')
  assert.equal(said(none.events), '')
  assert.equal(of(none.events, 'done').length, 1)
  const view = newChat('chat-none')
  for (const event of none.events) reduce(view, event)
  assert.ok(
    view.messages[0].text.includes(codexModelUnavailable('gpt-6-astra')),
    'the chat shows the message'
  )

  // The rejection in `turn.failed` only, in the exec error only, and after a warning
  // item; and a turn that asked for the model by name. Each falls back the same way.
  for (const [via, warn, model] of [
    ['turn.failed', false, undefined],
    ['exec', false, undefined],
    ['stream', true, undefined],
    ['stream', false, 'gpt-6.1-sol']
  ]) {
    const where = `in-process via ${via}${warn ? ' after a warning' : ''}${model ? ` asking for ${model}` : ''}`
    resetCodexModelMemory()
    reject(['gpt-6.1-sol'], via, warn)
    const run = await (await chat(codexProvider, model ? { model } : {})).turn('ping')
    assert.deepEqual(
      run.runs.map((r) => r.model),
      [model ?? null, 'gpt-6-sol'],
      `${where}: events ${JSON.stringify(run.events)}`
    )
    assert.deepEqual(
      statuses(run.events).filter((t) => t.startsWith('Codex:')),
      [notice],
      where
    )
    assert.equal(said(run.events), 'PONG from gpt-6-sol', where)
    assert.equal(of(run.events, 'error').length, 0, `${where}: no error`)
    assert.equal(of(run.events, 'done').length, 1, where)
  }

  // --- in the real helper host, under the real Swift owner ------------------------------
  resetCodexModelMemory()
  probed()
  assert.deepEqual(picker(), ['default', ...MODELS], 'a fresh app run lists every probed model')
  mkdirSync(join(scratch, 'profile'))
  fixture = await startProviderFixture(compileProviderFixture(), join(scratch, 'profile'), {
    PROVIDER_HELPER_ARGS: `${join(root, 'test/fixtures/codex-helper.mjs')}\u001f${CLI}`,
    PROVIDER_HELPER_PROVIDERS: 'codex'
  })
  setProviderOwner(fixture.owner())
  // The operator's run: a warning item, then the real CLI's stream errors.
  await fallbackChat(helperProvider('codex'), 'helper', true)
  console.log(
    'CODEX-MODEL OK — seat fallback, memory, picker, clear message and no personal MCP, in-process and in the helper'
  )
} finally {
  for (const s of sessions) s.shutdown()
  await fixture?.stop()
  setProviderOwner(null)
  await shutdownTreziAgentTools()
  rmSync(scratch, { recursive: true, force: true })
}
