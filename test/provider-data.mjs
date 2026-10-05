// LKM-102 provider data: the Swift provider owner (compiled fixture, `ProviderData.swift`),
// the only writer since LKM-111, against the answers and bytes its removed Bun twins
// recorded (`fixtures/provider-owner/data-golden.json`), and a v10 connection end to end.
// No provider SDK, no network, no Keychain: a scripted stand-in for `TreziSecrets --crypto`,
// a fake `codex` binary and a fake Codex SDK.
// - connections: saves and removes write the recorded `providers.json` bytes (key kept on
//   a path edit, dropped on an origin change, a corrupt file kept as `.corrupt`); refusals
//   carry the recorded messages and never the key;
// - catalog: the same lists write the recorded `model-catalog.json` bytes; Bun never writes;
// - probe: `codex debug models` through the owner parses like `parseCodexModels`;
// - in-process: a connection chat resolves its key and runs in Bun, never in a helper,
//   while every built-in seat runs in a helper.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
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
import { compileProviderFixture, startProviderFixture } from './helpers/provider-fixture.mjs'

// A fake Codex SDK: records how it was aimed and answers one turn.
const aimed = []
class FakeCodex {
  constructor(options) {
    aimed.push(options)
  }
  startThread() {
    return {
      id: null,
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'fake-thread' }
          yield {
            type: 'item.completed',
            item: { id: 'item_0', type: 'agent_message', text: 'hello from the connection' }
          }
          yield {
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }
          }
        })()
      })
    }
  }
}
mock.module('@openai/codex-sdk', () => ({ Codex: FakeCodex }))
mock.module('../src/main/backends/codex-mcp.ts', () => ({
  treziMcpConfig: () => ({ mcp_servers: {} }),
  verifyTreziMcp: async () => {},
  isolatedCodexConfig: (config = {}) => config
}))
mock.module('../src/main/trezi-agent-tools.ts', () => ({
  registerTreziAgentTools: async () => ({ socketPath: '/nowhere', token: 'fake', dispose() {} }),
  shutdownTreziAgentTools: async () => {}
}))

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-provider-data-')))
const CRYPTO = join(root, 'test/fixtures/provider-owner/fake-crypto.mjs')
const fixtures = new Set()
let count = 0
const profile = (name) => {
  const path = join(scratch, `p-${name}-${++count}`)
  mkdirSync(join(path, 'trezi'), { recursive: true })
  return path
}
const only = process.env.PROVIDER_DATA_ONLY?.split(',')
async function section(name, run) {
  if (only && !only.includes(name)) return
  await run()
  console.log(`PROVIDER-DATA ${name} PASS`)
}
const outcome = (promise) =>
  promise.then(
    (value) => ({ ok: value }),
    (error) => ({ error: error.message })
  )
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, label, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(10)
  }
  throw new Error(`Timed out: ${label}`)
}
/** An executable script (`#!<this bun>`) at `path`. */
const script = (path, source) => {
  writeFileSync(path, `#!${process.execPath}\n${source}`)
  chmodSync(path, 0o755)
  return path
}
const golden = JSON.parse(
  readFileSync(join(root, 'test/fixtures/provider-owner/data-golden.json'), 'utf8')
)
// A void answer reads as `{ ok: null }`, as it was recorded.
const normalized = (answer) =>
  JSON.parse(JSON.stringify('error' in answer ? answer : { ok: answer.ok ?? null }))

const { createProviderStore } = await import('../src/main/providers-store.ts')
const { createModelCatalog, parseCodexModels } = await import('../src/main/model-catalog.ts')
const { setProviderDataOwner, setProviderDataDir } = await import('../src/main/provider-data.ts')
const { setProviderOwner, providerOwner } = await import('../src/main/provider-owner.ts')
const { pickProvider } = await import('../src/main/backends/index.ts')
const { startProviderSession } = await import('../src/main/provider-sessions.ts')
const { resolveConnection } = await import('../src/main/providers.ts')

async function fixture(home, env = {}) {
  const started = await startProviderFixture(binary, home, {
    PROVIDER_CRYPTO: `${process.execPath}\u001f${CRYPTO}`,
    ...env
  })
  fixtures.add(started)
  return started
}
let binary
try {
  binary = compileProviderFixture()

  await section('connections', async () => {
    const home = profile('swift')
    const f = await fixture(home)
    const swift = f.owner().data
    const file = join(home, 'trezi/providers.json')
    const steps = new Map(golden.connections.map((step) => [step.label, step]))
    const same = async (label, run) => {
      const expected = steps.get(label)
      const answer = normalized(await outcome(Promise.resolve().then(run)))
      assert.deepEqual(answer, expected.answer, `${label}: the recorded answer`)
      assert.equal(
        existsSync(file) ? readFileSync(file, 'utf8') : null,
        expected.file,
        `${label}: the recorded providers.json bytes`
      )
      return answer
    }
    const saves = [
      [
        'create',
        {
          id: 'gw',
          label: ' AI Gateway ',
          baseUrl: ' https://ai-gateway.vercel.sh/v1// ',
          apiKey: ' sk-one ',
          models: ['kimi', ' kimi', 'deepseek', 3, '']
        }
      ],
      [
        'keyless',
        {
          id: 'groq',
          label: 'Groq',
          preset: 'custom',
          baseUrl: 'https://api.groq.com/openai/v1',
          models: []
        }
      ],
      [
        'path edit keeps the key',
        {
          id: 'gw',
          label: 'Gateway (work)',
          baseUrl: 'https://ai-gateway.vercel.sh/v1beta',
          models: ['a']
        }
      ],
      [
        'blank key keeps the key',
        {
          id: 'gw',
          label: 'Gateway (work)',
          baseUrl: 'https://ai-gateway.vercel.sh/v1beta',
          apiKey: '   ',
          models: ['a']
        }
      ],
      [
        'a key for a keyless one',
        {
          id: 'groq',
          label: 'Groq',
          preset: 'custom',
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKey: 'gsk-two'
        }
      ],
      [
        'origin change drops the key',
        { id: 'groq', label: 'Groq', preset: 'custom', baseUrl: 'https://attacker.example/v1' }
      ],
      [
        'port change drops the key',
        { id: 'gw', label: 'Gateway (work)', baseUrl: 'https://ai-gateway.vercel.sh:444/v1' }
      ],
      [
        'unicode label',
        {
          id: 'local',
          label: 'Local ✨  ',
          preset: 'custom',
          baseUrl: 'http://127.0.0.1:1234/v1/',
          apiKey: 'lk'
        }
      ]
    ]
    for (const [label, input] of saves) await same(label, () => swift.save(input))
    for (const [id, secret] of Object.entries(golden.secrets))
      assert.equal(await swift.secretFor(id), secret, `secret ${id}`)
    assert.equal(await swift.secretFor('local'), 'lk')
    assert.equal(await swift.secretFor('gw'), null, 'the key did not follow the port change')
    // Refusals: the recorded message, never the key.
    for (const [label, input] of [
      ['no label', { label: '  ', baseUrl: 'https://x.example' }],
      ['no url', { label: 'X', baseUrl: ' / ' }],
      ['unsafe id', { id: '../etc', label: 'X', baseUrl: 'https://x.example' }],
      [
        'locked keychain',
        { id: 'gw', label: 'X', baseUrl: 'https://x.example', apiKey: 'sk-locked-secret' }
      ]
    ]) {
      const answer = await same(label, () => swift.save(input))
      assert.ok(answer.error, `${label} refused`)
      assert.ok(!answer.error.includes('sk-locked-secret'), `${label}: the key is not in the error`)
    }
    await same('remove unknown', () => swift.remove('missing'))
    await same('remove', () => swift.remove('groq'))
    // The file Swift wrote reads the same through Bun's reader (what providers.ts lists).
    assert.deepEqual(createProviderStore(join(home, 'trezi')).list(), golden.list)
    // A file the owner cannot parse is kept beside the new one, never overwritten.
    writeFileSync(file, '{"connections": nope')
    await same('corrupt', () => swift.save({ id: 'n', label: 'N', baseUrl: 'https://n.example' }))
    assert.equal(readFileSync(`${file}.corrupt`, 'utf8'), '{"connections": nope')
    // Without a credential store a key is refused, never written in plain text.
    const bare = profile('bare')
    const g = await startProviderFixture(binary, bare, { PROVIDER_CRYPTO: '' })
    fixtures.add(g)
    const refused = await outcome(
      g.owner().data.save({ label: 'X', baseUrl: 'https://x.example', apiKey: 'sk-plain' })
    )
    assert.equal(refused.error, golden.noStore)
    assert.ok(!existsSync(join(bare, 'trezi/providers.json')))
    // A write before the service aliased an older session store would split it: refused.
    const older = join(scratch, 'older')
    mkdirSync(join(older, 'praxis'), { recursive: true })
    const h = await startProviderFixture(binary, older, {})
    fixtures.add(h)
    const early = await outcome(h.owner().data.save({ label: 'X', baseUrl: 'https://x.example' }))
    assert.equal(early.error, "Trezi's session store is not ready yet.")
    assert.ok(!existsSync(join(older, 'trezi')))
    for (const started of [f, g, h]) {
      await started.stop()
      fixtures.delete(started)
    }
  })

  // LKM-144: Keychain helper calls run one at a time, so parallel reads show one macOS
  // prompt (the first approval serves the rest), never one each.
  await section('keychain-serial', async () => {
    const home = profile('serial')
    const busy = join(scratch, 'crypto-busy'),
      overlaps = join(scratch, 'crypto-overlaps')
    const slow = script(
      join(scratch, 'slow-crypto.mjs'),
      `
import { appendFileSync, mkdirSync, rmdirSync } from 'node:fs'
try { mkdirSync(${JSON.stringify(busy)}) } catch { appendFileSync(${JSON.stringify(overlaps)}, 'x') }
await new Promise(resolve => setTimeout(resolve, 250))
try { rmdirSync(${JSON.stringify(busy)}) } catch {}
await import(${JSON.stringify(CRYPTO)})`
    )
    const f = await fixture(home, { PROVIDER_CRYPTO: `${process.execPath}\u001f${slow}` })
    const data = f.owner().data
    await data.save({ id: 'one', label: 'One', baseUrl: 'https://one.example', apiKey: 'sk-one' })
    await data.save({ id: 'two', label: 'Two', baseUrl: 'https://two.example', apiKey: 'sk-two' })
    const read = await Promise.all(['one', 'two', 'one', 'two'].map((id) => data.secretFor(id)))
    assert.deepEqual(read, ['sk-one', 'sk-two', 'sk-one', 'sk-two'])
    assert.ok(!existsSync(overlaps), 'no two Keychain helper calls ran at once')
    await f.stop()
    fixtures.delete(f)
  })

  await section('catalog', async () => {
    const home = profile('catalog-swift')
    writeFileSync(join(home, 'trezi/model-catalog.json'), golden.catalogSeed)
    const f = await fixture(home, { PROVIDER_NOW: '1234' })
    const swift = f.owner().data
    const read = () => readFileSync(join(home, 'trezi/model-catalog.json'), 'utf8')
    for (const { backend, models, file } of golden.catalog) {
      assert.equal(await swift.saveCatalog(backend, models), models.length > 0, `${backend} saved`)
      assert.equal(read(), file, `the recorded bytes after ${backend} (${models.length})`)
    }
    // LKM-164: the harness stamp is stored with its entry, the other entry kept as it was.
    const codexBefore = JSON.parse(read()).entries.codex
    assert.equal(
      await swift.saveCatalog('claude', [{ id: 'opus', label: 'Opus' }], 'sdk@1'),
      true,
      'a stamped list saved'
    )
    const stamped = JSON.parse(read()).entries
    assert.deepEqual(stamped.claude, {
      at: 1234,
      models: [{ id: 'opus', label: 'Opus' }],
      harness: 'sdk@1'
    })
    assert.deepEqual(stamped.codex, codexBefore, 'the other backend is untouched')
    const reader = createModelCatalog({
      baseDir: join(home, 'trezi'),
      now: () => 1234,
      harness: () => 'sdk@1',
      persist: () => true
    })
    assert.deepEqual(reader.get('claude'), [{ id: 'opus', label: 'Opus' }], 'Bun reads it back')
    assert.equal(reader.get('codex'), null, 'an unstamped entry is not the current harness')
    assert.equal(
      (
        await f.frame('catalogSave', {
          backend: 'claude',
          models: [{ id: 'a', label: 'A' }],
          harness: 7
        })
      ).payload.code,
      'invalidRequest',
      'a stamp must be text'
    )
    // Bun's reader, handed the Swift writer (`persist`), keeps serving from memory.
    const taken = []
    const routed = createModelCatalog({
      baseDir: join(home, 'trezi'),
      now: () => 1234,
      persist: (backend, models) => {
        taken.push([backend, models])
        return true
      }
    })
    const before = read()
    routed.set('codex', [{ id: 'm', label: 'M' }])
    assert.deepEqual(routed.get('codex'), [{ id: 'm', label: 'M' }])
    assert.deepEqual(taken, [['codex', [{ id: 'm', label: 'M' }]]])
    assert.equal(read(), before, 'Bun did not write')
    // A write the owner refused leaves the list in memory only; Bun never writes.
    const refusing = createModelCatalog({
      baseDir: join(home, 'trezi'),
      now: () => 1234,
      persist: () => false
    })
    refusing.set('claude', [{ id: 'n', label: 'N' }])
    assert.deepEqual(refusing.get('claude'), [{ id: 'n', label: 'N' }])
    assert.equal(read(), before, 'Bun did not write after a refusal')
    assert.equal(
      (await f.frame('catalogSave', { backend: 'gemini', models: [] })).payload.code,
      'invalidRequest'
    )
    assert.equal(
      (await f.frame('catalogSave', { backend: 'codex', models: [{ id: 1, label: 'x' }] })).payload
        .code,
      'invalidRequest'
    )
    await f.stop()
    fixtures.delete(f)
  })

  await section('probe', async () => {
    const payload = {
      models: [
        { slug: 'gpt-b', display_name: 'B', visibility: 'list', priority: 2 },
        { slug: 'hidden', visibility: 'hide', priority: 0 },
        { slug: 'gpt-a', visibility: 'list', priority: 1 }
      ]
    }
    const good = script(
      join(scratch, 'codex-good'),
      `if (process.argv.slice(2).join(' ') !== 'debug models') process.exit(2)\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))})\n`
    )
    const bad = script(join(scratch, 'codex-bad'), 'process.stdout.write("not json")\n')
    const f = await fixture(profile('probe'), { TREZI_CODEX_BIN: good })
    assert.deepEqual(await f.owner().data.codexModels(), parseCodexModels(payload))
    assert.deepEqual(
      (await f.owner().data.codexModels()).map((m) => m.id),
      ['gpt-a', 'gpt-b']
    )
    const g = await fixture(profile('probe-bad'), { TREZI_CODEX_BIN: bad })
    assert.deepEqual(await g.owner().data.codexModels(), [])
    const h = await fixture(profile('probe-missing'), {
      TREZI_CODEX_BIN: join(scratch, 'no-such-codex')
    })
    assert.deepEqual(await h.owner().data.codexModels(), [])
    for (const started of [f, g, h]) {
      await started.stop()
      fixtures.delete(started)
    }
  })

  await section('in-process', async () => {
    // A connection chat on the Swift owner: the key is resolved in Bun and the adapter
    // runs in-process, while a built-in seat routes to a provider helper.
    const WT = join(scratch, 'wt'),
      LIVE = join(scratch, 'live')
    mkdirSync(WT, { recursive: true })
    mkdirSync(LIVE, { recursive: true })
    const saved = { ...process.env }
    process.env.CODEX_HOME = join(scratch, 'codex-home')
    try {
      const home = profile('chat-swift')
      setProviderDataDir(() => join(home, 'trezi'))
      process.env.TREZI_SERVICE_SUPERVISED = '1'
      const f = await fixture(home)
      const owner = f.owner()
      setProviderOwner(owner)
      setProviderDataOwner(owner.data)
      // Saved through the store the settings dialog uses (providers:save).
      const { connectionStore } = await import('../src/main/provider-data.ts')
      const conn = await connectionStore.save({
        id: 'fake-conn',
        label: 'Fake',
        preset: 'custom',
        baseUrl: 'https://fake.example/v1',
        apiKey: 'sk-fake-connection',
        models: ['fake-model']
      })
      assert.equal(conn.hasKey, true)
      assert.ok(
        !readFileSync(join(home, 'trezi/providers.json'), 'utf8').includes('sk-fake-connection'),
        'no plaintext key on disk'
      )
      assert.deepEqual(await resolveConnection('fake-conn'), {
        baseUrl: 'https://fake.example/v1',
        apiKey: 'sk-fake-connection',
        wireApi: 'responses'
      })
      const options = { provider: 'claude', connectionId: 'fake-conn', model: 'fake-model' }
      const provider = pickProvider(options)
      assert.notEqual(provider.host, 'helper', 'a connection is never helper-hosted')
      assert.equal(provider.id, 'codex', 'a connection runs on the Codex harness')
      for (const seat of ['claude', 'codex', undefined])
        assert.equal(
          pickProvider({ provider: seat }).host,
          'helper',
          `${seat ?? 'default'} runs in a helper`
        )
      const events = []
      aimed.length = 0
      const session = await startProviderSession(provider, WT, options, () => null, {
        emitKey: 'chat-swift',
        liveRoot: LIVE,
        onEvent: (e) => events.push(e)
      })
      session.send('hi')
      await until(() => events.some((e) => e.type === 'done'), 'connection turn')
      assert.equal(
        events
          .filter((e) => e.type === 'delta')
          .map((e) => e.text)
          .join(''),
        'hello from the connection'
      )
      assert.ok(!events.some((e) => e.type === 'error'), JSON.stringify(events))
      assert.equal(aimed.length, 1)
      assert.equal(aimed[0].apiKey, 'sk-fake-connection', 'the key reached the in-process SDK')
      assert.equal(
        Object.values(aimed[0].config.model_providers)[0].base_url,
        'https://fake.example/v1'
      )
      assert.ok(!JSON.stringify(events).includes('sk-fake-connection'), 'the key is never emitted')
      const sessions = (await providerOwner().snapshot()).sessions
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].host, 'bun', 'the owner sees an in-process session')
      session.shutdown()
      await sleep(50)
      await f.stop()
      fixtures.delete(f)
    } finally {
      setProviderOwner(null)
      setProviderDataOwner(null)
      for (const key of ['CODEX_HOME', 'TREZI_SERVICE_SUPERVISED']) {
        if (key in saved) process.env[key] = saved[key]
        else delete process.env[key]
      }
    }
  })

  console.log(
    'Provider data: connections, catalog and probe against the recorded answers, and in-process connection chats passed; no provider calls'
  )
} finally {
  for (const started of fixtures) await started.kill().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
