// LKM-111 live provider parity: the real Claude and Codex adapters on the user's own
// subscriptions, run in-process in Bun (the path built-in seats took before LKM-111)
// and in a provider helper the real Swift ProviderOwner supervises (the only path now).
// Bounded on purpose: two providers × two hosts × one minimal prompt, cheapest model
// settings, no tools, no Gemini. Each run's events, answer and token usage are
// compared and written to test/artifacts/provider-live-parity.json.
//
// Real provider calls: runs only with TREZI_LIVE_PROVIDERS=1 (otherwise SKIP, which is
// not PASS). Run with: TREZI_LIVE_PROVIDERS=1 bun run test:provider-live
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.TREZI_LIVE_PROVIDERS !== '1') {
  console.log(
    'PROVIDER-LIVE-PARITY SKIP: set TREZI_LIVE_PROVIDERS=1 to make real Claude and Codex calls on your subscriptions'
  )
  process.exit(0)
}

const { claudeProvider } = await import('../src/main/backends/claude.ts')
const { codexProvider } = await import('../src/main/backends/codex.ts')
const { helperProvider } = await import('../src/main/backends/helper-session.ts')
const { setProviderOwner } = await import('../src/main/provider-owner.ts')
const { compileProviderFixture, startProviderFixture } = await import(
  './helpers/provider-fixture.mjs'
)

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-provider-live-')))
const PROMPT = 'Reply with exactly the word PONG and nothing else. Do not use any tools.'
const MATRIX = [
  {
    provider: 'claude',
    options: { provider: 'claude', model: 'haiku', effort: 'low', permissionMode: 'default' }
  },
  { provider: 'codex', options: { provider: 'codex', effort: 'low', permissionMode: 'default' } }
]
const TURN_MS = 180_000
const inProcess = { claude: claudeProvider, codex: codexProvider }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One chat, one turn: the events in order, the answer, and the summed token usage. */
async function run(provider, options, host) {
  const project = join(scratch, `${provider}-${host}`)
  mkdirSync(project)
  const events = []
  const adapter = host === 'helper' ? helperProvider(provider) : inProcess[provider]
  const started = Date.now()
  const session = await adapter.startSession(project, options, () => null, {
    emitKey: `live-${provider}-${host}`,
    liveRoot: project,
    onEvent: (e) => events.push(e)
  })
  try {
    session.send(PROMPT)
    const deadline = Date.now() + TURN_MS
    while (!events.some((e) => e.type === 'done')) {
      // No tools were asked for: any permission card is refused (and fails the comparison).
      for (const [id, prompt] of session.pending) {
        session.pending.delete(id)
        prompt.settle('deny')
      }
      assert.ok(Date.now() < deadline, `${provider}/${host}: no done within ${TURN_MS} ms`)
      await sleep(50)
    }
  } finally {
    session.shutdown()
  }
  const usage = { input: 0, output: 0, cached: 0 }
  for (const e of events.filter((e) => e.type === 'usage'))
    for (const key of Object.keys(usage)) usage[key] += e[key] ?? 0
  return {
    provider,
    host,
    ms: Date.now() - started,
    answer: events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join('')
      .trim(),
    errors: events.filter((e) => e.type === 'error').map((e) => e.message),
    kinds: [
      ...new Set(
        events
          .map((e) => e.type)
          .filter((type) => ['delta', 'done', 'error', 'permission-request'].includes(type))
      )
    ],
    dones: events.filter((e) => e.type === 'done').length,
    usage
  }
}

const fixtures = []
const results = []
try {
  const binary = compileProviderFixture()
  const profile = join(scratch, 'profile')
  mkdirSync(profile)
  const fixture = await startProviderFixture(binary, profile, {
    PROVIDER_HELPER_EXEC: process.execPath,
    PROVIDER_HELPER_ARGS: join(root, 'src/main/backends/provider-helper-entry.ts'),
    PROVIDER_HELPER_PROVIDERS: 'claude,codex'
  })
  fixtures.push(fixture)
  setProviderOwner(fixture.owner())
  for (const { provider, options } of MATRIX) {
    for (const host of ['in-process', 'helper']) {
      const result = await run(provider, options, host)
      results.push(result)
      console.log(
        `PROVIDER-LIVE ${provider}/${host}: ${JSON.stringify(result.answer)} in ${result.ms} ms, tokens in=${result.usage.input} out=${result.usage.output} cached=${result.usage.cached}${result.errors.length ? `, errors ${JSON.stringify(result.errors)}` : ''}`
      )
    }
  }
  mkdirSync(join(root, 'test/artifacts'), { recursive: true })
  writeFileSync(
    join(root, 'test/artifacts/provider-live-parity.json'),
    `${JSON.stringify({ prompt: PROMPT, at: new Date().toISOString(), results }, null, 2)}\n`
  )
  for (const { provider } of MATRIX) {
    const [before, after] = ['in-process', 'helper'].map((host) =>
      results.find((r) => r.provider === provider && r.host === host)
    )
    for (const r of [before, after]) {
      assert.deepEqual(r.errors, [], `${provider}/${r.host} failed`)
      assert.equal(r.dones, 1, `${provider}/${r.host}: exactly one done`)
      assert.match(r.answer, /^PONG\.?$/i, `${provider}/${r.host} answered`)
      assert.ok(r.usage.input + r.usage.output > 0, `${provider}/${r.host} reported token usage`)
    }
    assert.deepEqual(
      after.kinds,
      before.kinds,
      `${provider}: the helper emits the events the in-process adapter did`
    )
  }
  const total = results.reduce((sum, r) => sum + r.usage.input + r.usage.output, 0)
  console.log(
    `PROVIDER-LIVE-PARITY OK — Claude and Codex answer alike in-process and in the supervised helper (${results.length} runs, ${total} tokens)`
  )
} catch (error) {
  console.error('PROVIDER-LIVE-PARITY FAILED:', error?.stack ?? error)
  process.exitCode = 1
} finally {
  setProviderOwner(null)
  for (const fixture of fixtures) await fixture.kill().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
