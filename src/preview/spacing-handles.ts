/**
 * Selection-mode spacing handles (LKM-541). The selected element shows one grip per
 * padding side and one in the gap between its first two laid-out children. A drag
 * previews the value inline at once (the Styles preview stash, no source write, HMR
 * or agent turn); release sends one draft that the inspector stages for its Apply.
 * Escape, a cancelled pointer or a drag back to the start leave no draft. Escape
 * arrives through `cancel()` from the preload's key handler, which must see it
 * before its own Escape branch (that one exits Selection mode).
 *
 * Geometry comes from client rects, so a scroll needs only a re-position. A CSS zoom
 * or scale above the element is the ratio of its rendered to its layout width:
 * pointer pixels are divided by it, so a value moves by CSS pixels, not screen ones.
 */
import type { SpacingDraftProp } from '../shared/spacing-draft'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}
export interface Sides {
  top: number
  right: number
  bottom: number
  left: number
}
export interface Gap {
  prop: 'row-gap' | 'column-gap'
  value: number
  rect: Box
}
export interface SpacingHandle {
  prop: SpacingDraftProp
  axis: 'x' | 'y'
  /** +1 when moving right/down grows the value. */
  sign: 1 | -1
  value: number
  box: Box
}

const GRIP = 18,
  THICK = 6

/** Rendered px per CSS px: CSS zoom or a transform scale above the element. */
export function renderScale(renderedWidth: number, layoutWidth: number): number {
  const scale = layoutWidth > 0 ? renderedWidth / layoutWidth : 1
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** The gap the first two children leave: beside each other a column gap, else a row gap. */
export function gapBetween(first: Box, second: Box, row: number, column: number): Gap | null {
  const right = first.left + first.width,
    bottom = first.top + first.height
  if (second.left >= right - 0.5) {
    const top = Math.min(first.top, second.top)
    const height = Math.max(bottom, second.top + second.height) - top
    return {
      prop: 'column-gap',
      value: column,
      rect: { left: right, top, width: Math.max(0, second.left - right), height }
    }
  }
  if (second.top >= bottom - 0.5) {
    const left = Math.min(first.left, second.left)
    const width = Math.max(right, second.left + second.width) - left
    return {
      prop: 'row-gap',
      value: row,
      rect: { left, top: bottom, width, height: Math.max(0, second.top - bottom) }
    }
  }
  return null
}

/** One grip per padding side and the gap; a side too short to hold a grip has none. */
export function spacingHandles(
  rect: Box,
  padding: Sides,
  scale: number,
  gap: Gap | null
): SpacingHandle[] {
  const handles: SpacingHandle[] = []
  const midX = rect.left + rect.width / 2,
    midY = rect.top + rect.height / 2
  const wide = rect.width >= GRIP * 2,
    tall = rect.height >= GRIP * 2
  const along = (band: number, edge: number, inward: 1 | -1) =>
    edge + inward * Math.max(band * scale, THICK) * 0.5 - THICK / 2
  if (wide) {
    handles.push({
      prop: 'padding-top',
      axis: 'y',
      sign: 1,
      value: padding.top,
      box: {
        left: midX - GRIP / 2,
        top: along(padding.top, rect.top, 1),
        width: GRIP,
        height: THICK
      }
    })
    handles.push({
      prop: 'padding-bottom',
      axis: 'y',
      sign: -1,
      value: padding.bottom,
      box: {
        left: midX - GRIP / 2,
        top: along(padding.bottom, rect.top + rect.height, -1),
        width: GRIP,
        height: THICK
      }
    })
  }
  if (tall) {
    handles.push({
      prop: 'padding-left',
      axis: 'x',
      sign: 1,
      value: padding.left,
      box: {
        left: along(padding.left, rect.left, 1),
        top: midY - GRIP / 2,
        width: THICK,
        height: GRIP
      }
    })
    handles.push({
      prop: 'padding-right',
      axis: 'x',
      sign: -1,
      value: padding.right,
      box: {
        left: along(padding.right, rect.left + rect.width, -1),
        top: midY - GRIP / 2,
        width: THICK,
        height: GRIP
      }
    })
  }
  if (gap) {
    const g = gap.rect,
      column = gap.prop === 'column-gap'
    if (column ? g.height >= GRIP : g.width >= GRIP)
      handles.push({
        prop: gap.prop,
        axis: column ? 'x' : 'y',
        sign: 1,
        value: gap.value,
        box: column
          ? {
              left: g.left + g.width / 2 - THICK / 2,
              top: g.top + g.height / 2 - GRIP / 2,
              width: THICK,
              height: GRIP
            }
          : {
              left: g.left + g.width / 2 - GRIP / 2,
              top: g.top + g.height / 2 - THICK / 2,
              width: GRIP,
              height: THICK
            }
      })
  }
  return handles
}

/** The dragged value in whole CSS px, never below zero. */
export function dragValue(start: number, delta: number, sign: 1 | -1, scale: number): number {
  return Math.max(0, Math.round(start + (sign * delta) / (scale > 0 ? scale : 1)))
}

export interface SpacingHandleDeps {
  layer: () => HTMLElement | null
  /** Selection mode is on and no inline editor, composer or 3D view owns the pointer. */
  enabled: () => boolean
  preview: (el: HTMLElement, prop: SpacingDraftProp, value: string) => void
  /** Put the inline value back as it was before the gesture (`before`). */
  restore: (el: HTMLElement, prop: SpacingDraftProp, before: string) => void
  commit: (prop: SpacingDraftProp, value: string) => void
}

const px = (value: string) => {
  const number = parseFloat(value)
  return Number.isFinite(number) ? number : 0
}

export function createSpacingHandles(deps: SpacingHandleDeps) {
  let target: HTMLElement | null = null,
    instances = 1
  let drag: {
    prop: SpacingDraftProp
    start: number
    value: number
    before: string
    stop: () => void
  } | null = null
  let readout: HTMLDivElement | null = null

  const measure = (el: HTMLElement): SpacingHandle[] => {
    const rect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const scale = renderScale(rect.width, el.offsetWidth)
    const padding = {
      top: px(cs.paddingTop),
      right: px(cs.paddingRight),
      bottom: px(cs.paddingBottom),
      left: px(cs.paddingLeft)
    }
    let gap: Gap | null = null
    if (/(?:^|-)(?:flex|grid)$/.test(cs.display)) {
      const children = Array.from(el.children).filter(
        (child) =>
          child instanceof HTMLElement &&
          child.getClientRects().length > 0 &&
          !/^(?:absolute|fixed)$/.test(getComputedStyle(child).position)
      )
      if (children.length >= 2)
        gap = gapBetween(
          children[0].getBoundingClientRect(),
          children[1].getBoundingClientRect(),
          px(cs.rowGap),
          px(cs.columnGap)
        )
    }
    return spacingHandles(rect, padding, scale, gap)
  }

  const label = (prop: SpacingDraftProp, value: number) => {
    const layer = deps.layer()
    if (!layer) return
    if (!readout) {
      readout = document.createElement('div')
      readout.setAttribute('data-trezi-spacing-readout', '')
      readout.style.cssText =
        'position:fixed;pointer-events:none;font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'color:#fff;background:#db2777;padding:2px 6px;border-radius:4px;white-space:nowrap;'
    }
    // Every instance of the stamp shares the source this draft applies to.
    readout.textContent = `${prop} ${value}px${instances > 1 ? ` · ${instances} instances share this source` : ''}`
    const rect = target?.getBoundingClientRect()
    readout.style.left = `${Math.max(4, rect?.left ?? 0)}px`
    readout.style.top = `${Math.max(4, (rect ? rect.top + rect.height : 0) + 6)}px`
    if (readout.parentNode !== layer) layer.appendChild(readout)
  }

  const finish = (commit: boolean) => {
    const current = drag,
      el = target
    if (!current) return
    drag = null
    current.stop()
    readout?.remove()
    if (!el) return
    if (commit && current.value !== current.start) deps.commit(current.prop, String(current.value))
    else deps.restore(el, current.prop, current.before)
    position()
  }

  const begin = (handle: SpacingHandle, grip: HTMLElement, e: PointerEvent) => {
    const el = target
    if (!el || drag || !e.isTrusted || e.button !== 0 || !deps.enabled()) return
    // No focus move: the page keeps its focused input and caret.
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX,
      startY = e.clientY
    const scale = renderScale(el.getBoundingClientRect().width, el.offsetWidth)
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== e.pointerId) return
      event.preventDefault()
      const delta = handle.axis === 'x' ? event.clientX - startX : event.clientY - startY
      const value = dragValue(handle.value, delta, handle.sign, scale)
      if (value === drag.value) return
      drag.value = value
      deps.preview(el, handle.prop, `${value}px`)
      label(handle.prop, value)
      position()
    }
    const onUp = (event: PointerEvent) => {
      if (event.pointerId === e.pointerId) finish(true)
    }
    const onCancel = () => finish(false)
    try {
      grip.setPointerCapture(e.pointerId)
    } catch {
      /* the pointer already ended */
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
    grip.addEventListener('pointercancel', onCancel)
    drag = {
      prop: handle.prop,
      start: handle.value,
      value: handle.value,
      before: el.style.getPropertyValue(handle.prop),
      stop: () => {
        grip.removeEventListener('pointermove', onMove)
        grip.removeEventListener('pointerup', onUp)
        grip.removeEventListener('pointercancel', onCancel)
      }
    }
    label(handle.prop, handle.value)
  }

  const clearGrips = () => {
    const layer = deps.layer()
    layer?.querySelectorAll('[data-trezi-spacing-handle]').forEach((node) => {
      if (!drag || (node as HTMLElement).dataset.prop !== drag.prop) node.remove()
    })
  }

  /** Re-measure and redraw the grips for the current target (scroll, resize, drag). */
  function position() {
    const layer = deps.layer()
    if (!layer) return
    if (!target || !target.isConnected || !deps.enabled()) {
      if (drag) finish(false)
      clearGrips()
      return
    }
    const handles = measure(target)
    const existing = new Map<string, HTMLElement>()
    layer.querySelectorAll<HTMLElement>('[data-trezi-spacing-handle]').forEach((node) => {
      existing.set(node.dataset.prop ?? '', node)
    })
    for (const handle of handles) {
      let grip = existing.get(handle.prop)
      existing.delete(handle.prop)
      if (!grip) {
        grip = document.createElement('div')
        grip.setAttribute('data-trezi-spacing-handle', '')
        grip.dataset.prop = handle.prop
        grip.style.cssText =
          'position:fixed;pointer-events:auto;box-sizing:border-box;border-radius:3px;' +
          'background:#db2777;border:1px solid #fff;touch-action:none;'
        layer.appendChild(grip)
      }
      const node = grip
      node.style.cursor = handle.axis === 'x' ? 'ew-resize' : 'ns-resize'
      node.style.left = `${handle.box.left}px`
      node.style.top = `${handle.box.top}px`
      node.style.width = `${handle.box.width}px`
      node.style.height = `${handle.box.height}px`
      node.title = `${handle.prop} ${handle.value}px`
      node.onpointerdown = (e) => begin(handle, node, e)
    }
    for (const [prop, node] of existing) if (!drag || drag.prop !== prop) node.remove()
  }

  return {
    /** The single selected element (null for none, a group or a nested document). */
    target(el: Element | null, count = 1) {
      if (drag && el !== target) finish(false)
      target = el instanceof HTMLElement && el.ownerDocument === document ? el : null
      instances = count
      position()
    },
    position,
    dragging: () => !!drag,
    cancel: () => finish(false)
  }
}
