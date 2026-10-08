/**
 * Distances from a hovered element to the nearest guide or grid line (LKM-205), the
 * pure half of the labels the select-mode hover draws while guides or a layout grid
 * are shown. Each edge measures outwards to the nearest line on its side: the left
 * edge to the nearest line at or left of it, the right edge to the right, and so on.
 *
 * Lines arrive in the overlay's space (page CSS px, or viewport CSS px when fixed);
 * the result is viewport-relative like `getBoundingClientRect`, which is what the
 * fixed-position overlay draws in. No DOM here: `test/guide-distance.mjs`.
 */
import type { OverlayLines } from '../shared/preview-overlay'
import type { MeasureRect, MeasureSegment } from './measure'

/** The nearest periodic line `offset + k·step` at or below (`dir` -1) or above (+1) `value`. */
function periodicNear(value: number, step: number, offset: number, dir: -1 | 1): number {
  const k = (value - offset) / step
  return offset + (dir < 0 ? Math.floor(k + 1e-9) : Math.ceil(k - 1e-9)) * step
}

/** The nearest line on one side of `value`, or undefined when there is none. */
function nearest(
  value: number,
  lines: number[],
  periods: { step: number; offset: number }[],
  dir: -1 | 1
): number | undefined {
  let best: number | undefined
  const consider = (line: number): void => {
    if ((line - value) * dir < -1e-6) return
    if (best === undefined || Math.abs(line - value) < Math.abs(best - value)) best = line
  }
  for (const line of lines) consider(line)
  for (const p of periods) consider(periodicNear(value, p.step, p.offset, dir))
  return best
}

export function guideDistances(
  rect: MeasureRect,
  lines: OverlayLines,
  scroll: { x: number; y: number },
  viewport: { width: number; height: number }
): MeasureSegment[] {
  const segments: MeasureSegment[] = []
  for (const axis of ['x', 'y'] as const) {
    const shift = lines.fixed ? 0 : axis === 'x' ? scroll.x : scroll.y
    const own = lines[axis].map((line) => line - shift)
    const periods = lines.periods
      .filter((p) => p.axis === axis)
      .map((p) => ({ step: p.step, offset: p.offset - shift }))
    if (!own.length && !periods.length) continue
    const [low, high] = axis === 'x' ? [rect.left, rect.right] : [rect.top, rect.bottom]
    const extent = axis === 'x' ? viewport.width : viewport.height
    const cross = axis === 'x' ? (rect.top + rect.bottom) / 2 : (rect.left + rect.right) / 2
    for (const [edge, dir] of [
      [low, -1],
      [high, 1]
    ] as const) {
      const line = nearest(edge, own, periods, dir)
      // Off-screen lines would draw labels nobody can relate to a line.
      if (line === undefined || line < 0 || line > extent) continue
      const distance = Math.abs(edge - line)
      const [a, b] = dir < 0 ? [line, edge] : [edge, line]
      segments.push(
        axis === 'x'
          ? { axis, distance, x1: a, x2: b, y1: cross, y2: cross }
          : { axis, distance, x1: cross, x2: cross, y1: a, y2: b }
      )
    }
  }
  return segments
}
