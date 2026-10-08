/**
 * Rulers, guides and layout grids over the preview (LKM-205). The native host draws
 * and edits them (`src/native/PreviewOverlay*.swift`); this module is the shape main
 * stores per project and per viewport, reports to the agent, and sends to the page for
 * the hover distance labels. All positions are page CSS pixels.
 */

export type OverlayGuide = { id: string; axis: 'x' | 'y'; position: number }
export type OverlayGrid = {
  kind: 'columns' | 'rows' | 'square'
  visible: boolean
  count: number
  /** A fixed column width, or null to stretch the columns. */
  width: number | null
  gutter: number
  margin: number
  align: 'left' | 'center' | 'stretch'
  step: number
  offset: number
  size: number
  color: string
  opacity: number
}
export type PreviewOverlayState = {
  rulers: boolean
  gridVisible: boolean
  locked: boolean
  /** Guides and grids stay put in the viewport instead of following page scroll. */
  fixed: boolean
  guides: OverlayGuide[]
  grids: OverlayGrid[]
}

/** The lines the page measures hovered elements to (host → main → isolated preview). */
export type OverlayLines = {
  /** The page reports scroll, viewport size and selection extent while this is on. */
  report: boolean
  fixed: boolean
  x: number[]
  y: number[]
  periods: { axis: 'x' | 'y'; step: number; offset: number }[]
}

/** One preference for every project: `{[project]: {at, rulers, viewports: {desktop, mobile}}}`. */
export const PREVIEW_OVERLAY_PREFERENCE = 'trezi:preview-overlay:v1'
export const MAX_OVERLAY_PROJECTS = 50
const MAX_GUIDES = 200
const MAX_GRIDS = 8
const MAX_LINES = 400

export const EMPTY_OVERLAY: PreviewOverlayState = {
  rulers: false,
  gridVisible: false,
  locked: false,
  fixed: false,
  guides: [],
  grids: []
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Settings from preferences or the host, clamped like `OverlayState(json:)` in Swift. */
export function normalizeOverlay(value: unknown): PreviewOverlayState {
  const raw = record(value)
  const guides = (Array.isArray(raw.guides) ? raw.guides : [])
    .slice(0, MAX_GUIDES)
    .flatMap((item, index): OverlayGuide[] => {
      const g = record(item)
      const position = num(g.position)
      if ((g.axis !== 'x' && g.axis !== 'y') || position === undefined) return []
      const id = typeof g.id === 'string' && g.id && g.id.length <= 40 ? g.id : `g${index}`
      return [{ id, axis: g.axis, position: clamp(position, -100_000, 100_000) }]
    })
  const grids = (Array.isArray(raw.grids) ? raw.grids : [])
    .slice(0, MAX_GRIDS)
    .flatMap((item): OverlayGrid[] => {
      const g = record(item)
      if (g.kind !== 'columns' && g.kind !== 'rows' && g.kind !== 'square') return []
      const width = num(g.width)
      return [
        {
          kind: g.kind,
          visible: g.visible !== false,
          count: Math.trunc(clamp(num(g.count) ?? 12, 1, 48)),
          width: width === undefined ? null : clamp(width, 1, 4000),
          gutter: clamp(num(g.gutter) ?? 24, 0, 1000),
          margin: clamp(num(g.margin) ?? 0, 0, 2000),
          align: g.align === 'left' || g.align === 'center' ? g.align : 'stretch',
          step: clamp(num(g.step) ?? 8, 2, 1000),
          offset: clamp(num(g.offset) ?? 0, -1000, 1000),
          size: clamp(num(g.size) ?? 8, 2, 1000),
          color:
            typeof g.color === 'string' && /^#[0-9a-f]{6}$/i.test(g.color)
              ? g.color.toLowerCase()
              : '#ff3b30',
          opacity: clamp(num(g.opacity) ?? 0.12, 0.02, 1)
        }
      ]
    })
  return {
    rulers: raw.rulers === true,
    gridVisible: raw.gridVisible === true,
    locked: raw.locked === true,
    fixed: raw.fixed === true,
    guides,
    grids
  }
}

/** Lines for the page, from the host; anything malformed is dropped. */
export function normalizeLines(value: unknown): OverlayLines {
  const raw = record(value)
  const list = (v: unknown): number[] =>
    (Array.isArray(v) ? v : []).filter((n): n is number => num(n) !== undefined).slice(0, MAX_LINES)
  const periods = (Array.isArray(raw.periods) ? raw.periods : [])
    .slice(0, 2 * MAX_GRIDS)
    .flatMap((item): OverlayLines['periods'] => {
      const p = record(item)
      const step = num(p.step)
      const offset = num(p.offset) ?? 0
      return (p.axis === 'x' || p.axis === 'y') && step !== undefined && step >= 2
        ? [{ axis: p.axis, step, offset }]
        : []
    })
  return {
    report: raw.report === true,
    fixed: raw.fixed === true,
    x: list(raw.x),
    y: list(raw.y),
    periods
  }
}

type ProjectEntry = { at: number; rulers: boolean; viewports: Record<string, unknown> }
const viewportKey = (viewport: string): string => (viewport === 'mobile' ? 'mobile' : 'desktop')

/** The settings a project shows at a viewport: rulers per project, the rest per viewport. */
export function overlayFor(store: unknown, project: string, viewport: string): PreviewOverlayState {
  const entry = record(record(store)[project])
  const state = normalizeOverlay(record(entry.viewports)[viewportKey(viewport)])
  return { ...state, rulers: entry.rulers === true }
}

/** The store with a project's settings at a viewport replaced; the least recently
 *  changed projects beyond the cap are dropped. */
export function storeOverlay(
  store: unknown,
  project: string,
  viewport: string,
  state: PreviewOverlayState,
  now = Date.now()
): Record<string, ProjectEntry> {
  const next: Record<string, ProjectEntry> = {}
  for (const [key, value] of Object.entries(record(store))) {
    const entry = record(value)
    next[key] = {
      at: num(entry.at) ?? 0,
      rulers: entry.rulers === true,
      viewports: record(entry.viewports)
    }
  }
  const { rulers, ...rest } = normalizeOverlay(state)
  const previous = next[project]?.viewports ?? {}
  next[project] = { at: now, rulers, viewports: { ...previous, [viewportKey(viewport)]: rest } }
  const kept = Object.entries(next)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_OVERLAY_PROJECTS)
  return Object.fromEntries(kept)
}
