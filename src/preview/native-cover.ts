/**
 * Native cover (LKM-173): the viewport rects that native views (the editing island
 * and its resize edge) float over, as the host reports them on layout. AppKit hands
 * those views their clicks, but WebKit's own tracking areas still deliver every
 * pointer move in the web view's frame. A transparent shield over each rect takes
 * them instead, so neither the select-mode hover box nor the page's own `:hover` and
 * pointer listeners see a pointer that is really over a native view. No per-move
 * work: the browser's own hit test lands on the shield.
 */
export type CoverRect = { x: number; y: number; width: number; height: number }

const POINTER_TYPES = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'wheel'
]

function rects(value: unknown): CoverRect[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (r): r is CoverRect =>
      !!r &&
      typeof r === 'object' &&
      [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      r.width > 0 &&
      r.height > 0
  )
}

export function createNativeCover() {
  let host: HTMLDivElement | null = null
  let shadow: ShadowRoot | null = null
  let current: CoverRect[] = []

  const draw = (): void => {
    if (!current.length) {
      host?.remove()
      return
    }
    if (!host || !shadow) {
      host = document.createElement('div')
      host.setAttribute('data-trezi-cover', '')
      // Above the page and the hover overlay; only the shields take the pointer.
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
      shadow = host.attachShadow({ mode: 'open' })
    }
    shadow.replaceChildren(
      ...current.map((r) => {
        const shield = document.createElement('div')
        shield.style.cssText =
          `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;` +
          'pointer-events:auto;cursor:default;background:transparent;'
        return shield
      })
    )
    // A page that rewrites <html> drops the host; the next report puts it back.
    if (!host.isConnected) document.documentElement?.appendChild(host)
  }

  return {
    set(value: unknown): void {
      current = rects(value)
      if (document.documentElement) draw()
      else document.addEventListener('DOMContentLoaded', draw, { once: true })
    },
    /** The shield host, as a window listener sees a pointer event over a shield. */
    contains(target: EventTarget | null): boolean {
      return !!host && target === host
    },
    /** Window capture listeners that keep the page's own handlers from seeing the
     *  pointer over a shield. Install after the preload's own listeners: those
     *  treat the shield as overlay and drop the hover box. */
    install(): void {
      for (const type of POINTER_TYPES)
        window.addEventListener(
          type,
          (e) => {
            if (!host || e.target !== host) return
            e.stopImmediatePropagation()
            if (e.type !== 'wheel' && e.cancelable) e.preventDefault()
          },
          { capture: true, passive: false }
        )
    }
  }
}
