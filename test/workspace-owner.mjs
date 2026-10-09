// S04 workspace: the Swift owner (real WorkspaceOwner + OperationLedger compiled into
// a fixture process), the only writer since LKM-111, on real files. Current/old
// profile fixtures against the retired Bun writer's recorded answers, canonical-root
// identity, concurrent updates, unknown/corrupt data, injected write failures, SIGKILL
// at every durable boundary, service restart, offline edits and Bun's client +
// controller.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { NativeWorkspaceController } from '../src/native/workspace-controller.ts'
import { serviceWorkspace } from '../src/native/workspace-service.ts'
import { skipUnlessDarwin } from './helpers/darwin.mjs'
import { swiftBuild } from './helpers/swift-build.mjs'
import { WORKSPACE_FIXTURE } from './helpers/workspace-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'trezi-workspace-owner-'))
const binary = join(scratch, 'workspace-fixture')
const NOW = 1790000000000
const live = new Set()
let cases = 0

function compile() {
  skipUnlessDarwin('the Swift workspace owner')
  swiftBuild('workspace-owner', WORKSPACE_FIXTURE, { out: binary })
}

function profile(initial) {
  const dir = join(scratch, `case-${++cases}`)
  mkdirSync(dir)
  if (initial !== undefined) writeFileSync(join(dir, 'workspace.json'), initial)
  return dir
}
const file = (dir) => join(dir, 'workspace.json')
const bytes = (dir) => (existsSync(file(dir)) ? readFileSync(file(dir)) : null)
const folder = (name) => {
  const dir = join(scratch, 'projects', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function start(dir, env = {}) {
  const child = spawn(binary, [dir], {
    env: { ...process.env, WORKSPACE_NOW: String(NOW), ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  live.add(child)
  const lines = [],
    events = [],
    waiters = []
  let stderr = '',
    status = null
  child.stderr.on('data', (data) => {
    stderr += data
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const value = JSON.parse(line)
    ;(value.event === 'service-event' ? events : lines).push(value)
    for (const wake of waiters.splice(0)) wake()
  })
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      live.delete(child)
      status = { code, signal }
      resolve(status)
      for (const wake of waiters.splice(0)) wake()
    })
  )
  const connection = randomUUID()
  let id = 0
  const fixture = {
    events,
    async next() {
      const deadline = Date.now() + 20_000
      while (!lines.length) {
        assert.ok(!status, `fixture exited ${JSON.stringify(status)}\n${stderr}`)
        assert.ok(Date.now() < deadline, `fixture timed out\n${stderr}`)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 50)
          waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      return lines.shift()
    },
    raw(line) {
      child.stdin.write(`${line}\n`)
      return this.next()
    },
    frame(method, body = {}, expectedRevision, operationID = randomUUID()) {
      return {
        service: 'workspace',
        id: ++id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID,
          scope: {},
          mode: method === 'snapshot' ? 'read' : 'mutation',
          ...(expectedRevision ? { expectedRevision } : {}),
          service: 'workspace',
          method,
          body
        }
      }
    },
    send(frame) {
      return this.raw(JSON.stringify(frame))
    },
    snapshot() {
      return this.send(this.frame('snapshot'))
    },
    op(method, body, revision, operationID) {
      return this.send(this.frame(method, body, revision, operationID))
    },
    async crash(frame) {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
      const result = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 20_000))
      ])
      assert.equal(
        result?.signal,
        'SIGKILL',
        `expected an injected SIGKILL, got ${JSON.stringify(result)}\n${stderr}`
      )
      assert.equal(lines.length, 0, 'no reply escaped before the crash')
    },
    async close() {
      child.stdin.end()
      assert.equal((await exited).code, 0, stderr)
    }
  }
  const ready = await fixture.next()
  assert.equal(ready.ready, true, stderr)
  fixture.ledger = ready.ledger
  return fixture
}

const ok = (reply) => {
  assert.equal(reply.reply.result.kind, 'succeeded', JSON.stringify(reply))
  return reply.reply.result.payload
}
const code = (reply) => {
  assert.equal(reply.reply.result.kind, 'failed', JSON.stringify(reply))
  return reply.reply.result.payload.code
}
const keys = (view) => view.projects.map((p) => p.key)
/** The retired Bun writer's answers for the parity profiles, recorded with `<scratch>` for this run's folder. */
const golden = () =>
  JSON.parse(
    readFileSync(join(root, 'test/fixtures/workspace-owner/golden.json'), 'utf8').replaceAll(
      '<scratch>',
      scratch
    )
  )

try {
  compile()
  const alpha = folder('alpha'),
    beta = folder('beta'),
    gamma = folder('gamma')
  const alias = join(scratch, 'alias-to-alpha')
  symlinkSync(alpha, alias)

  // --- Legacy/current profile fixtures: reader and every operation match Bun byte for byte ---
  {
    const current = JSON.stringify({
      projects: [
        {
          root: alpha,
          key: alpha,
          name: 'alpha',
          url: 'http://127.0.0.1:5173',
          previewKind: 'web',
          branch: 'trezi/x',
          launchSpec: {
            root: alpha,
            command: 'bun run dev',
            framework: 'vite',
            previewKind: 'web'
          },
          touchedAt: 1789999999999,
          sessionKeys: [alpha, `${alpha}#2`],
          activeSessionKey: `${alpha}#2`,
          chatSettings: { [alpha]: { provider: 'claude', model: 'default' } },
          viewport: 'mobile'
        },
        {
          root: beta + '/',
          key: beta,
          name: 'beta',
          url: null,
          previewKind: 'simulator',
          branch: null,
          launchSpec: null,
          touchedAt: 1,
          sessionKeys: [beta],
          activeSessionKey: beta
        }
      ],
      activeKey: beta,
      recents: [{ root: alpha, name: 'alpha', at: 5 }]
    })
    const old = JSON.stringify({
      projects: [{ root: alpha, key: alpha, name: 'Alpha', touchedAt: 3 }]
    })
    const odd =
      '{"10":1,"projects":[' +
      [
        '{"root":"/x\\\\y/","key":"/x/y","2":"b","1":"a","z":1e-7,"n":1.5,"big":1e21,"neg":-0,"f":123456789.123,"e":"😀\\ud800"}',
        `{"root":${JSON.stringify(gamma + '　')},"key":${JSON.stringify(gamma)},"__proto__":{"x":1}}`,
        '{"root":"relative","key":"relative"}',
        '{"root":"/mismatch","key":"/other"}',
        'null',
        '[1]',
        '7',
        `{"root":${JSON.stringify(alpha)},"key":${JSON.stringify(alpha)},"name":"first-wins"}`,
        `{"root":${JSON.stringify(alpha)},"key":${JSON.stringify(alpha)},"name":"duplicate"}`
      ].join(',') +
      '],"activeKey":7,"recents":[null,{"root":"/r"},{"root":"/r2","name":"R2","at":0.5}],"0":"zero","__proto__":1}'
    const empty = '{"projects":[]}'
    const ops = [
      { method: 'open', root: alpha + '/' },
      { method: 'open', root: alias },
      { method: 'open', root: beta, chatSettings: { provider: 'codex', 5: 'k' } },
      { method: 'open', root: join(scratch, 'missing-folder') },
      { method: 'select', key: beta },
      { method: 'select', key: '/nope' },
      {
        method: 'update',
        projects: [
          {
            key: alpha,
            fields: {
              name: 'Renamed',
              branch: 'main',
              viewport: 'desktop',
              sessionKeys: [alpha, 'x'],
              chatSettings: { 3: 1, a: [1.25, null] },
              environmentRevision: 2,
              launchSpec: null
            }
          },
          { key: '/closed-meanwhile', fields: { name: 'ignored' } }
        ]
      },
      { method: 'update', projects: [{ key: alpha, fields: { name: 'Renamed' } }] },
      { method: 'reorder', key: beta, before: null },
      { method: 'reorder', key: beta, before: alpha },
      { method: 'reorder', key: alpha, before: alpha },
      { method: 'recent', root: alpha, name: 'Renamed' },
      { method: 'recent', root: beta, name: 'beta' },
      { method: 'recent', root: alpha, name: 'again' },
      { method: 'close', key: beta },
      { method: 'close', key: beta },
      { method: 'select', key: alpha },
      { method: 'close', key: alpha }
    ]
    const fixture = await start(profile())
    const recorded = golden()
    for (const [name, content] of Object.entries({ current, old, odd, empty })) {
      const dir = profile(content)
      const expected = recorded[name]
      const decoded = await fixture.send({ cmd: 'apply', path: file(dir), ops: [] })
      assert.equal(decoded.ok, true, name)
      assert.deepEqual(
        decoded.view,
        expected.read.view,
        `${name}: same projects, selection and recents as the recorded reader`
      )
      assert.equal(
        Buffer.from(decoded.encoded, 'base64').toString(),
        expected.read.encoded,
        `${name}: re-encoding is byte-identical`
      )
      const swift = await fixture.send({ cmd: 'apply', path: file(dir), ops })
      assert.deepEqual(swift.results, expected.applied.results, `${name}: same operation results`)
      assert.equal(
        Buffer.from(swift.encoded, 'base64').toString('hex'),
        Buffer.from(expected.applied.encoded).toString('hex'),
        `${name}: byte-identical after every operation`
      )
    }
    const oddView = recorded.odd.read.view
    assert.deepEqual(
      keys(oddView),
      ['/x/y', gamma, alpha],
      'valid entries only, first per key, canonical keys'
    )
    assert.equal(oddView.projects[2].name, 'first-wins')
    assert.equal(oddView.activeKey, null, 'a non-project selection reads as none')
    assert.deepEqual(oddView.recents, [{ root: '/r2', name: 'R2', at: 0.5 }])
    const numbers = [
      1e-7,
      1.5,
      1e21,
      123456789.123,
      5e-324,
      2 ** 53,
      1e20,
      0.000001,
      1.7976931348623157e308,
      -2.5e-8,
      100,
      0.1 + 0.2
    ]
    assert.deepEqual(
      (await fixture.send({ cmd: 'number', values: numbers })).out,
      numbers.map(String),
      'JavaScript number formatting'
    )
    for (const refused of [
      'invalid',
      'null',
      '[]',
      '{"projects":{}}',
      '{"projects":null}',
      '﻿{"projects":[]}',
      '{"projects":[]} x',
      '{}'
    ]) {
      const dir = profile(refused)
      assert.equal(
        (await fixture.send({ cmd: 'apply', path: file(dir), ops: [] })).ok,
        false,
        `Swift refuses ${refused}`
      )
    }
    await fixture.close()
    console.log(
      'WORKSPACE-OWNER format: current/old/odd profiles, unknown fields, invalid entries, JS numbers and key order, every operation byte-identical to the recorded writer PASS'
    )
  }

  // --- Canonical-root identity, operations, idempotency, validation, concurrency, restart ---
  {
    const dir = profile()
    let ws = await start(dir)
    const first = ok(await ws.snapshot())
    assert.deepEqual(
      [first.revision.counter, first.projects, first.activeKey, first.recents],
      ['0', [], null, []]
    )
    assert.equal(bytes(dir), null, 'import writes nothing')
    const op = randomUUID()
    const opened = await ws.op('open', { root: alpha + '/' }, first.revision, op)
    assert.deepEqual(
      [ok(opened).key, ok(opened).created, ok(opened).revision.counter],
      [alpha, true, '1']
    )
    assert.deepEqual(keys(opened.snapshot), [alpha])
    assert.deepEqual(
      JSON.parse(readFileSync(file(dir), 'utf8')).projects[0].root,
      alpha + '/',
      'the root is stored as opened'
    )
    assert.deepEqual(
      (await ws.op('open', { root: alpha + '/' }, first.revision, op)).reply.result,
      opened.reply.result,
      'a duplicate returns the recorded result'
    )
    assert.equal(
      code(await ws.op('open', { root: beta }, first.revision, op)),
      'idempotencyMismatch'
    )
    const stale = await ws.op('open', { root: beta }, first.revision)
    assert.equal(code(stale), 'conflict')
    assert.equal(stale.snapshot.revision.counter, '1', 'a conflict carries the current snapshot')
    const viaAlias = ok(await ws.op('open', { root: alias }, opened.snapshot.revision))
    assert.deepEqual(
      [viaAlias.key, viaAlias.created],
      [alpha, false],
      'a symlinked path is the same project'
    )
    const unchanged = readFileSync(file(dir))
    let rev = viaAlias.revision
    const b = await ws.op('open', { root: beta }, rev)
    rev = ok(b).revision
    assert.deepEqual(readFileSync(file(dir)).length > unchanged.length, true)
    const selected = await ws.op('select', { key: beta }, rev)
    rev = ok(selected).revision
    assert.equal(selected.snapshot.activeKey, beta)
    assert.equal(code(await ws.op('select', { key: '/nope' }, rev)), 'notFound')

    // Two operations on one revision: exactly one commits.
    const [x, y] = (
      await ws.send({
        cmd: 'concurrent',
        frames: [
          JSON.stringify(ws.frame('select', { key: alpha }, rev)),
          JSON.stringify(ws.frame('reorder', { key: beta, before: alpha }, rev))
        ]
      })
    ).replies
    assert.deepEqual(
      [x, y].map((r) => r.reply.result.kind).sort(),
      ['failed', 'succeeded'],
      'concurrent updates: exactly one commits'
    )
    assert.equal(
      [x, y].find((r) => r.reply.result.kind === 'failed').reply.result.payload.code,
      'conflict'
    )
    const after = [x, y].find((r) => r.reply.result.kind === 'succeeded').snapshot

    // LKM-153: the project's Connect to Trezi outcome is a field the service validates.
    const sourceSetup = {
      state: 'failed',
      reason: 'the dev server reported: @babel/core is not installed',
      at: 1759400000000
    }
    const remembered = await ws.op(
      'update',
      { projects: [{ key: alpha, fields: { sourceSetup } }] },
      after.revision
    )
    assert.deepEqual(
      remembered.snapshot.projects.find((p) => p.key === alpha).sourceSetup,
      sourceSetup
    )
    // LKM-157: a connected project whose restarted preview lost its stamps.
    const lost = await ws.op(
      'update',
      {
        projects: [
          { key: alpha, fields: { sourceSetup: { state: 'unstamped', at: 1759500000000 } } }
        ]
      },
      remembered.snapshot.revision
    )
    assert.deepEqual(lost.snapshot.projects.find((p) => p.key === alpha).sourceSetup, {
      state: 'unstamped',
      at: 1759500000000
    })
    const restored = await ws.op(
      'update',
      { projects: [{ key: alpha, fields: { sourceSetup } }] },
      lost.snapshot.revision
    )
    const before = readFileSync(file(dir))
    const good = restored.snapshot.revision
    const setupField = (value) =>
      ws.frame('update', { projects: [{ key: alpha, fields: { sourceSetup: value } }] }, good)
    for (const bad of [
      setupField('declined'),
      setupField({ state: 'pending', at: 1 }),
      setupField({ state: 'done' }),
      setupField({ state: 'done', at: -1 }),
      setupField({ state: 'done', at: 1.5 }),
      setupField({ state: 'failed', reason: 3, at: 1 }),
      setupField({ state: 'done', at: 1, extra: true }),
      ws.frame('open', { root: 'relative' }, good),
      ws.frame('open', { root: '/a\ud800' }, good),
      ws.frame('open', { root: '/a', extra: 1 }, good),
      ws.frame('open', { root: '/a', chatSettings: [] }, good),
      ws.frame('open', { root: '/a' }),
      ws.frame('select', {}, good),
      ws.frame('reorder', { key: alpha }, good),
      ws.frame('recent', { root: '/r', name: 1 }, good),
      ws.frame('update', { projects: [] }, good),
      ws.frame('update', { projects: [{ key: alpha, fields: {} }] }, good),
      ws.frame('update', { projects: [{ key: alpha, fields: { root: '/elsewhere' } }] }, good),
      ws.frame('update', { projects: [{ key: alpha, fields: { touchedAt: 1 } }] }, good),
      ws.frame('update', { projects: [{ key: alpha, fields: { viewport: 'tablet' } }] }, good),
      ws.frame(
        'update',
        { projects: [{ key: alpha, fields: { environmentRevision: 1.5 } }] },
        good
      ),
      ws.frame('update', { projects: [{ key: alpha, fields: { name: 'x' }, extra: 1 }] }, good),
      ws.frame('adopt', { digest: 'x' }, good),
      ws.frame('snapshot', { x: 1 }),
      { ...ws.frame('snapshot'), extra: true },
      {
        ...ws.frame('select', { key: alpha }, good),
        request: { ...ws.frame('select', { key: alpha }, good).request, mode: 'read' }
      }
    ])
      assert.equal(code(await ws.send(bad)), 'invalidRequest', JSON.stringify(bad).slice(0, 200))
    const scoped = ws.frame('select', { key: alpha }, good)
    scoped.request.scope = { project: randomUUID() }
    assert.equal(
      code(await ws.send(scoped)),
      'unauthorized',
      'the workspace is global; a scoped frame is refused'
    )
    assert.deepEqual(readFileSync(file(dir)), before, 'refused frames write nothing')
    const noop = await ws.op('reorder', { key: alpha, before: alpha }, good)
    assert.deepEqual(
      readFileSync(file(dir)),
      before,
      'an operation that changes nothing writes nothing'
    )
    await ws.close()

    // Service restart: projects, order, selection, revision and receipts survive.
    ws = await start(dir)
    const reopened = ok(await ws.snapshot())
    assert.deepEqual(reopened.revision, noop.snapshot.revision, 'revision survives restart')
    assert.deepEqual(
      [keys(reopened), reopened.activeKey],
      [keys(after), after.activeKey],
      'projects, order and selection survive restart'
    )
    assert.deepEqual(
      (await ws.op('open', { root: alpha + '/' }, first.revision, op)).reply.result,
      opened.reply.result,
      'receipt survives restart'
    )
    await ws.send({ cmd: 'close' })
    assert.equal(
      code(await ws.op('select', { key: alpha }, reopened.revision)),
      'unavailable',
      'a closed owner refuses new writes'
    )
    await ws.close()
    console.log(
      'WORKSPACE-OWNER operations: canonical-root identity, receipts, mismatch, conflict, concurrency, strict validation, no-op writes and restart PASS'
    )
  }

  // --- External edits are adopted; invalid files are never replaced ---------------
  {
    const dir = profile()
    const ws = await start(dir)
    const base = ok(await ws.snapshot())
    const one = await ws.op('open', { root: alpha }, base.revision)
    const edited = JSON.parse(readFileSync(file(dir), 'utf8'))
    edited.projects.push({
      root: beta,
      key: beta,
      name: 'beta',
      touchedAt: 9,
      sessionKeys: [beta],
      activeSessionKey: beta
    })
    edited.activeKey = beta
    writeFileSync(file(dir), JSON.stringify(edited))
    const conflict = await ws.op('select', { key: alpha }, one.snapshot.revision)
    assert.equal(code(conflict), 'conflict', 'an external edit conflicts')
    assert.deepEqual(
      [keys(conflict.snapshot), conflict.snapshot.activeKey],
      [[alpha, beta], beta],
      'the external file is adopted, not overwritten'
    )
    assert.equal(ws.events.at(-1)?.name, 'workspace.changed', 'adoption is announced')
    const reselected = await ws.op('select', { key: alpha }, conflict.snapshot.revision)
    ok(reselected)
    assert.deepEqual(keys(JSON.parse(readFileSync(file(dir), 'utf8'))), [alpha, beta])

    writeFileSync(file(dir), '{"projects":')
    const corrupt = await ws.op('select', { key: beta }, reselected.snapshot.revision)
    assert.equal(code(corrupt), 'recoveryRequired')
    assert.equal(
      readFileSync(file(dir), 'utf8'),
      '{"projects":',
      'an invalid external file is left untouched'
    )
    await ws.close()

    for (const invalid of ['{"projects":{}}', 'not json']) {
      const blockedDir = profile(invalid)
      const blocked = await start(blockedDir)
      assert.equal(
        code(await blocked.snapshot()),
        'recoveryRequired',
        'an unreadable workspace blocks the domain'
      )
      assert.equal(readFileSync(file(blockedDir), 'utf8'), invalid)
      await blocked.close()
    }
    const owned = await start(dir)
    const second = await start(dir)
    assert.equal(second.ledger, false, 'a second owner cannot open the ledger')
    assert.equal(code(await second.snapshot()), 'recoveryRequired')
    await second.close()
    await owned.close()
    console.log(
      'WORKSPACE-OWNER external edits: conflict, adoption, invalid-file refusal, blocked open and single writer PASS'
    )
  }

  // --- Interrupted persistence: injected write failures change nothing ------------
  for (const step of ['create', 'write', 'flush', 'rename', 'directory']) {
    const initial = JSON.stringify({
      projects: [
        {
          root: alpha,
          key: alpha,
          name: 'alpha',
          touchedAt: 1,
          sessionKeys: [alpha],
          activeSessionKey: alpha
        }
      ],
      activeKey: null,
      recents: []
    })
    const dir = profile(initial)
    const ws = await start(dir, { WORKSPACE_FAIL: step })
    const base = ok(await ws.snapshot())
    const reply = await ws.op('select', { key: alpha }, base.revision)
    if (step === 'directory') {
      assert.equal(ok(reply).revision.counter, '1')
      assert.equal(JSON.parse(readFileSync(file(dir), 'utf8')).activeKey, alpha)
    } else {
      assert.equal(code(reply), 'ioFailure', step)
      assert.equal(reply.reply.result.payload.retryable, true)
      assert.equal(
        readFileSync(file(dir), 'utf8'),
        initial,
        `${step}: the committed file is unchanged`
      )
      assert.equal(existsSync(file(dir) + '.tmp'), false, `${step}: no temp file is left`)
      assert.equal(reply.snapshot.activeKey, null, `${step}: the selection did not move`)
      assert.equal(
        ok(await ws.op('select', { key: alpha }, base.revision)).revision.counter,
        '1',
        `${step}: retry succeeds`
      )
    }
    await ws.close()
  }
  console.log(
    'WORKSPACE-OWNER faults: temp create/write/flush/rename failures change nothing and retry; directory-sync failure keeps the visible commit PASS'
  )

  // --- SIGKILL at each durable boundary, then restart --------------------------
  for (const boundary of [
    'intent',
    'effect',
    'after-rename',
    'receipt',
    'after-rename-then-external'
  ]) {
    const initial = JSON.stringify({
      projects: [
        {
          root: alpha,
          key: alpha,
          name: 'alpha',
          touchedAt: 1,
          sessionKeys: [alpha],
          activeSessionKey: alpha
        }
      ],
      activeKey: alpha,
      recents: []
    })
    const dir = profile(initial)
    let ws = await start(dir, { WORKSPACE_CRASH: boundary.replace('-then-external', '') })
    const base = ok(await ws.snapshot())
    const op = randomUUID()
    await ws.crash(ws.frame('open', { root: beta }, base.revision, op))
    if (boundary === 'after-rename-then-external') {
      const edited = JSON.parse(readFileSync(file(dir), 'utf8'))
      edited.projects.push({
        root: gamma,
        key: gamma,
        name: 'gamma',
        touchedAt: 2,
        sessionKeys: [gamma],
        activeSessionKey: gamma
      })
      writeFileSync(file(dir), JSON.stringify(edited))
    }
    const onDisk = readFileSync(file(dir))
    ws = await start(dir)
    const snap = ok(await ws.snapshot())
    const again = await ws.op('open', { root: beta }, base.revision, op)
    if (boundary === 'intent' || boundary === 'effect') {
      assert.equal(onDisk.toString(), initial, `${boundary}: file unchanged`)
      assert.deepEqual([snap.revision.counter, keys(snap)], ['0', [alpha]])
      assert.equal(
        code(again),
        boundary === 'intent' ? 'unavailable' : 'ioFailure',
        `${boundary}: the same ID is never replayed`
      )
      assert.equal(readFileSync(file(dir), 'utf8'), initial)
      assert.equal(
        ok(await ws.op('open', { root: beta }, base.revision)).revision.counter,
        '1',
        `${boundary}: the domain is not blocked`
      )
    } else if (boundary === 'after-rename-then-external') {
      assert.equal(
        code(again),
        'conflict',
        'an uncertain write superseded by an external edit is not claimed'
      )
      assert.deepEqual(keys(snap), [alpha, beta, gamma], 'the newer external state is adopted')
      assert.deepEqual(readFileSync(file(dir)), onDisk, 'and never overwritten')
    } else {
      assert.deepEqual(
        [snap.revision.counter, keys(snap), snap.activeKey],
        ['1', [alpha, beta], alpha],
        `${boundary}: restart reveals the committed write`
      )
      assert.deepEqual(
        [ok(again).revision.counter, ok(again).key, ok(again).created],
        ['1', beta, true],
        `${boundary}: the same ID returns the reconciled receipt`
      )
      assert.equal(code(await ws.op('select', { key: beta }, base.revision)), 'conflict')
    }
    await ws.close()
  }
  console.log(
    'WORKSPACE-OWNER crashes: SIGKILL at intent/effect/after-rename/receipt reconciles from the file, never replays PASS'
  )

  // --- An edit made while the service was down is adopted at the next launch ------
  {
    const dir = profile(
      JSON.stringify({
        projects: [
          {
            root: alpha,
            key: alpha,
            name: 'alpha',
            touchedAt: 1,
            sessionKeys: [alpha],
            activeSessionKey: alpha,
            future: 'kept'
          }
        ],
        activeKey: alpha,
        recents: []
      })
    )
    const backup = join(scratch, 'old-workspace-backup.json')
    copyFileSync(file(dir), backup)
    let ws = await start(dir)
    const base = ok(await ws.snapshot())
    const opened = await ws.op('open', { root: beta }, base.revision)
    const selected = await ws.op('select', { key: beta }, opened.snapshot.revision)
    await ws.close()
    const saved = JSON.parse(readFileSync(file(dir), 'utf8'))
    assert.deepEqual(
      [keys(saved), saved.activeKey],
      [keys(selected.snapshot), beta],
      'the file holds the newest committed state'
    )
    saved.projects.reverse()
    saved.projects.push({
      root: gamma,
      key: gamma,
      name: 'gamma',
      touchedAt: 2,
      sessionKeys: [gamma],
      activeSessionKey: gamma
    })
    writeFileSync(file(dir), JSON.stringify(saved))
    const newest = readFileSync(file(dir))
    ws = await start(dir)
    const back = ok(await ws.snapshot())
    assert.equal(back.revision.counter, '3', 'the newer file is adopted as a new revision')
    assert.deepEqual([keys(back), back.activeKey], [[beta, alpha, gamma], beta])
    assert.equal(JSON.parse(newest).projects[1].future, 'kept', 'unknown fields survived')
    assert.deepEqual(readFileSync(file(dir)), newest, 'adoption rewrites nothing')
    assert.notDeepEqual(
      readFileSync(file(dir)),
      readFileSync(backup),
      'the old backup was never restored'
    )
    await ws.close()
    console.log(
      'WORKSPACE-OWNER offline edit: the file holds the newest commit; a newer file is adopted, never overwritten PASS'
    )
  }

  // --- Bun's client and controller against the real owner, over the pipe protocol ---
  {
    function link(dir) {
      const child = spawn(binary, [dir], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'inherit']
      })
      live.add(child)
      child.on('exit', () => live.delete(child))
      const emitter = new EventEmitter(),
        held = []
      let holding = false,
        ready
      const started = new Promise((resolve) => {
        ready = resolve
      })
      createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line)
        if (message.ready) ready()
        else emitter.emit(message.event, message)
      })
      const write = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`)
      return Object.assign(emitter, {
        started,
        child,
        sendService(frame) {
          holding ? held.push(frame) : write(frame)
        },
        hold() {
          holding = true
        },
        flush() {
          holding = false
          for (const frame of held.splice(0)) write(frame)
        },
        async close() {
          child.stdin.end()
          await new Promise((resolve) => child.once('exit', resolve))
        }
      })
    }
    const dir = profile(
      JSON.stringify({
        projects: [{ root: alpha, key: alpha, name: 'alpha', touchedAt: 1 }],
        activeKey: alpha
      })
    )
    let pipe = link(dir)
    await pipe.started
    let store = await serviceWorkspace(pipe, 2_000)
    assert.deepEqual(
      [keys(store.snapshot()), store.snapshot().activeKey],
      [[alpha], alpha],
      'the legacy file is imported'
    )
    await assert.rejects(store.open('relative'), /absolute/, 'invalid operations never leave Bun')
    // Queued operations go one at a time, each on the revision the previous one committed.
    const [b] = await Promise.all([
      store.open(beta),
      store.select(alpha),
      store.recent(alpha, 'alpha')
    ])
    assert.deepEqual(b, { key: beta, created: true })
    assert.deepEqual(
      await store.open(alias),
      { key: alpha, created: false },
      'canonical-root identity through the client'
    )
    await store.select(beta)
    assert.equal(JSON.parse(readFileSync(file(dir), 'utf8')).activeKey, beta)

    // An external edit is adopted and announced; the intent is retried on it.
    let notified = 0
    store.subscribe(() => notified++)
    const external = JSON.parse(readFileSync(file(dir), 'utf8'))
    external.projects.push({
      root: gamma,
      key: gamma,
      name: 'gamma',
      touchedAt: 2,
      sessionKeys: [gamma],
      activeSessionKey: gamma
    })
    writeFileSync(file(dir), JSON.stringify(external))
    await store.reorder(gamma, alpha)
    assert.deepEqual(
      keys(store.snapshot()),
      [gamma, alpha, beta],
      'the retried intent applies on top of the adopted edit'
    )
    assert.equal(notified, 1, 'the adoption reaches subscribers')

    // A service that does not answer: the operation fails and nothing is written locally.
    const before = readFileSync(file(dir))
    pipe.hold()
    await assert.rejects(
      store.select(alpha),
      (error) =>
        error.code === 'deadlineExceeded' && /Nothing was written locally/.test(error.message)
    )
    assert.deepEqual(readFileSync(file(dir)), before, 'no fallback write after a timeout')
    assert.equal(store.snapshot().activeKey, beta)
    pipe.flush()
    const deadline = Date.now() + 10_000
    while (store.snapshot().activeKey !== alpha) {
      assert.ok(Date.now() < deadline, 'late reply')
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(
      JSON.parse(readFileSync(file(dir), 'utf8')).activeKey,
      alpha,
      'the late commit is reflected, not replayed'
    )
    await pipe.close()

    // The controller on the Swift owner; a service restart and a UI reattach keep projects and selection.
    const invoke = async (channel, ...args) => {
      if (channel === 'agent:workspace-snapshot') return { projects: [] }
      if (channel === 'project:detect')
        return { name: args[0].split('/').at(-1), setupRequired: true, previewKind: 'web' }
      if (channel === 'git:ensure' || channel === 'git:list') return { current: 'main' }
      if (channel === 'sessions:list') return []
      return { ok: true }
    }
    const services = (store) => ({
      store,
      invoke,
      render() {},
      activate: async () => {},
      closeChat() {},
      reusableChat: () => false
    })
    pipe = link(dir)
    await pipe.started
    let controller = new NativeWorkspaceController(services(await serviceWorkspace(pipe, 5_000)))
    await controller.command({ type: 'attach' })
    await controller.command({ type: 'select', key: beta })
    await controller.reorderProject(beta, null)
    const expected = [keys({ projects: controller.state.projects }), controller.state.activeKey]
    assert.equal(expected[1], beta)
    for (
      let i = 0;
      i < 50 &&
      JSON.parse(readFileSync(file(dir), 'utf8')).projects.find((p) => p.key === beta)?.branch !==
        'main';
      i++
    )
      await new Promise((r) => setTimeout(r, 20))
    assert.equal(
      JSON.parse(readFileSync(file(dir), 'utf8')).projects.find((p) => p.key === beta).branch,
      'main',
      'metadata persisted through the adapter'
    )
    await pipe.close()
    pipe = link(dir)
    await pipe.started
    controller = new NativeWorkspaceController(services(await serviceWorkspace(pipe, 5_000)))
    await controller.command({ type: 'attach' })
    await controller.command({ type: 'attach' })
    assert.deepEqual(
      [keys({ projects: controller.state.projects }), controller.state.activeKey],
      expected,
      'service restart + UI reattach preserve projects and selection'
    )
    await pipe.close()

    // A domain the service cannot open fails Bun's startup instead of guessing.
    const broken = profile('{"projects":null}')
    pipe = link(broken)
    await pipe.started
    await assert.rejects(serviceWorkspace(pipe, 2_000), /not a valid saved workspace/)
    assert.equal(readFileSync(file(broken), 'utf8'), '{"projects":null}')
    await pipe.close()
    console.log(
      'WORKSPACE-OWNER Bun client + controller: serialized intents, canonical identity, adoption retry, timeout without fallback, late reply, service restart/UI reattach and startup refusal PASS'
    )
  }
} finally {
  for (const child of live) child.kill('SIGKILL')
  rmSync(scratch, { recursive: true, force: true })
}
