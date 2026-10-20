import { readConsole } from './agent-console'
import { describe, disabled, visible } from './agent-events'
import { find, overlay } from './agent-inspect'
import { sourceSelector, sourceStamp } from './source-stamp'

/**
 * LOCAL-WEBKIT-2: element refs and raw observations for the agent browser, installed in
 * the isolated TreziPreview world (the page cannot call or replace these globals).
 *  - `DOCUMENT_ID` is drawn once per document: a reload or navigation runs this script
 *    again, so a ref from an earlier document never resolves in a later one.
 *  - A ref (`e<n>`) names one element of this document; it fails once that element left
 *    the DOM. Bun scopes refs to one agent browser and navigation (`src/main/agent-refs.ts`).
 *  - `observe` reads facts only (count, visibility, text, value, attributes, computed
 *    styles, state). Whether a check passes is decided in Bun (`src/main/browser-checks.ts`).
 */

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
export const DOCUMENT_ID = hex(crypto.getRandomValues(new Uint8Array(12)))

const MAX_REFS = 150
const MAX_KEPT = 5000
const MAX_TEXT = 2000
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

const ids = new WeakMap<Element, string>()
const elements = new Map<string, WeakRef<Element>>()
let next = 0

function refOf(el: Element): string {
  let id = ids.get(el)
  if (id) return id
  if (elements.size >= MAX_KEPT)
    for (const [key, ref] of elements) if (!ref.deref()?.isConnected) elements.delete(key)
  id = `e${++next}`
  ids.set(el, id)
  elements.set(id, new WeakRef(el))
  return id
}

export interface TargetRequest {
  selector?: string
  index?: number
  source?: string
  x?: number
  y?: number
  ref?: string
  document?: string
}
type Resolved = { el: Element; matches: number } | { error: string; stale?: boolean }

/** The element a request names: a ref, a source stamp, a selector or a point. */
export function resolveTarget(request: TargetRequest): Resolved {
  if (typeof request.ref === 'string' && request.ref) {
    if (request.document !== DOCUMENT_ID)
      return {
        stale: true,
        error: `Ref ${clip(request.ref, 40)} is stale: the page now shows a different document. Call refs again.`
      }
    const el = elements.get(request.ref)?.deref()
    if (!el?.isConnected)
      return {
        stale: true,
        error: `Ref ${clip(request.ref, 40)} is stale: its element was removed from the page. Call refs again.`
      }
    return { el, matches: 1 }
  }
  if (typeof request.source === 'string' && request.source.trim()) {
    const wanted = request.source.trim()
    const all = [...document.querySelectorAll(sourceSelector())].filter((e) => {
      const stamp = sourceStamp(e) ?? ''
      return !overlay(e) && (stamp === wanted || stamp.startsWith(`${wanted}:`))
    })
    const index = Math.max(0, Math.min(all.length - 1, Math.floor(Number(request.index) || 0)))
    return all[index]
      ? { el: all[index], matches: all.length }
      : { error: `No element is stamped with source ${clip(wanted, 200)}` }
  }
  return find(request)
}

const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="switch"], [role="option"], [tabindex], [contenteditable=""], [contenteditable="true"], h1, h2, h3'

function nameOf(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return aria
  const labels = (el as HTMLInputElement).labels
  if (labels?.length) return squash(labels[0].textContent ?? '')
  return el.getAttribute('alt') ?? el.getAttribute('title') ?? el.getAttribute('placeholder') ?? ''
}

/** Refs for the page's interactive elements and headings, or for `selector`'s matches. */
export function listRefs(request: { selector?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(MAX_REFS, Math.floor(Number(request.limit) || 50)))
  let all: Element[]
  try {
    all = [...document.querySelectorAll(request.selector?.trim() || INTERACTIVE)]
  } catch {
    return { error: `Invalid CSS selector: ${clip(String(request.selector), 200)}` }
  }
  const shown = all.filter((e) => !overlay(e) && (request.selector || visible(e)))
  return {
    document: DOCUMENT_ID,
    url: location.href,
    title: clip(document.title, 200),
    total: shown.length,
    truncated: shown.length > limit,
    refs: shown.slice(0, limit).map((el) => {
      const r = el.getBoundingClientRect()
      const name = clip(squash(nameOf(el)), 80)
      return {
        ref: refOf(el),
        element: describe(el),
        role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
        ...(name ? { name } : {}),
        text: clip(squash((el as HTMLElement).innerText ?? el.textContent ?? ''), 80),
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height)
        },
        source: sourceStamp(el),
        ...(visible(el) ? {} : { visible: false }),
        ...(disabled(el) ? { disabled: true } : {})
      }
    })
  }
}

export interface ObserveTarget extends TargetRequest {
  attrs?: string[]
  styles?: string[]
}

/** The selector's matches outside Trezi's overlays, or why it cannot be read. */
function matches(selector: string): Element[] | { error: string; invalid: true } {
  try {
    return [...document.querySelectorAll(selector)].filter((e) => !overlay(e))
  } catch {
    return { error: `Invalid CSS selector: ${clip(selector, 200)}`, invalid: true }
  }
}

function observeOne(target: ObserveTarget) {
  let el: Element | null = null
  let count: number
  if (target.selector && !target.ref && !target.source) {
    const all = matches(target.selector)
    if (!Array.isArray(all)) return all
    count = all.length
    el = all[Math.max(0, Math.min(all.length - 1, Math.floor(Number(target.index) || 0)))] ?? null
  } else {
    const found = resolveTarget(target)
    if ('error' in found) return found.stale ? found : { count: 0, found: false }
    el = found.el
    count = found.matches
  }
  if (!el) return { count, found: false }
  const attrs: Record<string, string | null> = {}
  for (const name of target.attrs ?? []) attrs[name] = el.getAttribute(name)
  const computed = target.styles?.length ? getComputedStyle(el) : null
  const styles: Record<string, string> = {}
  for (const name of target.styles ?? [])
    styles[name] = clip(computed?.getPropertyValue(name) ?? '', 300)
  const control = el as HTMLInputElement
  const hasValue =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  return {
    count,
    found: true,
    element: describe(el),
    source: sourceStamp(el),
    visible: visible(el),
    text: clip(squash((el as HTMLElement).innerText ?? el.textContent ?? ''), MAX_TEXT),
    ...(hasValue
      ? control.type === 'password'
        ? { valueHidden: true }
        : { value: clip(control.value, MAX_TEXT) }
      : {}),
    checked:
      el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true',
    disabled: disabled(el),
    focused: document.activeElement === el,
    attrs,
    styles
  }
}

/** Raw facts for each target, plus the page and its console errors since `consoleSince`. */
export function observe(request: { targets: ObserveTarget[]; consoleSince?: number }) {
  const errors = readConsole({
    since: Number(request.consoleSince) || 0,
    limit: 5,
    errorsOnly: true
  })
  return {
    document: DOCUMENT_ID,
    url: location.href,
    title: clip(document.title, 500),
    readyState: document.readyState,
    consoleErrors: errors.entries.length + errors.dropped,
    consoleSample: errors.entries.map(({ level, text }) => ({ level, text: clip(text, 300) })),
    targets: (request.targets ?? []).slice(0, 20).map(observeOne)
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __treziAgentObserve:
    | { document: string; refs: typeof listRefs; observe: typeof observe }
    | undefined
}

globalThis.__treziAgentObserve = { document: DOCUMENT_ID, refs: listRefs, observe }
