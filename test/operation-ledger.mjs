// S03 durable operation ledger: real processes, real files, SIGKILL at every
// durable boundary and restart. Foundation-only; no window, XPC or profile.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { skipUnlessDarwin } from './helpers/darwin.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'trezi-ledger-'))
const binary = join(scratch, 'ledger-fixture')
const live = new Set()
let cases = 0

function compile() {
  skipUnlessDarwin('the Swift operation ledger')
  const args = [
    'swiftc',
    '-module-cache-path',
    join(scratch, 'module-cache'),
    ...['ServiceContract', 'LedgerStore', 'OperationLedger', 'LedgerMirror'].map(
      (name) => `src/service/${name}.swift`
    ),
    'test/fixtures/operation-ledger/main.swift',
    '-o',
    binary
  ]
  const result = spawnSync('xcrun', args, { cwd: root, encoding: 'utf8', timeout: 300_000 })
  assert.equal(
    result.status,
    0,
    `swiftc: ${result.error || ''}\n${result.stdout}\n${result.stderr}`
  )
}

function place() {
  const base = join(scratch, `case-${++cases}`)
  mkdirSync(base)
  return {
    dir: join(base, 'ledger'),
    effects: join(base, 'effects'),
    trace: join(base, 'trace'),
    base
  }
}

function start(dir, env = {}) {
  const child = spawn(binary, [dir], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  live.add(child)
  const lines = [],
    waiters = []
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr += data
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line)
    for (const wake of waiters.splice(0)) wake()
  })
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      live.delete(child)
      resolve({ code, signal })
    })
  )
  let status = null
  exited.then((value) => {
    status = value
    for (const wake of waiters.splice(0)) wake()
  })
  return {
    async next(timeout = 15_000) {
      const deadline = Date.now() + timeout
      while (!lines.length) {
        assert.ok(
          !status,
          `fixture exited ${JSON.stringify(status)} while an answer was expected\n${stderr}`
        )
        assert.ok(Date.now() < deadline, `fixture answer timed out\n${stderr}`)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 50)
          waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      return JSON.parse(lines.shift())
    },
    send(command) {
      child.stdin.write(`${typeof command === 'string' ? command : JSON.stringify(command)}\n`)
      return this.next()
    },
    /** The command must kill the fixture at its injected boundary, without answering. */
    async crash(command) {
      child.stdin.write(`${JSON.stringify(command)}\n`)
      const result = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000))
      ])
      assert.equal(
        result?.signal,
        'SIGKILL',
        `expected an injected SIGKILL, got ${JSON.stringify(result)}\n${lines.join('\n')}\n${stderr}`
      )
      assert.equal(lines.length, 0, 'no reply escaped before the crash')
    },
    kill() {
      child.kill('SIGKILL')
      return exited
    },
    async close() {
      child.stdin.end()
      assert.equal((await exited).code, 0, stderr)
    },
    exited,
    get stderr() {
      return stderr
    }
  }
}

async function open(dir, env = {}) {
  const fixture = start(dir, env)
  const hello = await fixture.next()
  assert.equal(hello.open, 'ok', `${JSON.stringify(hello)}\n${fixture.stderr}`)
  fixture.epoch = hello.epoch
  fixture.quarantined = hello.quarantined
  return fixture
}

async function openFails(dir, env = {}) {
  const fixture = start(dir, env)
  const hello = await fixture.next()
  assert.equal(hello.open, 'failed')
  assert.equal((await fixture.exited).code, 3)
  return hello.error
}

const rev = (snapshot) => snapshot.revision
const effectCount = (where, id) =>
  existsSync(join(where.effects, id))
    ? readFileSync(join(where.effects, id), 'utf8').split('\n').filter(Boolean).length
    : 0
const perform = (id, expected, extra = {}) => ({
  cmd: 'perform',
  id,
  domain: 'd',
  expected,
  body: { step: id },
  external: true,
  ...extra
})
const code = (answer) => answer.result.payload.code
const files = (where) =>
  Object.fromEntries(
    readdirSync(where.dir)
      .filter((name) => name !== 'LOCK')
      .map((name) => [
        name,
        existsSync(join(where.dir, name)) && !name.endsWith('quarantine')
          ? createHash('sha256')
              .update(readFileSync(join(where.dir, name)))
              .digest('hex')
          : 'dir'
      ])
  )

try {
  compile()

  // --- Identity, conflict and restart ---------------------------------------
  {
    const where = place()
    let ledger = await open(where.dir)
    const initial = await ledger.send({ cmd: 'register', domain: 'd' })
    assert.equal(initial.revision.counter, '0')
    const a = randomUUID()
    const first = await ledger.send(perform(a, rev(initial)))
    assert.equal(first.op.phase, 'committed')
    assert.deepEqual(first.result, { kind: 'succeeded', payload: { count: 1, id: a } })
    assert.equal(first.op.reserved.counter, '1')
    const retry = await ledger.send(perform(a, rev(initial)))
    assert.deepEqual(
      retry.result,
      first.result,
      'same ID + same intent returns the recorded result'
    )
    assert.equal(effectCount(where, a), 1, 'a duplicate never repeats the effect')
    assert.equal(
      code(await ledger.send(perform(a, rev(initial), { body: { step: 'changed' } }))),
      'idempotencyMismatch'
    )
    const b = randomUUID()
    const stale = await ledger.send(perform(b, rev(initial)))
    assert.equal(code(stale), 'conflict')
    assert.equal(stale.failure.currentRevision.counter, '1')
    assert.equal(
      code(await ledger.send(perform(b, { epoch: randomUUID(), counter: '1' }))),
      'conflict',
      'another revision epoch conflicts'
    )
    assert.equal(effectCount(where, b), 0)
    assert.equal(
      code(await ledger.send({ ...perform(randomUUID(), rev(initial)), domain: 'missing' })),
      'notFound'
    )
    await ledger.close()

    ledger = await open(where.dir)
    assert.deepEqual(
      (await ledger.send(perform(a, rev(initial)))).result,
      first.result,
      'receipt survives restart'
    )
    assert.equal(
      code(await ledger.send(perform(a, rev(initial), { body: { step: 'changed' } }))),
      'idempotencyMismatch',
      'digest survives restart'
    )
    const after = await ledger.send({ cmd: 'snapshot', domain: 'd' })
    assert.deepEqual(after.revision, first.op.reserved)
    assert.deepEqual(after.value, { count: 1, last: a })
    assert.deepEqual(after.cursor, { serviceEpoch: ledger.epoch, sequence: '1' })
    const reregistered = await ledger.send({
      cmd: 'register',
      domain: 'd',
      checkpoint: { count: 99 }
    })
    assert.deepEqual(
      reregistered.value,
      after.value,
      'registration never resets an existing domain'
    )
    assert.equal(effectCount(where, a), 1)
    await ledger.close()
    console.log(
      'OPERATION-LEDGER identity: duplicate, mismatch, conflict, notFound and receipts across restart PASS'
    )
  }

  // --- Intent digest --------------------------------------------------------
  {
    const where = place()
    const ledger = await open(where.dir)
    const bodies =
      '[{"a":1,"b":[1,2]},{"b":[1,2],"a":1},{"a":1,"b":[2,1]},{"a":1,"b":[1,2],"c":null},{"s":"é"},{"s":"é"},{"n":0},{"n":-0},{"n":1.5}]'
    const [ab, ba, swapped, nulled, composed, decomposed, zero, negativeZero, fraction] =
      await ledger.send(`{"cmd":"digest","bodies":${bodies}}`)
    assert.equal(ab, ba, 'object key order is not intent')
    assert.notEqual(ab, swapped, 'array order is intent')
    assert.notEqual(ab, nulled, 'explicit null differs from absence')
    assert.notEqual(composed, decomposed, 'Unicode spelling is significant')
    assert.equal(zero, negativeZero)
    assert.notEqual(zero, fraction)
    await ledger.close()
  }

  // --- SIGKILL at each durable boundary, then restart -----------------------
  for (const boundary of ['intent', 'effect', 'effect-performed', 'receipt']) {
    const where = place()
    let ledger = await open(where.dir, { LEDGER_CRASH: boundary })
    const initial = await ledger.send({ cmd: 'register', domain: 'd' })
    const x = randomUUID()
    await ledger.crash(perform(x, rev(initial)))

    ledger = await open(where.dir)
    let status = await ledger.send({ cmd: 'status', id: x })
    const recoveries = await ledger.send({ cmd: 'recoveries' })
    const y = randomUUID()
    if (boundary === 'intent') {
      assert.equal(
        status.op.phase,
        'abandoned',
        'an intent without an effect is abandoned, never run later'
      )
      assert.deepEqual(recoveries, [])
      const again = await ledger.send(perform(x, rev(initial)))
      assert.equal(again.op.phase, 'abandoned', 'stable outcome for the same ID')
      assert.equal(code(again), 'unavailable')
      assert.equal(again.result.payload.retryable, true)
      assert.equal(effectCount(where, x), 0)
      assert.equal(
        (await ledger.send(perform(y, rev(initial)))).op.phase,
        'committed',
        'revision was not consumed'
      )
    } else if (boundary === 'effect' || boundary === 'effect-performed') {
      assert.equal(status.op.phase, 'uncertain', 'an effect without a receipt is uncertain')
      assert.deepEqual(
        recoveries.map((op) => op.id),
        [x]
      )
      const again = await ledger.send(perform(x, rev(initial)))
      assert.equal(code(again), 'recoveryRequired', 'the same ID is never replayed blindly')
      assert.equal(again.result.payload.recoveryID, x)
      const blocked = await ledger.send(perform(y, rev(initial)))
      assert.equal(code(blocked), 'recoveryRequired', 'later mutations wait for reconciliation')
      assert.equal(blocked.failure.recoveryID, x)
      await ledger.close()
      ledger = await open(where.dir)
      assert.equal(
        (await ledger.send({ cmd: 'status', id: x })).op.phase,
        'uncertain',
        'uncertainty survives another restart'
      )
      const reconciled = await ledger.send({ cmd: 'reconcile', id: x })
      if (boundary === 'effect') {
        assert.equal(reconciled.op.phase, 'failed', 'reconciled: the effect never happened')
        assert.equal(effectCount(where, x), 0)
        assert.equal((await ledger.send(perform(y, rev(initial)))).op.phase, 'committed')
      } else {
        assert.equal(
          reconciled.op.phase,
          'committed',
          'reconciled: the effect happened exactly once'
        )
        assert.equal(reconciled.op.reserved.counter, '1')
        assert.equal(effectCount(where, x), 1)
        assert.deepEqual((await ledger.send(perform(x, rev(initial)))).result, reconciled.result)
        assert.equal(code(await ledger.send(perform(y, rev(initial)))), 'conflict')
        assert.equal((await ledger.send(perform(y, reconciled.op.reserved))).op.phase, 'committed')
      }
      assert.deepEqual(await ledger.send({ cmd: 'recoveries' }), [])
    } else {
      assert.equal(
        status.op.phase,
        'committed',
        'a synced receipt is the outcome even if the reply was lost'
      )
      assert.deepEqual(recoveries, [])
      const again = await ledger.send(perform(x, rev(initial)))
      assert.deepEqual(again.result, { kind: 'succeeded', payload: { count: 1, id: x } })
      assert.equal(effectCount(where, x), 1)
    }
    await ledger.close()
    ledger = await open(where.dir)
    status = await ledger.send({ cmd: 'status', id: x })
    assert.ok(
      ['abandoned', 'failed', 'committed'].includes(status.op.phase),
      `recovery was persisted: ${status.op.phase}`
    )
    await ledger.close()
  }
  console.log(
    'OPERATION-LEDGER crash boundaries: intent, effect, effect-performed, receipt with restart and reconciliation PASS'
  )

  // --- Unplanned SIGKILL at arbitrary points --------------------------------
  for (let round = 0; round < 8; round++) {
    const where = place()
    let ledger = await open(where.dir)
    const initial = await ledger.send({ cmd: 'register', domain: 'd' })
    const x = randomUUID()
    ledger.send(perform(x, rev(initial), { prepareMs: 20, effectMs: 20 })).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, round * 9))
    await ledger.kill()
    ledger = await open(where.dir)
    let status = await ledger.send({ cmd: 'status', id: x })
    if (status.op?.phase === 'uncertain') await ledger.send({ cmd: 'reconcile', id: x })
    status = await ledger.send({ cmd: 'status', id: x })
    const snapshot = await ledger.send({ cmd: 'snapshot', domain: 'd' })
    const committed = status.op?.phase === 'committed'
    assert.ok(
      status.status === 'unknown' || ['abandoned', 'failed', 'committed'].includes(status.op.phase),
      JSON.stringify(status)
    )
    assert.equal(
      effectCount(where, x),
      committed ? 1 : 0,
      'effect exists exactly when the ledger says committed'
    )
    assert.equal(snapshot.value.count ?? 0, committed ? 1 : 0)
    await ledger.close()
  }
  console.log('OPERATION-LEDGER unplanned SIGKILL: effect and ledger agree after recovery PASS')

  // --- Commits serialize across actor suspension ----------------------------
  {
    const where = place()
    const ledger = await open(where.dir)
    const initial = await ledger.send({ cmd: 'register', domain: 'd' })
    // Failures leave the revision alone, so every body runs; each sleeps (suspends
    // the actor) yet no two bodies overlap.
    const failing = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const outcomes = await ledger.send({
      cmd: 'race',
      ops: failing.map((id) => perform(id, rev(initial), { prepareMs: 40, fail: 'before' }))
    })
    assert.deepEqual(
      outcomes.map((outcome) => outcome.op.phase),
      ['failed', 'failed', 'failed', 'failed']
    )
    const trace = readFileSync(where.trace, 'utf8').trim().split('\n')
    assert.equal(trace.length, 8)
    for (let i = 0; i < trace.length; i += 2) {
      assert.equal(
        trace[i].replace('start ', ''),
        trace[i + 1].replace('end ', ''),
        `effects never interleave: ${trace.join(', ')}`
      )
    }
    const next = rev(initial)
    const contenders = [randomUUID(), randomUUID(), randomUUID()]
    const race = await ledger.send({
      cmd: 'race',
      ops: contenders.map((id) => perform(id, next, { prepareMs: 30 }))
    })
    assert.equal(
      race.filter((outcome) => outcome.op?.phase === 'committed').length,
      1,
      'one expected revision admits one commit'
    )
    assert.equal(
      race.filter((outcome) => outcome.kind === 'rejected' && code(outcome) === 'conflict').length,
      2
    )
    await ledger.close()
    console.log(
      'OPERATION-LEDGER serialization: FIFO lane across suspension, one commit per revision PASS'
    )
  }

  // --- Cancellation and effect errors ---------------------------------------
  {
    const where = place()
    let ledger = await open(where.dir)
    let head = rev(await ledger.send({ cmd: 'register', domain: 'd' }))
    const early = randomUUID()
    const origin = head
    const cancelled = await ledger.send({
      cmd: 'cancelDuring',
      afterMs: 60,
      op: perform(early, head, { prepareMs: 250 })
    })
    assert.equal(cancelled.cancel.kind, 'cancelled')
    assert.equal(cancelled.outcome.op.phase, 'cancelled', 'the late result is discarded')
    assert.equal(effectCount(where, early), 0, 'a cancelled operation never reaches its effect')
    assert.equal(
      code(await ledger.send(perform(early, head))),
      'cancelled',
      'stable cancelled outcome'
    )
    assert.deepEqual(rev(await ledger.send({ cmd: 'snapshot', domain: 'd' })), head)
    const late = randomUUID()
    const tooLate = await ledger.send({
      cmd: 'cancelDuring',
      afterMs: 60,
      op: perform(late, head, { effectMs: 250 })
    })
    assert.equal(tooLate.cancel.kind, 'tooLate')
    assert.equal(tooLate.outcome.op.phase, 'committed')
    assert.equal(effectCount(where, late), 1)
    head = tooLate.outcome.op.reserved
    assert.equal((await ledger.send({ cmd: 'cancel', id: late })).kind, 'finished')
    assert.equal((await ledger.send({ cmd: 'cancel', id: randomUUID() })).kind, 'notFound')

    const before = await ledger.send(perform(randomUUID(), head, { fail: 'before' }))
    assert.equal(before.op.phase, 'failed')
    const refused = await ledger.send(perform(randomUUID(), head, { fail: 'notApplied' }))
    assert.equal(refused.op.phase, 'failed', 'a known non-effect is final')
    assert.equal(code(refused), 'conflict')
    const unknown = randomUUID()
    const lost = await ledger.send(perform(unknown, head, { fail: 'unknown' }))
    assert.equal(
      lost.op.phase,
      'uncertain',
      'an unknown error after the effect began is not a failure'
    )
    assert.equal(code(await ledger.send(perform(randomUUID(), head))), 'recoveryRequired')
    await ledger.close()
    ledger = await open(where.dir)
    assert.equal(
      code(await ledger.send(perform(early, origin))),
      'cancelled',
      'cancellation survives restart'
    )
    const resolved = await ledger.send({ cmd: 'reconcile', id: unknown })
    assert.equal(resolved.op.phase, 'committed')
    assert.equal(effectCount(where, unknown), 1)
    await ledger.close()
    console.log(
      'OPERATION-LEDGER cancellation: before effect, too late, and effect-error classification PASS'
    )
  }

  // --- Event cursors, gaps, snapshots and the consumer mirror ---------------
  {
    const where = place()
    let ledger = await open(where.dir, { LEDGER_WINDOW: '2' })
    let head = rev(await ledger.send({ cmd: 'register', domain: 'd' }))
    const snapshots = []
    for (let i = 0; i < 3; i++) {
      head = (await ledger.send(perform(randomUUID(), head))).op.reserved
      snapshots.push(await ledger.send({ cmd: 'snapshot', domain: 'd' }))
    }
    const at = (sequence) => ({ serviceEpoch: ledger.epoch, sequence: String(sequence) })
    assert.equal(
      (await ledger.send({ cmd: 'events', cursor: at(0) })).delta,
      'snapshotRequired',
      'gap older than the window'
    )
    const deltas = await ledger.send({ cmd: 'events', cursor: at(1) })
    assert.deepEqual(
      deltas.events.map((event) => event.sequence),
      ['2', '3']
    )
    assert.deepEqual((await ledger.send({ cmd: 'events', cursor: at(3) })).events, [])
    assert.equal(
      (await ledger.send({ cmd: 'events', cursor: at(9) })).delta,
      'snapshotRequired',
      'a cursor from the future'
    )
    assert.equal(
      (await ledger.send({ cmd: 'events', cursor: { serviceEpoch: randomUUID(), sequence: '1' } }))
        .delta,
      'snapshotRequired',
      'another epoch'
    )
    await ledger.close()
    ledger = await open(where.dir, { LEDGER_WINDOW: '2' })
    assert.deepEqual(
      (await ledger.send({ cmd: 'events', cursor: at(1) })).events,
      deltas.events,
      'events and cursor survive restart'
    )

    const [second, third] = deltas.events
    const mirror = await ledger.send({
      cmd: 'mirror',
      domain: 'd',
      steps: [
        { kind: 'snapshot', value: snapshots[0] },
        { kind: 'event', value: third }, // gap
        { kind: 'event', value: second },
        { kind: 'event', value: third },
        { kind: 'event', value: second }, // duplicate/late
        { kind: 'snapshot', value: snapshots[0] }, // late snapshot
        { kind: 'ack', value: second.revision }, // late reply
        { kind: 'ack', value: { ...third.revision, counter: '9' } },
        { kind: 'event', value: { ...third, serviceEpoch: randomUUID(), sequence: '4' } }
      ]
    })
    assert.deepEqual(mirror.results, [
      'applied',
      'snapshotRequired',
      'applied',
      'applied',
      'stale',
      'stale',
      'stale',
      'snapshotRequired',
      'snapshotRequired'
    ])
    assert.deepEqual(mirror.revision, snapshots[2].revision)
    assert.deepEqual(
      mirror.value,
      snapshots[2].value,
      'late replies/snapshots never overwrite newer state'
    )
    await ledger.close()
    console.log(
      'OPERATION-LEDGER cursors: retained window, gaps, epochs, restart and mirror ordering PASS'
    )
  }

  // --- Retention horizon and compaction -------------------------------------
  {
    const where = place()
    let ledger = await open(where.dir, { LEDGER_NOW: '1000', LEDGER_HORIZON: '100' })
    const head = rev(await ledger.send({ cmd: 'register', domain: 'd' }))
    const old = randomUUID()
    const first = await ledger.send(perform(old, head))
    await ledger.close()
    ledger = await open(where.dir, { LEDGER_NOW: '1050', LEDGER_HORIZON: '100' })
    assert.deepEqual(
      (await ledger.send(perform(old, head))).result,
      first.result,
      'retained inside the horizon'
    )
    await ledger.close()
    ledger = await open(where.dir, { LEDGER_NOW: '2000', LEDGER_HORIZON: '100' })
    assert.equal((await ledger.send({ cmd: 'status', id: old })).status, 'expired')
    const expired = await ledger.send(perform(old, head))
    assert.equal(
      code(expired),
      'recoveryRequired',
      'an ID beyond the horizon is never executed again'
    )
    assert.equal(effectCount(where, old), 1)
    await ledger.close()

    const compacting = place()
    ledger = await open(compacting.dir, { LEDGER_COMPACT: '3', LEDGER_CRASH: 'snapshot' })
    const start = rev(await ledger.send({ cmd: 'register', domain: 'd' }))
    const c = randomUUID()
    await ledger.crash(perform(c, start))
    ledger = await open(compacting.dir, { LEDGER_COMPACT: '3' })
    assert.equal(
      (await ledger.send({ cmd: 'status', id: c })).op.phase,
      'committed',
      'crash between snapshot and journal reset'
    )
    let next = (await ledger.send({ cmd: 'snapshot', domain: 'd' })).revision
    const ids = []
    for (let i = 0; i < 7; i++) {
      ids.push(randomUUID())
      next = (await ledger.send(perform(ids.at(-1), next))).op.reserved
    }
    await ledger.close()
    ledger = await open(compacting.dir, { LEDGER_COMPACT: '3' })
    for (const id of [c, ...ids])
      assert.equal((await ledger.send({ cmd: 'status', id })).op.phase, 'committed')
    assert.deepEqual((await ledger.send({ cmd: 'snapshot', domain: 'd' })).value.count, 8)
    await ledger.close()
    console.log(
      'OPERATION-LEDGER retention: horizon expiry, compaction and snapshot-boundary crash PASS'
    )
  }

  // --- Damage: torn tail, corruption, newer format, lock --------------------
  {
    const where = place()
    let ledger = await open(where.dir)
    const head = rev(await ledger.send({ cmd: 'register', domain: 'd' }))
    const kept = randomUUID()
    await ledger.send(perform(kept, head))
    const other = await open(where.dir).catch((error) => error)
    assert.match(String(other), /busy/, 'a second opener is refused')
    await ledger.close()

    const journal = join(where.dir, 'journal.jsonl')
    appendFileSync(journal, '0123abc {"n":4,"kind":"intent"')
    const torn = readFileSync(journal)
    ledger = await open(where.dir)
    assert.equal(
      (await ledger.send({ cmd: 'status', id: kept })).op.phase,
      'committed',
      'acknowledged records survive a torn tail'
    )
    const quarantine = join(where.dir, 'quarantine')
    assert.deepEqual(
      readdirSync(quarantine).map((name) => readFileSync(join(quarantine, name)).equals(torn)),
      [true],
      'torn journal preserved byte-exact'
    )
    assert.ok(readFileSync(journal, 'utf8').endsWith('\n'))
    await ledger.close()

    const lines = readFileSync(journal, 'utf8').split('\n')
    lines[2] = lines[2].replace('"committed"', '"cancelled"').replace('"intent"', '"intemt"')
    writeFileSync(journal, lines.join('\n'))
    const before = files(where)
    assert.match(await openFails(where.dir), /corrupt/)
    assert.match(await openFails(where.dir), /corrupt/, 'no automatic repair on a second attempt')
    assert.deepEqual(files(where), before, 'a corrupt store is left untouched for diagnosis')
    ledger = await open(where.dir, { LEDGER_QUARANTINE: '1' })
    assert.ok(ledger.quarantined && existsSync(join(ledger.quarantined, 'journal.jsonl')))
    assert.equal(
      readFileSync(join(ledger.quarantined, 'journal.jsonl'), 'utf8'),
      lines.join('\n'),
      'quarantined whole'
    )
    assert.equal(
      await ledger.send({ cmd: 'snapshot', domain: 'd' }),
      null,
      'fresh ledger after explicit quarantine'
    )
    await ledger.close()

    const newer = place()
    ledger = await open(newer.dir)
    await ledger.send({ cmd: 'register', domain: 'd' })
    await ledger.close()
    const json = JSON.stringify({ format: 'trezi-ledger-2', generation: 9, epoch: 'x', state: {} })
    writeFileSync(
      join(newer.dir, 'snapshot.json'),
      `${createHash('sha256').update(json).digest('hex')} ${json}\n`
    )
    const newerBefore = files(newer)
    assert.match(
      await openFails(newer.dir),
      /unsupportedFormat/,
      'an older build never downgrades a newer store'
    )
    assert.deepEqual(files(newer), newerBefore)
    console.log(
      'OPERATION-LEDGER damage: lock, torn tail repair, corruption refusal, quarantine and newer format PASS'
    )
  }

  console.log('OPERATION-LEDGER PASS')
} finally {
  for (const child of live) child.kill('SIGKILL')
  rmSync(scratch, { recursive: true, force: true })
}
