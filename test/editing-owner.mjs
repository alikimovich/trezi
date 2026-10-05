// S12 editing coordinator: the real Swift EditingOwner (compiled into a fixture process
// with the conversation, repository and source owners it works with), driven through
// Bun's real client and the unchanged TS island/controls modules.
// - parity: one scripted session (definitions, same-turn replacement, activation by the
//   defining turn only, a late terminal, a composition cut short, command admission,
//   the revision chain of a reordered batch, Undo/Reset, restart normalization,
//   navigation, sidecar commits, project files) gives the answers and island history
//   bytes recorded from the Bun twin before LKM-111 removed it
//   (test/fixtures/editing-owner/parity-golden.json; LKM-114 dropped its content-draft
//   entries with the feature);
// - turns: the conversation coordinator is the authority for an island's origin and a
//   navigation's turn;
// - sidecars (stale bytes, symlinks, lanes), crash (SIGKILL inside an island write),
//   drain, schema. The island, controls and notes suites run on the Swift owners
//   themselves (with-service-owners.mjs).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash } from '../src/main/source-owner.ts'
import { NavigationController } from '../src/native/navigation-controller.ts'
import { TurnBoundaries } from '../src/native/turn-boundaries.ts'
import { compileEditingFixture, startEditingFixture } from './helpers/editing-fixture.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-editing-owner-')))
const binary = compileEditingFixture()
const dir = (...parts) => {
  const path = join(scratch, ...parts)
  mkdirSync(path, { recursive: true })
  return path
}
const hex = (seed) => contentHash(String(seed))
const def = (title) => ({
  manifest: {
    file: 'shadow.js',
    component: 'Card',
    title,
    params: [
      { id: 'x', label: 'x', kind: 'number', apply: { strategy: 'literal', anchor: 'const X = ' } }
    ]
  },
  blocks: [{ id: 'main', title, kind: 'group', params: ['x'] }]
})
const fixtures = []
const began = Date.now()
const log = console.log
console.log = (...args) => log(`[${((Date.now() - began) / 1000).toFixed(1)}s]`, ...args)
/** Where `EditingIslands` keeps a chat record's island history. */
const islandFile = (directory, root, record) =>
  join(directory, `${createHash('sha256').update(`${root}\0${record}`).digest('hex')}.json`)
const start = async (profile, env) => {
  const fixture = await startEditingFixture(binary, profile, env)
  fixtures.push(fixture)
  return fixture
}

/** The scripted session. Random ids/tokens are mapped to stable names before comparing. */
async function script(owner, root, profile) {
  const out = [],
    ids = new Map()
  const norm = (value) =>
    JSON.parse(
      JSON.stringify(value ?? null, (_, v) =>
        typeof v === 'string' && ids.has(v) ? ids.get(v) : v
      )
    )
  const note = (label, value) => out.push([label, norm(value)])
  const bare = ({ token, ticket, ...rest }) => rest
  const rejects = async (label, promise) => {
    try {
      await promise
      out.push([label, 'resolved'])
    } catch (error) {
      out.push([label, error.code, error.message])
    }
  }
  note('open', await owner.islandsOpen('A', root, 'rec-1'))
  const a = await owner.islandDefine('A', 1, 'T1')
  ids.set(a.id, 'id1')
  note('define', bare(a))
  await rejects('busy define', owner.islandDefine('A', 1, 'T1'))
  await rejects('busy command', owner.islandCommand('A', a.id, 1, 'commit', hex(0)))
  note('commit', await owner.islandCommit('A', a.token, def('one'), 'agent', { x: 0 }))
  const b = await owner.islandDefine('A', 1, 'T1', a.id, 1)
  note('replace (same turn: same id, next revision)', bare(b))
  note(
    'commit replacement',
    await owner.islandCommit('A', b.token, def('two'), 'jev', { x: 0.5 }, 'fallback note')
  )
  await rejects('stale definition revision', owner.islandDefine('A', 1, 'T1', a.id, 1))
  await rejects('not landed', owner.islandCommand('A', a.id, 2, 'commit', hex(0)))
  note('another turn’s late terminal activates nothing', await owner.islandSettle('A', 'T0', true))
  note('its own turn lands', await owner.islandSettle('A', 'T1', true))
  // A queued batch: each command is computed against the batch's own last write.
  const c1 = await owner.islandCommand('A', a.id, 2, 'commit', hex(0))
  note('c1', bare(c1))
  await rejects('one command at a time', owner.islandCommand('A', a.id, 2, 'commit', hex(0)))
  await owner.islandFinish('A', c1.ticket, { ok: true, group: 'g1', revision: hex(1) }, false)
  const c2 = await owner.islandCommand('A', a.id, 2, 'commit', hex(0))
  note('c2 (reordered frame)', bare(c2))
  await owner.islandFinish('A', c2.ticket, { ok: true, group: 'g1', revision: hex(2) }, false)
  const c3 = await owner.islandCommand('A', a.id, 2, 'commit', hex(1))
  note('c3', bare(c3))
  await owner.islandFinish('A', c3.ticket, { ok: false }, true)
  const c4 = await owner.islandCommand('A', a.id, 2, 'commit', hex(0))
  note('c4 (batch over: external bytes not blessed)', bare(c4))
  await owner.islandFinish('A', c4.ticket, { ok: true }, true)
  const u = await owner.islandCommand('A', a.id, 2, 'undo', hex(2))
  note('undo group', bare(u))
  await owner.islandFinish('A', u.ticket, { ok: true }, true)
  await rejects('undo twice', owner.islandCommand('A', a.id, 2, 'undo', hex(2)))
  const r = await owner.islandCommand('A', a.id, 2, 'reset', hex(2))
  note('reset initial', bare(r))
  await rejects('wrong ticket', owner.islandFinish('A', 'not-a-ticket', { ok: true }, true))
  await owner.islandFinish('A', r.ticket, { ok: true, group: 'g2', revision: hex(3) }, true)
  note('reload', bare(await owner.islandCommand('A', a.id, 2, 'reload', hex(9))))
  await rejects('stale island revision', owner.islandCommand('A', a.id, 1, 'commit', hex(3)))
  // A later turn: its own island; a failed terminal of that turn, and a composition cut short.
  const d = await owner.islandDefine('A', 2, 'T2', a.id, 2)
  ids.set(d.id, 'id2')
  note('later turn gets a fresh island', bare(d))
  note('commit later', await owner.islandCommit('A', d.token, def('three'), 'agent', {}))
  const e = await owner.islandDefine('A', 2, 'T2')
  ids.set(e.id, 'id3')
  note('stopped turn', await owner.islandSettle('A', 'T2', false))
  await rejects(
    'commit after its turn ended',
    owner.islandCommit('A', e.token, def('four'), 'agent', {})
  )
  note('duplicate success does not revive', await owner.islandSettle('A', 'T2', true))
  // No origin (a legacy record): any terminal of the chat settles it.
  const f = await owner.islandDefine('A', 3, null)
  ids.set(f.id, 'id4')
  await owner.islandCommit('A', f.token, def('five'), 'agent', {})
  note('origin-less', await owner.islandSettle('A', 'T9', true))
  note('another chat on the same history sees it', await owner.islandsOpen('B', root, 'rec-1'))
  const g = await owner.islandDefine('A', 4, 'T4')
  ids.set(g.id, 'id5')
  await owner.islandCommit('A', g.token, def('six'), 'agent', {})
  note('B follows A’s write', await owner.islands('B'))
  await owner.islandsClose('A')
  await owner.islandsClose('B')
  note('reopen: waiting lost its turn', await owner.islandsOpen('C', root, 'rec-1'))
  await rejects('closed chat', owner.islandCommand('A', a.id, 2, 'commit', hex(3)))
  const file = readFileSync(islandFile(join(profile, 'chat-islands'), root, 'rec-1'), 'utf8')
  out.push([
    'history bytes',
    [...ids].reduce((text, [id, name]) => text.replaceAll(id, name), file)
  ])

  // Deferred navigation
  note('nav awaits its turn', await owner.navigate('N', root, '/work/a?view=full#x', 'T1'))
  note('another turn lands', await owner.navigation('N', 'landed', 'T0'))
  note('take while awaiting', await owner.navigationTake('N'))
  note('state', await owner.navigationState())
  note('its turn lands', await owner.navigation('N', 'landed', 'T1'))
  note('take', await owner.navigationTake('N'))
  note('taken once', await owner.navigationTake('N'))
  note('failed turn drops', [
    await owner.navigate('N', root, '/b', 'T2'),
    await owner.navigation('N', 'failed', 'T2'),
    await owner.navigationTake('N')
  ])
  note('newer turn drops', [
    await owner.navigate('N', root, '/c', 'T3'),
    await owner.navigation('N', 'begin', 'T3'),
    await owner.navigation('N', 'begin', 'T4'),
    await owner.navigationState()
  ])
  note('idle request opens now', [
    await owner.navigate('N', root, '/d', null),
    await owner.navigation('N', 'close', null),
    await owner.navigationTake('N')
  ])
  for (const path of ['//evil.test/', 'https://x.test/', '/a b', '/a\\b', 'relative'])
    await rejects(`bad path ${path}`, owner.navigate('N', root, path, null))
  return out
}

/** Sidecar commits on `root`. */
async function sidecars(owner, root) {
  const out = []
  const attempt = async (label, promise) => {
    try {
      out.push([label, await promise])
    } catch (error) {
      out.push([label, error.code])
    }
  }
  const file = join(root, '.trezi', 'control-panels.json')
  await attempt('create', owner.sidecar(root, 'control-panels.json', null, '{"version":1}\n'))
  await attempt('create again is stale', owner.sidecar(root, 'control-panels.json', null, '{}\n'))
  await attempt(
    'bound update',
    owner.sidecar(
      root,
      'control-panels.json',
      contentHash('{"version":1}\n'),
      '{"version":1,"panels":[]}\n'
    )
  )
  writeFileSync(file, '{"hand":"edit"}\n')
  await attempt(
    'hand edit refused',
    owner.sidecar(root, 'control-panels.json', contentHash('{"version":1,"panels":[]}\n'), '{}\n')
  )
  out.push(['hand edit kept', readFileSync(file, 'utf8')])
  await attempt('not a sidecar', owner.sidecar(root, 'settings.json', null, '{}'))
  // S15: the notes and starter tokens sidecars commit the same way.
  await attempt('notes create', owner.sidecar(root, 'annotations.json', null, '[]\n'))
  await attempt(
    'notes bound update',
    owner.sidecar(root, 'annotations.json', contentHash('[]\n'), '[{"id":"a1","text":"x"}]\n')
  )
  await attempt('notes stale', owner.sidecar(root, 'annotations.json', contentHash('[]\n'), '[]\n'))
  await attempt('tokens create-only', owner.sidecar(root, 'tokens.json', null, '{}\n'))
  await attempt('tokens exists', owner.sidecar(root, 'tokens.json', null, '{"x":1}\n'))
  out.push(['notes kept', readFileSync(join(root, '.trezi', 'annotations.json'), 'utf8')])
  rmSync(file)
  symlinkSync(join(scratch, 'outside.json'), file)
  await attempt('symlinked file', owner.sidecar(root, 'control-panels.json', null, '{}'))
  rmSync(join(root, '.trezi'), { recursive: true })
  symlinkSync(dir('outside-trezi'), join(root, '.trezi'))
  await attempt('symlinked folder', owner.sidecar(root, 'annotations.json', null, '{}'))
  rmSync(join(root, '.trezi'))
  await attempt(
    'oversized',
    owner.sidecar(root, 'annotations.json', null, 'x'.repeat(1024 * 1024 + 1))
  )
  return out
}

/** The other `.trezi/` files (S15): migration, setup helpers, dependency marker. */
async function project(owner, base) {
  const out = []
  const attempt = async (label, promise) => {
    try {
      out.push([label, await promise])
    } catch (error) {
      out.push([label, error.code ?? String(error)])
    }
  }
  const tree = (path) =>
    existsSync(path)
      ? readdirSync(path)
          .sort()
          .map((name) => [
            name,
            lstatSync(join(path, name)).isFile() ? readFileSync(join(path, name), 'utf8') : 'dir'
          ])
      : null
  const put = (path, text) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  // Migration: .praxis copies over, .dsgn's known files move, a differing file collides, existing wins.
  const live = join(base, 'live')
  put(join(live, '.praxis', 'notes.json'), 'praxis-notes')
  put(join(live, '.praxis', 'nested', 'deep.json'), 'deep')
  put(join(live, '.praxis', 'tokens.json'), 'praxis-tokens')
  put(join(live, '.dsgn', 'annotations.json'), 'dsgn-notes')
  put(join(live, '.dsgn', 'tokens.json'), 'dsgn-tokens')
  put(join(live, '.dsgn', 'other.json'), 'stays')
  await attempt('migrate', owner.migrateSidecar(live))
  out.push([
    'migrated',
    tree(join(live, '.trezi')),
    tree(join(live, '.dsgn')),
    tree(join(live, '.praxis'))
  ])
  await attempt('migrate again', owner.migrateSidecar(live))
  put(join(live, '.praxis', 'notes.json'), 'praxis-notes-changed')
  await attempt('migrate collision', owner.migrateSidecar(live))
  const linked = join(base, 'linked')
  mkdirSync(linked, { recursive: true })
  symlinkSync(dir('outside-migrate'), join(linked, '.trezi'))
  put(join(linked, '.dsgn', 'tokens.json'), 'x')
  await attempt('migrate linked .trezi', owner.migrateSidecar(linked))
  // Setup helpers: copied and hashed, a vanished helper is removed, a linked folder refused.
  const tree2 = join(base, 'worktree')
  mkdirSync(tree2, { recursive: true })
  put(join(live, '.trezi', 'trezi-source.cjs'), 'source')
  put(join(live, '.trezi', 'trezi-next.cjs'), 'next')
  put(join(live, '.praxis', 'praxis-mdx.mjs'), 'mdx')
  put(join(tree2, '.trezi', 'trezi-mdx.mjs'), 'stale')
  await attempt('sync helpers', owner.syncSetupHelpers(live, tree2))
  out.push(['helpers', tree(join(tree2, '.trezi')), tree(join(tree2, '.praxis'))])
  rmSync(join(live, '.trezi', 'trezi-next.cjs'))
  await attempt('sync again', owner.syncSetupHelpers(live, tree2))
  out.push(['helpers after removal', tree(join(tree2, '.trezi'))])
  const bad = join(base, 'bad-worktree')
  mkdirSync(bad, { recursive: true })
  symlinkSync(dir('outside-sync'), join(bad, '.trezi'))
  await attempt('sync linked target', owner.syncSetupHelpers(live, bad))
  // Dependency marker: link removed then install, marker recorded, unchanged manifests skip.
  const app = join(base, 'app'),
    checkout = join(base, 'checkout')
  put(join(app, 'node_modules', 'x.txt'), 'x')
  put(join(checkout, 'package.json'), '{"name":"a"}')
  symlinkSync(join(app, 'node_modules'), join(checkout, 'node_modules'))
  await attempt('needs install (link)', owner.dependencyState(app, checkout))
  out.push(['link removed', existsSync(join(checkout, 'node_modules'))])
  mkdirSync(join(checkout, 'node_modules'))
  await attempt('needs install (no marker)', owner.dependencyState(app, checkout))
  await attempt('mark', owner.markDependencies(app, checkout))
  out.push(['marker', readFileSync(join(checkout, '.trezi', 'dependencies.sha256'), 'utf8')])
  await attempt('skip when marked', owner.dependencyState(app, checkout))
  writeFileSync(join(checkout, 'package.json'), '{"name":"b"}')
  await attempt('install after manifest change', owner.dependencyState(app, checkout))
  rmSync(join(app, 'node_modules'), { recursive: true })
  mkdirSync(join(base, 'fresh'))
  await attempt('no live dependencies', owner.dependencyState(app, join(base, 'fresh')))
  return out
}

try {
  // ── parity ──────────────────────────────────────────────────────────────
  {
    const golden = JSON.parse(
      readFileSync(join(repo, 'test/fixtures/editing-owner/parity-golden.json'), 'utf8')
    )
    const replace = (value, from, to) => JSON.parse(JSON.stringify(value).replaceAll(from, to))
    const swiftProfile = dir('parity-swift'),
      root = dir('parity-project')
    const fixture = await start(swiftProfile)
    const { editing } = fixture.owners()
    assert.equal(editing.kind, 'swift')
    const swift = replace(await script(editing, root, swiftProfile), root, '<root>')
    for (let i = 0; i < Math.max(golden.script.length, swift.length); i++)
      assert.deepEqual(swift[i], golden.script[i], `step ${golden.script[i]?.[0] ?? swift[i]?.[0]}`)
    const swiftSide = await sidecars(editing, dir('sidecar-swift'))
    assert.deepEqual(swiftSide, golden.sidecars)
    assert.deepEqual(swiftSide.map(([label, value]) => [label, value?.ok ?? value]).slice(0, 5), [
      ['create', true],
      ['create again is stale', false],
      ['bound update', true],
      ['hand edit refused', false],
      ['hand edit kept', '{"hand":"edit"}\n']
    ])
    assert.deepEqual(
      swiftSide.slice(5).map(([label, value]) => [label, value?.ok ?? value]),
      [
        ['not a sidecar', 'invalidRequest'],
        ['notes create', true],
        ['notes bound update', true],
        ['notes stale', false],
        ['tokens create-only', true],
        ['tokens exists', false],
        ['notes kept', '[{"id":"a1","text":"x"}]\n'],
        ['symlinked file', 'unauthorized'],
        ['symlinked folder', 'unauthorized'],
        ['oversized', 'invalidRequest']
      ]
    )
    const swiftBase = dir('project-swift')
    const swiftProject = await project(editing, swiftBase)
    const relative = (steps, base) => replace(steps, base, '<base>')
    assert.deepEqual(
      relative(swiftProject, swiftBase),
      golden.project,
      'project files: as recorded'
    )
    const answer = (label) => relative(swiftProject, swiftBase).find((step) => step[0] === label)[1]
    assert.deepEqual([answer('migrate'), answer('migrate again')], [[], []])
    assert.deepEqual(answer('migrate collision'), ['<base>/live/.praxis/notes.json'])
    assert.deepEqual(
      [answer('migrate linked .trezi'), answer('sync linked target')],
      ['invalidRequest', 'invalidRequest']
    )
    assert.deepEqual(
      [
        answer('needs install (link)'),
        answer('needs install (no marker)'),
        answer('skip when marked'),
        answer('install after manifest change'),
        answer('no live dependencies')
      ],
      [true, true, false, true, false]
    )
    console.log(
      `parity: ${swift.length} island/navigation/draft steps and ${swiftSide.length} sidecar steps match the recorded golden`
    )
    await fixture.stop()
  }

  // ── turns: the conversation coordinator decides an island's origin ─────
  {
    const profile = dir('turns'),
      root = dir('turns-project')
    const fixture = await start(profile)
    const { editing, conversation } = fixture.owners()
    const record = (id) => ({ id, projectKey: 'project', projectRoot: root, transcript: [] })
    await conversation.open('live', 'project', record('rec-live'), {}, true)
    await editing.islandsOpen('live', root, 'rec-live')
    await assert.rejects(
      editing.islandDefine('live', 1, 'T1'),
      /turn has finished/,
      'A definition claiming a turn the chat is not in'
    )
    const outside = await editing.islandDefine('live', 1, null)
    await editing.islandAbort('live', outside.token)
    await conversation.begin('live', 'T1')
    await assert.rejects(
      editing.islandDefine('live', 1, 'T0'),
      /turn has finished/,
      'A stale attribution is refused'
    )
    const admitted = await editing.islandDefine('live', 1, null)
    const [created] = await editing.islandCommit('live', admitted.token, def('turn'), 'agent', {})
    assert.equal(created.origin, 'T1', 'The owner binds the definition to the turn in flight')
    assert.equal((await editing.islandSettle('live', 'T0', true)).records[0].status, 'waiting')
    assert.equal(
      await editing.navigate('live', root, '/next', null),
      false,
      'Navigation waits for the turn in flight'
    )
    assert.deepEqual(
      (await editing.navigationState()).map((r) => [r.chat, r.turn, r.awaiting]),
      [['live', 'T1', true]]
    )
    assert.equal((await editing.islandSettle('live', 'T1', true)).records[0].status, 'ready')
    assert.equal(await editing.navigation('live', 'landed', 'T1'), true)
    // The Bun side: only the chat and project that asked, only once its server runs.
    const loads = []
    let active = { root, chat: 'live', url: null }
    const controller = new NavigationController(
      editing,
      { active: () => active, load: async (url) => loads.push(url) },
      () => null
    )
    await controller.boundary('live', 'landed', 'T1')
    assert.deepEqual(loads, [], 'Held until the server runs')
    active = { ...active, url: 'http://127.0.0.1:5173/old/page' }
    await controller.open()
    assert.deepEqual(loads, ['http://127.0.0.1:5173/next'])
    await controller.request({ root, key: 'other-chat', path: '/never' })
    assert.deepEqual(await editing.navigationState(), [], 'Never followed into another chat')
    await controller.request({ root, key: 'live', path: '/switch' })
    active = { root, chat: 'second', url: 'http://127.0.0.1:5173/' }
    await controller.open()
    assert.equal(loads.length, 1, 'Leaving the chat drops its request')
    await fixture.stop()
    // Bun's attribution of provider events to turn boundaries (the events reordered).
    const boundaries = new TurnBoundaries()
    const seen = (events) =>
      events.flatMap((event) => boundaries.events('k', event).map((b) => `${b.kind}:${b.turn}`))
    assert.deepEqual(
      seen([
        { type: 'delta', text: 'a', turn: 'T1' },
        { type: 'done', turn: 'T1', landingPending: true },
        { type: 'delta', text: 'b', turn: 'T2' },
        { type: 'isolation', state: 'merged' }
      ]),
      ['begin:T1', 'begin:T2', 'landed:T1'],
      'A landing that finishes after the next turn began is still the earlier turn’s'
    )
    assert.deepEqual(
      seen([
        { type: 'done', stale: true, landingPending: false },
        { type: 'error', message: 'x', turn: 'T2' },
        { type: 'done', turn: 'T2', landingPending: false }
      ]),
      ['failed:T2', 'landed:T2']
    )
    assert.deepEqual(
      seen([
        { type: 'done', turn: 'T3', landingPending: true },
        { type: 'isolation', state: 'parked' }
      ]),
      ['begin:T3', 'failed:T3']
    )
    console.log(
      'turns: origin and navigation bound to the conversation owner’s turn; loads only in the asking chat'
    )
  }

  // ── dependencies: a worktree owns a copy-on-write clone of live node_modules (LKM-146) ──
  {
    const fixture = await start(dir('deps'))
    const { editing } = fixture.owners()
    const git = (cwd, ...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout
    }
    const project = (name, ignore) => {
      const live = dir(name, 'live')
      git(live, 'init', '-q')
      if (ignore) writeFileSync(join(live, '.gitignore'), ignore)
      writeFileSync(join(live, 'package.json'), '{"dependencies":{"a":"1"}}')
      mkdirSync(join(live, 'node_modules', 'a', 'lib'), { recursive: true })
      writeFileSync(join(live, 'node_modules', 'a', 'lib', 'index.js'), 'a1')
      symlinkSync('../a/lib/index.js', join(live, 'node_modules', 'a', 'bin.js'))
      const checkout = dir(name, 'checkout')
      writeFileSync(join(checkout, 'package.json'), '{"dependencies":{"a":"1"}}')
      return { live, checkout }
    }
    const listing = (path) => readdirSync(path, { recursive: true }).sort().join(',')
    const { live, checkout } = project('ignored', 'node_modules\n')
    // A worktree from before LKM-146 still links the live folder: the link goes, a clone replaces it.
    symlinkSync(join(live, 'node_modules'), join(checkout, 'node_modules'))
    const before = listing(join(live, 'node_modules'))
    assert.equal(await editing.dependencyState(live, checkout), false, 'A clone needs no install')
    assert.ok(
      lstatSync(join(checkout, 'node_modules')).isDirectory(),
      'The checkout owns a real folder'
    )
    assert.equal(listing(join(checkout, 'node_modules')), before, 'The clone has the live tree')
    assert.equal(
      readlinkSync(join(checkout, 'node_modules', 'a', 'bin.js')),
      '../a/lib/index.js',
      'Links inside are cloned, not followed'
    )
    assert.notEqual(
      statSync(join(checkout, 'node_modules', 'a', 'lib', 'index.js')).ino,
      statSync(join(live, 'node_modules', 'a', 'lib', 'index.js')).ino
    )
    assert.ok(existsSync(join(checkout, '.trezi', 'dependencies.sha256')), 'The clone is marked')
    // What an agent's add and remove do to the clone never reaches the live folder.
    writeFileSync(join(checkout, 'node_modules', 'a', 'lib', 'index.js'), 'a2')
    mkdirSync(join(checkout, 'node_modules', 'b'))
    rmSync(join(checkout, 'node_modules', 'a', 'bin.js'))
    assert.equal(listing(join(live, 'node_modules')), before, 'Live node_modules untouched')
    assert.equal(readFileSync(join(live, 'node_modules', 'a', 'lib', 'index.js'), 'utf8'), 'a1')
    assert.equal(
      await editing.dependencyState(live, checkout),
      false,
      'Unchanged manifests: still marked'
    )
    writeFileSync(join(checkout, 'package.json'), '{"dependencies":{"a":"1","b":"1"}}')
    assert.equal(
      await editing.dependencyState(live, checkout),
      true,
      'Changed manifests install into the checkout'
    )
    // Manifests that differ from live are not cloned: the checkout installs its own.
    const fresh = dir('ignored', 'fresh')
    writeFileSync(join(fresh, 'package.json'), '{"dependencies":{"c":"1"}}')
    assert.equal(await editing.dependencyState(live, fresh), true)
    assert.equal(existsSync(join(fresh, 'node_modules')), false)
    // A node_modules Git does not ignore is never copied (or linked) in.
    const tracked = project('unignored', '')
    assert.equal(await editing.dependencyState(tracked.live, tracked.checkout), false)
    assert.equal(existsSync(join(tracked.checkout, 'node_modules')), false)
    await fixture.stop()
    console.log(
      'dependencies: a clone replaces the live link; agent installs in it leave live node_modules alone'
    )
  }

  // ── lanes: a sidecar commit waits for another chain's lease, runs inside its own ──
  {
    const profile = dir('lanes'),
      root = dir('lanes-project')
    const fixture = await start(profile)
    const { editing, repository } = fixture.owners()
    let release
    const held = repository.withLease(
      root,
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5))
    let done = false
    const outside = editing
      .sidecar(root, 'control-panels.json', null, '{"a":1}\n')
      .then((value) => {
        done = true
        return value
      })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(done, false, 'Queued behind the held lease')
    release()
    await held
    assert.equal((await outside).ok, true)
    const inside = await repository.withLease(root, () =>
      editing.sidecar(root, 'control-panels.json', contentHash('{"a":1}\n'), '{"a":2}\n')
    )
    assert.equal(inside.ok, true, 'A chain holding the lease commits inside it')
    await fixture.stop()
    console.log('lanes: sidecar commits are ordered in the repository lane')
  }

  // ── crash: SIGKILL inside an island history write ─────────────────────
  {
    const profile = dir('crash'),
      root = dir('crash-project')
    let fixture = await start(profile)
    let editing = fixture.owners().editing
    await editing.islandsOpen('A', root, 'rec')
    const first = await editing.islandDefine('A', 1, 'T1')
    await editing.islandCommit('A', first.token, def('first'), 'agent', {})
    await editing.islandSettle('A', 'T1', true)
    await fixture.stop()
    const file = islandFile(join(profile, 'chat-islands'), root, 'rec')
    const before = readFileSync(file, 'utf8')
    for (const [point, expected] of [
      ['island.write', 1],
      ['island.written', 2]
    ]) {
      fixture = await start(profile, { EDITING_FAULT: point })
      // The commit below is never answered: a short deadline lets the test process end.
      editing = fixture.owners({ timeout: 1000 }).editing
      await editing.islandsOpen('A', root, 'rec')
      const next = await editing.islandDefine('A', 2, 'T2')
      editing.islandCommit('A', next.token, def('second'), 'agent', {}).catch(() => {})
      assert.equal((await fixture.exited).signal, 'SIGKILL')
      fixture = await start(profile)
      const records = await fixture.owners().editing.islandsOpen('A', root, 'rec')
      assert.equal(records.length, expected, `${point}: history is whole (${expected})`)
      assert.equal(records[0].status, 'ready')
      if (expected === 1)
        assert.equal(readFileSync(file, 'utf8'), before, 'Nothing torn before the rename')
      else
        assert.equal(
          records[1].status,
          'unavailable',
          'A definition whose turn never landed is unavailable after restart'
        )
      await fixture.stop()
    }
    console.log('crash: an island write killed midway leaves the previous history whole')
  }

  // ── drain and schema ─────────────────────────────────────────────────
  {
    const profile = dir('schema'),
      root = dir('schema-project')
    const fixture = await start(profile)
    const code = async (method, body, request, top) => {
      const result = await fixture.editingFrame(method, body, request, top)
      return result.kind === 'failed' ? result.payload.code : 'ok'
    }
    assert.equal(await code('islandsOpen', { chat: 'A', root, record: 'r' }), 'ok')
    assert.equal(await code('nope', {}), 'invalidRequest')
    assert.equal(
      await code('islandsOpen', { chat: 'A', root, record: 'r', extra: 1 }),
      'invalidRequest'
    )
    assert.equal(await code('islands', { chat: 'A' }, { mode: 'mutation' }), 'invalidRequest')
    assert.equal(
      await code('islandsOpen', { chat: 'A', root: 'relative', record: 'r' }),
      'invalidRequest'
    )
    assert.equal(await code('islandDefine', { chat: 'A', turn: -1 }), 'invalidRequest')
    assert.equal(await code('islandDefine', { chat: 'A', turn: 1.5 }), 'invalidRequest')
    assert.equal(
      await code('islandCommand', {
        chat: 'A',
        id: 'x',
        revision: 1,
        action: 'replay',
        sourceRevision: 's'
      }),
      'invalidRequest'
    )
    assert.equal(
      await code('islandCommit', {
        chat: 'A',
        token: 't',
        definition: { manifest: {}, blocks: [], code: 'x' },
        engine: 'agent',
        initial: {}
      }),
      'invalidRequest'
    )
    assert.equal(
      await code('islandCommit', {
        chat: 'A',
        token: 't',
        definition: { manifest: {}, blocks: [] },
        engine: 'eval',
        initial: {}
      }),
      'invalidRequest'
    )
    assert.equal(
      await code('sidecar', { root, name: '../x.json', expectedHash: null, content: '' }),
      'invalidRequest'
    )
    assert.equal(
      await code(
        'islands',
        { chat: 'A' },
        { expectedRevision: { epoch: 'e', counter: '1' }, mode: 'read' }
      ),
      'invalidRequest'
    )
    assert.equal(
      await code('islands', { chat: 'A' }, { scope: { project: 'p' }, mode: 'read' }),
      'unauthorized'
    )
    assert.equal((await fixture.cmd({ cmd: 'close' })).closed, true)
    assert.equal(
      await code('islands', { chat: 'A' }, { mode: 'read' }),
      'unavailable',
      'A drained owner refuses new requests'
    )
    await fixture.stop()
    console.log('schema and drain: malformed, unknown, scoped and post-drain requests refused')
  }
  console.log('EDITING-OWNER OK — parity, turns, dependencies, lanes, crash, drain and schema')
} finally {
  for (const fixture of fixtures) await fixture.kill().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
