// The preferences owner (real PreferencesOwner + OperationLedger compiled into a
// fixture process), the only writer of preferences.json since LKM-111, on real files.
// The v1 format is pinned by answers recorded from the retired Bun writer. Batches,
// idempotency, conflicts, injected write failures, SIGKILL at every durable boundary,
// offline edits and Bun's client.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { servicePreferences } from '../src/native/preferences-service.ts'
import { skipUnlessDarwin } from './helpers/darwin.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'trezi-preferences-owner-'))
const binary = join(scratch, 'preferences-fixture')
const live = new Set()
let cases = 0

function compile() {
  skipUnlessDarwin('the Swift preferences owner')
  const sources = [
    'ServiceContract',
    'LedgerStore',
    'OperationLedger',
    'PreferencesFile',
    'PreferencesOwner'
  ].map((name) => `src/service/${name}.swift`)
  const result = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-module-cache-path',
      join(scratch, 'module-cache'),
      ...sources,
      'test/fixtures/preferences-owner/main.swift',
      '-o',
      binary
    ],
    { cwd: root, encoding: 'utf8', timeout: 300_000 }
  )
  assert.equal(
    result.status,
    0,
    `swiftc: ${result.error || ''}\n${result.stdout}\n${result.stderr}`
  )
}

function profile(initial) {
  const dir = join(scratch, `case-${++cases}`)
  mkdirSync(dir)
  if (initial !== undefined) writeFileSync(join(dir, 'preferences.json'), initial)
  return dir
}
const file = (dir) => join(dir, 'preferences.json')
const bytes = (dir) => (existsSync(file(dir)) ? readFileSync(file(dir)) : null)

async function start(dir, env = {}) {
  const child = spawn(binary, [dir], {
    env: { ...process.env, ...env },
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
        service: 'preferences',
        id: ++id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID,
          scope: {},
          mode: method === 'set' ? 'mutation' : 'read',
          ...(expectedRevision ? { expectedRevision } : {}),
          service: 'preferences',
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
    set(entries, revision, operationID) {
      return this.send(
        this.frame(
          'set',
          { entries: entries.map(([key, value]) => ({ key, value })) },
          revision,
          operationID
        )
      )
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
const entries = (snapshot) => snapshot.entries.map(({ key, value }) => [key, value])
const stored = (dir) => JSON.parse(readFileSync(file(dir), 'utf8')).values
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

try {
  compile()

  // --- The v1 reader/writer: the retired Bun writer's recorded answers ----------
  {
    const wide = '😀'.repeat(96) // 192 UTF-16 units, 96 scalars
    const files = {
      mixed: JSON.stringify({
        version: 1,
        other: true,
        values: {
          'trezi:a': 'x',
          'praxis:b': 'legacy',
          'trezi:null': null,
          'praxis.c': 'dot',
          'trezi.c': 'kept',
          'other:x': 'drop',
          __proto__x: 'drop',
          'trezi:num': 3,
          'trezi:obj': {},
          'trezi:arr': [1],
          'trezi:big': 'y'.repeat(2_000_001),
          'trezi:max': 'z'.repeat(2_000_000),
          ['trezi:' + 'k'.repeat(193)]: 'len199',
          ['trezi:' + 'k'.repeat(194)]: 'len200',
          ['trezi:' + wide.slice(0, 190)]: 'astral196',
          ['trezi:' + wide + 'a']: 'astral199',
          ['trezi:' + wide + 'ab']: 'astral200',
          'trezi:ctl': '\u0000\u001f"\\\n\t/ '
        }
      }),
      duplicate: '{"version":1,"values":{"trezi:a":"1","trezi:b":"2","trezi:a":"3"},"version":1}',
      surrogate:
        '{"version":1,"values":{"trezi:lone":"\\ud800x","trezi:low":"\\udfff","trezi:pair":"\\ud83d\\ude00","trezi:proto":"\\u0041"}}',
      decimal: '{"version":1.0e0,"values":{"trezi:a":"1"}}\n ',
      arrayValues: '{"version":1,"values":["trezi:a"]}',
      badUtf8: Buffer.concat([
        Buffer.from('{"version":1,"values":{"trezi:a":"'),
        Buffer.from([0xff, 0xc3, 0x28, 0xe2, 0x82]),
        Buffer.from('"}}')
      ]),
      empty: '{"version":1,"values":{}}'
    }
    const refused = {
      bom: '﻿{"version":1,"values":{}}',
      version2: '{"version":2,"values":{}}',
      versionString: '{"version":"1","values":{}}',
      nullValues: '{"version":1,"values":null}',
      stringValues: '{"version":1,"values":"x"}',
      missing: '{"version":1}',
      array: '[1]',
      truncated: '{"version":1,"values":{',
      trailingComma: '{"version":1,"values":{},}',
      text: 'null',
      leadingZero: '{"version":01,"values":{}}'
    }
    // Entries, order, nulls and code units; `praxis` names gain a canonical `trezi` copy.
    const expected = {
      mixed: {
        keys: [
          'trezi:a',
          'praxis:b',
          'trezi:null',
          'praxis.c',
          'trezi.c',
          'trezi:max',
          'trezi:' + 'k'.repeat(193),
          'trezi:' + wide.slice(0, 190),
          'trezi:' + wide + 'a',
          'trezi:ctl',
          'trezi:b'
        ],
        sha256: '81b8e432116061d7890981fe1a390341015e0a4143cf4e65bcfdda40bc947919'
      },
      duplicate: [
        ['trezi:a', '3'],
        ['trezi:b', '2']
      ],
      surrogate: [
        ['trezi:lone', '\ud800x'],
        ['trezi:low', '\udfff'],
        ['trezi:pair', '😀'],
        ['trezi:proto', 'A']
      ],
      decimal: [['trezi:a', '1']],
      arrayValues: [],
      badUtf8: [['trezi:a', '��(�']],
      empty: []
    }
    const fixture = await start(profile())
    for (const [name, content] of Object.entries(files)) {
      const swift = await fixture.send({ cmd: 'decode', path: file(profile(content)) })
      assert.equal(swift.ok, true, name)
      const golden = expected[name]
      if (Array.isArray(golden))
        assert.deepEqual(swift.entries, golden, `${name}: the recorded entries`)
      else {
        assert.deepEqual(
          swift.entries.map(([key]) => key),
          golden.keys,
          `${name}: the recorded keys`
        )
        assert.equal(
          sha256(JSON.stringify(swift.entries)),
          golden.sha256,
          `${name}: the recorded values`
        )
      }
      assert.equal(
        Buffer.from(swift.encoded, 'base64').toString('hex'),
        Buffer.from(
          JSON.stringify({ version: 1, values: Object.fromEntries(swift.entries) })
        ).toString('hex'),
        `${name}: byte-identical v1 output`
      )
    }
    for (const [name, content] of Object.entries(refused)) {
      assert.equal(
        (await fixture.send({ cmd: 'decode', path: file(profile(content)) })).ok,
        false,
        `${name}: refused, as Bun refused it`
      )
    }
    await fixture.close()
    console.log(
      'PREFERENCES-OWNER format: v1 reader/writer, unknown keys, null, UTF-16 limits, lone surrogates and refusals as recorded PASS'
    )
  }

  // --- Snapshot, batches, idempotency, validation, restart --------------------
  {
    const initial = JSON.stringify({
      version: 1,
      values: { 'praxis:legacy': 'old', 'trezi:unknown-future': '{"x":1}', 'trezi:gone': null }
    })
    const dir = profile(initial)
    let prefs = await start(dir)
    const first = ok(await prefs.snapshot())
    assert.equal(first.revision.counter, '0')
    assert.deepEqual(
      entries(first),
      [
        ['praxis:legacy', 'old'],
        ['trezi:unknown-future', '{"x":1}'],
        ['trezi:gone', null],
        ['trezi:legacy', 'old']
      ],
      'imported exactly as the Bun owner read it'
    )
    assert.equal(bytes(dir).toString(), initial, 'import writes nothing')

    const batch = [
      ['trezi:native-chat-width', '500'],
      ['praxis:legacy', 'new'],
      ['trezi:unknown-future', null]
    ]
    const op = randomUUID()
    const committed = await prefs.set(batch, first.revision, op)
    assert.equal(ok(committed).revision.counter, '1')
    assert.equal(committed.snapshot.revision.counter, '1')
    assert.equal(
      bytes(dir).toString(),
      '{"version":1,"values":{"praxis:legacy":"old","trezi:unknown-future":null,"trezi:gone":null,"trezi:legacy":"new","trezi:native-chat-width":"500"}}',
      'byte-identical to the retired Bun writer'
    )
    const retry = await prefs.set(batch, first.revision, op)
    assert.deepEqual(
      retry.reply.result,
      committed.reply.result,
      'a duplicate returns the recorded result'
    )
    assert.equal(
      code(await prefs.set([['trezi:native-chat-width', '600']], first.revision, op)),
      'idempotencyMismatch'
    )
    const stale = await prefs.set([['trezi:native-chat-width', '600']], first.revision)
    assert.equal(code(stale), 'conflict')
    assert.equal(stale.snapshot.revision.counter, '1', 'a conflict carries the current snapshot')

    const rev = committed.snapshot.revision
    const [a, b] = (
      await prefs.send({
        cmd: 'concurrent',
        frames: [
          JSON.stringify(prefs.frame('set', { entries: [{ key: 'trezi:race', value: 'a' }] }, rev)),
          JSON.stringify(prefs.frame('set', { entries: [{ key: 'trezi:race', value: 'b' }] }, rev))
        ]
      })
    ).replies
    assert.deepEqual(
      [a, b].map((r) => r.reply.result.kind).sort(),
      ['failed', 'succeeded'],
      'two batches on one revision: exactly one commits'
    )
    assert.equal(
      [a, b].find((r) => r.reply.result.kind === 'failed').reply.result.payload.code,
      'conflict'
    )
    const winner = [a, b].find((r) => r.reply.result.kind === 'succeeded')
    const after = winner.snapshot
    assert.equal(after.revision.counter, '2')

    const before = bytes(dir)
    for (const bad of [
      prefs.frame('set', { entries: [{ key: '__proto__', value: 'x' }] }, after.revision),
      prefs.frame('set', { entries: [{ key: 'trezi:x', value: 1 }] }, after.revision),
      prefs.frame(
        'set',
        { entries: [{ key: 'trezi:x', value: 'y'.repeat(2_000_001) }] },
        after.revision
      ),
      prefs.frame(
        'set',
        { entries: [{ key: 'trezi:' + 'k'.repeat(194), value: 'x' }] },
        after.revision
      ),
      prefs.frame('set', { entries: [{ key: 'trezi:x', value: 'x', extra: 1 }] }, after.revision),
      prefs.frame('set', { entries: [] }, after.revision),
      prefs.frame('set', { entries: [{ key: 'trezi:x', value: 'x' }] }),
      { ...prefs.frame('snapshot'), extra: true },
      {
        ...prefs.frame('set', { entries: [{ key: 'trezi:x', value: 'x' }] }, after.revision),
        request: {
          ...prefs.frame('set', { entries: [{ key: 'trezi:x', value: 'x' }] }, after.revision)
            .request,
          mode: 'read'
        }
      }
    ])
      assert.equal(code(await prefs.send(bad)), 'invalidRequest', JSON.stringify(bad).slice(0, 200))
    const scoped = prefs.frame('set', { entries: [{ key: 'trezi:x', value: 'x' }] }, after.revision)
    scoped.request.scope = { project: randomUUID() }
    assert.equal(
      code(await prefs.send(scoped)),
      'unauthorized',
      'preferences are global; a scoped frame is refused'
    )
    assert.deepEqual(bytes(dir), before, 'refused frames write nothing')
    await prefs.close()

    prefs = await start(dir)
    const reopened = ok(await prefs.snapshot())
    assert.deepEqual(reopened.revision, after.revision, 'revision survives restart')
    assert.deepEqual(entries(reopened), entries(after))
    assert.deepEqual(
      (await prefs.set(batch, first.revision, op)).reply.result,
      committed.reply.result,
      'receipt survives restart'
    )
    await prefs.send({ cmd: 'close' })
    assert.equal(
      code(await prefs.set([['trezi:x', 'x']], after.revision)),
      'unavailable',
      'a closed owner refuses new writes'
    )
    await prefs.close()
    console.log(
      'PREFERENCES-OWNER batches: snapshot import, atomic batch, duplicate receipt, mismatch, conflict, concurrency, validation and restart PASS'
    )
  }

  // --- External edits conflict; invalid external files are never replaced -----
  {
    const dir = profile()
    const prefs = await start(dir)
    const base = ok(await prefs.snapshot())
    assert.deepEqual(base.entries, [])
    const one = await prefs.set([['trezi:mine', '1']], base.revision)
    ok(one)
    writeFileSync(
      file(dir),
      JSON.stringify({ version: 1, values: { 'trezi:mine': '1', 'trezi:theirs': 'external' } })
    )
    const conflict = await prefs.set([['trezi:mine', '2']], one.snapshot.revision)
    assert.equal(code(conflict), 'conflict', 'an external edit conflicts')
    assert.deepEqual(
      entries(conflict.snapshot),
      [
        ['trezi:mine', '1'],
        ['trezi:theirs', 'external']
      ],
      'the external file is adopted, not overwritten'
    )
    assert.equal(
      prefs.events.at(-1)?.snapshot.revision.counter,
      conflict.snapshot.revision.counter,
      'adoption is announced'
    )
    const retried = await prefs.set([['trezi:mine', '2']], conflict.snapshot.revision)
    assert.deepEqual(entries(retried.snapshot), [
      ['trezi:mine', '2'],
      ['trezi:theirs', 'external']
    ])

    writeFileSync(file(dir), '{"version":1,"values":')
    const corrupt = await prefs.set([['trezi:mine', '3']], retried.snapshot.revision)
    assert.equal(code(corrupt), 'recoveryRequired')
    assert.equal(
      readFileSync(file(dir), 'utf8'),
      '{"version":1,"values":',
      'an invalid external file is left untouched'
    )
    writeFileSync(file(dir), JSON.stringify({ version: 1, values: { 'trezi:fixed': 'yes' } }))
    const refreshed = await prefs.set([['trezi:mine', '3']], retried.snapshot.revision)
    assert.equal(code(refreshed), 'conflict')
    ok(await prefs.set([['trezi:mine', '3']], refreshed.snapshot.revision))
    assert.deepEqual(JSON.parse(readFileSync(file(dir), 'utf8')).values, {
      'trezi:fixed': 'yes',
      'trezi:mine': '3'
    })
    await prefs.close()

    const invalid = profile('{"version":2}')
    const blocked = await start(invalid)
    assert.equal(
      code(await blocked.snapshot()),
      'recoveryRequired',
      'an unreadable v1 file blocks the domain'
    )
    assert.equal(readFileSync(file(invalid), 'utf8'), '{"version":2}')
    await blocked.close()

    const owned = await start(dir)
    const second = await start(dir)
    assert.equal(second.ledger, false, 'a second owner cannot open the ledger')
    assert.equal(
      code(await second.snapshot()),
      'recoveryRequired',
      'and so cannot read or write preferences'
    )
    await second.close()
    await owned.close()
    console.log(
      'PREFERENCES-OWNER external edits: conflict, adoption, invalid-file refusal, blocked open and single writer PASS'
    )
  }

  // --- Injected write failures: nothing changes, the retry succeeds -----------
  for (const step of ['create', 'write', 'flush', 'rename', 'directory']) {
    const initial = JSON.stringify({ version: 1, values: { 'trezi:keep': 'yes' } })
    const dir = profile(initial)
    const prefs = await start(dir, { PREFS_FAIL: step })
    const base = ok(await prefs.snapshot())
    const reply = await prefs.set([['trezi:new', 'v']], base.revision)
    if (step === 'directory') {
      // The rename is already visible; the commit stands and the file is authoritative.
      assert.equal(ok(reply).revision.counter, '1')
      assert.equal(JSON.parse(readFileSync(file(dir), 'utf8')).values['trezi:new'], 'v')
    } else {
      assert.equal(code(reply), 'ioFailure', step)
      assert.equal(reply.reply.result.payload.retryable, true)
      assert.equal(
        readFileSync(file(dir), 'utf8'),
        initial,
        `${step}: the committed file is unchanged`
      )
      assert.equal(existsSync(file(dir) + '.tmp'), false, `${step}: no temp file is left`)
      assert.equal(reply.snapshot.revision.counter, '0', `${step}: no revision was consumed`)
      assert.equal(
        ok(await prefs.set([['trezi:new', 'v']], base.revision)).revision.counter,
        '1',
        `${step}: retry succeeds`
      )
    }
    await prefs.close()
  }
  console.log(
    'PREFERENCES-OWNER faults: temp create/write/flush/rename failures change nothing and retry; directory-sync failure keeps the visible commit PASS'
  )

  // --- SIGKILL at each durable boundary, then restart --------------------------
  for (const boundary of [
    'intent',
    'effect',
    'after-rename',
    'receipt',
    'after-rename-then-external'
  ]) {
    const initial = JSON.stringify({ version: 1, values: { 'trezi:keep': 'yes' } })
    const dir = profile(initial)
    let prefs = await start(dir, { PREFS_CRASH: boundary.replace('-then-external', '') })
    const base = ok(await prefs.snapshot())
    const op = randomUUID()
    await prefs.crash(
      prefs.frame('set', { entries: [{ key: 'trezi:new', value: 'v' }] }, base.revision, op)
    )
    if (boundary === 'after-rename-then-external') {
      // Another writer runs in between and writes newer state.
      writeFileSync(
        file(dir),
        JSON.stringify({ version: 1, values: { ...stored(dir), 'trezi:external': 'newer' } })
      )
    }
    const onDisk = readFileSync(file(dir))
    prefs = await start(dir)
    const snap = ok(await prefs.snapshot())
    const again = await prefs.set([['trezi:new', 'v']], base.revision, op)
    if (boundary === 'intent' || boundary === 'effect') {
      assert.equal(onDisk.toString(), initial, `${boundary}: file unchanged`)
      assert.equal(snap.revision.counter, '0')
      assert.equal(
        code(again),
        boundary === 'intent' ? 'unavailable' : 'ioFailure',
        `${boundary}: the same ID is never replayed`
      )
      assert.equal(readFileSync(file(dir), 'utf8'), initial)
      assert.equal(
        ok(await prefs.set([['trezi:new', 'v']], base.revision)).revision.counter,
        '1',
        `${boundary}: the domain is not blocked`
      )
    } else if (boundary === 'after-rename-then-external') {
      assert.equal(
        code(again),
        'conflict',
        'an uncertain write superseded by another writer is not claimed'
      )
      assert.deepEqual(
        entries(snap),
        [
          ['trezi:keep', 'yes'],
          ['trezi:new', 'v'],
          ['trezi:external', 'newer']
        ],
        'the newer state is adopted'
      )
      assert.deepEqual(readFileSync(file(dir)), onDisk, 'and never overwritten')
    } else {
      assert.equal(snap.revision.counter, '1', `${boundary}: restart reveals the committed write`)
      assert.deepEqual(entries(snap), [
        ['trezi:keep', 'yes'],
        ['trezi:new', 'v']
      ])
      assert.equal(
        ok(again).revision.counter,
        '1',
        `${boundary}: the same ID returns the reconciled receipt`
      )
      assert.equal(code(await prefs.set([['trezi:other', 'x']], base.revision)), 'conflict')
    }
    await prefs.close()
  }
  console.log(
    'PREFERENCES-OWNER crashes: SIGKILL at intent/effect/after-rename/receipt reconciles from the file, never replays PASS'
  )

  // --- An edit while the service is down is adopted, never overwritten ---------
  {
    const dir = profile(
      JSON.stringify({
        version: 1,
        values: { 'trezi:chat-hidden': '0', 'trezi:future-key': 'kept' }
      })
    )
    const backup = join(scratch, 'old-backup.json')
    copyFileSync(file(dir), backup)
    let prefs = await start(dir)
    const base = ok(await prefs.snapshot())
    const swift = await prefs.set(
      [
        ['trezi:chat-hidden', '1'],
        ['trezi:publish-mode', 'pr'],
        ['trezi:empty', null]
      ],
      base.revision
    )
    await prefs.close()
    assert.deepEqual(
      Object.entries(stored(dir)),
      entries(swift.snapshot),
      'the file holds the newest committed state'
    )
    writeFileSync(
      file(dir),
      JSON.stringify({ version: 1, values: { ...stored(dir), 'trezi:publish-mode': 'merge' } })
    )
    const newest = readFileSync(file(dir))
    prefs = await start(dir)
    const back = ok(await prefs.snapshot())
    assert.equal(back.revision.counter, '2', 'the offline edit is adopted as a new revision')
    assert.deepEqual(entries(back), Object.entries(stored(dir)))
    assert.deepEqual(readFileSync(file(dir)), newest, 'adoption rewrites nothing')
    assert.notDeepEqual(
      readFileSync(file(dir)),
      readFileSync(backup),
      'the old backup was never restored'
    )
    await prefs.close()
    console.log(
      'PREFERENCES-OWNER offline edit: an edit made while the service is down is adopted; no rewrite, no backup restore PASS'
    )
  }

  // --- Bun's client against the real owner, over the pipe's line protocol ------
  {
    /** Bun's end of the private pipe; `hold` parks outgoing frames (a stalled service). */
    function link(dir) {
      const child = spawn(binary, [dir], { stdio: ['pipe', 'pipe', 'inherit'] })
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
        version: 1,
        values: { 'praxis:native-chat-width': '480', 'trezi:unknown': null }
      })
    )
    let pipe = link(dir)
    await pipe.started
    const prefs = await servicePreferences(pipe, 2_000)
    assert.equal(
      prefs.get('praxis:native-chat-width'),
      '480',
      'canonical praxis names read through'
    )
    assert.ok(Object.hasOwn(prefs.snapshot(), 'trezi:unknown'), 'explicit null survives the client')
    await assert.rejects(prefs.set('trezi:bad', 1), /Invalid/, 'invalid values never leave Bun')
    const untouched = readFileSync(file(dir))
    await assert.rejects(prefs.set('__proto__', 'bad'), /Invalid/)
    await assert.rejects(prefs.set('trezi:too-large', 'x'.repeat(2_000_001)), /Invalid/)
    await assert.rejects(
      prefs.apply([
        ['trezi:a', '1'],
        ['trezi:b', 2]
      ]),
      /Invalid/
    )
    assert.deepEqual(readFileSync(file(dir)), untouched, 'an invalid batch writes nothing')
    const copy = prefs.snapshot()
    copy['praxis:native-chat-width'] = 'changed'
    assert.equal(prefs.get('praxis:native-chat-width'), '480', 'a snapshot is a copy')

    // Queued batches go one at a time, each on the revision the previous one committed.
    await Promise.all([
      prefs.set('trezi:a', '1'),
      prefs.set('trezi:b', '2'),
      prefs.apply((current) => [
        ['trezi:c', (current['trezi:a'] ?? '?') + (current['trezi:b'] ?? '?')]
      ])
    ])
    assert.equal(
      prefs.get('trezi:c'),
      '12',
      'a function batch is built from the committed state when it is sent'
    )
    assert.equal(stored(dir)['trezi:c'], '12')

    // An external edit rejects the batch, is adopted and announced; the retry works.
    let notified = 0
    prefs.subscribe(() => notified++)
    writeFileSync(
      file(dir),
      JSON.stringify({ version: 1, values: { ...stored(dir), 'trezi:external': 'yes' } })
    )
    await assert.rejects(
      prefs.set('trezi:a', 'mine'),
      (error) => error.code === 'conflict' && /changed outside Trezi/.test(error.message)
    )
    assert.equal(prefs.get('trezi:external'), 'yes')
    assert.equal(notified, 1, 'the adoption reaches subscribers')
    await prefs.set('trezi:a', 'mine')
    assert.equal(stored(dir)['trezi:external'], 'yes', 'the external value is preserved')

    // A service that does not answer: the batch fails and nothing is written locally.
    const before = readFileSync(file(dir))
    pipe.hold()
    await assert.rejects(
      prefs.set('trezi:a', 'late'),
      (error) =>
        error.code === 'deadlineExceeded' && /Nothing was written locally/.test(error.message)
    )
    assert.deepEqual(readFileSync(file(dir)), before, 'no fallback write after a timeout')
    assert.equal(prefs.get('trezi:a'), 'mine')
    pipe.flush()
    const deadline = Date.now() + 10_000
    while (prefs.get('trezi:a') !== 'late') {
      assert.ok(Date.now() < deadline, 'late reply')
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(stored(dir)['trezi:a'], 'late', 'the late commit is reflected, not replayed')
    await prefs.set('trezi:a', 'after')
    await pipe.close()

    // A domain the service cannot open fails Bun's startup instead of guessing.
    const broken = profile('{"version":1,"values":null}')
    pipe = link(broken)
    await pipe.started
    await assert.rejects(servicePreferences(pipe, 2_000), /not a valid version 1/)
    assert.equal(readFileSync(file(broken), 'utf8'), '{"version":1,"values":null}')
    await pipe.close()
    console.log(
      'PREFERENCES-OWNER Bun client: serialized batches, committed-state batches, conflict/adoption, timeout without fallback, late reply and startup refusal PASS'
    )
  }
} finally {
  for (const child of live) child.kill('SIGKILL')
  rmSync(scratch, { recursive: true, force: true })
}
