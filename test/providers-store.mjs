import assert from 'node:assert/strict'
/**
 * ProviderStore unit test (pure — no Electron). Bun only READS the v10 store for
 * user-added model endpoints since LKM-111: the Swift provider owner is the only
 * writer (saves, the key cipher, secretFor), and its answers are pinned by the
 * recorded goldens in test/provider-data.mjs. Covered here: the reader's guarantee
 * that a secret never leaves via list()/get(), degrading to empty on a corrupt or
 * junk file, the on-read wireApi coercion, the Jev key picker over a store, and the
 * pure helpers the network layer leans on (modelsUrl, parseModelCatalog, sameOrigin,
 * scrubSecret).
 *
 * Run with: bun run test:providers
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { savedJevKey } from '../src/main/jev-credentials.ts'
import {
  createProviderStore,
  modelsUrl,
  parseModelCatalog,
  sameOrigin,
  scrubSecret
} from '../src/main/providers-store.ts'

const base = mkdtempSync(join(tmpdir(), 'trezi-providers-'))
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

const file = join(base, 'providers.json')
// The shape the owner writes: a connection plus its encrypted key blob.
const stored = (extra = {}) => ({
  id: 'gw',
  label: 'AI Gateway',
  preset: 'gateway',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
  wireApi: 'responses',
  models: ['moonshotai/kimi-k2'],
  ...extra
})
const writeStore = (connections, at = file) =>
  writeFileSync(at, JSON.stringify({ version: 1, connections }), 'utf8')

try {
  // --- reads ---------------------------------------------------------------
  const store = createProviderStore(base)
  ok(store.list().length === 0, 'no file lists nothing')
  ok(store.get('nope') === null, 'get of missing id is null')

  writeStore([
    stored({ secret: 'djEwAAAA-sk-secret-blob' }),
    stored({ id: 'local', label: 'Local', preset: 'custom', baseUrl: 'http://127.0.0.1:1234/v1' })
  ])
  ok(
    store
      .list()
      .map((c) => c.id)
      .join() === 'gw,local',
    'list reads the owner file in order'
  )
  ok(store.get('gw')?.hasKey === true, 'a stored key blob reads as hasKey')
  ok(store.get('local')?.hasKey === false, 'no blob reads as keyless')
  ok(store.get('../gw') === null, 'get of an unsafe id is null, not a lookup')

  // --- list()/get() never leak a secret ------------------------------------
  const listed = store.list()[0]
  ok(!('secret' in listed) && !('apiKey' in listed), 'list() strips every key field')
  ok(!JSON.stringify(store.list()).includes('sk-secret'), 'no key blob anywhere in list()')
  ok(!JSON.stringify(store.get('gw')).includes('sk-secret'), 'get() is key-free too')

  // --- savedJevKey over a store --------------------------------------------
  const gateway = store.get('gw')
  const secrets = { gw: 'sk-secret-1', gw2: 'other-key', custom: 'custom-key' }
  const over = (connections) => ({
    list: () => connections,
    secretFor: (id) => secrets[id] ?? null
  })
  assert.equal(savedJevKey(over([gateway])), 'sk-secret-1')
  const pair = over([gateway, { ...gateway, id: 'gw2' }])
  assert.throws(() => savedJevKey(pair), /multiple/)
  assert.equal(savedJevKey(pair, 'gw2'), 'other-key')
  assert.equal(savedJevKey(pair, 'gw'), 'sk-secret-1')
  const custom = {
    ...gateway,
    id: 'custom',
    preset: 'custom',
    baseUrl: 'https://custom.example/v1'
  }
  assert.equal(savedJevKey(over([gateway, custom]), 'custom'), 'sk-secret-1')
  const fakeStore = (connection, secret = 'must-not-leak') => ({
    list: () => [connection],
    secretFor: () => secret
  })
  for (const connection of [
    { ...gateway, baseUrl: 'https://other.example/v1' },
    { ...gateway, baseUrl: 'http://ai-gateway.vercel.sh/v1' },
    { ...gateway, baseUrl: 'https://ai-gateway.vercel.sh.evil.example/v1' },
    { ...gateway, baseUrl: 'https://user:pass@ai-gateway.vercel.sh/v1' },
    { ...gateway, preset: 'custom' },
    { ...gateway, hasKey: false }
  ])
    assert.equal(savedJevKey(fakeStore(connection)), undefined)
  assert.throws(() => savedJevKey(fakeStore(gateway, null)), /Reconnect/)

  // --- corrupt file degrades to empty --------------------------------------
  writeFileSync(file, '{not json at all', 'utf8')
  ok(store.list().length === 0, 'corrupt JSON lists as empty rather than throwing')
  ok(store.get('anything') === null, 'get on a corrupt store is null')
  // A file whose shape is wrong (valid JSON, no connections array) is corrupt too.
  writeFileSync(file, '{"version":1}', 'utf8')
  ok(store.list().length === 0, 'wrong-shape store is empty')
  writeFileSync(
    file,
    JSON.stringify({ version: 1, connections: [stored()], pad: 'x'.repeat(600 * 1024) }),
    'utf8'
  )
  ok(store.list().length === 0, 'an oversized file reads as corrupt')
  // A single junk ENTRY must not hide its healthy neighbours.
  writeStore([
    { nope: true },
    stored({ id: 'ok1', preset: 'custom', baseUrl: 'https://x/v1', wireApi: 'chat', models: [] })
  ])
  const partial = store.list()
  ok(partial.length === 1 && partial[0].id === 'ok1', 'a junk entry is skipped, the rest survive')
  // That fixture carries the retired wireApi 'chat' (the bundled codex CLI rejects
  // it), so reading it proves the on-read coercion.
  ok(partial[0].wireApi === 'responses', 'a retired wireApi on disk is coerced on read')

  // --- modelsUrl -----------------------------------------------------------
  ok(
    modelsUrl('https://ai-gateway.vercel.sh/v1') === 'https://ai-gateway.vercel.sh/v1/models',
    'joins /models onto a /v1 root'
  )
  ok(
    modelsUrl('https://ai-gateway.vercel.sh/v1/') === 'https://ai-gateway.vercel.sh/v1/models',
    'tolerates a trailing slash'
  )
  ok(
    modelsUrl('https://ai-gateway.vercel.sh/v1///') === 'https://ai-gateway.vercel.sh/v1/models',
    'tolerates repeated trailing slashes'
  )
  ok(
    modelsUrl('https://api.example.com') === 'https://api.example.com/models',
    'does not invent a /v1 segment'
  )
  ok(
    modelsUrl('  http://127.0.0.1:1234/v1  ') === 'http://127.0.0.1:1234/v1/models',
    'trims surrounding whitespace'
  )
  ok(
    modelsUrl('https://api.example.com/v1/models') === 'https://api.example.com/v1/models',
    'is idempotent on a full /models URL'
  )

  // --- parseModelCatalog ---------------------------------------------------
  ok(
    parseModelCatalog({ data: [{ id: 'b' }, { id: 'a' }] }).join() === 'a,b',
    'OpenAI {data:[{id}]} shape, sorted'
  )
  ok(parseModelCatalog({ models: ['z', 'y'] }).join() === 'y,z', 'bare {models:[…]} of strings')
  ok(parseModelCatalog(['gpt-5', 'gpt-4o']).join() === 'gpt-4o,gpt-5', 'bare array fallback')
  ok(
    parseModelCatalog({ models: [{ name: 'llama3' }] }).join() === 'llama3',
    'object entries may use name'
  )
  ok(
    parseModelCatalog({ data: [{ id: 'a' }, 'a', { id: '' }, { id: 5 }, null, 42] }).join() === 'a',
    'malformed entries ignored, ids de-duplicated'
  )
  ok(parseModelCatalog(null).length === 0, 'null body → no models')
  ok(parseModelCatalog('<html>').length === 0, 'a non-JSON-object body → no models')
  ok(parseModelCatalog({ data: {} }).length === 0, 'non-array data → no models')

  // --- sameOrigin (the one rule gating whether a key may follow a URL) ------
  ok(sameOrigin('https://h/v1', 'https://h/v1beta'), 'same host, different path → same origin')
  ok(!sameOrigin('https://h/v1', 'https://other/v1'), 'different host → different origin')
  ok(!sameOrigin('https://h/v1', 'http://h/v1'), 'protocol change counts as different')
  ok(!sameOrigin('https://h/v1', 'https://h:8443/v1'), 'port change counts as different')
  // Fails CLOSED: an unparseable URL must read as different, so the fallout is
  // "ask for the key again" rather than "send it to something we couldn't parse".
  ok(!sameOrigin('not a url', 'not a url'), 'unparseable input reads as a different origin')

  // --- scrubSecret ---------------------------------------------------------
  ok(scrubSecret('boom sk-abc123 boom', 'sk-abc123') === 'boom *** boom', 'the secret is blanked')
  ok(
    !scrubSecret('a sk-k b sk-k c', 'sk-k').includes('sk-k'),
    'every occurrence is blanked, not just the first'
  )
  ok(scrubSecret('nothing to do', 'sk-k') === 'nothing to do', 'untouched when absent')
  ok(scrubSecret('keep me', null) === 'keep me', 'a null secret is a no-op (the ChatGPT seat)')
  ok(scrubSecret('keep me', '') === 'keep me', 'an empty secret is a no-op')

  // --- a malformed entry can't reach the picker ----------------------------
  // `choices()` iterates `models`; a string there would be walked CHARACTER by
  // character, so the shape has to be rejected at the read boundary.
  const junkBase = mkdtempSync(join(tmpdir(), 'trezi-providers-junk-'))
  try {
    writeFileSync(
      join(junkBase, 'providers.json'),
      JSON.stringify({
        version: 1,
        connections: [
          {
            id: 'strmodels',
            label: 'X',
            preset: 'custom',
            baseUrl: 'https://x/v1',
            models: 'gpt-5'
          },
          { id: 'nolabel', preset: 'custom', baseUrl: 'https://x/v1', models: [] },
          { id: 'good', label: 'OK', preset: 'custom', baseUrl: 'https://x/v1', models: ['gpt-5'] }
        ]
      }),
      'utf8'
    )
    const kept = createProviderStore(junkBase).list()
    ok(
      kept.length === 1 && kept[0].id === 'good',
      'entries with a bad models/label shape are dropped'
    )
  } finally {
    rmSync(junkBase, { recursive: true, force: true })
  }

  if (failed === 0) {
    console.log(
      'PROVIDERS-STORE OK — owner-file reads, no secret leaks, Jev key picking, corrupt/junk/oversized files degrade, sameOrigin, scrubSecret, modelsUrl, parseModelCatalog'
    )
  } else {
    process.exitCode = 1
  }
} catch (err) {
  console.error('PROVIDERS-STORE FAILED:', err?.stack ?? err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
