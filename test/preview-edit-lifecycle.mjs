// Execute the production handlers with a small DOM model. This covers handler
// ordering; real WebKit focus and foreground painting still need desktop evidence.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/preview/preload.ts', import.meta.url), 'utf8')
function handler(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  const end = source.indexOf('\n}', start) + 2
  return source.slice(start, end)
}
class Element {
  textContent = 'Original'
  style = { outline: 'authored' }
  attrs = new Map()
  listeners = new Map()
  isConnected = true
  contains(el) {
    return el === this
  }
  getAttribute(key) {
    return this.attrs.get(key) ?? null
  }
  setAttribute(key, value) {
    this.attrs.set(key, value)
  }
  removeAttribute(key) {
    this.attrs.delete(key)
  }
  addEventListener(key, fn) {
    this.listeners.set(key, fn)
  }
  removeEventListener(key, fn) {
    if (this.listeners.get(key) === fn) this.listeners.delete(key)
  }
  focus() {}
  blur() {
    this.listeners.get('blur')?.()
  }
}
let ranges = 0
const sent = []
const noop = () => {}
let toolbar = null
let highlight = null
const context = vm.createContext({
  Element,
  KeyboardEvent: class {},
  overlayHost: null,
  window: {
    getSelection: () => ({
      removeAllRanges: () => {
        ranges = 0
      },
      addRange: () => {
        ranges++
      }
    })
  },
  document: { createRange: () => ({ selectNodeContents: noop }), documentElement: { style: {} } },
  ipcRenderer: { send: (...args) => sent.push(args) },
  TEXT_EDIT: 'edit',
  PICKED: 'pick',
  CANCELLED: 'cancel',
  sourceStamp: () => 'index.html:3:1',
  threeD: { active: () => false },
  previewTimings: { enabled: false },
  isOverlay: () => false,
  hover: { clear: noop },
  hideOverlay: noop,
  clearMeasure: noop,
  ensureOverlay: noop,
  resetInput: noop,
  showToolbar: (el) => {
    toolbar = el
  },
  hideToolbar: () => {
    toolbar = null
  },
  setSelectionHighlight: (el) => {
    highlight = el
  },
  describe: (el) => ({ text: el.textContent })
})
const handlers = [
  'startTextEdit',
  'endEdit',
  'commitEdit',
  'onEditKey',
  'onClick',
  'blockPageInput',
  'setActive'
]
vm.runInContext(
  new Bun.Transpiler({ loader: 'ts' }).transformSync(`
let editing = null, editOriginal = '', editOutline = '', editAttribute = null;
let active = true, selectedEl = null, lastHovered = null, pickedElements = [], commentMode = null;
${handlers.map(handler).join('\n')}
globalThis.api = { startTextEdit, commitEdit, onEditKey, onClick, blockPageInput, setActive,
  editing: () => editing };
`),
  context
)
const api = context.api
const a = new Element()
const b = new Element()
b.textContent = 'Other'
const event = (target, extra = {}) => ({
  target,
  isTrusted: true,
  preventDefault: noop,
  stopPropagation: noop,
  stopImmediatePropagation: noop,
  ...extra
})
api.startTextEdit(a)
a.textContent = 'Changed'
let prevented = false
api.blockPageInput(
  event(b, {
    type: 'mousedown',
    preventDefault: () => {
      prevented = true
    }
  })
)
assert.equal(prevented, true, 'selection blocks page pointer defaults, including natural blur')
api.onClick(event(a))
assert.equal(api.editing(), a, 'inside click retains editing')
api.onClick(event(b, { isTrusted: false }))
assert.equal(api.editing(), a, 'untrusted page events cannot commit')
api.onClick(event(b))
assert.deepEqual(
  sent.map(([kind]) => kind),
  ['edit', 'pick'],
  'outside click commits then selects in one gesture'
)
assert.equal(toolbar, b)
assert.equal(highlight, b)
assert.equal(a.listeners.size, 0)
assert.equal(a.style.outline, 'authored')
assert.equal(ranges, 0)
a.blur()
assert.equal(sent.length, 2, 'later blur cannot commit twice')

api.startTextEdit(a)
a.textContent = 'Cancelled'
api.onEditKey(event(a, { key: 'Escape' }))
assert.equal(a.textContent, 'Changed')
assert.equal(toolbar, null)
assert.equal(highlight, null)
assert.equal(ranges, 0)
assert.equal(sent.filter(([kind]) => kind === 'edit').length, 1)

api.setActive(true)
api.startTextEdit(a)
a.textContent = 'Enter'
api.onEditKey(event(a, { key: 'Enter' }))
assert.equal(api.editing(), null)
api.startTextEdit(a)
a.textContent = 'Blur'
a.blur()
assert.equal(api.editing(), null, 'blur/refocus allows re-entry')
api.startTextEdit(a)
a.textContent = 'Mode exit'
api.setActive(false)
assert.equal(api.editing(), null)
assert.equal(a.getAttribute('contenteditable'), null)
assert.equal(ranges, 0)
assert.equal(sent.filter(([kind]) => kind === 'edit').length, 4)
prevented = false
api.blockPageInput(
  event(b, {
    type: 'mousedown',
    preventDefault: () => {
      prevented = true
    }
  })
)
assert.equal(prevented, false, 'normal page input resumes after mode exit')
console.log('PREVIEW EDIT LIFECYCLE OK')
