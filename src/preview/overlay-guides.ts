/**
 * The page's half of the native rulers, guides and layout grids (LKM-205). The host
 * draws them above the web view; it cannot see the page's scroll or the selection, so
 * while its lines ask for it this reports scroll, viewport size and the selection's
 * extent, once per animation frame and only when they changed. With guides or a grid
 * shown, the select-mode hover also labels the distances from the hovered element's
 * edges to the nearest line (`guide-distance.ts`), in the measurement style.
 * Nothing here touches the project's DOM: labels go in the existing overlay's shadow.
 */
import { normalizeLines, type OverlayLines } from '../shared/preview-overlay'
import { guideDistances } from './guide-distance'
import { formatDistance, type MeasureSegment } from './measure'

export type OverlayGeometry = {
  scrollX: number
  scrollY: number
  width: number
  height: number
  selection: { left: number; top: number; right: number; bottom: number } | null
}

type Draw = {
  line: (segment: MeasureSegment) => HTMLElement
  label: (text: string, x: number, y: number) => HTMLElement
}

export function createOverlayGuides(options: {
  send: (geometry: OverlayGeometry) => void
  selection: () => Element | null
  layer: () => HTMLElement | null
  draw: Draw
}) {
  let lines: OverlayLines = normalizeLines(null)
  let frame = 0
  let last = ''
  let hovered: Element | null = null
  let drawnKey = ''

  const geometry = (): OverlayGeometry => {
    const root = document.documentElement
    const el = options.selection()
    const r = el?.isConnected ? el.getBoundingClientRect() : null
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: root?.clientWidth || window.innerWidth,
      height: root?.clientHeight || window.innerHeight,
      selection: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
    }
  }
  const flush = (): void => {
    frame = 0
    if (!lines.report) return
    const value = geometry()
    const key = JSON.stringify(value)
    if (key !== last) {
      last = key
      options.send(value)
    }
    if (hovered) hover(hovered)
  }
  /** Scroll, resize or the selection moved: report on the next frame. */
  const report = (): void => {
    if (lines.report && !frame) frame = requestAnimationFrame(flush)
  }
  const clear = (): void => {
    if (!drawnKey) return
    drawnKey = ''
    const layer = options.layer()
    if (layer) layer.textContent = ''
  }
  /** Labels the hovered element's distances to the nearest lines; null clears them. */
  const hover = (el: Element | null): void => {
    hovered = el
    const shown = lines.x.length || lines.y.length || lines.periods.length
    if (!el?.isConnected || !shown) {
      clear()
      return
    }
    const r = el.getBoundingClientRect()
    const segments = guideDistances(
      r,
      lines,
      { x: window.scrollX, y: window.scrollY },
      { width: window.innerWidth, height: window.innerHeight }
    )
    const key = segments.map((s) => [s.x1, s.y1, s.x2, s.y2].map(Math.round).join(',')).join(';')
    if (key === drawnKey) return
    const layer = options.layer()
    if (!layer) return
    drawnKey = key || ' '
    layer.replaceChildren(
      ...segments.flatMap((s) => [
        options.draw.line(s),
        options.draw.label(formatDistance(s.distance), (s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2)
      ])
    )
  }
  addEventListener('scroll', report, { capture: true, passive: true })
  addEventListener('resize', report, { passive: true })

  return {
    report,
    hover,
    set(value: unknown): void {
      lines = normalizeLines(value)
      last = ''
      drawnKey = ''
      options.layer()?.replaceChildren()
      report()
      if (hovered) hover(hovered)
    }
  }
}
