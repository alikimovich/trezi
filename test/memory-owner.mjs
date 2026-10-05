// S05 project memory: the Swift owner (real MemoryOwner + OperationLedger compiled
// into a fixture process), the only writer since LKM-111, on real files. The recorded
// format (file IDs, stored bytes, reader verdicts), manual-versus-generated ordering,
// receipts, strict frames, damaged and external files, injected write failures,
// SIGKILL at every durable boundary, service restart, Bun's client, the evaluation
// queue and the editor's failed-autosave draft retention.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createProjectMemoryUpdateQueue } from '../src/main/project-memory.ts'
import { serviceProjectMemory } from '../src/native/project-memory-service.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import { projectKey } from '../src/shared/projectKey.ts'
import { skipUnlessDarwin } from './helpers/darwin.mjs'
import { swiftBuild } from './helpers/swift-build.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'trezi-memory-owner-'))
const binary = join(scratch, 'memory-fixture')
const NOW = 1790000000000
const live = new Set()
let cases = 0

function compile() {
  skipUnlessDarwin('the Swift memory owner')
  const sources = [
    'ServiceContract',
    'LedgerStore',
    'OperationLedger',
    'PreferencesFile',
    'PreferencesOwner',
    'WorkspaceFile',
    'WorkspaceOwner',
    'DomainChannel',
    'MemoryFile',
    'MemoryOwner'
  ].map((name) => `src/service/${name}.swift`)
  swiftBuild('memory-owner', [...sources, 'test/fixtures/memory-owner/main.swift'], {
    out: binary
  })
}

/** A profile with the session store in place (as Bun's `nativeSessionPath` leaves it). */
function profile(files = {}, { sessions = true } = {}) {
  const dir = join(scratch, `case-${++cases}`)
  mkdirSync(dir)
  if (sessions) mkdirSync(join(dir, 'trezi/project-memories'), { recursive: true })
  for (const [project, content] of Object.entries(files))
    writeFileSync(memoryFile(dir, project), content)
  return dir
}
/** The file name: hex SHA-256 of the project key. */
const memoryFileId = (project) => createHash('sha256').update(projectKey(project)).digest('hex')
const memoryFile = (dir, project) =>
  join(dir, 'trezi/project-memories', `${memoryFileId(project)}.json`)
const bytes = (dir, project) =>
  existsSync(memoryFile(dir, project)) ? readFileSync(memoryFile(dir, project)) : null
const record = (content, updatedAt = 1) => JSON.stringify({ content, updatedAt })

async function start(dir, env = {}) {
  const child = spawn(binary, [dir], {
    env: { ...process.env, MEMORY_NOW: String(NOW), ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  live.add(child)
  const lines = [],
    waiters = []
  let stderr = '',
    status = null
  child.stderr.on('data', (data) => {
    stderr += data
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(JSON.parse(line))
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
    frame(method, body, expectedRevision, operationID = randomUUID()) {
      return {
        service: 'memory',
        id: ++id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID,
          scope: {},
          mode: method === 'read' ? 'read' : 'mutation',
          ...(expectedRevision ? { expectedRevision } : {}),
          service: 'memory',
          method,
          body
        }
      }
    },
    send(frame) {
      return this.raw(JSON.stringify(frame))
    },
    read(project) {
      return this.send(this.frame('read', { root: project }))
    },
    op(method, project, content, revision, operationID) {
      return this.send(this.frame(method, { root: project, content }, revision, operationID))
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
  assert.equal(ready.ledger, true, stderr)
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
/** What the owner stores for this content at NOW: trimmed, bounded to 16,000 characters. */
const storedBytes = (content) =>
  Buffer.from(JSON.stringify({ content: content.trim().slice(0, 16_000), updatedAt: NOW }))

function link(dir, env = {}) {
  const child = spawn(binary, [dir], {
    env: { ...process.env, ...env },
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

try {
  compile()
  const alpha = '/Users/me/alpha',
    beta = '/Users/me/beta'

  // --- The recorded format (the retired Bun writer's answers): file IDs, stored bytes, reader verdicts ---
  {
    const dir = profile()
    const fx = await start(dir)
    const roots = [
      alpha,
      `${alpha}/`,
      `${alpha}//`,
      `  ${alpha}\t`,
      'C:\\Users\\me\\alpha',
      '/',
      '/Users/me/ünïcødé 🎨'
    ]
    const contents = [
      '# Decisions\n- Keep it calm',
      '   padded \n\n',
      '\u2028\u00a0 unicode é 🎨 \ufeff',
      '\ud800 lone \udc00',
      'x'.repeat(16_050),
      `${' '.repeat(10)}${'y'.repeat(16_000)}`,
      'quote " backslash \\ control \u0001 \u007f',
      ''
    ]
    const files = [
      '',
      '{"content":"a","updatedAt":1}',
      '{"content":"a","updatedAt":1.5e300,"extra":true}',
      '{"content":"a","content":"b","updatedAt":2}',
      '{"content":1,"updatedAt":2}',
      '{"content":"a"}',
      '[]',
      'null',
      '"text"',
      '{"content":"a","updatedAt":"1"}',
      '\ufeff{"content":"a","updatedAt":1}',
      '{"content":"a","updatedAt":1} trailing',
      `{"content":"${'z'.repeat(16_010)}","updatedAt":3}`,
      '{"content":"\\ud800","updatedAt":4}'
    ]
    const swift = await fx.raw(
      JSON.stringify({
        cmd: 'parity',
        roots,
        contents,
        files: files.map((f) => Buffer.from(f).toString('base64'))
      })
    )
    const alphaID = '6b529731176ae2d54c86846c3e4bd5c26f91359808d8bf7f8d0b517787bdf7ea'
    assert.deepEqual(
      swift.ids,
      [
        alphaID,
        alphaID,
        alphaID,
        alphaID,
        '5f1d07c00650a7ef1a17bb15492c9450c24aa2f31f7272cca67b83c32937b651',
        '8a5edab282632443219e051e4ade2d1d5bbc671c781051bf1437897cbdfea0f1',
        '7001dee080df793ac1b55969c808a5ebb474399c28909b6f81b55c4773624e0c'
      ],
      'file IDs'
    )
    assert.deepEqual(swift.ids, roots.map(memoryFileId))
    assert.deepEqual(
      swift.encoded.map((b) => Buffer.from(b, 'base64').toString('utf8')),
      contents.map((c) => storedBytes(c).toString('utf8')),
      'stored bytes'
    )
    const verdicts = [
      null,
      { content: 'a', updatedAt: 1 },
      { content: 'a', updatedAt: 1.5e300 },
      { content: 'b', updatedAt: 2 },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      { content: 'z'.repeat(16_000), updatedAt: 3 },
      { content: '\ud800', updatedAt: 4 }
    ]
    assert.deepEqual(swift.decoded, verdicts, 'reader verdicts and bounded content')
    await fx.close()
    console.log(
      'MEMORY-OWNER format: file IDs, stored bytes and reader verdicts match the recorded format PASS'
    )
  }

  // --- Owner basics: import, save, receipts, stale revisions, no-op, isolation ---
  {
    const dir = profile({ [alpha]: record('- Earlier decision', 7) })
    const before = bytes(dir, alpha)
    const fx = await start(dir)
    const first = ok(await fx.read(alpha))
    assert.equal(first.content, '- Earlier decision')
    assert.equal(first.updatedAt, 7)
    assert.deepEqual(bytes(dir, alpha), before, 'import writes nothing')
    const empty = ok(await fx.read(beta))
    assert.deepEqual([empty.content, empty.updatedAt, empty.digest], ['', 0, 'absent'])

    const opID = randomUUID()
    const saved = await fx.op('save', alpha, '  - Manual decision  ', first.revision, opID)
    const payload = ok(saved)
    assert.deepEqual(
      bytes(dir, alpha),
      storedBytes('- Manual decision'),
      'Swift writes the recorded bytes'
    )
    assert.equal(saved.snapshot.content, '- Manual decision')
    assert.equal(payload.changed, true)
    assert.deepEqual(
      ok(await fx.op('save', alpha, '  - Manual decision  ', first.revision, opID)),
      payload,
      'a retried operation returns its receipt'
    )
    assert.equal(
      code(await fx.op('save', alpha, 'different', first.revision, opID)),
      'idempotencyMismatch'
    )
    const stale = await fx.op('save', alpha, 'Stale write', first.revision)
    assert.equal(code(stale), 'conflict')
    assert.equal(
      stale.snapshot.content,
      '- Manual decision',
      'a conflict carries the current record'
    )
    assert.deepEqual(bytes(dir, alpha), storedBytes('- Manual decision'))
    const noop = ok(await fx.op('save', alpha, '- Manual decision', payload.revision))
    assert.equal(noop.changed, false, 'an unchanged save commits without writing')
    assert.equal(bytes(dir, beta), null, 'other projects are untouched')
    assert.equal(
      ok(await fx.read(`${alpha}/`)).content,
      '- Manual decision',
      'a trailing slash is the same project'
    )
    assert.deepEqual(
      readdirSync(join(dir, 'trezi/project-memories')).sort(),
      [`${memoryFileId(alpha)}.json`],
      'no temp files left'
    )
    await fx.close()
    console.log(
      'MEMORY-OWNER basics: import without writing, recorded bytes, receipts, idempotency, stale revision, no-op PASS'
    )
  }

  // --- Manual edit wins against a stale evaluation ---
  {
    const dir = profile({ [alpha]: record('- Keep') })
    const fx = await start(dir)
    const evaluated = ok(await fx.read(alpha))
    const manual = ok(await fx.op('save', alpha, '- Keep\n- Manual', evaluated.revision))
    const late = await fx.op('propose', alpha, '- Keep\n- Generated', evaluated.revision)
    assert.equal(code(late), 'conflict', 'a proposal evaluated before the manual save is refused')
    assert.equal(late.snapshot.content, '- Keep\n- Manual')
    assert.deepEqual(bytes(dir, alpha), storedBytes('- Keep\n- Manual'))
    ok(await fx.op('propose', alpha, '- Keep\n- Manual\n- Generated', manual.revision))
    assert.equal(
      ok(await fx.read(alpha)).content,
      '- Keep\n- Manual\n- Generated',
      'a current proposal commits'
    )
    const current = ok(await fx.read(alpha))
    assert.equal(
      code(await fx.op('propose', alpha, '  \n ', current.revision)),
      'invalidRequest',
      'a proposal can never erase memory'
    )
    ok(await fx.op('save', alpha, '', current.revision))
    assert.equal(ok(await fx.read(alpha)).content, '', 'a manual save may clear memory')

    // The same revision raced from both sides: exactly one commits, in either order.
    for (const order of [
      ['propose', 'save'],
      ['save', 'propose']
    ]) {
      const base = ok(await fx.read(alpha))
      const frames = order.map((method) =>
        JSON.stringify(fx.frame(method, { root: alpha, content: `- ${method}` }, base.revision))
      )
      const { replies } = await fx.raw(JSON.stringify({ cmd: 'concurrent', frames }))
      assert.deepEqual(
        replies.map((r) => r.reply.result.kind).sort(),
        ['failed', 'succeeded'],
        `${order}: one commits`
      )
      assert.equal(
        replies.find((r) => r.reply.result.kind === 'failed').reply.result.payload.code,
        'conflict'
      )
    }
    await fx.close()
    console.log(
      'MEMORY-OWNER ordering: stale proposal refused, manual save kept, current proposal commits, one of two racers commits PASS'
    )
  }

  // --- Strict frames ---
  {
    const dir = profile()
    const fx = await start(dir)
    const revision = ok(await fx.read(alpha)).revision
    const frame = fx.frame('save', { root: alpha, content: 'x' }, revision)
    const invalid = [
      { ...frame, extra: 1 },
      { ...frame, request: { ...frame.request, body: { root: alpha, content: 'x', extra: 1 } } },
      { ...frame, request: { ...frame.request, body: { root: 'relative', content: 'x' } } },
      {
        ...frame,
        request: { ...frame.request, body: { root: alpha, content: 'x'.repeat(64_001) } }
      },
      { ...frame, request: { ...frame.request, mode: 'read' } },
      { ...frame, request: { ...frame.request, method: 'adopt' } },
      { ...frame, request: { ...frame.request, expectedRevision: undefined } },
      fx.frame('read', { root: alpha }, revision),
      fx.frame('read', { root: alpha, extra: true })
    ]
    for (const bad of invalid)
      assert.equal(
        code(await fx.send(JSON.parse(JSON.stringify(bad)))),
        'invalidRequest',
        JSON.stringify(bad).slice(0, 200)
      )
    assert.equal(
      code(await fx.send({ ...frame, request: { ...frame.request, scope: { project: 'p' } } })),
      'unauthorized'
    )
    assert.equal(bytes(dir, alpha), null, 'refused frames write nothing')
    await fx.close()
    console.log(
      'MEMORY-OWNER strict frames: unknown fields, invalid roots/limits, mode pairing, internal methods, scope PASS'
    )
  }

  // --- Damaged and external files ---
  {
    const damaged = '{"content":'
    const dir = profile({ [alpha]: damaged })
    const fx = await start(dir)
    const read = await fx.read(alpha)
    assert.equal(code(read), 'recoveryRequired')
    assert.match(read.reply.result.payload.message, /left untouched/)
    const revision = ok(await fx.read(beta)).revision
    assert.equal(code(await fx.op('save', alpha, 'Overwrite?', revision)), 'recoveryRequired')
    assert.equal(bytes(dir, alpha).toString(), damaged, 'a damaged file is never replaced')
    assert.equal(ok(await fx.read(beta)).content, '', 'other projects keep working')
    writeFileSync(memoryFile(dir, alpha), record('- Repaired', 9))
    const repaired = ok(await fx.read(alpha))
    assert.equal(repaired.content, '- Repaired', 'a repaired file is adopted')

    // An external write (another owner, a user edit) is adopted, never overwritten.
    writeFileSync(memoryFile(dir, alpha), record('- External', 10))
    const conflict = await fx.op('save', alpha, '- Mine', repaired.revision)
    assert.equal(code(conflict), 'conflict')
    assert.equal(conflict.snapshot.content, '- External')
    assert.equal(
      bytes(dir, alpha).toString(),
      record('- External', 10),
      'the external write is kept'
    )
    ok(await fx.op('save', alpha, '- Mine', conflict.snapshot.revision))
    rmSync(memoryFile(dir, alpha))
    assert.equal(
      ok(await fx.read(alpha)).digest,
      'absent',
      'an external removal is adopted as empty'
    )
    await fx.close()
    console.log(
      'MEMORY-OWNER damaged/external: refused and untouched, repair adopted, external edit adopted not overwritten PASS'
    )
  }

  // --- The session store alias: never created beside an older store ---
  {
    const dir = profile({}, { sessions: false })
    mkdirSync(join(dir, 'praxis'))
    let fx = await start(dir)
    const revision = ok(await fx.read(alpha)).revision
    assert.equal(code(await fx.op('save', alpha, '- Early', revision)), 'unavailable')
    assert.ok(!existsSync(join(dir, 'trezi')), 'no second session store')
    await fx.close()
    symlinkSync(join(dir, 'praxis'), join(dir, 'trezi'))
    fx = await start(dir)
    ok(await fx.op('save', alpha, '- Aliased', ok(await fx.read(alpha)).revision))
    assert.ok(
      existsSync(join(dir, 'praxis/project-memories', `${memoryFileId(alpha)}.json`)),
      'written through the alias'
    )
    await fx.close()
    const fresh = profile({}, { sessions: false })
    fx = await start(fresh)
    ok(await fx.op('save', alpha, '- Fresh', ok(await fx.read(alpha)).revision))
    assert.deepEqual(bytes(fresh, alpha), storedBytes('- Fresh'), 'a fresh profile gets its store')
    await fx.close()
    console.log(
      'MEMORY-OWNER session store: refuses beside a legacy store, writes through the alias, creates a fresh one PASS'
    )
  }

  // --- Interrupted persistence: injected failures and SIGKILL at each boundary ---
  {
    for (const step of ['create', 'write', 'flush', 'rename']) {
      const dir = profile({ [alpha]: record('- Before') })
      const fx = await start(dir, { MEMORY_FAIL: step })
      const base = ok(await fx.read(alpha))
      const failed = await fx.op('save', alpha, '- After', base.revision)
      assert.equal(code(failed), 'ioFailure', step)
      assert.equal(failed.reply.result.payload.retryable, true)
      assert.equal(bytes(dir, alpha).toString(), record('- Before'), `${step}: nothing changed`)
      assert.deepEqual(
        readdirSync(join(dir, 'trezi/project-memories')).length,
        1,
        `${step}: no temp file`
      )
      ok(await fx.op('save', alpha, '- After', base.revision))
      assert.deepEqual(bytes(dir, alpha), storedBytes('- After'), `${step}: the retry succeeds`)
      await fx.close()
    }
    {
      const dir = profile({ [alpha]: record('- Before') })
      const fx = await start(dir, { MEMORY_FAIL: 'directory' })
      ok(await fx.op('save', alpha, '- After', ok(await fx.read(alpha)).revision))
      assert.deepEqual(
        bytes(dir, alpha),
        storedBytes('- After'),
        'a directory-sync failure keeps the visible commit'
      )
      await fx.close()
    }
    const expected = {
      intent: ['- Before', 'failed'],
      effect: ['- Before', 'failed'],
      'after-rename': ['- After', 'succeeded'],
      receipt: ['- After', 'succeeded']
    }
    for (const [point, [content, kind]] of Object.entries(expected)) {
      const dir = profile({ [alpha]: record('- Before') })
      let fx = await start(dir, { MEMORY_CRASH: point })
      const base = ok(await fx.read(alpha))
      const opID = randomUUID()
      await fx.crash(fx.frame('save', { root: alpha, content: '- After' }, base.revision, opID))
      fx = await start(dir)
      const now = ok(await fx.read(alpha))
      assert.equal(now.content, content, `${point}: reconciled from the file`)
      const retry = await fx.op('save', alpha, '- After', base.revision, opID)
      assert.equal(
        retry.reply.result.kind,
        kind,
        `${point}: the receipt tells the retry what happened`
      )
      assert.equal(ok(await fx.read(alpha)).content, content, `${point}: never replayed`)
      await fx.close()
    }
    // A crash after the rename, then an edit outside Trezi before the relaunch: that edit is kept.
    {
      const dir = profile({ [alpha]: record('- Before') })
      let fx = await start(dir, { MEMORY_CRASH: 'after-rename' })
      await fx.crash(
        fx.frame('save', { root: alpha, content: '- Swift' }, ok(await fx.read(alpha)).revision)
      )
      writeFileSync(memoryFile(dir, alpha), record('- External newer', NOW + 5))
      fx = await start(dir)
      assert.equal(ok(await fx.read(alpha)).content, '- External newer')
      assert.equal(bytes(dir, alpha).toString(), record('- External newer', NOW + 5))
      await fx.close()
    }
    console.log(
      'MEMORY-OWNER interrupted persistence: failed steps change nothing, SIGKILL at intent/effect/after-rename/receipt reconciled, newer external write kept PASS'
    )
  }

  // --- Service restart ---
  {
    const dir = profile({ [alpha]: record('- Old') })
    let fx = await start(dir)
    const opID = randomUUID()
    const base = ok(await fx.read(alpha))
    const saved = ok(await fx.op('save', alpha, '- Swift newest', base.revision, opID))
    await fx.close()
    fx = await start(dir)
    const restarted = ok(await fx.read(alpha))
    assert.deepEqual(
      [restarted.content, restarted.revision],
      ['- Swift newest', saved.revision],
      'restart keeps content and revision'
    )
    assert.deepEqual(
      ok(await fx.op('save', alpha, '- Swift newest', base.revision, opID)),
      saved,
      'and receipts'
    )
    await fx.close()

    // A write made while the service was down is adopted at the next launch.
    assert.deepEqual(bytes(dir, alpha), storedBytes('- Swift newest'))
    writeFileSync(memoryFile(dir, alpha), record('- Offline newer', NOW + 10))
    const newest = bytes(dir, alpha)
    fx = await start(dir)
    assert.equal(ok(await fx.read(alpha)).content, '- Offline newer', 'the newer file is adopted')
    assert.deepEqual(bytes(dir, alpha), newest, 'adoption rewrites nothing')
    await fx.close()
    console.log(
      'MEMORY-OWNER restart: content, revision and receipts survive; an offline write is adopted, not replaced PASS'
    )
  }

  // --- Bun's client, the evaluation queue and the editor against the real owner ---
  {
    const dir = profile({ [alpha]: record('- Keep') })
    const project = join(scratch, 'project')
    mkdirSync(project)
    let pipe = link(dir)
    await pipe.started
    const store = serviceProjectMemory(pipe, 2_000)
    assert.equal((await store.get(alpha)).content, '- Keep')
    await assert.rejects(store.get('relative'), /absolute/, 'invalid requests never leave Bun')
    await assert.rejects(store.save(alpha, 'x'.repeat(64_001)), /limited/)

    // Manual save during an evaluation: the service refuses the stale proposal; the queue re-evaluates.
    const queue = createProjectMemoryUpdateQueue(store)
    let evaluations = 0,
      started,
      release
    const running = new Promise((resolve) => {
      started = resolve
    })
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const evaluation = queue.enqueue(alpha, async (current) => {
      evaluations++
      if (evaluations === 1) {
        started()
        await gate
      }
      return `${current}\n- Generated`
    })
    await running
    await store.save(alpha, '- Keep\n- Manual')
    release()
    await evaluation
    assert.equal(evaluations, 2, 'the stale proposal forces one re-evaluation')
    assert.equal(
      (await store.get(alpha)).content,
      '- Keep\n- Manual\n- Generated',
      'manual wording kept, generated merged on top'
    )
    const stale = await store.get(alpha)
    await store.save(alpha, '- Manual only')
    assert.equal(
      await store.propose(alpha, stale, '- Late'),
      null,
      'a stale proposal resolves null'
    )
    assert.equal((await store.get(alpha)).content, '- Manual only')
    await queue.enqueue(alpha, async () => {
      throw new Error('model unavailable')
    })
    assert.equal(
      (await store.get(alpha)).content,
      '- Manual only',
      'a failed evaluation is a no-op'
    )

    // A manual save is an intent: an external edit in between is adopted, then overwritten by the user's text.
    writeFileSync(memoryFile(dir, alpha), record('- External', 3))
    assert.equal((await store.save(alpha, '- Mine')).content, '- Mine')

    // No answer: the save fails and nothing is written locally.
    const before = bytes(dir, alpha)
    pipe.hold()
    await assert.rejects(
      store.save(alpha, '- Timed out'),
      (error) =>
        error.code === 'deadlineExceeded' && /Nothing was written locally/.test(error.message)
    )
    assert.deepEqual(bytes(dir, alpha), before, 'no fallback write after a timeout')
    pipe.flush()
    await pipe.close()
    assert.ok(!existsSync(join(project, '.trezi')), 'nothing is written into a project')

    // The editor: a failed autosave keeps the draft, and closing retries it.
    pipe = link(dir, { MEMORY_FAIL: 'rename' })
    await pipe.started
    const editor = serviceProjectMemory(pipe, 2_000)
    const invoke = async (channel, ...args) =>
      channel === 'project-memory:get' ? editor.get(args[0]) : editor.save(args[0], args[1])
    const workspace = {
      state: { projects: [{ key: alpha, root: alpha, name: 'alpha' }] },
      reportError() {}
    }
    const sheets = new NativeSheetController({ send() {} }, workspace, {}, invoke)
    await sheets.memory(alpha)
    const id = sheets.current.state.id
    const saved = bytes(dir, alpha)
    await sheets.action({ id, action: 'change', values: { content: '- Draft that must survive' } })
    assert.match(sheets.current.state.message, /Could not save.*draft is still here/)
    assert.deepEqual(bytes(dir, alpha), saved, 'the failed save changed nothing')
    await sheets.action({ id, action: 'cancel', values: {} })
    assert.equal(sheets.current, null, 'closing retries the kept draft')
    assert.equal((await editor.get(alpha)).content, '- Draft that must survive')
    await pipe.close()

    // A damaged file: the editor refuses to open over it and it is left untouched.
    writeFileSync(memoryFile(dir, alpha), 'not json')
    pipe = link(dir)
    await pipe.started
    const damaged = serviceProjectMemory(pipe, 2_000)
    const refused = new NativeSheetController(
      { send() {} },
      workspace,
      {},
      async (channel, ...args) =>
        channel === 'project-memory:get' ? damaged.get(args[0]) : damaged.save(args[0], args[1])
    )
    await assert.rejects(refused.memory(alpha), /left untouched/)
    assert.equal(refused.current, null)
    await createProjectMemoryUpdateQueue(damaged).enqueue(alpha, async () => '- Generated')
    assert.equal(bytes(dir, alpha).toString(), 'not json')
    await pipe.close()
    console.log(
      'MEMORY-OWNER Bun client: serialized requests, stale proposal re-evaluated, manual intent retried, timeout without fallback, failed autosave keeps and retries the draft, damaged file refused PASS'
    )
  }
} finally {
  for (const child of live) child.kill('SIGKILL')
  rmSync(scratch, { recursive: true, force: true })
}
