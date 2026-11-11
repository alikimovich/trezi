// LKM-638: a submitted inspector Apply (A) is an immutable batch; the inspector stays
// editable for the next draft (B), A's values stay on the preview until the page renders
// them itself, and B composes above A. Drives the real NativeInspectorController against a
// fake preview page that applies `styles:preview` / `styles:clear-preview` like the preload
// (per-property overrides, `keep`, lifted `base` values) and logs every value the element
// displays, so a snapback through the authored style is caught. Background Apply results
// are delivered by hand. No desktop, provider or sleeps.
import assert from 'node:assert/strict'
import { setSourceOwner } from '../src/main/source-owner.ts'
import { NativeInspectorController } from '../src/native/inspector-controller.ts'

/** The project: one file's hash, and what the dev server currently renders from it. */
let hash = 'h0'
/** When set, the next source read waits for `release()`; `entered` resolves once it waits. */
let held = null
const hold = () => {
  let entered, release
  const gate = {
    entered: new Promise((resolve) => (entered = resolve)),
    released: new Promise((resolve) => (release = resolve))
  }
  held = { ...gate, enter: entered }
  return { entered: gate.entered, release }
}
setSourceOwner({
  read: async (_root, file) => {
    const wait = held
    held = null
    if (wait) {
      wait.enter()
      await wait.released
    }
    return { path: file, hash, binary: false, size: 10 }
  }
})

const element = (id, line) => ({
  tag: 'div',
  id,
  classes: [],
  source: `/p/src/card.tsx:${line}`,
  componentSource: null,
  styles: {},
  selector: `div#${id}`,
  text: null,
  rect: { x: 0, y: 0, width: 10, height: 10 }
})
const X = element('x', 3)
const Y = element('y', 9)

const make = ({ inline = [] } = {}) => {
  // What the page renders per element without overrides (the served source).
  const rendered = {
    x: { width: '40px', opacity: '1', 'padding-top': '4px', 'padding-bottom': '4px' },
    y: { width: '80px', opacity: '1', 'padding-top': '4px', 'padding-bottom': '4px' }
  }
  const overrides = new Map() // prop → value, on `on`
  let on = null
  const shown = { x: [], y: [] } // per element: every change of a displayed value
  let c
  const display = (id) => {
    const values = { ...rendered[id] }
    if (on === id) for (const [prop, value] of overrides) values[prop] = value
    return values
  }
  const snapshot = () => {
    for (const id of ['x', 'y']) {
      const now = display(id)
      const last = shown[id].at(-1)
      if (!last || Object.keys(now).some((prop) => now[prop] !== last[prop])) shown[id].push(now)
    }
  }
  snapshot()
  const dispatched = []
  const sent = []
  c = new NativeInspectorController(
    async (channel) => {
      if (channel === 'styles:read') {
        const id = c.element?.id
        if (!id) return null
        const values = display(id)
        const base = {}
        if (on === id) for (const prop of overrides.keys()) base[prop] = rendered[id][prop]
        return {
          values,
          specified: { ...rendered[id] },
          origins: Object.fromEntries(inline.map((prop) => [prop, { kind: 'inline' }])),
          ...(Object.keys(base).length ? { base } : {})
        }
      }
      if (channel === 'controls:list') return []
      return null
    },
    async (channel, body) => {
      sent.push([channel, body])
      const id = c.element?.id ?? null
      if (channel === 'styles:preview') {
        if (on !== id) overrides.clear()
        on = id
        overrides.set(body.prop, body.value)
      } else if (channel === 'styles:clear-preview') {
        // An adopted inline value is the page's own now: it stays as displayed.
        for (const prop of body?.adopt ?? []) {
          if (on && overrides.has(prop)) rendered[on][prop] = overrides.get(prop)
          overrides.delete(prop)
        }
        if (body?.prop) overrides.delete(body.prop)
        else
          for (const prop of [...overrides.keys()])
            if (!body?.keep?.includes(prop)) overrides.delete(prop)
      }
      snapshot()
    },
    () => {},
    async (root, prompt, submit, action) => {
      dispatched.push({ root, prompt, submit, action })
      return `apply-${dispatched.length}`
    },
    async () => {}
  )
  c.expanded.add('padding')
  const act = (action, extra = {}) =>
    c.action({ root: '/p', generation: c.state.generation, action, ...extra })
  /** The dev server serves new source: the element renders `values` (HMR, no reload). */
  const serve = async (id, values) => {
    Object.assign(rendered[id], values)
    snapshot()
    await c.invalidated()
  }
  const field = (id) => c.state.fields.find((f) => f.id === id)?.value
  return { c, act, serve, shown, dispatched, sent, display, field }
}
/** Every value `prop` showed on `id`, in order, without repeats. */
const trail = (shown, id, prop) =>
  shown[id].map((v) => v[prop]).filter((value, i, all) => i === 0 || all[i - 1] !== value)

const cases = []
const test = (name, run) => cases.push({ name, run })

test('same property: A 10 then B 12 before A lands; display stays 12 while source catches up', async () => {
  const { c, act, serve, shown, dispatched, display, field } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  assert.equal(dispatched.length, 1)
  assert.match(dispatched[0].prompt, /staged against SHA-256 h0\): set width to 10px/)
  assert.equal(c.state.busy, false, 'the fields are not locked while A runs')
  assert.equal(c.state.draft?.count, 0)
  assert.equal(c.state.draft?.submitted, true)
  assert.equal(c.state.draft?.applying, 'Applying 1 value in the background')
  assert.equal(display('x').width, '10px', "A's value stays on the preview after handoff")
  // B, at once, on the same property: no "Wait for Apply" error.
  await act('apply', { field: 'style:width', value: '12' })
  assert.equal(c.state.error, '')
  assert.equal(c.state.draft?.count, 1)
  assert.equal(field('style:width'), '12px')
  assert.equal(display('x').width, '12px', 'B composes above A')
  // A lands before the preview updates: source moved, page still renders 40px.
  hash = 'h1'
  await c.settleDraftTurn(true, 'apply-1')
  assert.equal(c.state.draft?.landed, true)
  assert.match(c.state.draft?.applying ?? '', /^Applied to source, waiting for the preview$/)
  assert.equal(c.state.draft?.conflict, false, "A's own landing is not a conflict for B")
  assert.equal(display('x').width, '12px')
  // The preview now renders A's 10px; A retires, B still shows 12.
  await serve('x', { width: '10px' })
  assert.equal(c.state.draft?.landed, false, 'A retired once the page rendered it')
  assert.equal(c.state.draft?.count, 1, 'B is intact')
  assert.equal(display('x').width, '12px')
  // B gets its own batch and id, staged over A's landed version.
  await act('apply-drafts')
  assert.equal(dispatched.length, 2)
  assert.match(dispatched[1].prompt, /staged against SHA-256 h1\): set width to 12px/)
  hash = 'h2'
  await c.settleDraftTurn(true, 'apply-2')
  await serve('x', { width: '12px' })
  assert.equal(c.state.draft, undefined, 'both confirmed: nothing pending')
  assert.deepEqual(
    trail(shown, 'x', 'width'),
    ['40px', '10px', '12px'],
    'never back to 40px or 10px'
  )
})

test('different properties compose; A retires with no visible change', async () => {
  const { c, act, serve, shown, display } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:padding-top', value: '10' })
  await act('apply-drafts')
  await act('apply', { field: 'style:opacity', value: '0.5' })
  assert.deepEqual([display('x')['padding-top'], display('x').opacity], ['10px', '0.5'])
  hash = 'h1'
  await c.settleDraftTurn(true, 'apply-1')
  // An unrelated page update (another property) is not proof for A.
  await serve('x', { 'padding-bottom': '6px' })
  assert.equal(c.state.draft?.landed, true, 'A is still waiting for its own value')
  assert.equal(display('x')['padding-top'], '10px')
  await serve('x', { 'padding-top': '10px' })
  assert.equal(c.state.draft?.landed, false)
  assert.equal(c.state.draft?.count, 1)
  assert.equal(display('x').opacity, '0.5', 'B is untouched')
  assert.deepEqual(trail(shown, 'x', 'padding-top'), ['4px', '10px'], 'no flash through 4px')
})

test('a second Apply queues behind the running one, then lands in order with its own id', async () => {
  const { c, act, serve, dispatched, display } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  await act('apply', { field: 'style:opacity', value: '0.5' })
  await act('apply-drafts')
  assert.equal(dispatched.length, 1, 'B waits for A on the same file')
  assert.equal(c.state.draft?.count, 0)
  assert.match(c.state.draft?.applying ?? '', /^Applying 1 value in the background · 1 queued$/)
  assert.equal(display('x').width, '10px')
  assert.equal(display('x').opacity, '0.5')
  // A late result for an unknown id and a repeated press change nothing.
  await c.settleDraftTurn(true, 'apply-9')
  await act('apply-drafts')
  assert.equal(dispatched.length, 1)
  hash = 'h1'
  await c.settleDraftTurn(true, 'apply-1')
  assert.equal(dispatched.length, 2, 'B starts once A reported')
  assert.match(dispatched[1].prompt, /staged against SHA-256 h1\): set opacity to 0\.5/)
  assert.doesNotMatch(dispatched[1].prompt, /width/, "B never carries A's values")
  // A duplicate (late) A result neither completes B nor rolls anything back.
  await c.settleDraftTurn(false, 'apply-1', 'late')
  assert.equal(c.state.draft?.submitted, true)
  assert.equal(c.state.error, '')
  hash = 'h2'
  await c.settleDraftTurn(true, 'apply-2')
  await serve('x', { width: '10px', opacity: '0.5' })
  assert.equal(c.state.draft, undefined)
})

test('a failed A returns beneath B: B keeps its value, A is recoverable, nothing re-sent', async () => {
  const { c, act, shown, dispatched, display, field } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply', { field: 'style:opacity', value: '0.4' })
  await act('apply-drafts')
  await act('apply', { field: 'style:width', value: '12' })
  await c.settleDraftTurn(false, 'apply-1', 'Apply was cancelled. The draft is still pending.')
  assert.equal(dispatched.length, 1, 'no automatic re-POST')
  assert.match(c.state.error, /cancelled/)
  assert.equal(c.state.draft?.submitted, false)
  assert.equal(c.state.draft?.count, 2, "B's width and A's returned opacity")
  assert.equal(field('style:width'), '12px', 'B wins its own property')
  assert.equal(field('style:opacity'), '0.4')
  assert.deepEqual([display('x').width, display('x').opacity], ['12px', '0.4'])
  assert.deepEqual(trail(shown, 'x', 'opacity'), ['1', '0.4'], 'no flash on return')
  // Undo steps back B's edit; A's returned value stays below it.
  await act('undo-draft')
  assert.deepEqual([field('style:width'), field('style:opacity')], ['10px', '0.4'])
  await act('apply-drafts')
  assert.equal(dispatched.length, 2, 'an explicit Apply again')
  assert.match(
    dispatched[1].prompt,
    /set width to 10px[\s\S]*set opacity to 0\.4|set opacity to 0\.4[\s\S]*set width to 10px/
  )
})

test('Undo and Revert act on B only; A keeps showing', async () => {
  const { c, act, display, dispatched } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  await act('apply', { field: 'style:width', value: '12' })
  await act('apply', { field: 'style:opacity', value: '0.5' })
  await act('undo-draft')
  assert.equal(c.state.draft?.count, 1)
  assert.equal(display('x').opacity, '1')
  assert.equal(display('x').width, '12px')
  await act('revert-draft')
  assert.equal(c.state.draft?.count, 0)
  assert.equal(c.state.draft?.submitted, true, 'A is still running')
  assert.equal(display('x').width, '10px', "Revert falls back to A's pending value, not 40px")
  assert.equal(dispatched.length, 1)
})

test('a real external edit is a conflict, said as such; A in progress is not', async () => {
  const { c, act } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  await act('apply', { field: 'style:opacity', value: '0.5' })
  // Source moves while A runs: waiting on A, not a conflict.
  hash = 'h-during'
  await c.invalidated()
  assert.equal(c.state.draft?.conflict, false)
  await act('apply', { field: 'style:opacity', value: '0.6' })
  assert.equal(c.state.error, '')
  // A fails; the file moved by someone else: B (and A under it) are now stale.
  await c.settleDraftTurn(false, 'apply-1', 'Apply failed.')
  await c.invalidated()
  assert.equal(c.state.draft?.conflict, true)
  await act('apply', { field: 'style:opacity', value: '0.7' })
  assert.match(c.state.error, /Source changed outside this draft\. Revert the draft/)
  assert.doesNotMatch(c.state.error, /Wait for Apply/)
})

test('a landed batch whose source did not move is not success; it returns as pending', async () => {
  const { c, act, display } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  await c.settleDraftTurn(true, 'apply-1')
  assert.match(c.state.error, /did not confirm source/)
  assert.equal(c.state.draft?.count, 1)
  assert.equal(display('x').width, '10px')
})

test('a selection change: A follows only its own element and confirms there', async () => {
  const { c, act, serve, sent, display } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  await c.select(Y)
  const mark = sent.length
  assert.equal(c.state.draft, undefined, "A is not shown on Y's island")
  await act('apply', { field: 'style:opacity', value: '0.3' })
  assert.equal(display('y').width, '80px', "A's override never reaches Y")
  hash = 'h1'
  await c.settleDraftTurn(true, 'apply-1')
  assert.equal(c.state.draft?.count, 1, "Y's draft is intact")
  assert.ok(
    sent.slice(mark).every(([ch, body]) => ch !== 'styles:preview' || body.prop !== 'width'),
    "nothing of A's is previewed while Y is selected"
  )
  await serve('x', { width: '10px' })
  await c.select(X)
  assert.equal(c.state.draft, undefined, 'back on X, the rendered value retires A')
  await c.select(Y)
  assert.equal(c.state.draft?.count, 1)
  assert.equal(display('y').opacity, '0.3')
})

test('a same-element re-pick (reload) carries A; a different element with the same tag does not', async () => {
  const { c, act, display } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  assert.equal(await c.reattach({ ...X, selector: 'main > div:nth-of-type(2)' }), true)
  assert.equal(c.state.draft?.submitted, true)
  assert.equal(display('x').width, '10px')
  assert.equal(await c.reattach({ ...X, id: 'other' }), false)
  await c.select({ ...X, id: 'other', selector: 'div#other' })
  assert.equal(c.state.draft, undefined, 'the other element shows nothing of A')
  assert.equal(display('x').width, '40px', "A's override left with X's selection")
  await c.select({ ...X, selector: 'main > div:nth-of-type(2)' })
  assert.equal(c.state.draft?.submitted, true, 'X still owns A')
})

test('a queued batch needing a preview refresh waits for its element, then continues', async () => {
  const { c, act, dispatched } = make()
  const fresh = []
  c.previewFreshness = async () => fresh.shift() ?? 'current'
  const refreshed = []
  c.refreshPreview = async (_root, element) => {
    refreshed.push(element.id)
    return 'ok'
  }
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  await act('apply', { field: 'style:opacity', value: '0.5' })
  await act('apply-drafts')
  await c.select(Y)
  // A lands; B's preflight finds the preview out of date while X is not selected.
  fresh.push('stale')
  hash = 'h1'
  await c.settleDraftTurn(true, 'apply-1')
  assert.equal(dispatched.length, 1, 'B did not start without its element')
  assert.equal(refreshed.length, 0, "Y's preview is never refreshed for X's batch")
  assert.equal(c.state.error, '')
  // Selecting X continues B: one refresh for X, then its own dispatch.
  fresh.push('stale', 'current')
  await c.select(X)
  assert.equal(dispatched.length, 2)
  assert.deepEqual(refreshed, ['x'])
  assert.match(dispatched[1].prompt, /staged against SHA-256 h1\): set opacity to 0\.5/)
})

test('a failure reported during the success check wins; a duplicate success changes nothing', async () => {
  const { c, act, dispatched, display } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  hash = 'h1'
  const h = hold()
  const settling = c.settleDraftTurn(true, 'apply-1')
  await h.entered
  await c.settleDraftTurn(true, 'apply-1')
  await c.settleDraftTurn(false, 'apply-1', 'Apply was cancelled. The draft is still pending.')
  h.release()
  await settling
  assert.match(c.state.error, /cancelled/)
  assert.equal(c.state.draft?.count, 1)
  assert.equal(c.state.draft?.submitted, false)
  assert.equal(display('x').width, '10px')
  assert.equal(dispatched.length, 1)
})

test('a result without an id settles the running batch of the selected element', async () => {
  const { c, act } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  await c.settleDraftTurn(false)
  assert.equal(c.state.draft?.count, 1)
  assert.equal(c.state.draft?.submitted, false)
})

test('a draft staged on an intermediate version while A writes is not a false conflict', async () => {
  const { c, act } = make()
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  hash = 'h-mid' // the worker's first write
  await act('apply', { field: 'style:opacity', value: '0.5' })
  hash = 'h-final' // its last
  await c.settleDraftTurn(true, 'apply-1')
  await c.invalidated()
  assert.equal(c.state.draft?.conflict, false)
  await act('apply-drafts')
  assert.equal(c.state.error, '')
})

test('a JSX inline value retires by adoption after the page updated, never snapping back', async () => {
  const { c, act, serve, shown, display } = make({ inline: ['width'] })
  await c.activate('/p')
  await c.select(X)
  await act('apply', { field: 'style:width', value: '10' })
  await act('apply-drafts')
  hash = 'h1'
  await c.settleDraftTurn(true, 'apply-1')
  assert.equal(c.state.draft?.landed, true, 'the landing alone is not proof')
  // The re-render wrote the same inline value: the lifted read still says 40px.
  await serve('x', {})
  assert.equal(c.state.draft, undefined, 'retired after the page updated')
  assert.equal(display('x').width, '10px')
  assert.deepEqual(trail(shown, 'x', 'width'), ['40px', '10px'])
})

let failed = 0
for (const { name, run } of cases) {
  hash = 'h0'
  held = null
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n  ${error.stack?.split('\n').slice(0, 5).join('\n  ')}`)
  }
}
setSourceOwner(null)
if (failed) {
  console.log(`${failed} of ${cases.length} failed`)
  process.exit(1)
}
console.log(`${cases.length} passed`)
process.exit(0)
