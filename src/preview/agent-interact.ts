import { readConsole } from './agent-console'
import {
  activate,
  describe,
  disabled,
  fire,
  hoverTo,
  mouseInit,
  pointOf,
  refusal,
  visible
} from './agent-events'
import { find, overlay } from './agent-inspect'
import { MAX_TEXT, pressKey, typeText } from './agent-keys'
import { sourceSelector, sourceStamp } from './source-stamp'

/**
 * Agent browser interactions (LKM-230), installed in the isolated TreziPreview world.
 * Bun calls `run` only on a session's private agent page (`src/main/agent-interact.ts`),
 * never on the user's visible preview. A target is a CSS selector (with index), a source
 * stamp (`file:line[:col]`) or a viewport point. Results are plain bounded JSON.
 */

export type InteractAction = 'click' | 'type' | 'press' | 'hover' | 'scroll' | 'select' | 'wait'
export interface InteractRequest {
  action: InteractAction
  selector?: string
  index?: number
  source?: string
  x?: number
  y?: number
  text?: string
  clear?: boolean
  key?: string
  option?: string
  deltaX?: number
  deltaY?: number
  to?: 'top' | 'bottom'
  networkIdle?: boolean
  hidden?: boolean
  timeoutMs?: number
  force?: boolean
}
type Answer = Record<string, unknown> & { error?: string }

const IDLE_MS = 500
let inflight = 0
let lastNetwork = performance.now()
let resources = 0
// A page-world counter (agent pages only, `PreviewAgent.networkCounter`) sends +1/-1 per request.
document.addEventListener('trezi:net', (event) => {
  const step = (event as CustomEvent).detail
  if (step !== 1 && step !== -1) return
  inflight = Math.max(0, inflight + step)
  lastNetwork = performance.now()
})
function networkIdle(): boolean {
  const count = performance.getEntriesByType('resource').length
  if (count !== resources) {
    resources = count
    lastNetwork = performance.now()
  }
  return (
    document.readyState === 'complete' &&
    inflight === 0 &&
    performance.now() - lastNetwork >= IDLE_MS
  )
}

/** The element a request names, or why there is none. */
function resolve(request: InteractRequest): { el: Element; matches: number } | { error: string } {
  if (typeof request.source === 'string' && request.source.trim()) {
    const wanted = request.source.trim()
    const all = [...document.querySelectorAll(sourceSelector())].filter((e) => {
      const stamp = sourceStamp(e) ?? ''
      return !overlay(e) && (stamp === wanted || stamp.startsWith(`${wanted}:`))
    })
    const index = Math.max(0, Math.min(all.length - 1, Math.floor(Number(request.index) || 0)))
    return all[index]
      ? { el: all[index], matches: all.length }
      : { error: `No element is stamped with source ${wanted.slice(0, 200)}` }
  }
  return find(request)
}
const hasTarget = (r: InteractRequest) =>
  !!r.selector?.trim() || !!r.source?.trim() || (Number.isFinite(r.x) && Number.isFinite(r.y))

/** Where a pointer action lands: the element's center, or the requested point. */
function aim(request: InteractRequest, el: Element) {
  if (Number.isFinite(request.x) && Number.isFinite(request.y))
    return { x: request.x as number, y: request.y as number, hit: el, on: el }
  const point = pointOf(el)
  if (!point) return { error: `${describe(el)} is not visible (it has no size).` }
  const inside = point.hit && (point.hit === el || el.contains(point.hit))
  if (!inside && !request.force)
    return {
      error: `${describe(el)} is covered by ${describe(point.hit)} at ${point.x},${point.y}. Close what covers it, or pass force: true.`
    }
  return { ...point, on: inside ? (point.hit as Element) : el }
}

function click(request: InteractRequest, el: Element): Answer {
  const at = aim(request, el)
  if ('error' in at) return at
  const blocked = refusal(at.on)
  if (blocked) return blocked
  if (disabled(at.on)) return { error: `${describe(at.on)} is disabled.` }
  activate(at.on, at.x, at.y)
  return { point: { x: at.x, y: at.y }, clicked: describe(at.on) }
}

function hover(request: InteractRequest, el: Element): Answer {
  const at = aim(request, el)
  if ('error' in at) return at
  hoverTo(at.on, at.x, at.y)
  return {
    point: { x: at.x, y: at.y },
    hovered: describe(at.on),
    note: 'Pointer and mouse handlers ran; CSS :hover rules do not apply to synthetic events.'
  }
}

const scrollable = (el: Element) => {
  const style = getComputedStyle(el)
  return (
    (/(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) ||
    (/(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth)
  )
}

function scroll(request: InteractRequest, el: Element | null): Answer {
  const page = document.scrollingElement ?? document.documentElement
  const dx = Number(request.deltaX) || 0
  const dy = Number(request.deltaY) || 0
  if (el && !dx && !dy && !request.to) {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    return { scrolledIntoView: describe(el), rect: el.getBoundingClientRect().toJSON() }
  }
  let scroller: Element = page
  for (let node = el; node && node !== page; node = node.parentElement)
    if (scrollable(node)) {
      scroller = node
      break
    }
  const before = { x: scroller.scrollLeft, y: scroller.scrollTop }
  const wheelOn = el ?? document.elementFromPoint(innerWidth / 2, innerHeight / 2) ?? page
  const rect = wheelOn.getBoundingClientRect()
  const wheel = fire(
    wheelOn,
    'wheel',
    {
      ...mouseInit(rect.left + rect.width / 2, rect.top + rect.height / 2),
      deltaX: dx,
      deltaY: dy,
      deltaMode: 0
    } as WheelEventInit,
    WheelEvent
  )
  if (!wheel)
    return { scroller: describe(scroller), prevented: 'The page handled the wheel event.' }
  if (request.to === 'top') scroller.scrollTo({ top: 0, behavior: 'instant' })
  else if (request.to === 'bottom')
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' })
  else scroller.scrollBy({ left: dx, top: dy, behavior: 'instant' })
  return {
    scroller: scroller === page ? 'page' : describe(scroller),
    from: before,
    to: { x: scroller.scrollLeft, y: scroller.scrollTop }
  }
}

function select(request: InteractRequest, el: Element): Answer {
  const control = el instanceof HTMLSelectElement ? el : el.closest('label')?.control
  if (!(control instanceof HTMLSelectElement))
    return { error: `${describe(el)} is not a <select>. Click custom menus instead.` }
  const wanted = String(request.option ?? '').trim()
  const options = [...control.options]
  const option =
    options.find((o) => o.value === wanted) ??
    options.find((o) => o.label.trim() === wanted || o.text.trim() === wanted)
  if (!option)
    return {
      error: `No option "${wanted.slice(0, 100)}". Options: ${options
        .slice(0, 20)
        .map((o) => JSON.stringify(o.label.trim()))
        .join(', ')}`
    }
  if (control.disabled || option.disabled) return { error: `${option.label} is disabled.` }
  control.focus({ preventScroll: true })
  if (control.multiple) for (const o of options) o.selected = false
  option.selected = true
  fire(control, 'input', { bubbles: true, composed: true })
  fire(control, 'change', { bubbles: true })
  return { element: describe(control), value: control.value, label: option.label.trim() }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function wait(request: InteractRequest): Promise<Answer> {
  const timeout = Math.max(100, Math.min(15_000, Math.floor(Number(request.timeoutMs) || 5000)))
  const hidden = request.hidden === true
  let check: () => boolean
  let what: string
  if (request.networkIdle) {
    check = networkIdle
    what = 'network idle'
  } else if (request.selector?.trim()) {
    const selector = request.selector
    try {
      document.querySelector(selector)
    } catch {
      return { error: `Invalid CSS selector: ${selector.slice(0, 200)}` }
    }
    check = () =>
      [...document.querySelectorAll(selector)].some((e) => !overlay(e) && visible(e)) !== hidden
    what = `${hidden ? 'no visible' : 'a visible'} ${selector.slice(0, 200)}`
  } else if (request.text) {
    const text = request.text
    check = () => (document.body?.innerText ?? '').includes(text) !== hidden
    what = `text ${hidden ? 'gone' : 'shown'}: ${JSON.stringify(text.slice(0, 200))}`
  } else return { error: 'Wait for a selector, text, or networkIdle: true.' }
  const started = performance.now()
  for (;;) {
    if (check()) return { waitedFor: what, ms: Math.round(performance.now() - started) }
    if (performance.now() - started > timeout)
      return { error: `Timed out after ${timeout} ms waiting for ${what}.` }
    await pause(50)
  }
}

/** Two frames (or 100 ms when frames are throttled) so handlers' re-renders are on the page. */
const settle = () =>
  new Promise<void>((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()))
    setTimeout(done, 100)
  })

let unloading = false
let listening = false

async function act(request: InteractRequest): Promise<Answer> {
  if (request.action === 'wait') return wait(request)
  const found = hasTarget(request) ? resolve(request) : null
  if (found && 'error' in found) return found
  const el = found?.el ?? null
  const base = el ? { element: describe(el), source: sourceStamp(el), matches: found?.matches } : {}
  let answer: Answer
  if (request.action === 'type')
    answer = typeText(el, String(request.text ?? '').slice(0, MAX_TEXT), request.clear !== false)
  else if (request.action === 'press') answer = pressKey(el, String(request.key ?? ''))
  else if (request.action === 'scroll') answer = scroll(request, el)
  else if (!el) return { error: `${request.action} needs a selector, source or x/y point.` }
  else if (request.action === 'click') answer = click(request, el)
  else if (request.action === 'hover') answer = hover(request, el)
  else if (request.action === 'select') answer = select(request, el)
  else return { error: `Unknown action ${String(request.action).slice(0, 40)}.` }
  return { ...base, ...answer }
}

/** One interaction; `consoleSeq` marks the console before it and `navigating` a page unload. */
export async function run(request: InteractRequest): Promise<Answer> {
  if (!listening) {
    // Only agent pages ever call `run`, so the visible preview never gets this listener.
    listening = true
    addEventListener('beforeunload', () => {
      unloading = true
    })
  }
  unloading = false
  const consoleSeq = readConsole({ since: Number.MAX_SAFE_INTEGER, limit: 1 }).total
  let answer: Answer
  try {
    answer = await act(request)
  } catch (error) {
    answer = {
      error: `${request.action} failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!answer.error && request.action !== 'wait') await settle()
  return { ...answer, consoleSeq, navigating: unloading }
}

/** The page after an interaction: its URL and the console errors since `since`. */
export function after(since: number) {
  const errors = readConsole({ since, limit: 10, errorsOnly: true })
  return {
    url: location.href,
    title: document.title.slice(0, 200),
    consoleErrors: errors.entries.map(({ level, text }) => ({ level, text: text.slice(0, 500) })),
    droppedErrors: errors.dropped
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __treziAgentInteract: { run: typeof run; after: typeof after } | undefined
}

globalThis.__treziAgentInteract = { run, after }
