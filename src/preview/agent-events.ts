import { describeElement, overlay } from './agent-inspect'

/**
 * Shared pieces of the agent browser's interactions (LKM-230): synthetic pointer, mouse
 * and keyboard events, and the safety checks every action runs before it acts. Events are
 * untrusted: page handlers run and click activation follows, but the browser applies no
 * CSS :hover and performs no other default action unless `agent-keys.ts` emulates it.
 */

export type Refusal = {
  error: string
  refused: 'upload' | 'download' | 'navigation' | 'form'
}

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text)
export const describe = (el: Element | null) => (el ? describeElement(el) : 'nothing')

const sameOrigin = (href: string) => {
  try {
    return new URL(href, location.href).origin === location.origin
  } catch {
    return false
  }
}

/** A form submission leaving the dev server's origin, or null. */
export function formRefusal(
  form: HTMLFormElement | null,
  submitter?: Element | null
): Refusal | null {
  if (!form) return null
  const action =
    submitter?.hasAttribute('formaction') && 'formAction' in submitter
      ? String((submitter as HTMLButtonElement).formAction)
      : form.action
  return sameOrigin(action)
    ? null
    : { refused: 'form', error: `Form submission to another host is refused: ${clip(action)}` }
}

/** File inputs, downloads, links off the origin and external form posts are refused before any event. */
export function refusal(el: Element): Refusal | null {
  const control = el instanceof HTMLInputElement ? el : (el.closest('label')?.control ?? null)
  if (control instanceof HTMLInputElement && control.type === 'file')
    return { refused: 'upload', error: 'File uploads are not allowed in the agent browser.' }
  const link = el.closest('a[href], area[href]') as HTMLAnchorElement | null
  if (link) {
    if (link.hasAttribute('download'))
      return { refused: 'download', error: 'Downloads are not allowed in the agent browser.' }
    let url: URL | null = null
    try {
      url = new URL(link.href)
    } catch {}
    if (url && url.protocol !== 'javascript:' && url.origin !== location.origin)
      return {
        refused: 'navigation',
        error: `Navigation outside the dev server origin is blocked: ${clip(url.href)}`
      }
  }
  const button = el.closest('button, input[type="submit"], input[type="image"]') as
    | HTMLButtonElement
    | HTMLInputElement
    | null
  if (button && button.type !== 'button' && button.type !== 'reset')
    return formRefusal(button.form, button)
  return null
}

export function visible(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility
  if (check && !check.call(el, { visibilityProperty: true })) return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 || rect.height > 0
}

export function disabled(el: Element): boolean {
  const control = el.closest('button, input, select, textarea, fieldset')
  return !!control?.matches(':disabled') || el.closest('[aria-disabled="true"]') !== null
}

export function mouseInit(x: number, y: number, extra: MouseEventInit = {}): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    ...extra
  }
}

/** Dispatches one event; false when a handler called preventDefault. */
export function fire(
  target: EventTarget,
  type: string,
  init: EventInit,
  Kind: new (type: string, init: never) => Event = Event
): boolean {
  return target.dispatchEvent(new Kind(type, init as never))
}

let hovered: Element | null = null

/** Moves the synthetic pointer onto `el`, leaving the previously hovered element. */
export function hoverTo(el: Element, x: number, y: number) {
  if (hovered && hovered !== el && hovered.isConnected) {
    const out = mouseInit(x, y, { relatedTarget: el })
    fire(hovered, 'pointerout', out, PointerEvent)
    fire(hovered, 'pointerleave', { ...out, bubbles: false }, PointerEvent)
    fire(hovered, 'mouseout', out, MouseEvent)
    fire(hovered, 'mouseleave', { ...out, bubbles: false }, MouseEvent)
  }
  const init = mouseInit(x, y, { relatedTarget: hovered?.isConnected ? hovered : null })
  if (hovered !== el) {
    fire(el, 'pointerover', init, PointerEvent)
    fire(el, 'pointerenter', { ...init, bubbles: false }, PointerEvent)
    fire(el, 'mouseover', init, MouseEvent)
    fire(el, 'mouseenter', { ...init, bubbles: false }, MouseEvent)
  }
  fire(el, 'pointermove', init, PointerEvent)
  fire(el, 'mousemove', init, MouseEvent)
  hovered = el
}

const FOCUSABLE =
  'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]'

/** The full press sequence at one point; the final click runs the element's activation. */
export function activate(el: Element, x: number, y: number) {
  hoverTo(el, x, y)
  fire(el, 'pointerdown', mouseInit(x, y, { buttons: 1 }), PointerEvent)
  if (fire(el, 'mousedown', mouseInit(x, y, { buttons: 1, detail: 1 }), MouseEvent)) {
    const focusable = el.closest(FOCUSABLE) as HTMLElement | null
    if (focusable && !disabled(focusable)) focusable.focus({ preventScroll: true })
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }
  fire(el, 'pointerup', mouseInit(x, y), PointerEvent)
  fire(el, 'mouseup', mouseInit(x, y, { detail: 1 }), MouseEvent)
  fire(el, 'click', mouseInit(x, y, { detail: 1 }), MouseEvent)
}

/** The point an element is used at, scrolled into view first; `hit` is what a user would touch there. */
export function pointOf(el: Element): { x: number; y: number; hit: Element | null } | null {
  let rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    rect = el.getBoundingClientRect()
  }
  const x = Math.round(Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)))
  const y = Math.round(Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)))
  const hit = document.elementsFromPoint(x, y).find((e) => !overlay(e)) ?? null
  return { x, y, hit }
}
