/**
 * A chat island gesture's temporary box-shadow (LKM-140).
 *
 * While someone drags a Shadow island, Bun shows each frame here instead of writing the
 * source, so the dev server runs no HMR update mid-gesture. The override is an inline
 * `!important` box-shadow on the elements that showed the island's derived value when the
 * gesture began; it lives in this isolated world only, so a navigation drops it.
 *
 * It is removed only by `settle`, once every target's own style (the override taken away)
 * computes to the written value: the HMR update with the final value has applied. The check
 * and the removal run in one task, so no frame is painted in between and a CSS swap that
 * drops the old rule before the new one applies never shows.
 *
 * Next's HMR can remount the bound element, which disconnects the targets. That is never
 * "settled": the new elements (showing the start or the written value) are found again and
 * held until their own style shows the written value.
 */
import type { IslandOverrideMessage } from '../shared/preview-channels'

const PROP = 'box-shadow'
const MAX_TARGETS = 64
interface Target {
  el: HTMLElement
  original: string
  priority: string
  shown: string | null
}
interface Override {
  targets: Target[]
  css: string
  from: string
}
const overrides = new Map<string, Override>()

/** A computed box-shadow without fully transparent empty layers (Tailwind's ring slots). */
export function shadowLayers(value: string): string {
  const layers: string[] = []
  let depth = 0,
    start = 0
  for (let i = 0; i <= value.length; i++) {
    const c = value[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if ((c === ',' && depth === 0) || i === value.length) {
      layers.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  return layers.filter((layer) => !/^rgba\(0, 0, 0, 0\)( 0px){2,4}$/.test(layer)).join(', ')
}

/** The computed form of `css`, so authored and computed shadows compare. */
function computed(css: string): string {
  const probe = document.createElement('div')
  probe.style.setProperty('display', 'none')
  probe.style.setProperty(PROP, css)
  document.documentElement.append(probe)
  const value = getComputedStyle(probe).boxShadow
  probe.remove()
  return shadowLayers(value)
}

/** The elements (other than `held`) that show one of `values` now: the island's bound elements. */
function discover(values: string[], held = new Set<Element>()): Target[] {
  const wanted = new Set(values.map(computed).filter((value) => value && value !== 'none'))
  if (!wanted.size || !document.body) return []
  const found: Target[] = []
  for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
    if (!(el instanceof HTMLElement) || held.has(el)) continue
    if (!wanted.has(shadowLayers(getComputedStyle(el).boxShadow))) continue
    found.push({
      el,
      original: el.style.getPropertyValue(PROP),
      priority: el.style.getPropertyPriority(PROP),
      shown: null
    })
    if (found.length >= MAX_TARGETS) break
  }
  return found
}

/** The held targets still in the page, plus the elements an HMR remount put in place of the others. */
function resolve(override: Override): Target[] {
  const connected = override.targets.filter((t) => t.el.isConnected)
  if (connected.length && connected.length === override.targets.length) return connected
  const held = new Set<Element>(connected.map((t) => t.el))
  return [...connected, ...discover([override.from, override.css], held)].slice(0, MAX_TARGETS)
}

/** The page (a React render, HMR) may rewrite the inline value we took over. */
function owned(target: Target): boolean {
  const style = target.el.style
  return (
    target.shown !== null &&
    style.getPropertyValue(PROP) === target.shown &&
    style.getPropertyPriority(PROP) === 'important'
  )
}

/** A box-shadow transition would make the computed value lag; the check needs the end value. */
function settledShadow(el: HTMLElement): string {
  getComputedStyle(el).boxShadow
  for (const animation of el.getAnimations?.() ?? [])
    if (animation instanceof CSSTransition && animation.transitionProperty === PROP)
      animation.cancel()
  return shadowLayers(getComputedStyle(el).boxShadow)
}

function show(target: Target, css: string) {
  const style = target.el.style
  if (target.shown !== null && !owned(target)) {
    target.original = style.getPropertyValue(PROP)
    target.priority = style.getPropertyPriority(PROP)
  }
  style.setProperty(PROP, css, 'important')
  target.shown = style.getPropertyValue(PROP)
}

function restore(target: Target) {
  if (!owned(target)) return
  const style = target.el.style
  if (target.original) style.setProperty(PROP, target.original, target.priority)
  else style.removeProperty(PROP)
  target.shown = null
}

function apply(key: string, from: string, css: string): number {
  let override = overrides.get(key)
  if (override) {
    override.from = from
    override.targets = resolve(override)
  }
  if (!override?.targets.length) {
    const targets = discover([from])
    if (!targets.length) {
      overrides.delete(key)
      return 0
    }
    override = { targets, css, from }
    overrides.set(key, override)
  }
  override.css = css
  for (const target of override.targets) show(target, css)
  return override.targets.length
}

/**
 * Remove the override once the page's own style shows `css`; true when nothing is held.
 * Both the shown and the own value must compute to `css`: an element that is gone or still
 * on the old rule keeps the override, and an empty page is never settled (the backend's
 * timeout drops the override if the bound elements never come back).
 */
function settle(key: string, css: string): boolean {
  const override = overrides.get(key)
  if (!override) return true
  if (override.css !== css) return false
  const expected = computed(css)
  if (!expected || expected === 'none') return false
  override.targets = resolve(override)
  if (!override.targets.length) return false
  // A remounted element is held before anything is read, so it never paints the old value.
  for (const target of override.targets) if (!owned(target)) show(target, css)
  for (const target of override.targets) {
    const shown = settledShadow(target.el)
    restore(target)
    const own = settledShadow(target.el)
    show(target, css)
    settledShadow(target.el)
    if (shown !== expected || own !== expected) return false
  }
  for (const target of override.targets) restore(target)
  overrides.delete(key)
  return true
}

function clear(key: string): boolean {
  for (const target of overrides.get(key)?.targets ?? []) if (target.el.isConnected) restore(target)
  overrides.delete(key)
  return true
}

function clearAll(): boolean {
  for (const key of [...overrides.keys()]) clear(key)
  return true
}

let observer: MutationObserver | null = null

/**
 * While an override is held, an HMR re-render that rewrites a target's inline style, or a
 * remount that replaces it, is taken over again in the same microtask checkpoint, before the
 * page paints the old value. Only `settle` lets the page's own value show.
 */
function watch() {
  if (!overrides.size || !document.body) {
    observer?.disconnect()
    observer = null
    return
  }
  if (observer || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(() => {
    for (const override of overrides.values()) {
      override.targets = resolve(override)
      for (const target of override.targets) if (!owned(target)) show(target, override.css)
    }
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style']
  })
}

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const shadow = (value: unknown): value is string => text(value, 8192) && !/[<>{};]/.test(value)

/** One validated message from Bun; the answer goes back on the reply channel. */
export function islandOverride(message: unknown): number | boolean | null {
  const parsed = parse(message)
  const value = parsed ? handle(parsed) : null
  watch()
  return value
}

/** The message as the wire format, or null when any field is missing or unsafe. */
function parse(message: unknown): IslandOverrideMessage | null {
  const m = message as Partial<Record<'op' | 'key' | 'from' | 'css', unknown>> | null
  if (!m) return null
  if (m.op === 'clearAll') return { op: 'clearAll' }
  if (!text(m.key, 200)) return null
  if (m.op === 'clear') return { op: 'clear', key: m.key }
  if (!shadow(m.css)) return null
  if (m.op === 'settle') return { op: 'settle', key: m.key, css: m.css }
  if (m.op === 'apply' && shadow(m.from))
    return { op: 'apply', key: m.key, from: m.from, css: m.css }
  return null
}

function handle(message: IslandOverrideMessage): number | boolean {
  switch (message.op) {
    case 'apply':
      return apply(message.key, message.from, message.css)
    case 'settle':
      return settle(message.key, message.css)
    case 'clear':
      return clear(message.key)
    case 'clearAll':
      return clearAll()
  }
}
