// LKM-140: the preview override lifecycle (src/preview/island-override.ts) on a small fake DOM.
// The override is removed only when the bound element's shown and own box-shadow both compute
// to the written value; a Next HMR remount (targets disconnected) is never "settled" and the
// remounted element is held again before it can paint; a gap swap keeps the override.
import assert from 'node:assert/strict'

const observers = new Set()
let pending = false
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
  }
  observe() {
    observers.add(this)
  }
  disconnect() {
    observers.delete(this)
  }
}
/** The microtask checkpoint after a task: observers see the batched records before paint. */
function checkpoint() {
  for (let i = 0; pending && i < 10; i++) {
    pending = false
    for (const observer of [...observers]) observer.callback([])
  }
  assert.equal(pending, false, 'observer callbacks settle')
}

class Style {
  constructor(el) {
    this.el = el
    this.props = new Map()
  }
  getPropertyValue(prop) {
    return this.props.get(prop)?.value ?? ''
  }
  getPropertyPriority(prop) {
    return this.props.get(prop)?.priority ?? ''
  }
  setProperty(prop, value, priority = '') {
    this.props.set(prop, { value, priority })
    this.el.changed()
  }
  removeProperty(prop) {
    this.props.delete(prop)
    this.el.changed()
  }
}
class HTMLElement {
  constructor(rule = '') {
    this.style = new Style(this)
    this.children = []
    this.parent = null
    this.rule = rule
  }
  get isConnected() {
    let el = this
    while (el.parent) el = el.parent
    return el === document.documentElement
  }
  /** Only mutations inside body reach the observer, as with `observe(document.body)`. */
  changed() {
    for (let el = this; el; el = el.parent)
      if (el === document.body) {
        if (observers.size) pending = true
        return
      }
  }
  append(child) {
    child.parent = this
    this.children.push(child)
    this.changed()
  }
  remove() {
    const parent = this.parent
    if (!parent) return
    parent.children.splice(parent.children.indexOf(this), 1)
    this.parent = null
    parent.changed()
  }
  replaceWith(next) {
    const parent = this.parent
    parent.children[parent.children.indexOf(this)] = next
    next.parent = parent
    this.parent = null
    parent.changed()
  }
  querySelectorAll() {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()])
  }
  getAnimations() {
    return []
  }
}
const documentElement = new HTMLElement()
const body = new HTMLElement()
globalThis.document = { documentElement, body, createElement: () => new HTMLElement() }
documentElement.append(body)
globalThis.HTMLElement = HTMLElement
globalThis.CSSTransition = class {}
globalThis.MutationObserver = FakeMutationObserver
// Inline style (either priority) wins over the stylesheet rule; no value at all is 'none'.
globalThis.getComputedStyle = (el) => ({
  boxShadow: el.style.getPropertyValue('box-shadow') || el.rule || 'none'
})

const { islandOverride } = await import('../src/preview/island-override.ts')

const FROM = '1px 2px 4px rgba(0, 0, 0, 0.35), 2px 4px 8px rgba(0, 0, 0, 0.21)'
const MID = '-1px 2px 4px rgba(0, 0, 0, 0.35), -2px 4px 8px rgba(0, 0, 0, 0.21)'
const CSS = '-2px 1px 4px rgba(0, 0, 0, 0.35), -4px 2px 8px rgba(0, 0, 0, 0.21)'
const key = 'chat\nisland'
const shown = (el) => getComputedStyle(el).boxShadow
const apply = (css, from = FROM) => {
  const n = islandOverride({ op: 'apply', key, from, css })
  checkpoint()
  return n
}
const settle = (css) => {
  const done = islandOverride({ op: 'settle', key, css })
  checkpoint()
  return done
}
const reset = () => {
  islandOverride({ op: 'clearAll' })
  checkpoint()
  body.children.splice(0)
}

// React (Next): the card's inline style carries the source value.
function reactCard(value) {
  const el = new HTMLElement()
  el.style.setProperty('box-shadow', value)
  return el
}

{
  const card = reactCard(FROM),
    other = reactCard('0px 1px 2px rgba(0, 0, 0, 0.5)')
  body.append(card)
  body.append(other)
  assert.equal(apply(MID), 1, 'apply holds the one element showing the source value')
  assert.equal(apply(CSS), 1)
  assert.equal(shown(card), CSS)
  assert.equal(card.style.getPropertyPriority('box-shadow'), 'important')
  assert.equal(shown(other), '0px 1px 2px rgba(0, 0, 0, 0.5)', 'an unrelated element is untouched')
  assert.equal(settle(MID), false, 'a stale write never settles a newer frame')
  assert.equal(settle(CSS), false, 'own style still on the start value: held')
  assert.equal(shown(card), CSS, 'the failed check leaves the override shown')

  // Next HMR remounts the card. The new node first renders the old value.
  const remounted = reactCard(FROM)
  card.replaceWith(remounted)
  checkpoint()
  assert.equal(shown(remounted), CSS, 'a remount is held before it paints the old value')
  assert.equal(settle(CSS), false, 'disconnected targets never settle')
  assert.equal(shown(remounted), CSS)

  // Fast Refresh re-renders with the written value: React rewrites the inline style.
  remounted.style.setProperty('box-shadow', CSS)
  checkpoint()
  assert.equal(
    remounted.style.getPropertyPriority('box-shadow'),
    'important',
    'the re-render is held until settle'
  )
  assert.equal(settle(CSS), true, 'shown and own both compute to the written value')
  assert.equal(shown(remounted), CSS)
  assert.equal(
    remounted.style.getPropertyPriority('box-shadow'),
    '',
    'the page owns the value again'
  )
  assert.equal(settle(CSS), true, 'nothing held')
  assert.equal(observers.size, 0, 'no observer without an override')
  reset()
}

{
  // The bound element is gone and nothing replaces it (yet): never settled.
  const card = reactCard(FROM)
  body.append(card)
  assert.equal(apply(CSS), 1)
  card.remove()
  checkpoint()
  for (let i = 0; i < 3; i++)
    assert.equal(settle(CSS), false, 'an empty target list is not settled')
  // An element that already shows the written value comes back: it is the bound element.
  const back = reactCard(CSS)
  body.append(back)
  checkpoint()
  assert.equal(back.style.getPropertyPriority('box-shadow'), 'important', 'held when it comes back')
  assert.equal(settle(CSS), true)
  assert.equal(shown(back), CSS)
  reset()
}

{
  // CSS module (Vite): the rule swaps; a swap gap (old rule gone, new not yet applied) stays covered.
  const card = new HTMLElement(FROM)
  body.append(card)
  assert.equal(apply(CSS), 1)
  card.rule = ''
  assert.equal(settle(CSS), false, 'gap frame: own value none')
  assert.equal(shown(card), CSS, 'the gap never shows')
  card.rule = MID
  assert.equal(settle(CSS), false, 'own value is not the written one')
  card.rule = CSS
  assert.equal(settle(CSS), true, 'removed after the update with the final value')
  assert.equal(card.style.getPropertyValue('box-shadow'), '', 'no inline value left behind')
  assert.equal(shown(card), CSS)
  reset()
}

{
  // Clear (Undo, Reset, conflict) restores the page's inline value at once.
  const card = reactCard(FROM)
  body.append(card)
  apply(CSS)
  islandOverride({ op: 'clear', key })
  checkpoint()
  assert.equal(shown(card), FROM)
  assert.equal(card.style.getPropertyPriority('box-shadow'), '')
  assert.equal(observers.size, 0)
  assert.equal(
    apply(CSS, '9px 9px 9px rgba(0, 0, 0, 0.1)'),
    0,
    'no element shows the start value: nothing held'
  )
  reset()
}

assert.equal(
  islandOverride({ op: 'apply', key, from: FROM, css: 'red; }' }),
  null,
  'unsafe css is refused'
)
console.log('ISLAND-OVERRIDE PASS')
