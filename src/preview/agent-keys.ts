import {
  activate,
  describe,
  disabled,
  fire,
  formRefusal,
  pointOf,
  type Refusal,
  refusal,
  visible
} from './agent-events'
import { overlay } from './agent-inspect'

/**
 * Typing and key presses in the agent browser (LKM-230). Synthetic key events change
 * nothing by themselves, so the defaults a user relies on are emulated: characters go into
 * the focused field, Enter submits its form or activates a button or link, Space toggles,
 * Tab moves focus, Backspace/Delete edit and the arrow keys step a select. Every emulated
 * activation passes the same safety checks as a click.
 */

export const MAX_TEXT = 1000

interface Key {
  key: string
  code: string
  keyCode: number
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

const NAMED: Record<string, [string, string, number]> = {
  enter: ['Enter', 'Enter', 13],
  return: ['Enter', 'Enter', 13],
  escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27],
  tab: ['Tab', 'Tab', 9],
  backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46],
  space: [' ', 'Space', 32],
  arrowup: ['ArrowUp', 'ArrowUp', 38],
  arrowdown: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36],
  end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34]
}
const MODIFIERS: Record<string, keyof Key> = {
  shift: 'shiftKey',
  ctrl: 'ctrlKey',
  control: 'ctrlKey',
  alt: 'altKey',
  option: 'altKey',
  meta: 'metaKey',
  cmd: 'metaKey',
  command: 'metaKey'
}

function charKey(ch: string, shift = ch !== ch.toLowerCase()): Key {
  const upper = ch.toUpperCase()
  const code = /^[a-z]$/i.test(ch)
    ? `Key${upper}`
    : /^\d$/.test(ch)
      ? `Digit${ch}`
      : ch === ' '
        ? 'Space'
        : ''
  return {
    key: ch,
    code,
    keyCode: upper.charCodeAt(0),
    shiftKey: shift,
    ctrlKey: false,
    altKey: false,
    metaKey: false
  }
}

/** "Enter", "Shift+Tab", "Meta+a" or one character; null when it names no key. */
export function parseKey(spec: string): Key | null {
  const parts = spec === '+' ? ['+'] : spec.split('+')
  if (parts.at(-1) === '' && parts.length > 1) parts.splice(-2, 2, '+')
  const name = parts.pop() ?? ''
  const named = NAMED[name.toLowerCase()]
  if (!named && [...name].length !== 1) return null
  const key: Key = named
    ? {
        key: named[0],
        code: named[1],
        keyCode: named[2],
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false
      }
    : charKey(name)
  for (const part of parts) {
    const flag = MODIFIERS[part.toLowerCase()]
    if (!flag) return null
    ;(key as unknown as Record<string, boolean>)[flag] = true
  }
  if (!named && key.shiftKey) key.key = key.key.toUpperCase()
  return key
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement
const VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'])
const NOT_TEXT = new Set([
  'button',
  'submit',
  'reset',
  'image',
  'checkbox',
  'radio',
  'file',
  'hidden'
])

/** A field that takes typed text, or null. */
export function textField(el: Element | null): Field | null {
  if (el instanceof HTMLTextAreaElement) return el
  if (el instanceof HTMLInputElement) return NOT_TEXT.has(el.type) ? null : el
  return el instanceof HTMLElement && el.isContentEditable ? el : null
}

const keyInit = (key: Key): KeyboardEventInit => ({
  ...key,
  bubbles: true,
  cancelable: true,
  composed: true,
  view: window
})
const inputEvent = (el: Element, inputType: string, data: string | null, cancelable = false) =>
  el.dispatchEvent(
    new InputEvent(cancelable ? 'beforeinput' : 'input', {
      inputType,
      data,
      bubbles: true,
      cancelable,
      composed: true
    })
  )

function edit(field: Field, text: string, inputType: string, direction: -1 | 0 | 1 = 0) {
  if (!inputEvent(field, inputType, text || null, true)) return
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    let start: number | null = null
    try {
      start = field.selectionStart
    } catch {}
    if (start === null) {
      field.value = direction < 0 ? field.value.slice(0, -1) : field.value + text
    } else {
      let end = field.selectionEnd ?? start
      if (start === end && direction < 0) start = Math.max(0, start - 1)
      if (start === end && direction > 0) end = Math.min(field.value.length, end + 1)
      field.setRangeText(text, start, end, 'end')
    }
    inputEvent(field, inputType, text || null)
  } else {
    document.execCommand(
      direction < 0 ? 'delete' : direction > 0 ? 'forwardDelete' : 'insertText',
      false,
      text
    )
  }
}

function typeChar(field: Field, ch: string) {
  const init = keyInit(charKey(ch))
  if (fire(field, 'keydown', init, KeyboardEvent)) {
    const full =
      (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
      field.maxLength > 0 &&
      field.value.length >= field.maxLength &&
      field.selectionStart === field.selectionEnd
    if (fire(field, 'keypress', init, KeyboardEvent) && !full) edit(field, ch, 'insertText')
  }
  fire(field, 'keyup', init, KeyboardEvent)
}

/** Types `text` into `el` (or the focused field); `clear` replaces what it holds. */
export function typeText(el: Element | null, text: string, clear: boolean) {
  const target = el ?? document.activeElement
  const blocked = target && refusal(target)
  if (blocked && blocked.refused === 'upload') return blocked
  const field = textField(target)
  if (!field) return { error: `${describe(target)} is not a text field. Pass a field's selector.` }
  if (disabled(field) || (field as HTMLInputElement).readOnly)
    return { error: `${describe(field)} is disabled or read-only.` }
  field.focus({ preventScroll: true })
  if (field instanceof HTMLInputElement && VALUE_TYPES.has(field.type)) {
    field.value = text
    inputEvent(field, 'insertReplacementText', text)
  } else {
    if (clear) {
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        if (field.value) {
          field.select()
          edit(field, '', 'deleteContentBackward')
        }
      } else if (field.textContent) {
        document.execCommand('selectAll')
        document.execCommand('delete')
      }
    }
    for (const ch of text) typeChar(field, ch)
  }
  fire(field, 'change', { bubbles: true })
  const value =
    field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
      ? field.type === 'password'
        ? '•'.repeat(field.value.length)
        : field.value
      : (field.textContent ?? '')
  return { element: describe(field), value: value.slice(0, 200) }
}

function tabbables(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"], [contenteditable=""]'
    )
  ].filter((e) => e.tabIndex >= 0 && !disabled(e) && visible(e) && !overlay(e))
}

/** Clicks a control the way Enter or Space would, after the click safety checks. */
function keyActivate(el: Element): Refusal | string {
  const blocked = refusal(el)
  if (blocked) return blocked
  const point = pointOf(el)
  activate(el, point?.x ?? 0, point?.y ?? 0)
  return `activated ${describe(el)}`
}

function defaultAction(el: Element, key: Key): Refusal | string | null {
  const field = textField(el)
  if (key.key === 'Enter' && el instanceof HTMLInputElement && field && el.form) {
    const form = el.form
    const submitter = form.querySelector(
      'button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]'
    )
    if (submitter && !disabled(submitter)) return keyActivate(submitter)
    const blocked = formRefusal(form)
    if (blocked) return blocked
    form.requestSubmit()
    return 'submitted the form'
  }
  const button = el.closest('button, a[href], summary, [role="button"], [role="link"]')
  if ((key.key === 'Enter' || key.key === ' ') && button && !field) return keyActivate(button)
  if (key.key === ' ' && el instanceof HTMLInputElement && /^(checkbox|radio)$/.test(el.type))
    return keyActivate(el)
  if (key.key === 'Tab') {
    const list = tabbables()
    const at = list.indexOf(el as HTMLElement)
    const from = at >= 0 ? at : key.shiftKey ? list.length : -1
    const next = list[(from + (key.shiftKey ? -1 : 1) + list.length) % list.length]
    next?.focus()
    return next ? `focused ${describe(next)}` : null
  }
  if (field && (key.key === 'Backspace' || key.key === 'Delete')) {
    edit(
      field,
      '',
      key.key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward',
      key.key === 'Backspace' ? -1 : 1
    )
    return 'deleted'
  }
  if (el instanceof HTMLSelectElement && (key.key === 'ArrowDown' || key.key === 'ArrowUp')) {
    const index = el.selectedIndex + (key.key === 'ArrowDown' ? 1 : -1)
    if (index < 0 || index >= el.options.length || el.options[index].disabled) return null
    el.selectedIndex = index
    fire(el, 'input', { bubbles: true, composed: true })
    fire(el, 'change', { bubbles: true })
    return `selected ${el.options[index].label}`
  }
  return null
}

/** Presses one key (with modifiers) on `el` or the focused element. */
export function pressKey(el: Element | null, spec: string) {
  const key = parseKey(spec)
  if (!key)
    return {
      error: `Unknown key "${spec.slice(0, 40)}". Use Enter, Escape, Tab, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown or one character, with Shift+, Ctrl+, Alt+ or Meta+.`
    }
  if (el instanceof HTMLElement) el.focus({ preventScroll: true })
  const target = el ?? document.activeElement ?? document.body
  const plain = !key.ctrlKey && !key.metaKey && !key.altKey
  const field = textField(target)
  if (field && plain && key.key.length === 1) {
    typeChar(field, key.key)
    return { element: describe(target), key: spec, effect: 'typed' }
  }
  let effect: Refusal | string | null = null
  if (fire(target, 'keydown', keyInit(key), KeyboardEvent)) {
    if (key.key === 'Enter' || (plain && key.key.length === 1))
      fire(target, 'keypress', keyInit(key), KeyboardEvent)
    effect = plain || key.key === 'Tab' ? defaultAction(target, key) : null
  } else effect = 'prevented by the page'
  fire(target, 'keyup', keyInit(key), KeyboardEvent)
  if (effect && typeof effect === 'object') return effect
  return {
    element: describe(target),
    key: spec,
    effect,
    focused: describe(document.activeElement)
  }
}
