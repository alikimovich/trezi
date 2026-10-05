import type { MoveNodeRequest } from '../shared/api'
import { type SiblingSlot, siblingSlot } from './sibling-drop'
import { sourceSelector, sourceStamp } from './source-stamp'

/** Native-preview input only. No DOM reparenting: source edits own persistence. */
export function installDragReorder(options: {
  selection: () => Element | null
  blocked: () => boolean
  overlay: () => ShadowRoot
  clearHover: () => void
  move: (request: MoveNodeRequest) => void
}): { active: () => boolean } {
  let drag: {
    el: Element
    parent: Element
    children: Element[]
    source: string
    startX: number
    startY: number
    pointer: number
    moved: boolean
    slot: SiblingSlot | null
    cursor: string
  } | null = null
  let line: HTMLDivElement | null = null
  let suppressClick = false
  const swallow = (e: Event): void => {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  const modifier = (e: MouseEvent | KeyboardEvent): boolean =>
    /Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey
  const finish = (): void => {
    if (!drag) return
    document.documentElement.style.cursor = drag.cursor
    drag = null
    line?.remove()
    line = null
  }
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return
      suppressClick = false
      const el = options.selection()
      if (
        !e.isTrusted ||
        e.button !== 0 ||
        !modifier(e) ||
        options.blocked() ||
        !el?.isConnected ||
        !(e.target instanceof Element) ||
        !el.contains(e.target)
      )
        return
      const source = sourceStamp(el)
      const parent = el.parentElement
      if (!source || !parent || el === document.body) return
      swallow(e)
      suppressClick = true
      drag = {
        el,
        parent,
        source,
        children: Array.from(parent.children),
        startX: e.clientX,
        startY: e.clientY,
        pointer: e.pointerId,
        moved: false,
        slot: null,
        cursor: document.documentElement.style.cursor
      }
    },
    true
  )
  window.addEventListener(
    'pointermove',
    (e) => {
      const d = drag
      if (!d || !e.isTrusted || e.pointerId !== d.pointer) return
      swallow(e)
      if (
        !modifier(e) ||
        options.blocked() ||
        options.selection() !== d.el ||
        !d.el.isConnected ||
        d.el.parentElement !== d.parent ||
        d.children.some((el, i) => d.parent.children[i] !== el) ||
        d.parent.children.length !== d.children.length
      ) {
        finish()
        return
      }
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return
      d.moved = true
      options.clearHover()
      document.documentElement.style.cursor = 'grabbing'
      const parentBox = d.parent.getBoundingClientRect()
      const inside =
        e.clientX >= parentBox.left &&
        e.clientX <= parentBox.right &&
        e.clientY >= parentBox.top &&
        e.clientY <= parentBox.bottom
      const boxes = d.children.map((el) => el.getBoundingClientRect())
      const style = getComputedStyle(d.parent)
      const visible = boxes.filter((b) => b.width > 0 && b.height > 0)
      const row = style.display.includes('flex')
        ? style.flexDirection.startsWith('row')
        : visible.some((b, i) => {
            const next = visible[i + 1]
            return (
              next &&
              Math.min(b.bottom, next.bottom) - Math.max(b.top, next.top) >
                Math.min(b.height, next.height) / 2
            )
          })
      const reverse = row
        ? (style.direction === 'rtl') !== (style.flexDirection === 'row-reverse')
        : style.flexDirection === 'column-reverse'
      d.slot = inside
        ? siblingSlot(boxes, d.children.indexOf(d.el), e.clientX, e.clientY, row, reverse, d.slot)
        : null
      if (d.slot && !sourceStamp(d.children[d.slot.index])) d.slot = null
      if (!d.slot) {
        line?.remove()
        line = null
        return
      }
      line ??= document.createElement('div')
      line.setAttribute('data-trezi-drop-line', '')
      const s = d.slot
      line.style.cssText =
        `position:fixed;pointer-events:none;background:#2563eb;outline:1px solid white;` +
        `left:${s.x - (s.vertical ? 1 : 0)}px;top:${s.y - (s.vertical ? 0 : 1)}px;` +
        `width:${s.vertical ? 2 : s.length}px;height:${s.vertical ? s.length : 2}px;`
      options.overlay().appendChild(line)
    },
    true
  )
  window.addEventListener(
    'pointerup',
    (e) => {
      const d = drag
      if (!e.isTrusted) return
      if (!d) {
        if (suppressClick) swallow(e)
        return
      }
      if (e.pointerId !== d.pointer) return
      swallow(e)
      const target = d.slot && d.children[d.slot.index]
      if (
        modifier(e) &&
        d.moved &&
        d.slot &&
        target?.isConnected &&
        options.selection() === d.el &&
        !options.blocked() &&
        d.el.parentElement === d.parent &&
        target.parentElement === d.parent &&
        d.children.length === d.parent.children.length &&
        d.children.every((el, i) => d.parent.children[i] === el) &&
        sourceStamp(d.el) === d.source
      ) {
        const source = sourceStamp(target)
        if (source)
          options.move({
            dragged: { source: d.source },
            target: { source },
            position: d.slot.position,
            sessionId: crypto.randomUUID()
          })
      }
      finish()
    },
    true
  )
  window.addEventListener(
    'click',
    (e) => {
      if (suppressClick && e.isTrusted) {
        swallow(e)
        suppressClick = false
      }
    },
    true
  )
  window.addEventListener(
    'dragstart',
    (e) => {
      if (drag) swallow(e)
    },
    true
  )
  window.addEventListener(
    'keydown',
    (e) => {
      if (drag && e.isTrusted && e.key === 'Escape') {
        swallow(e)
        finish()
      }
    },
    true
  )
  window.addEventListener(
    'keyup',
    (e) => {
      if (drag && !modifier(e)) finish()
    },
    true
  )
  for (const event of ['blur', 'pagehide', 'pointercancel', 'scroll', 'resize']) {
    window.addEventListener(event, finish, true)
  }
  return { active: () => drag !== null }
}
