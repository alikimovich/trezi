/**
 * Model-catalog unit test (pure — no Electron). This is the module that replaced
 * the hardcoded picker lists in providers.ts with what the harnesses actually
 * report, so what's under test is: can we read a REAL `codex debug models`
 * payload, do we refuse the entries the CLI hides, and does the cache degrade
 * quietly instead of taking the picker down with it.
 *
 * The codex fixtures are the real shape captured from
 * `codex debug models` (@openai/codex 0.146.0, 2026-08-07) — trimmed to the four
 * fields the parser reads, since each real entry also carries a multi-KB
 * `base_instructions` blob (the full payload is ~300KB). The Claude fixture is
 * the real `Query.supportedModels()` answer from the same day, including the
 * SDK's own `default` sentinel, which collides with trezi's.
 *
 * The clock, baseDir and persist callback are injected, so TTL expiry is tested
 * without sleeping and persistence without touching userData or the service: the
 * Swift provider owner writes the file (LKM-111), `ownerPersist` stands in for it.
 *
 * Run with: bun run test:model-catalog
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CATALOG_TTL_MS,
  createModelCatalog,
  parseClaudeModels,
  parseCodexModels
} from '../src/main/model-catalog.ts'

const base = mkdtempSync(join(tmpdir(), 'trezi-model-catalog-'))
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

// Stands in for the Swift provider owner, the only writer since LKM-111: it merges one
// backend's entry into the versioned file the Bun reader parses on the next launch.
const ownerPersist = (dir, now) => (backend, models) => {
  const file = join(dir, 'model-catalog.json')
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  if (!doc || typeof doc.entries !== 'object' || Array.isArray(doc.entries))
    doc = { version: 1, entries: {} }
  doc.entries[backend] = { at: now(), models }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(doc))
    return true
  } catch {
    return false
  }
}

// The eight entries `codex debug models` returns today, in emission order.
const CODEX_PAYLOAD = {
  models: [
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 1 },
    { slug: 'gpt-5.6-sol-wm', display_name: 'GPT-5.6-Sol-WM', visibility: 'hide', priority: 1 },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 2 },
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', priority: 3 },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 7 },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 16 },
    { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', priority: 23 },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      visibility: 'hide',
      priority: 43
    }
  ]
}

const CLAUDE_PAYLOAD = [
  { value: 'default', displayName: 'Default (recommended)', description: '' },
  { value: 'opus[1m]', displayName: 'Opus', description: '' },
  { value: 'claude-fable-5[1m]', displayName: 'Fable', description: '' },
  { value: 'sonnet', displayName: 'Sonnet', description: '' },
  { value: 'sonnet[1m]', displayName: 'Sonnet (1M context)', description: '' },
  { value: 'haiku', displayName: 'Haiku', description: '' }
]

try {
  // --- codex: the real payload -----------------------------------------------
  const codex = parseCodexModels(CODEX_PAYLOAD)
  ok(
    codex.map((m) => m.id).join(',') ===
      'gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini',
    `the six LISTED models survive, in priority order (got ${codex.map((m) => m.id).join(',')})`
  )
  ok(
    !codex.some((m) => m.id === 'gpt-5.6-sol-wm' || m.id === 'codex-auto-review'),
    'the two visibility:"hide" entries are dropped — the CLI itself will not offer them'
  )
  ok(codex[0].label === 'GPT-5.6-Sol', 'display_name becomes the picker label')
  ok(
    !codex.some((m) => m.id === 'gpt-5-codex' || m.id === 'gpt-5'),
    'the models the old hardcoded list advertised are simply not there any more'
  )

  // priority, not array position, decides the order.
  const shuffled = parseCodexModels({
    models: [
      { slug: 'late', display_name: 'Late', visibility: 'list', priority: 9 },
      { slug: 'first', display_name: 'First', visibility: 'list', priority: 1 }
    ]
  })
  ok(shuffled.map((m) => m.id).join(',') === 'first,late', 'entries sort by the CLI’s priority')
  const unranked = parseCodexModels({
    models: [
      { slug: 'none', display_name: 'None', visibility: 'list' },
      { slug: 'ranked', display_name: 'Ranked', visibility: 'list', priority: 40 }
    ]
  })
  ok(
    unranked.map((m) => m.id).join(',') === 'ranked,none',
    'an unranked entry sorts LAST, never ahead of a ranked flagship'
  )

  // --- codex: junk ------------------------------------------------------------
  ok(parseCodexModels(null).length === 0, 'null parses to an empty list, not a throw')
  ok(parseCodexModels('nonsense').length === 0, 'a non-object parses to empty')
  ok(parseCodexModels({}).length === 0, 'a payload with no `models` parses to empty')
  ok(parseCodexModels({ models: 'gpt-5.6' }).length === 0, 'a non-array `models` parses to empty')
  const malformed = parseCodexModels({
    models: [
      null,
      'gpt-5.6-sol',
      42,
      { display_name: 'No slug', visibility: 'list' },
      { slug: '', display_name: 'Empty slug', visibility: 'list' },
      { slug: '   ', visibility: 'list' },
      { slug: 'no-visibility', display_name: 'No visibility' },
      { slug: 'weird-visibility', visibility: 'maybe' },
      { slug: 'no-label', visibility: 'list' },
      { slug: 'dupe', display_name: 'One', visibility: 'list', priority: 1 },
      { slug: 'dupe', display_name: 'Two', visibility: 'list', priority: 2 },
      { slug: 'bad-priority', display_name: 'Bad', visibility: 'list', priority: 'high' }
    ]
  })
  ok(
    malformed.map((m) => m.id).join(',') === 'dupe,no-label,bad-priority',
    `only the well-formed listed entries survive (got ${malformed.map((m) => m.id).join(',')})`
  )
  ok(
    malformed.find((m) => m.id === 'no-label').label === 'no-label',
    'a missing display_name falls back to the slug rather than an empty picker row'
  )
  ok(
    malformed.find((m) => m.id === 'dupe').label === 'One',
    'a duplicate slug keeps the first entry'
  )
  ok(
    parseCodexModels({ models: [{ slug: 'x', visibility: 'list' }] })[0].id === 'x',
    'a bare-minimum entry (slug + visibility) is enough'
  )

  // --- claude -----------------------------------------------------------------
  const claude = parseClaudeModels(CLAUDE_PAYLOAD)
  ok(
    claude.map((m) => m.id).join(',') ===
      'default,opus[1m],claude-fable-5[1m],sonnet,sonnet[1m],haiku',
    'ModelInfo[] parses in the SDK’s own order (it is already ranked)'
  )
  ok(claude[1].label === 'Opus', 'displayName becomes the label')
  ok(
    claude[0].id === 'default',
    "the SDK's own 'default' sentinel is REPORTED here — providers.ts is what drops it, " +
      'so a future SDK that stops sending one changes nothing'
  )
  ok(
    parseClaudeModels({ models: CLAUDE_PAYLOAD }).length === 6,
    'a {models:[…]} wrapper is accepted'
  )
  ok(parseClaudeModels(undefined).length === 0, 'undefined parses to empty')
  ok(
    parseClaudeModels([null, 7, {}, { value: 3 }, { value: ' ' }, { value: 'ok' }])
      .map((m) => m.id)
      .join(',') === 'ok',
    'malformed ModelInfo entries are skipped individually'
  )
  ok(
    parseClaudeModels([{ value: 'ok' }])[0].label === 'ok',
    'a missing displayName falls back to the id'
  )

  // --- cache: hit, expiry, persistence ---------------------------------------
  let clock = 1_000_000
  const cacheDir = join(base, 'cache')
  const cache = createModelCatalog({
    baseDir: cacheDir,
    now: () => clock,
    persist: ownerPersist(cacheDir, () => clock)
  })

  ok(cache.get('codex') === null, 'a never-populated backend reads as null (not [])')
  ok(cache.isStale('codex') === true, 'a never-populated backend is stale — go discover')

  cache.set('codex', codex)
  ok(cache.get('codex').length === 6, 'a set list reads back')
  ok(cache.isStale('codex') === false, 'a freshly set list is not stale')
  ok(cache.get('claude') === null, 'the other backend is untouched')

  clock += CATALOG_TTL_MS - 1
  ok(cache.isStale('codex') === false, 'still fresh one tick inside the TTL')
  clock += 2
  ok(cache.isStale('codex') === true, 'stale one tick past the TTL')
  ok(
    cache.get('codex').length === 6,
    'a STALE list is still served — the picker must render now; the refresh happens behind it'
  )

  // A clock that jumped backwards (NTP/DST correction, or a cache file copied
  // from another machine) must not pin an entry as fresh forever.
  clock = 0
  ok(cache.isStale('codex') === true, 'a negative age reads as stale, not eternally fresh')
  clock = 1_000_000

  // An empty list is a FAILED probe, and must never overwrite a good answer.
  cache.set('codex', [])
  ok(cache.get('codex').length === 6, 'setting [] does not clobber the cached list')
  ok(cache.get('claude') === null, 'setting [] on an empty backend stores nothing')

  // Persistence: a second catalog over the same dir sees the first one's writes,
  // which is what makes a fresh launch show real models before any session exists.
  const reopened = createModelCatalog({
    baseDir: cacheDir,
    now: () => clock,
    persist: ownerPersist(cacheDir, () => clock)
  })
  ok(
    reopened
      .get('codex')
      ?.map((m) => m.id)
      .join(',') === 'gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini',
    'the list survives to a new process'
  )
  ok(reopened.isStale('codex') === false, 'and its age survives with it')
  const onDisk = JSON.parse(readFileSync(join(cacheDir, 'model-catalog.json'), 'utf8'))
  ok(onDisk.version === 1 && !!onDisk.entries.codex, 'the on-disk shape is versioned')

  // --- cache: corrupt / hostile files ----------------------------------------
  const corruptCases = [
    ['not json at all', '{ models: '],
    ['a JSON non-object', '"hello"'],
    ['no entries key', '{"version":1}'],
    ['entries of the wrong type', '{"version":1,"entries":[]}'],
    [
      'an entry with no timestamp',
      '{"version":1,"entries":{"codex":{"models":[{"id":"a","label":"A"}]}}}'
    ],
    [
      'a models field that is a string',
      '{"version":1,"entries":{"codex":{"at":1,"models":"gpt-5"}}}'
    ],
    [
      'model entries of the wrong shape',
      '{"version":1,"entries":{"codex":{"at":1,"models":["gpt-5"]}}}'
    ],
    ['an empty model list', '{"version":1,"entries":{"codex":{"at":1,"models":[]}}}']
  ]
  for (const [what, body] of corruptCases) {
    const dir = mkdtempSync(join(base, 'corrupt-'))
    writeFileSync(join(dir, 'model-catalog.json'), body, 'utf8')
    const c = createModelCatalog({
      baseDir: dir,
      now: () => clock,
      persist: ownerPersist(dir, () => clock)
    })
    ok(c.get('codex') === null, `${what}: degrades to empty`)
    ok(c.isStale('codex') === true, `${what}: reads as stale, so discovery reruns`)
    // …and it is recoverable: the next successful probe simply overwrites it.
    c.set('codex', codex)
    ok(c.get('codex').length === 6, `${what}: a later discovery repairs the file`)
  }

  // One mangled half must not cost the other its cache.
  const halfDir = mkdtempSync(join(base, 'half-'))
  writeFileSync(
    join(halfDir, 'model-catalog.json'),
    JSON.stringify({
      version: 1,
      entries: {
        codex: { at: clock, models: 'nope' },
        claude: { at: clock, models: [{ id: 'sonnet', label: 'Sonnet' }] }
      }
    }),
    'utf8'
  )
  const half = createModelCatalog({
    baseDir: halfDir,
    now: () => clock,
    persist: ownerPersist(halfDir, () => clock)
  })
  ok(half.get('codex') === null, 'the mangled backend reads as absent')
  ok(half.get('claude')?.[0]?.id === 'sonnet', 'the intact backend is unaffected')

  // An unwritable baseDir costs persistence, never correctness.
  const blocked = createModelCatalog({
    baseDir: join(base, 'file-not-a-dir'),
    now: () => clock,
    persist: ownerPersist(join(base, 'file-not-a-dir'), () => clock)
  })
  writeFileSync(join(base, 'file-not-a-dir'), 'x', 'utf8')
  blocked.set('codex', codex)
  ok(blocked.get('codex').length === 6, 'a failed write still serves the in-memory list')

  if (failed === 0) {
    console.log(
      'MODEL-CATALOG OK — real codex payload parsed (hide/list filtered, priority-ordered), ' +
        'malformed entries skipped, ModelInfo parsed, TTL hit/expiry on an injected clock, ' +
        'persistence across processes, corrupt/hostile cache files degrade to empty and self-heal'
    )
  } else {
    process.exitCode = 1
  }
} catch (err) {
  console.error('MODEL-CATALOG FAILED:', err?.stack ?? err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
