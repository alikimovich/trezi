import type { ThreeDAction, ThreeDState } from './api'

/** Bounds of the layer set the preview sends to the host. `src/native/ThreeDChrome.swift`
 * checks the same values; capture itself stops at 160 surfaces and depth 18. */
export const THREE_D_LIMITS = {
  layers: 160,
  depth: 18,
  pages: 6,
  label: 120,
  title: 160,
  extent: 100000
} as const

/** Scene revisions protect node-index and atlas actions. Close remains usable during HMR.
 * `paint` shows one atlas page on black (even) or white (odd) for the host's snapshot; -1 hides. */
export function threeDActionAllowed(
  raw: unknown,
  session: string,
  revision: number,
  layers: number,
  pages = 0
): raw is ThreeDAction {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as { session?: unknown; revision?: unknown; action?: unknown; value?: unknown }
  if (
    value.session !== session ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0
  )
    return false
  switch (value.action) {
    case 'close':
      return true
    case 'code':
      return value.revision === revision
    case 'layer':
      return (
        value.revision === revision &&
        Number.isInteger(value.value) &&
        (value.value as number) >= 0 &&
        (value.value as number) < layers
      )
    case 'paint':
      return (
        value.revision === revision &&
        Number.isInteger(value.value) &&
        (value.value as number) >= -1 &&
        (value.value as number) < pages * 2
      )
    default:
      return false
  }
}

const finite = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/** The host-side shape check, mirrored here so the preview cannot drift from it. */
export function threeDStateAllowed(raw: unknown): raw is ThreeDState {
  if (!raw || typeof raw !== 'object') return false
  const s = raw as Partial<ThreeDState>
  const { layers, extent, pages, depth, label, title } = THREE_D_LIMITS
  if (
    typeof s.session !== 'string' ||
    !s.session ||
    s.session.length > 80 ||
    !Number.isInteger(s.revision) ||
    (s.revision as number) < 0 ||
    typeof s.title !== 'string' ||
    s.title.length > title ||
    !Array.isArray(s.layers) ||
    s.layers.length > layers ||
    !finite(s.width, 0, extent) ||
    !finite(s.height, 0, extent) ||
    !finite(s.scale, 0.01, 1) ||
    !Number.isInteger(s.pages) ||
    (s.pages as number) < 0 ||
    (s.pages as number) > pages ||
    typeof s.hasSource !== 'boolean' ||
    typeof s.limited !== 'boolean' ||
    typeof s.simplified !== 'boolean' ||
    typeof s.invalid !== 'boolean'
  )
    return false
  if (
    s.selected !== null &&
    !(
      Number.isInteger(s.selected) &&
      (s.selected as number) >= 0 &&
      (s.selected as number) < s.layers.length
    )
  )
    return false
  return s.layers.every(
    (l, i) =>
      l &&
      l.id === i &&
      typeof l.label === 'string' &&
      l.label.length <= label &&
      Number.isInteger(l.depth) &&
      l.depth >= 0 &&
      l.depth <= depth &&
      finite(l.x, -extent, extent) &&
      finite(l.y, -extent, extent) &&
      finite(l.width, 0, extent) &&
      finite(l.height, 0, extent) &&
      Number.isInteger(l.page) &&
      l.page >= 0 &&
      l.page < (s.pages as number) &&
      finite(l.ax, 0, extent) &&
      finite(l.ay, 0, extent)
  )
}

export interface AtlasSlot {
  page: number
  x: number
  y: number
}

/** Shelf-packs surfaces (CSS px) into viewport-sized pages at one shared scale, so the
 * host needs few snapshots. Surfaces that do not fit `maxPages` are left out (`fitted`). */
export function packAtlas(
  sizes: { width: number; height: number }[],
  viewport: { width: number; height: number },
  maxPages: number = THREE_D_LIMITS.pages
): { scale: number; pages: number; slots: AtlasSlot[]; fitted: number } {
  const pad = 2
  const gap = 4
  const w = Math.max(1, viewport.width - 2 * pad)
  const h = Math.max(1, viewport.height - 2 * pad)
  const area = sizes.reduce((sum, s) => sum + s.width * s.height, 0)
  const largest = sizes.reduce((m, s) => Math.max(m, s.width / w, s.height / h), 0)
  // Largest surface fits one page; the total area fits about half the page budget.
  let scale = Math.min(
    1,
    largest > 0 ? 1 / largest : 1,
    Math.sqrt((maxPages * w * h * 0.5) / Math.max(1, area))
  )
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b].height - sizes[a].height)
  const pack = (factor: number) => {
    const slots: AtlasSlot[] = []
    let page = 0
    let x = pad
    let y = pad
    let shelf = 0
    let fitted = 0
    let used = 0
    for (const i of order) {
      const sw = Math.min(w, Math.ceil(sizes[i].width * factor))
      const sh = Math.min(h, Math.ceil(sizes[i].height * factor))
      if (x + sw > pad + w) {
        x = pad
        y += shelf + gap
        shelf = 0
      }
      if (y + sh > pad + h) {
        page++
        x = pad
        y = pad
        shelf = 0
      }
      if (page >= maxPages) break
      slots[i] = { page, x, y }
      fitted++
      used = page + 1
      x += sw + gap
      shelf = Math.max(shelf, sh)
    }
    return { slots, fitted, pages: used }
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const packed = pack(scale)
    if (packed.fitted === sizes.length || attempt === 7) return { scale, ...packed }
    scale = Math.max(0.01, scale * 0.8)
  }
  return { scale, slots: [], fitted: 0, pages: 0 }
}
