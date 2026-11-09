// LKM-581: an inspector Styles draft and its Apply belong to the element that was selected
// when they started. A selection change while staging, Apply's source preflight or the
// Apply confirmation is awaiting a source read must not move the draft, the prompt or the
// confirmation onto the newly selected element. Drives the real NativeInspectorController
// with a source owner whose reads are released by hand (no sleeps, no desktop, no provider).
import assert from 'node:assert/strict'
import { setSourceOwner } from '../src/main/source-owner.ts'
import { NativeInspectorController } from '../src/native/inspector-controller.ts'

const gate = () => {
  let open
  const promise = new Promise((resolve) => {
    open = resolve
  })
  return { promise, open }
}
let held = null
/** The next source read waits until `release()`; `entered` resolves once it is waiting.
 *  `hash` overrides what that one read answers (a file that drifted on disk). */
const hold = (hash) => {
  const entered = gate(),
    release = gate()
  held = { entered, release, hash }
  return { entered: entered.promise, release: () => release.open() }
}
let authoredHash = 'base'
let authoredOpacity = '1'
let authoredWidth = '10px'
setSourceOwner({
  read: async (_root, file) => {
    const wait = held
    held = null
    if (wait) {
      wait.entered.open()
      await wait.release.promise
    }
    return { path: file, hash: wait?.hash ?? authoredHash, binary: false, size: 10 }
  }
})

// Two elements in the same file: every file/binding guard passes for both, so only
// element identity tells them apart.
const A = {
  tag: 'div',
  id: 'a',
  classes: [],
  source: 'card.tsx:3',
  componentSource: null,
  styles: {},
  selector: 'div#a',
  text: null,
  rect: { x: 0, y: 0, width: 10, height: 10 }
}
const B = { ...A, id: 'b', source: 'card.tsx:9', selector: 'div#b' }

const make = () => {
  const sent = [],
    prompts = []
  const c = new NativeInspectorController(
    async (channel) => {
      if (channel === 'styles:read')
        return {
          values: { opacity: authoredOpacity, width: authoredWidth, display: 'block' },
          specified: { opacity: authoredOpacity, width: authoredWidth }
        }
      if (channel === 'controls:list') return []
      return null
    },
    async (...args) => sent.push(args),
    () => {},
    async (_root, prompt) => {
      prompts.push(prompt)
      return `turn-${prompts.length}`
    },
    async () => {}
  )
  const act = (action, extra = {}) =>
    c.action({ root: '/p', generation: c.state.generation, action, ...extra })
  return { c, sent, prompts, act }
}
const previews = (sent, from) =>
  sent.slice(from).filter(([channel, body]) => channel === 'styles:preview' && body.prop)
const reset = () => {
  authoredHash = 'base'
  authoredOpacity = '1'
  authoredWidth = '10px'
}
const cases = []
const test = (name, run) => cases.push({ name, run })

test('control: a gated staging read and Apply without a selection change', async () => {
  const { c, prompts, act } = make()
  await c.activate('/p')
  await c.select(A)
  const h = hold()
  const staging = act('apply', { field: 'style:opacity', value: '0.4' })
  await h.entered
  h.release()
  await staging
  assert.equal(c.state.draft?.count, 1)
  const h2 = hold()
  const applying = act('apply-drafts')
  await h2.entered
  h2.release()
  await applying
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /Target div#a from card\.tsx:3/)
  assert.match(prompts[0], /card\.tsx \(staged against SHA-256 base\): set opacity to 0\.4/)
  authoredHash = 'applied'
  authoredOpacity = '0.4'
  await c.settleDraftTurn(true, 'turn-1')
  assert.equal(c.state.draft, undefined, 'confirmed Apply clears its draft')
})

test('staging: a selection change during the source read does not stage on the new element', async () => {
  const { c, sent, act } = make()
  await c.activate('/p')
  await c.select(A)
  const h = hold()
  const staging = act('apply', { field: 'style:opacity', value: '0.4' })
  await h.entered
  await c.select(B)
  const mark = sent.length
  h.release()
  await staging
  assert.equal(c.state.draft, undefined, "B must not inherit A's staged value")
  assert.deepEqual(previews(sent, mark), [], "A's value is not previewed on B")
  await c.select(A)
  assert.equal(c.state.draft, undefined, 'the interrupted gesture left no draft on A')
})

test('Apply: a selection change during the preflight read submits nothing', async () => {
  const { c, prompts, act } = make()
  await c.activate('/p')
  await c.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  const h = hold()
  const applying = act('apply-drafts')
  await h.entered
  await c.select(B)
  h.release()
  await applying
  assert.deepEqual(prompts, [], 'no Apply turn is started for a selection that moved')
  assert.equal(c.state.busy, false)
  await c.select(A)
  assert.equal(c.state.draft?.count, 1, "A's draft is still pending")
  assert.equal(c.state.draft?.submitted, false, "A's draft is not locked to a turn")
  await c.action({ root: '/p', generation: c.state.generation, action: 'apply-drafts' })
  assert.equal(prompts.length, 1, 'A can be applied again')
  assert.match(prompts[0], /Target div#a from card\.tsx:3/)
})

test('confirmation: a selection change during the confirming read keeps the newer draft', async () => {
  const { c, prompts, act } = make()
  await c.activate('/p')
  await c.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  await act('apply-drafts')
  assert.equal(prompts.length, 1)
  authoredHash = 'applied'
  authoredOpacity = '0.4'
  const h = hold()
  const settling = c.settleDraftTurn(true, 'turn-1')
  await h.entered
  await c.select(B)
  await c.action({
    root: '/p',
    generation: c.state.generation,
    action: 'apply',
    field: 'style:width',
    value: '12px'
  })
  assert.equal(c.state.draft?.count, 1)
  h.release()
  await settling
  assert.equal(c.state.draft?.count, 1, "the old confirmation cannot clear B's newer draft")
  assert.equal(c.state.draft?.submitted, false)
  await c.select(A)
  assert.equal(c.state.draft, undefined, "A's landed turn still confirms A when it returns")
  await c.select(B)
  assert.equal(c.state.draft?.count, 1, "B's draft is still pending")
})

test('confirmation: away and back during the confirming read still settles the draft', async () => {
  const { c, act } = make()
  await c.activate('/p')
  await c.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  await act('apply-drafts')
  authoredHash = 'applied'
  authoredOpacity = '0.4'
  const h = hold()
  const settling = c.settleDraftTurn(true, 'turn-1')
  await h.entered
  await c.select(B)
  await c.select(A)
  assert.equal(c.state.draft?.submitted, true, 'the restored draft is still locked to its turn')
  h.release()
  await settling
  assert.equal(c.state.draft, undefined, 'the landed turn confirms the restored draft')
})

test('control: a failed turn followed by a selection change unlocks on return', async () => {
  const { c, act } = make()
  await c.activate('/p')
  await c.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  await act('apply-drafts')
  const settling = c.settleDraftTurn(false, 'turn-1')
  await c.select(B)
  await settling
  await c.select(A)
  assert.equal(c.state.draft?.count, 1, 'the draft is still pending')
  assert.equal(c.state.draft?.submitted, false, 'a failed turn releases the lock')
})

test('gesture: a selection change during staging leaves the new element untouched', async () => {
  const { c, sent } = make()
  await c.activate('/p')
  await c.select(A)
  const h = hold()
  const gesture = c.gesture('width', '12')
  await h.entered
  await c.select(B)
  const mark = sent.length
  h.release()
  assert.equal(await gesture, false)
  assert.equal(c.state.draft, undefined)
  assert.equal(c.state.error, '', "A's gesture reports no error on B")
  assert.deepEqual(sent.slice(mark), [], "A's gesture sends nothing to B's page")
})

test('Apply: a drifted preflight read after a selection change does not flag B', async () => {
  const { c, prompts, act } = make()
  await c.activate('/p')
  await c.select(B)
  await act('apply', { field: 'style:width', value: '12px' })
  await c.select(A)
  await c.action({
    root: '/p',
    generation: c.state.generation,
    action: 'apply',
    field: 'style:opacity',
    value: '0.4'
  })
  const h = hold('drifted')
  const applying = c.action({ root: '/p', generation: c.state.generation, action: 'apply-drafts' })
  await h.entered
  await c.select(B)
  h.release()
  await applying
  assert.deepEqual(prompts, [])
  assert.equal(c.state.draft?.count, 1)
  assert.equal(c.state.draft?.conflict, false, "A's drifted read cannot mark B's draft stale")
})

test('invalidation: a drifted read for A after a selection change does not flag B', async () => {
  const { c, act } = make()
  await c.activate('/p')
  await c.select(B)
  await act('apply', { field: 'style:width', value: '12px' })
  await c.select(A)
  await c.action({
    root: '/p',
    generation: c.state.generation,
    action: 'apply',
    field: 'style:opacity',
    value: '0.4'
  })
  const h = hold('drifted')
  const invalidating = c.invalidated()
  await h.entered
  await c.select(B)
  h.release()
  await invalidating
  assert.equal(c.state.draft?.count, 1)
  assert.equal(c.state.draft?.conflict, false, "A's drifted read cannot mark B's draft stale")
})

let failed = 0
for (const { name, run } of cases) {
  reset()
  held = null
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n  ${error.message.split('\n').join('\n  ')}`)
  }
}
setSourceOwner(null)
if (failed) {
  console.log(`${failed} of ${cases.length} failed`)
  process.exit(1)
}
console.log(`${cases.length} passed`)
