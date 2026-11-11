/**
 * LKM-541: Selection-mode spacing handles. Geometry under scroll offsets and zoom,
 * the preview payload guard, and the inspector staging a released handle as the
 * same LKM-539 Styles draft (no source write or agent turn until one Apply).
 * Run via bun so the .ts imports transpile: bun run test:spacing-handles
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { setSourceOwner } from '../src/main/source-owner.ts'
import { NativeInspectorController } from '../src/native/inspector-controller.ts'
import {
  createSpacingHandles,
  dragValue,
  gapBetween,
  renderScale,
  spacingHandles
} from '../src/preview/spacing-handles.ts'
import { parseSpacingDraft } from '../src/shared/spacing-draft.ts'

const source = readFileSync(new URL('../src/preview/preload.ts', import.meta.url), 'utf8')
const box = (left, top, width, height) => ({ left, top, width, height })
const byProp = (handles) => Object.fromEntries(handles.map((h) => [h.prop, h]))

// Grips sit inside their padding band of the rendered (client) rect.
{
  const rect = box(100, -40, 200, 120) // scrolled: the top is above the viewport
  const handles = byProp(
    spacingHandles(rect, { top: 20, right: 10, bottom: 30, left: 16 }, 1, null)
  )
  assert.deepEqual(Object.keys(handles).sort(), [
    'padding-bottom',
    'padding-left',
    'padding-right',
    'padding-top'
  ])
  const top = handles['padding-top']
  assert.equal(top.axis, 'y')
  assert.equal(top.sign, 1)
  assert.equal(top.value, 20)
  assert.equal(top.box.top + top.box.height / 2, -40 + 10, 'centred in the top band')
  assert.equal(top.box.left + top.box.width / 2, 200, 'centred horizontally')
  const bottom = handles['padding-bottom']
  assert.equal(bottom.sign, -1, 'dragging the bottom grip up grows the padding')
  assert.equal(bottom.box.top + bottom.box.height / 2, 80 - 15)
  const right = handles['padding-right']
  assert.equal(right.axis, 'x')
  assert.equal(right.box.left + right.box.width / 2, 300 - 5)
}

// A 2× zoom doubles the rendered band; pointer pixels convert back to CSS pixels.
{
  assert.equal(renderScale(400, 200), 2)
  assert.equal(renderScale(0, 0), 1)
  assert.equal(renderScale(Number.NaN, 10), 1)
  const handles = byProp(
    spacingHandles(box(0, 0, 400, 240), { top: 10, right: 0, bottom: 0, left: 0 }, 2, null)
  )
  assert.equal(handles['padding-top'].box.top + 3, 10, 'band is 20 rendered px')
  assert.equal(dragValue(10, 20, 1, 2), 20, '20 screen px at 2× is 10 CSS px')
  assert.equal(dragValue(10, -100, 1, 1), 0, 'never negative')
  assert.equal(dragValue(30, 12, -1, 1), 18, 'bottom/right grips invert')
  assert.equal(dragValue(4, 1.4, 1, 1), 5, 'whole pixels')
}

// Tiny boxes get no grips on the axis that cannot hold one.
assert.equal(
  spacingHandles(box(0, 0, 20, 20), { top: 4, right: 4, bottom: 4, left: 4 }, 1, null).length,
  0
)

// The gap between the first two children: beside → column gap, below → row gap.
{
  const column = gapBetween(box(0, 0, 50, 40), box(62, 0, 50, 40), 4, 12)
  assert.equal(column.prop, 'column-gap')
  assert.equal(column.value, 12)
  assert.deepEqual(column.rect, box(50, 0, 12, 40))
  const row = gapBetween(box(0, 0, 100, 30), box(0, 38, 100, 30), 8, 0)
  assert.equal(row.prop, 'row-gap')
  assert.deepEqual(row.rect, box(0, 30, 100, 8))
  assert.equal(gapBetween(box(0, 0, 100, 30), box(10, 10, 20, 20), 0, 0), null, 'overlap')
  const handles = byProp(
    spacingHandles(box(0, 0, 112, 40), { top: 0, right: 0, bottom: 0, left: 0 }, 1, column)
  )
  assert.equal(handles['column-gap'].axis, 'x')
  assert.equal(handles['column-gap'].box.left + 3, 56, 'centred in the gap')
}

// The preview is semi-trusted: only allowlisted props with bounded whole pixels pass.
assert.deepEqual(parseSpacingDraft({ prop: 'padding-top', value: '024' }), {
  prop: 'padding-top',
  value: '24'
})
assert.equal(parseSpacingDraft({ prop: 'margin-top', value: '4' }), null)
assert.equal(parseSpacingDraft({ prop: 'row-gap', value: '-4' }), null)
assert.equal(parseSpacingDraft({ prop: 'row-gap', value: '4px' }), null)
assert.equal(parseSpacingDraft({ prop: 'row-gap', value: '99999' }), null)
assert.equal(parseSpacingDraft(null), null)

// A released handle stages the same Styles draft as a typed field.
const element = {
  tag: 'div',
  id: null,
  classes: [],
  source: 'a.tsx:3',
  componentSource: null,
  styles: {},
  selector: 'div',
  text: null,
  rect: { x: 0, y: 0, width: 10, height: 10 }
}
const invoked = [],
  sent = [],
  agent = []
const hash = 'base'
setSourceOwner({ read: async () => ({ path: 'a.tsx', hash, binary: false, size: 10 }) })
const inspector = new NativeInspectorController(
  async (channel) => {
    invoked.push(channel)
    if (channel === 'styles:read')
      return {
        values: {
          display: 'flex',
          'padding-top': '8px',
          'padding-right': '8px',
          'padding-bottom': '8px',
          'padding-left': '8px',
          'row-gap': '0px',
          'column-gap': '12px'
        },
        specified: { 'padding-top': '8px', 'column-gap': '12px' }
      }
    if (channel === 'controls:list' || channel === 'controls:get') return []
    return null
  },
  async (...args) => sent.push(args),
  () => {},
  async (...args) => {
    agent.push(args)
    return 'turn-1'
  },
  async () => {}
)
await inspector.activate('/a')
await inspector.select(element)
assert.equal(inspector.state.visible, false, 'picking alone keeps the inspector closed')
assert.equal(await inspector.gesture('padding-top', '24'), true)
assert.equal(inspector.state.draft.count, 1)
assert.equal(inspector.state.visible, true, 'the staged draft shows with its Apply')
assert.equal(
  inspector.state.fields.find((field) => field.id === 'style:padding-top').value,
  '24px',
  'the side field shows the dragged value'
)
assert.ok(
  sent.some(([channel, p]) => channel === 'styles:preview' && p.prop === 'padding-top'),
  'the draft is projected through the Styles preview'
)
assert.equal(await inspector.gesture('column-gap', '20'), true)
assert.equal(inspector.state.draft.count, 2)
assert.equal(
  invoked.filter((channel) => /^styles:apply/.test(channel)).length,
  0,
  'no source write per drag'
)
assert.equal(agent.length, 0, 'no agent turn per drag')

// No field for the prop here: the gesture's own preview is cleared, drafts stay.
sent.length = 0
assert.equal(await inspector.gesture('row-gap', 'x'), false)
assert.equal(await inspector.gesture('margin-top', '4'), false)
assert.ok(sent.some(([channel, p]) => channel === 'styles:clear-preview' && p?.prop))
assert.match(inspector.state.error, /margin-top/)
assert.equal(inspector.state.draft.count, 2)

// Undo, then one explicit Apply batches the remaining drafts into one agent operation.
await inspector.action({ root: '/a', generation: inspector.state.generation, action: 'undo-draft' })
assert.equal(inspector.state.draft.count, 1)
await inspector.action({
  root: '/a',
  generation: inspector.state.generation,
  action: 'apply-drafts'
})
assert.equal(agent.length, 1)
assert.match(agent[0][1], /set padding-top to 24px/)
assert.doesNotMatch(agent[0][1], /column-gap/)

// LKM-638: a drag while Apply is running stages the next draft; it never merges into the
// submitted batch or rewrites its instruction.
assert.equal(await inspector.gesture('padding-left', '30'), true)
assert.equal(inspector.state.error, '')
assert.equal(inspector.state.draft.count, 1, 'the drag is the next draft')
assert.equal(inspector.state.draft.submitted, true, 'the first Apply still runs')
assert.equal(agent.length, 1)
assert.doesNotMatch(agent[0][1], /padding-left/)
setSourceOwner(null)

// Cancel mid-drag restores the exact inline value and commits no draft. A small DOM model
// stands in for WebKit; real pointer and paint evidence stays with the native fixture.
{
  class FakeStyle {
    values = new Map()
    getPropertyValue(prop) {
      return this.values.get(prop) ?? ''
    }
    setProperty(prop, value) {
      this.values.set(prop, value)
    }
  }
  class FakeElement {
    style = new FakeStyle()
    dataset = {}
    attrs = new Map()
    kids = []
    children = []
    listeners = new Map()
    parentNode = null
    ownerDocument = null
    rect = { left: 100, top: 50, width: 200, height: 120 }
    offsetWidth = 200
    get isConnected() {
      return true
    }
    setAttribute(key, value) {
      this.attrs.set(key, value)
    }
    appendChild(node) {
      node.parentNode = this
      this.kids.push(node)
    }
    remove() {
      if (this.parentNode) this.parentNode.kids = this.parentNode.kids.filter((n) => n !== this)
      this.parentNode = null
    }
    querySelectorAll(selector) {
      const attr = selector.slice(1, -1)
      return this.kids.filter((node) => node.attrs.has(attr))
    }
    getBoundingClientRect() {
      return this.rect
    }
    getClientRects() {
      return [this.rect]
    }
    setPointerCapture() {}
    addEventListener(type, fn) {
      this.listeners.set(type, fn)
    }
    removeEventListener(type, fn) {
      if (this.listeners.get(type) === fn) this.listeners.delete(type)
    }
  }
  const fakeDocument = { createElement: () => new FakeElement() }
  Object.assign(globalThis, {
    document: fakeDocument,
    HTMLElement: FakeElement,
    getComputedStyle: () => ({
      paddingTop: '20px',
      paddingRight: '10px',
      paddingBottom: '30px',
      paddingLeft: '16px',
      display: 'block',
      rowGap: '0px',
      columnGap: '0px'
    })
  })
  const node = new FakeElement()
  node.ownerDocument = fakeDocument
  node.style.setProperty('padding-top', '5px')
  const layer = new FakeElement()
  const commits = [],
    previews = []
  const handles = createSpacingHandles({
    layer: () => layer,
    enabled: () => true,
    preview: (el, prop, value) => {
      previews.push([prop, value])
      el.style.setProperty(prop, value)
    },
    restore: (el, prop, before) => el.style.setProperty(prop, before),
    commit: (prop, value) => commits.push([prop, value])
  })
  handles.target(node, 1)
  const grip = layer.kids.find((g) => g.dataset.prop === 'padding-top')
  assert.ok(grip, 'the selected element shows a padding-top grip')
  const press = (clientY) => ({
    isTrusted: true,
    button: 0,
    pointerId: 1,
    clientX: 200,
    clientY,
    preventDefault() {},
    stopPropagation() {}
  })
  const move = (clientY) =>
    grip.listeners.get('pointermove')({ pointerId: 1, clientY, preventDefault() {} })
  grip.onpointerdown(press(10))
  assert.equal(handles.dragging(), true)
  move(30)
  assert.equal(node.style.getPropertyValue('padding-top'), '40px', 'the drag previews at once')
  handles.cancel()
  assert.equal(handles.dragging(), false)
  assert.equal(
    node.style.getPropertyValue('padding-top'),
    '5px',
    'cancel restores the inline value'
  )
  assert.deepEqual(commits, [], 'cancel stages no draft')
  assert.equal(grip.listeners.size, 0, 'cancel removes the drag listeners')

  // Release at a new value commits exactly once; the preview stays for the inspector draft.
  const regrip = layer.kids.find((g) => g.dataset.prop === 'padding-top')
  regrip.onpointerdown(press(10))
  regrip.listeners.get('pointermove')({ pointerId: 1, clientY: 14, preventDefault() {} })
  regrip.listeners.get('pointerup')({ pointerId: 1 })
  assert.deepEqual(commits, [['padding-top', '24']])
  assert.equal(handles.dragging(), false)
}

// Escape mid-drag through the production key handler: only the drag ends. Selection mode and
// the selection stay; without a drag the same key still exits Selection mode.
{
  const start = source.indexOf('function onKey(')
  assert.ok(start >= 0, 'preload onKey')
  const onKey = source.slice(start, source.indexOf('\n}', start) + 2)
  const sent = [],
    log = []
  let dragging = true
  const noop = () => {}
  const context = vm.createContext({
    threeD: { active: () => false },
    spacing: {
      dragging: () => dragging,
      cancel: () => {
        dragging = false
        log.push('cancel')
      }
    },
    blockPageInput: () => {
      log.push('block')
      return true
    },
    ipcRenderer: { send: (...args) => sent.push(args) },
    CANCELLED: 'cancelled',
    inputEl: null,
    setActive: (next) => {
      log.push(`active:${next}`)
      state.active = next
    },
    refreshMeasure: noop,
    isTypingTarget: () => false,
    latinKey: () => ''
  })
  const state = { active: true }
  vm.runInContext(
    new Bun.Transpiler({ loader: 'ts' }).transformSync(`
let editing = null, commenting = null, commentMode = null, altHeld = false;
Object.defineProperty(globalThis, 'active', { get: () => globalThis.state.active });
${onKey}
globalThis.onKey = onKey;
`),
    Object.assign(context, { state })
  )
  const escapeKey = () => ({
    key: 'Escape',
    isTrusted: true,
    composedPath: () => [],
    preventDefault: () => log.push('prevent'),
    stopImmediatePropagation: () => log.push('stop')
  })
  context.onKey(escapeKey())
  assert.deepEqual(log, ['prevent', 'stop', 'cancel'], 'Escape mid-drag only cancels the drag')
  assert.equal(state.active, true, 'Selection mode stays on')
  assert.deepEqual(sent, [], 'no selection-cancelled event')
  log.length = 0
  context.onKey(escapeKey())
  assert.deepEqual(sent, [['cancelled']], 'Escape with no drag still exits Selection mode')
  assert.equal(state.active, false)
}
console.log('spacing-handles: ok')
