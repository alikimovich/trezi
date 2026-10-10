import { CONTROL_OVERLAY_SELECTOR } from '../shared/control-overlay'
import { sourceStamp } from './source-stamp'

/**
 * Agent preview inspection (LKM-138), installed in the isolated TreziPreview world.
 * The page cannot see these globals; main calls them through an isolated evaluate
 * and every result is plain, bounded JSON built here (never page objects).
 */

const STYLE_KEYS = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'overflow-x',
  'overflow-y',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'color',
  'background-color',
  'background-image',
  'opacity',
  'visibility',
  'box-shadow',
  'filter',
  'backdrop-filter',
  'transform',
  'transform-origin',
  'transition',
  'animation-name',
  'clip-path',
  'border-radius',
  'outline',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-overflow',
  'white-space',
  'cursor',
  'pointer-events'
]
const SIDES = ['top', 'right', 'bottom', 'left'] as const
const MAX_STYLE = 300

export const overlay = (el: Element) =>
  el.closest('[data-trezi-overlay]') !== null || el.closest(CONTROL_OVERLAY_SELECTOR) !== null
const round = (n: number) => Math.round(n * 100) / 100
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

export function describeElement(el: Element): string {
  const id = el.id ? `#${el.id}` : ''
  const classes =
    typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}`
      : ''
  return clip(`${el.tagName.toLowerCase()}${id}${classes}`, 160)
}

function rectOf(el: Element) {
  const r = el.getBoundingClientRect()
  return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) }
}

function box(style: CSSStyleDeclaration, prefix: string, suffix = '') {
  return Object.fromEntries(
    SIDES.map((side) => [side, style.getPropertyValue(`${prefix}-${side}${suffix}`)])
  )
}

/** Ancestors that clip or contain the element: the usual cause of a cut-off shadow. */
function clippingAncestors(el: Element) {
  const found: { element: string; overflow: string; source: string | null }[] = []
  for (let node = el.parentElement; node && found.length < 6; node = node.parentElement) {
    const style = getComputedStyle(node)
    const overflow = `${style.overflowX} ${style.overflowY}`
    if (
      overflow !== 'visible visible' ||
      style.clipPath !== 'none' ||
      style.contain.includes('paint')
    )
      found.push({ element: describeElement(node), overflow, source: sourceStamp(node) })
  }
  return found
}

export interface InspectRequest {
  selector?: string
  x?: number
  y?: number
  index?: number
}

export function find(
  request: InspectRequest
): { el: Element; matches: number } | { error: string } {
  if (typeof request.selector === 'string' && request.selector.trim()) {
    let all: Element[]
    try {
      all = [...document.querySelectorAll(request.selector)].filter((e) => !overlay(e))
    } catch {
      return { error: `Invalid CSS selector: ${clip(request.selector, 200)}` }
    }
    const el = all[Math.max(0, Math.min(all.length - 1, Math.floor(Number(request.index) || 0)))]
    return el
      ? { el, matches: all.length }
      : { error: `No element matches ${clip(request.selector, 200)}` }
  }
  if (Number.isFinite(request.x) && Number.isFinite(request.y)) {
    const el = document
      .elementsFromPoint(request.x as number, request.y as number)
      .find((e) => !overlay(e))
    return el ? { el, matches: 1 } : { error: `No page element at ${request.x},${request.y}` }
  }
  return { error: 'Pass a CSS selector or an x/y point in CSS pixels.' }
}

export function inspectElement(request: InspectRequest) {
  const found = find(request)
  if ('error' in found) return found
  const { el, matches } = found
  const style = getComputedStyle(el)
  const styles: Record<string, string> = {}
  for (const key of STYLE_KEYS) {
    const value = style.getPropertyValue(key)
    if (value) styles[key] = clip(value, MAX_STYLE)
  }
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return {
    element: describeElement(el),
    tag: el.tagName.toLowerCase(),
    source: sourceStamp(el),
    componentSource: sourceStamp(el, true),
    matches,
    rect: rectOf(el),
    boxModel: {
      margin: box(style, 'margin'),
      border: box(style, 'border', '-width'),
      padding: box(style, 'padding')
    },
    styles,
    children: el.children.length,
    text: clip(text, 200),
    clippedBy: clippingAncestors(el),
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollX: round(scrollX),
      scrollY: round(scrollY)
    }
  }
}

/** Scrolls an element into view for a cropped capture; `restore` undoes it. */
export function prepareCapture(request: InspectRequest) {
  const found = find(request)
  if ('error' in found) return found
  const from = { x: scrollX, y: scrollY }
  let rect = rectOf(found.el)
  const visible =
    rect.y >= 0 &&
    rect.x >= 0 &&
    rect.y + rect.height <= innerHeight &&
    rect.x + rect.width <= innerWidth
  if (!visible) {
    found.el.scrollIntoView({
      behavior: 'instant',
      block: rect.height > innerHeight ? 'start' : 'center',
      inline: 'nearest'
    })
    rect = rectOf(found.el)
  }
  const x = Math.max(0, rect.x),
    y = Math.max(0, rect.y)
  const crop = {
    x,
    y,
    width: Math.max(0, Math.min(innerWidth, rect.x + rect.width) - x),
    height: Math.max(0, Math.min(innerHeight, rect.y + rect.height) - y)
  }
  return {
    element: describeElement(found.el),
    source: sourceStamp(found.el),
    rect,
    crop,
    scrolled: from.x !== scrollX || from.y !== scrollY,
    restore: from
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __treziAgentInspect:
    | {
        inspect: typeof inspectElement
        prepareCapture: typeof prepareCapture
        restoreScroll: (to: { x: number; y: number }) => void
      }
    | undefined
}

globalThis.__treziAgentInspect = {
  inspect: inspectElement,
  prepareCapture,
  restoreScroll: (to) => scrollTo({ left: to.x, top: to.y, behavior: 'instant' })
}
