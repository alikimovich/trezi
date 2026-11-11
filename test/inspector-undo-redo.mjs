// LKM-644: Edit → Undo (⌘Z) / Redo (⇧⌘Z) step the inspector's visual Styles draft one
// logical edit at a time. Drives the real NativeInspectorController against a fake preview
// page that applies `styles:preview` / `styles:clear-preview` like the preload (per-property
// overrides, `keep`, lifted `base` values, authored `specified` text that never includes an
// override). Checks the rendered value and the field value the island publishes together,
// the exact earlier unit / token choice / absence, grouping, the redo branch, Revert, a
// pending Apply A beneath B, the source-history boundary and project scope. No desktop,
// provider or sleeps.
import assert from 'node:assert/strict'
import { setSourceOwner } from '../src/main/source-owner.ts'
import { NativeInspectorController } from '../src/native/inspector-controller.ts'
import { DRAFT_STEP_LIMIT, DraftSteps } from '../src/native/inspector-history.ts'

let hash = 'h0'
/** When set, source reads wait for it (an XPC read still in flight). */
let gate = null
setSourceOwner({
  read: async (_root, file) => {
    if (gate) await gate
    return { path: file, hash, binary: false, size: 10 }
  }
})

const element = (id, line, root = '/p') => ({
  tag: 'div',
  id,
  classes: [],
  source: `${root}/src/card.tsx:${line}`,
  componentSource: null,
  styles: {},
  selector: `div#${id}`,
  text: null,
  rect: { x: 0, y: 0, width: 10, height: 10 }
})
const X = element('x', 3)
const Y = element('y', 9)

const make = () => {
  // The page without overrides: padding authored in a rule (2rem = 32px), margin not
  // authored at all (the browser default).
  const authored = { 'padding-top': '2rem', 'padding-bottom': '2rem' }
  const rendered = {
    'padding-top': '32px',
    'padding-bottom': '32px',
    'margin-top': '0px',
    'margin-bottom': '0px',
    display: 'block'
  }
  const overrides = new Map()
  const dispatched = []
  const sent = []
  let c
  const display = () => ({ ...rendered, ...Object.fromEntries(overrides) })
  c = new NativeInspectorController(
    async (channel) => {
      if (channel === 'styles:read') {
        if (!c.element) return null
        const base = {}
        for (const prop of overrides.keys()) base[prop] = rendered[prop]
        return {
          values: display(),
          specified: { ...authored },
          origins: {},
          ...(Object.keys(base).length ? { base } : {})
        }
      }
      if (channel === 'tokens:detect')
        return {
          source: 'css',
          groups: [
            {
              name: 'spacing',
              tokens: [
                { name: '--space-3', value: '0.75rem' },
                { name: '--space-8', value: '2rem' }
              ]
            }
          ]
        }
      if (channel === 'controls:list' || channel === 'controls:get') return []
      return null
    },
    async (channel, body) => {
      sent.push([channel, body])
      if (channel === 'styles:preview') overrides.set(body.prop, body.value)
      else if (channel === 'styles:clear-preview') {
        if (body?.prop) overrides.delete(body.prop)
        else
          for (const prop of [...overrides.keys()])
            if (!body?.keep?.includes(prop)) overrides.delete(prop)
      }
    },
    () => {},
    async (root, prompt) => {
      dispatched.push({ root, prompt })
      return `apply-${dispatched.length}`
    },
    async () => {}
  )
  c.expanded.add('padding')
  const act = (action, extra = {}) =>
    c.action({ root: c.state.root, generation: c.state.generation, action, ...extra })
  const field = (id) => c.state.fields.find((f) => f.id === id)?.value
  /** What the island shows and what the page renders, side by side. */
  const view = () => ({
    padding: field('style:padding-top'),
    margin: field('style:margin-vertical'),
    renderedPadding: display()['padding-top'],
    renderedMargin: display()['margin-top']
  })
  const drafts = () => Object.fromEntries([...c.drafts].map(([key, d]) => [key, d.value]))
  return { c, act, view, drafts, dispatched, sent, overrides, rendered, authored, display }
}
const original = {
  padding: '2rem',
  margin: '0',
  renderedPadding: '32px',
  renderedMargin: '0px'
}
const afterPadding = { ...original, padding: '0.75rem', renderedPadding: '0.75rem' }
const afterMargin = { ...afterPadding, margin: '12', renderedMargin: '12px' }

const cases = []
const test = (name, run) => cases.push({ name, run })
const start = async () => {
  hash = 'h0'
  const t = make()
  await t.c.activate('/p')
  await t.c.select(X)
  return t
}

test('padding then margin: ⌘Z twice restores each in turn, ⇧⌘Z replays in order', async () => {
  const { c, act, view } = await start()
  assert.deepEqual(view(), original)
  assert.deepEqual(c.state.history, { undo: false, redo: false, restored: 0 })
  await act('apply', { field: 'style:padding-top', value: '0.75rem' })
  assert.deepEqual(view(), afterPadding)
  await act('apply', { field: 'style:margin-vertical', value: '12' })
  assert.deepEqual(view(), afterMargin)
  // A page update read while both overrides are on: its computed margin is the override.
  await c.invalidated()
  assert.equal(c.state.history.undo, true)

  assert.deepEqual(await c.historyStep(true), { kind: 'stepped' })
  assert.deepEqual(view(), afterPadding, 'only the margin step was undone, field and page')
  assert.equal(c.state.history.restored, 1)
  assert.deepEqual(await c.historyStep(true), { kind: 'stepped' })
  assert.deepEqual(view(), original, 'padding back to the exact 2rem; margin absent again')
  assert.equal(c.state.history.undo, false)
  assert.equal(c.state.history.redo, true)
  assert.equal(c.state.draft?.count, 0, 'the footer stays for Redo')
  // Nothing left to undo, but its Redo still stands: the source history must not answer.
  assert.equal((await c.historyStep(true)).kind, 'blocked')

  assert.deepEqual(await c.historyStep(false), { kind: 'stepped' })
  assert.deepEqual(view(), afterPadding)
  assert.deepEqual(await c.historyStep(false), { kind: 'stepped' })
  assert.deepEqual(view(), afterMargin)
  assert.equal(c.state.history.redo, false)
  // The draft is still unsent: Redo never falls through to the project's source history.
  assert.deepEqual(await c.historyStep(false), {
    kind: 'blocked',
    reason: "Nothing more to redo in this element's style draft."
  })
  assert.equal(c.state.history.restored, 4, 'each step is published to the native fields')
})

test('the island Undo draft button takes the same step, and its field value follows', async () => {
  const { c, act, view } = await start()
  await act('apply', { field: 'style:padding-top', value: '0.75rem' })
  await act('apply', { field: 'style:margin-vertical', value: '12' })
  await c.invalidated()
  await act('undo-draft')
  assert.deepEqual(view(), afterPadding)
  await act('redo-draft')
  assert.deepEqual(view(), afterMargin)
})

test('grouping: previews are not steps; one commit is one; a repeated commit is none', async () => {
  const { c, act, view, drafts } = await start()
  for (const value of ['1rem', '0.9rem', '0.8rem']) {
    await act('preview', { field: 'style:padding-top', value })
  }
  await act('apply', { field: 'style:padding-top', value: '0.75rem' })
  await act('apply', { field: 'style:padding-top', value: '0.75rem' }) // Return, then blur
  assert.equal(c.steps.past.length, 1)
  // A spacing-handle drag stages one value at release.
  assert.equal(await c.gesture('padding-bottom', '8'), true)
  assert.equal(c.steps.past.length, 2)
  assert.deepEqual(drafts(), { 'style:padding-top': '0.75rem', 'style:padding-bottom': '8px' })
  await c.historyStep(true)
  assert.deepEqual(drafts(), { 'style:padding-top': '0.75rem' }, 'the drag is undone as one')
  await c.historyStep(true)
  assert.deepEqual(view(), original)
  assert.equal(c.steps.past.length, 0, 'Undo itself records nothing')
  assert.equal(c.steps.future.length, 2, 'Redo keeps both steps')
})

test('exact restore: unit, token choice and the earlier draft object come back', async () => {
  const { c, act } = await start()
  await act('token', { field: 'style:padding-top', value: '0' }) // --space-3 · 0.75rem
  const tokened = c.drafts.get('style:padding-top')
  assert.equal(tokened.value, '0.75rem')
  assert.equal(tokened.tokenChoice, '0')
  await act('apply', { field: 'style:padding-top', value: '12' }) // a bare number: px
  assert.equal(c.drafts.get('style:padding-top').value, '12px')
  assert.equal(c.drafts.get('style:padding-top').tokenChoice, undefined)
  await c.historyStep(true)
  assert.equal(c.drafts.get('style:padding-top'), tokened, 'the token-bound draft itself')
  assert.equal(c.drafts.get('style:padding-top').tokenChoice, '0')
  await c.historyStep(false)
  assert.equal(c.drafts.get('style:padding-top').value, '12px')
})

test('a new edit after Undo drops the redo branch; Revert is not a step', async () => {
  const { c, act, view, drafts } = await start()
  await act('apply', { field: 'style:padding-top', value: '0.75rem' })
  await act('apply', { field: 'style:margin-vertical', value: '12' })
  await c.historyStep(true)
  await act('apply', { field: 'style:margin-vertical', value: '4' })
  assert.equal(c.state.history.redo, false, 'the undone margin 12 is gone')
  assert.equal((await c.historyStep(false)).kind, 'blocked')
  assert.deepEqual(drafts(), { 'style:padding-top': '0.75rem', 'style:margin-vertical': '4' })
  const restored = c.state.history.restored
  await act('revert-draft')
  assert.deepEqual(view(), original)
  assert.deepEqual(c.state.history, { undo: false, redo: false, restored: restored + 1 })
  assert.deepEqual(await c.historyStep(true), { kind: 'none' }, 'nothing to undo after Revert')
})

test('pending A stays: undoing B shows A again, A is never re-sent, late A keeps B', async () => {
  const { c, act, view, dispatched, overrides, rendered, authored } = await start()
  await act('apply', { field: 'style:padding-top', value: '0.75rem' })
  await act('apply-drafts')
  assert.equal(dispatched.length, 1, 'A submitted once')
  assert.equal(c.state.history.undo, false, "A's steps are A's own")
  await act('apply', { field: 'style:margin-vertical', value: '12' })
  await act('apply', { field: 'style:padding-top', value: '1rem' })
  assert.equal(overrides.get('padding-top'), '1rem')
  await c.historyStep(true) // B's padding
  assert.equal(overrides.get('padding-top'), '0.75rem', "A's pending layer shows again")
  assert.equal(view().padding, '0.75rem')
  await c.historyStep(true) // B's margin
  assert.deepEqual(view(), afterPadding, 'all of B undone; A still shown')
  assert.deepEqual(await c.historyStep(true), {
    kind: 'blocked',
    reason: "Undo waits for the running Apply: its change is not in the project's history yet."
  })
  await c.historyStep(false)
  assert.equal(view().margin, '12')
  // A lands: the source moves and the page renders it; B and its redo step stay.
  hash = 'h1'
  await c.settleDraftTurn(true, 'apply-1')
  rendered['padding-top'] = '0.75rem'
  Object.assign(authored, { 'padding-top': '0.75rem' })
  await c.invalidated()
  assert.equal(dispatched.length, 1, 'no Apply job replayed by Undo/Redo')
  assert.equal(c.batches.length, 0, 'A retired once rendered')
  assert.equal(view().margin, '12')
  assert.equal(c.state.history.redo, true, "B's redo step survived A's completion")
  await c.historyStep(false)
  assert.equal(view().padding, '1rem', 'redo of B over the landed A (rebased hash)')
})

test('race: ⌘Z right after a commit waits for it, then undoes exactly that commit', async () => {
  const { c, act, drafts } = await start()
  await act('apply', { field: 'style:padding-top', value: '10px' })
  let open
  gate = new Promise((resolve) => (open = resolve))
  const committing = act('apply', { field: 'style:padding-top', value: '12px' })
  const stepping = c.historyStep(true)
  await new Promise((resolve) => setTimeout(resolve, 5))
  gate = null
  open()
  await committing
  assert.deepEqual(await stepping, { kind: 'stepped' })
  assert.deepEqual(drafts(), { 'style:padding-top': '10px' }, 'the 12 commit was undone, 10 kept')
  await c.historyStep(false)
  assert.deepEqual(drafts(), { 'style:padding-top': '12px' })
})

test('no source undo while redo steps, a queued Apply or a landed layer remain', async () => {
  const { c, act } = await start()
  await act('apply', { field: 'style:padding-top', value: '0.75rem' })
  await c.historyStep(true)
  assert.deepEqual(await c.historyStep(true), {
    kind: 'blocked',
    reason: "Nothing more to undo in this element's style draft."
  })
  await act('revert-draft')
  assert.equal(c.state.history.redo, false, 'Revert drops the pending Redo')
  assert.deepEqual(await c.historyStep(true), { kind: 'none' })
  await act('apply', { field: 'style:padding-top', value: '0.75rem' })
  await act('apply-drafts')
  hash = 'h1'
  await c.settleDraftTurn(true, 'apply-1')
  // Landed in source, not yet rendered by the page: its layer still shows.
  assert.match((await c.historyStep(true)).reason, /applied change to show in the preview/)
  hash = 'h0'
})

test('stale source: a step over a changed file stops with a reason and changes nothing', async () => {
  const { c, act, drafts } = await start()
  await act('apply', { field: 'style:padding-top', value: '0.75rem' })
  await act('apply', { field: 'style:margin-vertical', value: '12' })
  hash = 'edited-elsewhere'
  const before = drafts()
  const step = await c.historyStep(true)
  assert.equal(step.kind, 'blocked')
  assert.match(step.reason, /source file changed since that step\. Revert/)
  assert.deepEqual(drafts(), before)
  hash = 'h0'
})

test('scope: another element, an unsent draft elsewhere and another project', async () => {
  const { c, act, drafts } = await start()
  await act('apply', { field: 'style:padding-top', value: '0.75rem' })
  await c.select(Y)
  const step = await c.historyStep(true)
  assert.equal(step.kind, 'blocked', 'never a source undo under an unsent draft')
  assert.match(step.reason, /belongs to another element\. Select it to undo/)
  await c.select(X)
  assert.equal(c.state.history.undo, true, "X's steps came back with it")
  await c.historyStep(true)
  assert.deepEqual(drafts(), {})
  assert.equal(c.state.history.redo, true)
  await c.select(Y)
  await c.select(X)
  assert.equal(c.state.history.redo, true, 'redo-only history follows the element too')
  await c.historyStep(false)
  assert.deepEqual(drafts(), { 'style:padding-top': '0.75rem' })
  // Another project: nothing of /p is stepped there.
  c.suspend()
  await c.activate('/q')
  await c.select(element('x', 3, '/q'))
  assert.equal(c.state.history.undo, false)
  assert.deepEqual(await c.historyStep(true), { kind: 'none' })
})

test('bounded: the oldest step goes first', () => {
  const steps = new DraftSteps()
  for (let i = 0; i < DRAFT_STEP_LIMIT + 5; i++) steps.record(new Map([['f', { value: `${i}` }]]))
  assert.equal(steps.past.length, DRAFT_STEP_LIMIT)
  assert.equal(steps.past[0].get('f').value, '5')
})

test('preview page: ⌘Z / ⇧⌘Z outside a page field become one step; a field keeps its own', async () => {
  const posted = []
  let listener = null
  globalThis.webkit = { messageHandlers: { trezi: { postMessage: (m) => posted.push(m) } } }
  globalThis.window = { addEventListener: (_type, fn) => (listener = fn) }
  const { installHistoryKeys, historyStep } = await import('../src/preview/history-keys.ts')
  installHistoryKeys(
    () => false,
    () => false
  )
  const press = (key, { shift = false, tag = 'DIV', editable = false } = {}) => {
    const target = { tagName: tag, isContentEditable: editable }
    const event = {
      isTrusted: true,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: shift,
      key,
      target,
      defaultPrevented: false,
      composedPath: () => [target],
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    listener(event)
    return event.defaultPrevented
  }
  const steps = () => posted.map((m) => JSON.stringify(m)).filter((m) => /preview:history/.test(m))
  assert.equal(press('z'), true, 'taken, so WebKit does not also send it to the menu')
  assert.equal(press('Z', { shift: true }), true)
  assert.equal(steps().length, 2)
  assert.match(steps()[0], /"undo"/)
  assert.match(steps()[1], /"redo"/)
  assert.equal(press('z', { tag: 'INPUT' }), false, "a page field's own Undo")
  assert.equal(press('z', { editable: true }), false, 'contenteditable / Trezi text edit')
  assert.equal(steps().length, 2)
  assert.equal(
    historyStep({
      isTrusted: true,
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      key: 'z'
    }),
    null
  )
  assert.equal(
    historyStep({
      isTrusted: true,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      key: 'ArrowLeft'
    }),
    null
  )
  assert.equal(
    historyStep({
      isTrusted: true,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      key: 'ArrowLeft'
    }),
    'back'
  )
})

for (const { name, run } of cases) {
  try {
    await run()
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}
console.log(`INSPECTOR-UNDO-REDO PASS — ${cases.length} cases`)
