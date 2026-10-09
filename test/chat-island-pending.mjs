import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { islandProblems } from '../src/main/chat-island-schema.ts'
import { ChatIslands } from '../src/main/chat-islands.ts'

// LKM-201: a pending island is defined before the source has its literals. The definition
// is validated at once; the island activates after its turn lands and every binding
// resolves, otherwise it is disabled with the reason (the island shows Recreate for it).
const root = await mkdtemp(join(tmpdir(), 'trezi-island-pending-'))
const file = join(root, 'card.js')
const before = 'export const Card = () => null\n'
const literals = 'const RADIUS = 12;\nconst LIFT = 0.4;\nexport const Card = () => null\n'
const request = (over = {}) => ({
  action: 'define',
  engine: 'agent',
  planned: true,
  manifest: {
    file: 'card.js',
    component: 'Card',
    title: 'Card shape',
    params: [
      {
        id: 'radius',
        label: 'Radius',
        kind: 'number',
        min: 0,
        max: 40,
        step: 1,
        apply: { strategy: 'literal', anchor: 'const RADIUS = ' }
      },
      {
        id: 'lift',
        label: 'Lift',
        kind: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        apply: { strategy: 'literal', anchor: 'const LIFT = ' }
      }
    ]
  },
  blocks: [{ id: 'shape', title: 'Shape', kind: 'group', params: ['radius', 'lift'] }],
  ...over
})
const RAW = /Error\b|\bat \S+ \(|ENOENT|undefined|\/Users\/|\/tmp\//
let n = 0
/** A fresh chat on the same project; `islands.settle` stands in for its turn's terminal. */
async function chat() {
  const islands = new ChatIslands(() => {})
  const key = `pending-${++n}`
  islands.register(key, root, `pending-record-${n}`, () => 1)
  await islands.sessions.get(key).opening
  return { islands, key, view: (id) => islands.sessions.get(key).views.get(id) }
}
const record = ({ islands, key }, id) => islands.sessions.get(key).records.find((r) => r.id === id)

try {
  // 1. An invalid definition answers at once with every problem, before any wait or edit:
  // this chat's workspace never becomes ready, and nothing is reserved.
  const waiting = new ChatIslands(() => {}, undefined, { locate: () => new Promise(() => {}) })
  const invalid = request({
    manifest: {
      ...request().manifest,
      params: [
        { ...request().manifest.params[0], kind: 'slider' },
        { ...request().manifest.params[1], apply: { strategy: 'literal', anchor: '' } }
      ]
    },
    blocks: [
      { id: 'shape', title: 'Shape', kind: 'group', params: ['radius'] },
      { id: 'tilt', title: 'Tilt', kind: 'point', params: ['radius'] },
      { id: 'other', title: 'Other', kind: 'group', params: ['nowhere'] }
    ]
  })
  const refused = await Promise.race([
    waiting.tool('nowhere', root, invalid),
    new Promise((resolve) => setTimeout(() => resolve('waited'), 2000))
  ])
  assert.notEqual(refused, 'waited', 'Validation never waits for the workspace')
  assert.equal(refused.code, 'invalid_definition', JSON.stringify(refused))
  assert.ok(refused.problems.length >= 3, JSON.stringify(refused.problems))
  assert.match(refused.problems.join('\n'), /params\[0\] \(radius\)/)
  assert.match(refused.problems.join('\n'), /params\[1\] \(lift\)/)
  assert.match(refused.problems.join('\n'), /blocks\[2\] \(other\): Unknown binding/)
  assert.match(refused.error, /nothing was reserved/)
  assert.equal(waiting.sessions.size, 0, 'Nothing attached or reserved')
  assert.deepEqual(islandProblems(request()), [], 'A valid definition has no problems')
  // A ready chat refuses the same way, with no record and no source change.
  await writeFile(file, before)
  const early = await chat()
  const again = await early.islands.tool(early.key, root, invalid)
  assert.equal(again.code, 'invalid_definition')
  assert.equal(early.islands.sessions.get(early.key).records.length, 0)
  assert.equal(await readFile(file, 'utf8'), before, 'No source edit')

  // Without planned, a binding the code does not have yet is refused with the way forward.
  const strict = await early.islands.tool(early.key, root, request({ planned: undefined }))
  assert.match(strict.error, /define with planned:true/, JSON.stringify(strict))

  // 2. pending -> active: reserved before the literals exist, active once the turn lands
  // with them, its initial values taken from the landed source.
  const one = await chat()
  const made = await one.islands.tool(one.key, root, request())
  assert.ok(made.id, JSON.stringify(made))
  assert.equal(made.status, 'pending')
  assert.deepEqual(made.bindings, { radius: 'planned', lift: 'planned' })
  assert.equal(one.view(made.id).status, 'waiting')
  assert.match(one.view(made.id).detail, /bindings are planned/)
  assert.equal(record(one, made.id).planned, true)
  await writeFile(file, literals)
  await one.islands.settle(one.key, true)
  const active = one.view(made.id)
  assert.equal(active.status, 'ready', JSON.stringify(active))
  assert.equal(active.fields.find((f) => f.id === 'radius').value, 12)
  assert.equal(record(one, made.id).planned, undefined, 'Activated: no longer planned')
  assert.deepEqual(record(one, made.id).initial, { radius: 12, lift: 0.4 })
  await one.islands.interact({
    chat: one.key,
    id: made.id,
    revision: active.revision,
    sourceRevision: active.sourceRevision,
    action: 'commit',
    values: { radius: 20 }
  })
  assert.match(await readFile(file, 'utf8'), /const RADIUS = 20;/, 'The active island writes')
  await one.islands.interact({
    chat: one.key,
    id: made.id,
    revision: active.revision,
    sourceRevision: one.view(made.id).sourceRevision,
    action: 'reset'
  })
  assert.match(await readFile(file, 'utf8'), /const RADIUS = 12;/, 'Reset uses the landed values')
  // A restart keeps it active.
  const reopened = new ChatIslands(() => {})
  reopened.register('reopened', root, `pending-record-${n}`, () => 2)
  await reopened.refresh('reopened')
  assert.equal(reopened.sessions.get('reopened').views.get(made.id).status, 'ready')
  reopened.close('reopened')

  // 3. pending -> failed: the turn lands but a binding does not resolve. The island is
  // disabled by the code with the reason (Recreate), and writes nothing.
  await writeFile(file, 'const RADIUS = 12;\nexport const Card = () => null\n')
  const two = await chat()
  const half = await two.islands.tool(two.key, root, request())
  assert.deepEqual(half.bindings, { radius: 'resolved', lift: 'planned' })
  await two.islands.settle(two.key, true)
  const failed = two.view(half.id)
  assert.equal(failed.status, 'disabled', JSON.stringify(failed))
  assert.equal(failed.disabledBy, 'code')
  assert.equal(failed.reason, 'These controls never activated: Lift is not in card.js.')
  assert.doesNotMatch(failed.reason, RAW)
  assert.match(failed.fields.find((f) => f.id === 'lift').disabled, /Lift is not in card\.js/)
  assert.equal(record(two, half.id).planned, true, 'Still planned: never activated')
  assert.equal(record(two, half.id).health, 'disabled', 'The failure persists with the record')
  await assert.rejects(
    two.islands.interact({
      chat: two.key,
      id: half.id,
      revision: failed.revision,
      sourceRevision: failed.sourceRevision,
      action: 'commit',
      values: { radius: 30 }
    }),
    /activate once their planned bindings resolve/
  )
  assert.match(await readFile(file, 'utf8'), /const RADIUS = 12;/, 'Nothing written')
  // Recreate: show refuses an island that never activated; clone makes a new pending one.
  const shown = await two.islands.tool(two.key, root, { action: 'show', id: half.id })
  assert.match(shown.error, /never activated/)
  const recreated = await two.islands.tool(two.key, root, {
    action: 'clone',
    id: half.name,
    planned: true
  })
  assert.equal(recreated.status, 'pending', JSON.stringify(recreated))

  // 4. pending -> failed: the turn does not land.
  const three = await chat()
  const lost = await three.islands.tool(three.key, root, request())
  await three.islands.settle(three.key, false)
  const unlanded = three.view(lost.id)
  assert.equal(unlanded.status, 'disabled')
  assert.equal(unlanded.disabledBy, 'code')
  assert.match(unlanded.reason, /did not land/)

  // 5. A planned file that never appears.
  const four = await chat()
  const missing = await four.islands.tool(
    four.key,
    root,
    request({ manifest: { ...request().manifest, file: 'later.js' } })
  )
  assert.deepEqual(
    missing.bindings,
    { radius: 'planned', lift: 'planned' },
    JSON.stringify(missing)
  )
  await four.islands.settle(four.key, true)
  assert.equal(
    four.view(missing.id).reason,
    'These controls never activated: later.js does not exist.'
  )
  // It still activates when a later edit brings the literals.
  await writeFile(join(root, 'later.js'), literals)
  await four.islands.refresh(four.key)
  assert.equal(four.view(missing.id).status, 'ready')
  assert.equal(record(four, missing.id).planned, undefined)

  for (const c of [early, one, two, three, four]) c.islands.close(c.key)
  console.log('CHAT-ISLAND-PENDING OK — immediate validation, pending -> active, pending -> failed')
} finally {
  await rm(root, { recursive: true, force: true })
}
