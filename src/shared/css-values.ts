/**
 * css-values.ts — pure CSS value math for the Styles panel (v1).
 *
 * Parse/format numeric CSS text ('12px' ⇄ {n, unit}), the per-property
 * metadata table for the v1 style set (unit/min/max/step/group + flags),
 * time normalization ('0.3s' → 300ms), and cubic-bezier parse/format/snap
 * for the transition-timing-function editor.
 *
 * DOM-free by design (no window/document): it runs in the island renderer
 * AND under plain bun in `test/css-values.mjs`.
 */

import type { StyleProp } from './style-props'

export interface CssNumber {
  n: number
  unit: string // '' for unitless (opacity, font-weight)
}

export type StyleGroup = 'layout' | 'appearance' | 'typography' | 'transition'

/** Which control the panel renders for the property. */
export type StyleControl = 'number' | 'color' | 'select' | 'bezier' | 'text' | 'readonly'

export interface StylePropMeta {
  group: StyleGroup
  control: StyleControl
  /** Canonical unit scrub values are expressed in ('' = unitless). */
  unit?: string
  min?: number
  max?: number
  step?: number
  /** For control 'select' — REAL CSS values for the property (these feed the
   * commit paths verbatim), never display names. */
  options?: string[]
  /** Display labels for select options whose CSS value is unwieldy. */
  optionLabels?: Record<string, string>
  /** Only shown when the element computes to display flex/grid (gap). */
  flexGridOnly?: boolean
}

/** Panel rendering order for the four groups. */
export const STYLE_GROUPS: StyleGroup[] = ['layout', 'appearance', 'typography', 'transition']

const pxMeta = (
  group: StyleGroup,
  min: number,
  max: number,
  step = 1,
  extra: Partial<StylePropMeta> = {}
): StylePropMeta => ({ group, control: 'number', unit: 'px', min, max, step, ...extra })

const SIDES = ['top', 'right', 'bottom', 'left'] as const

/** `sideMeta('padding', 0, 400)` → the 4 `padding-{top,right,bottom,left}`
 *  entries, keyed with real literal types (not widened to `string`) so the
 *  `satisfies` check below can see them. */
function sideMeta<P extends 'padding' | 'margin'>(
  prefix: P,
  min: number,
  max: number
): { [S in (typeof SIDES)[number] as `${P}-${S}`]: StylePropMeta } {
  const out = {} as { [S in (typeof SIDES)[number] as `${P}-${S}`]: StylePropMeta }
  for (const s of SIDES)
    (out as Record<string, StylePropMeta>)[`${prefix}-${s}`] = pxMeta('layout', min, max)
  return out
}

/**
 * The ENTIRE v1 property set (longhands), keyed by css property name.
 * Out of scope for v1 (width/height, per-corner radius, borders,
 * position/inset, variants) is deliberately absent — the styles engine
 * allowlist mirrors this table.
 *
 * Checked with `satisfies Record<StyleProp | 'font-family' | 'display', …>` —
 * `StyleProp` is the shared/style-props.ts canonical WRITABLE set main's
 * `styles.ts` also derives from; `font-family`/`display` are the two extra
 * READ-ONLY chips this panel shows that aren't part of that writable set.
 * `satisfies` (rather than a plain type annotation) requires every one of
 * those keys to be present WITHOUT narrowing the exported type away from
 * `Record<string, StylePropMeta>` — callers below still look up arbitrary
 * prop strings and expect `undefined` for anything out of scope. Dropping (or
 * misspelling) a `StyleProp` key here is now a compile error, not a silent gap.
 */
export const STYLE_PROP_META: Record<string, StylePropMeta> = {
  // --- layout ---
  ...sideMeta('padding', 0, 400),
  ...sideMeta('margin', -400, 400),
  gap: pxMeta('layout', 0, 400, 1, { flexGridOnly: true }),

  // --- appearance ---
  color: { group: 'appearance', control: 'color' },
  'background-color': { group: 'appearance', control: 'color' },
  'box-shadow': { group: 'appearance', control: 'text' },
  'border-radius': pxMeta('appearance', 0, 200),
  opacity: { group: 'appearance', control: 'number', unit: '', min: 0, max: 1, step: 0.01 },

  // --- typography ---
  'font-size': pxMeta('typography', 4, 200),
  'font-weight': {
    group: 'typography',
    control: 'number',
    unit: '',
    min: 100,
    max: 900,
    step: 100
  },
  'line-height': pxMeta('typography', 0, 400),
  'letter-spacing': pxMeta('typography', -10, 20, 0.1),
  'font-family': { group: 'typography', control: 'readonly' },
  display: { group: 'typography', control: 'readonly' },

  // --- transition ---
  'transition-property': {
    group: 'transition',
    control: 'select',
    // CSS values, not Tailwind family names: 'colors'/'shadow' would commit
    // `transition-property: shadow` — parseable but inert (no such property).
    // tailwindClassFor maps these to transition-colors / transition-shadow.
    options: [
      'all',
      'color, background-color, border-color, text-decoration-color, fill, stroke',
      'opacity',
      'transform',
      'box-shadow'
    ],
    optionLabels: {
      'color, background-color, border-color, text-decoration-color, fill, stroke': 'colors',
      'box-shadow': 'shadow'
    }
  },
  'transition-duration': {
    group: 'transition',
    control: 'number',
    unit: 'ms',
    min: 0,
    max: 5000,
    step: 10
  },
  'transition-delay': {
    group: 'transition',
    control: 'number',
    unit: 'ms',
    min: 0,
    max: 5000,
    step: 10
  },
  'transition-timing-function': { group: 'transition', control: 'bezier' }
} satisfies Record<StyleProp | 'font-family' | 'display', StylePropMeta>

/** Metadata for a v1 property, or null when the prop isn't in the set. */
export function stylePropMeta(prop: string): StylePropMeta | null {
  return STYLE_PROP_META[prop] ?? null
}

// ---------------------------------------------------------------------------
// numeric css text ⇄ {n, unit}
// ---------------------------------------------------------------------------

const NUM_RE = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i

/** '12px' → {n:12, unit:'px'}; '0.5' → {n:0.5, unit:''}; non-numeric → null. */
export function parseCssNumber(text: string): CssNumber | null {
  const m = NUM_RE.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return { n, unit: m[2].toLowerCase() }
}

/** Round away float noise (0.30000000000000004 → 0.3) without losing steps like 0.01. */
function fmtNum(n: number): string {
  return String(Number(n.toFixed(4)))
}

/** {n:13, unit:'px'} → '13px'; unitless → '13'. */
export function formatCssNumber(v: CssNumber): string {
  return `${fmtNum(v.n)}${v.unit}`
}

// ---------------------------------------------------------------------------
// time normalization — durations/delays are always handled in ms
// ---------------------------------------------------------------------------

/** '0.3s' → 300, '250ms' → 250, '0' → 0; anything else → null. */
export function normalizeMs(text: string): number | null {
  const v = parseCssNumber(text)
  if (!v) return null
  if (v.unit === 'ms') return v.n
  if (v.unit === 's') return v.n * 1000
  if (v.unit === '' && v.n === 0) return 0 // css allows bare 0 for times
  return null
}

/** 300 → '300ms'. */
export function formatMs(ms: number): string {
  return `${fmtNum(ms)}ms`
}

/**
 * Does this computed-style snapshot describe a transition that can actually
 * animate? CSS initial values look deceptively configured (`all`, `0s`,
 * `ease`), so the Styles panel must not use property presence as the signal.
 */
export function hasActiveTransition(values: Record<string, string>): boolean {
  const properties = (values['transition-property'] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (properties.length === 0 || properties.every((property) => property === 'none')) return false

  return (values['transition-duration'] ?? '').split(',').some((duration) => {
    const ms = normalizeMs(duration.trim())
    return ms !== null && ms > 0
  })
}

// ---------------------------------------------------------------------------
// cubic-bezier — parse/format, keyword presets, snap, clamp
// ---------------------------------------------------------------------------

export interface Bezier {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** CSS spec coordinates for the timing-function keywords. */
export const BEZIER_PRESETS: Record<string, Bezier> = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  ease: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  'ease-in': { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  'ease-out': { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  'ease-in-out': { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }
}

const BEZIER_RE =
  /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/i

/**
 * 'cubic-bezier(.17,.67,.83,.67)' or a keyword (ease/ease-in/…/linear) →
 * {x1,y1,x2,y2}. Rejects spec-invalid input (x coords outside [0,1]) → null.
 */
export function parseBezier(text: string): Bezier | null {
  const t = text.trim().toLowerCase()
  const preset = BEZIER_PRESETS[t]
  if (preset) return { ...preset }
  const m = BEZIER_RE.exec(t)
  if (!m) return null
  const [x1, y1, x2, y2] = [m[1], m[2], m[3], m[4]].map(Number)
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null // css requires x ∈ [0,1]
  return { x1, y1, x2, y2 }
}

/** {x1,y1,x2,y2} → 'cubic-bezier(0.17, 0.67, 0.83, 0.67)'. */
export function formatBezier(b: Bezier): string {
  return `cubic-bezier(${fmtNum(b.x1)}, ${fmtNum(b.y1)}, ${fmtNum(b.x2)}, ${fmtNum(b.y2)})`
}

/** Tolerance per coordinate for keyword snapping (plan: 0.01/coord). */
export const BEZIER_SNAP_TOLERANCE = 0.01
const SNAP_EPS = 1e-9 // absorb float noise so "exactly 0.01 off" still snaps

/**
 * Nearest keyword preset when EVERY coordinate is within 0.01, else null.
 * Commits use this to write `ease-out` instead of its raw coords.
 */
export function snapBezierPreset(b: Bezier): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const [name, p] of Object.entries(BEZIER_PRESETS)) {
    const ds = [b.x1 - p.x1, b.y1 - p.y1, b.x2 - p.x2, b.y2 - p.y2].map(Math.abs)
    if (ds.some((d) => d > BEZIER_SNAP_TOLERANCE + SNAP_EPS)) continue
    const total = ds.reduce((a, d) => a + d, 0)
    if (total < bestDist) {
      bestDist = total
      best = name
    }
  }
  return best
}

/**
 * Tailwind's ease-* classes carry slightly DIFFERENT curves than the CSS
 * keywords S1 maps them from (the `ease-out` class is cubic-bezier(0,0,0.2,1);
 * CSS `ease-out` is (0,0,0.58,1)). Mirrors the EASE_KEYWORDS table in
 * main/tw-styles.ts (`linear`/`ease` need no entry — they land as the keyword
 * itself). Consumed two ways: `sameCssValue`'s reconcile comparison treats a
 * committed keyword and its Tailwind curve as the same value, and
 * `displayBezierPreset` names the Tailwind curve for readout/chip display —
 * without it, a keyword commit on a Tailwind element would visually "drift" to
 * raw coords when reconcile merges the computed Tailwind curve back in.
 */
export const TW_EASE_EQUIV: Record<string, Bezier> = {
  'ease-in': { x1: 0.4, y1: 0, x2: 1, y2: 1 },
  'ease-out': { x1: 0, y1: 0, x2: 0.2, y2: 1 },
  'ease-in-out': { x1: 0.4, y1: 0, x2: 0.2, y2: 1 }
}

/**
 * DISPLAY-ONLY preset name: the CSS keyword snap first, else a Tailwind
 * ease-* curve read back from a committed keyword. Commits must keep using
 * snapBezierPreset — writing a keyword for the Tailwind coords would be
 * wrong everywhere but Tailwind.
 */
export function displayBezierPreset(b: Bezier): string | null {
  const snap = snapBezierPreset(b)
  if (snap) return snap
  for (const [name, p] of Object.entries(TW_EASE_EQUIV)) {
    const ds = [b.x1 - p.x1, b.y1 - p.y1, b.x2 - p.x2, b.y2 - p.y2].map(Math.abs)
    if (ds.every((d) => d <= BEZIER_SNAP_TOLERANCE)) return name
  }
  return null
}

/** Coord-wise bezier equality with room for computed-style float noise. */
export function sameBezier(a: Bezier, b: Bezier): boolean {
  return (
    Math.abs(a.x1 - b.x1) < 0.005 &&
    Math.abs(a.y1 - b.y1) < 0.005 &&
    Math.abs(a.x2 - b.x2) < 0.005 &&
    Math.abs(a.y2 - b.y2) < 0.005
  )
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Bezier handle x — spec-constrained to [0,1]. */
export function clampBezierX(x: number): number {
  return clamp(x, 0, 1)
}

/** Bezier handle y — editor range [-1,2] (overshoot allowed, bounded canvas). */
export function clampBezierY(y: number): number {
  return clamp(y, -1, 2)
}

/** Clamp all four handles into the editor's legal ranges. */
export function clampBezier(b: Bezier): Bezier {
  return {
    x1: clampBezierX(b.x1),
    y1: clampBezierY(b.y1),
    x2: clampBezierX(b.x2),
    y2: clampBezierY(b.y2)
  }
}

// ---------------------------------------------------------------------------
// panel row helpers — computed css text ⇄ what a control shows/commits
// ---------------------------------------------------------------------------

/**
 * The row's numeric value in its canonical unit, from the computed css text.
 * `normal` gets a scrubbable interpretation where one exists (letter-spacing/
 * gap → 0, line-height → font-size × 1.2); anything else non-numeric → null
 * (the row renders as a readout instead of a scrubber).
 */
export function numericValue(prop: string, values: Record<string, string>): number | null {
  const raw = values[prop]
  if (raw === undefined) return null
  const meta = STYLE_PROP_META[prop]
  if (meta?.unit === 'ms') return normalizeMs(raw)
  const p = parseCssNumber(raw)
  if (p) return p.n
  if (raw === 'normal') {
    if (prop === 'letter-spacing' || prop === 'gap') return 0
    if (prop === 'line-height') {
      const fs = parseCssNumber(values['font-size'] ?? '')
      return fs ? Math.round(fs.n * 1.2) : null
    }
  }
  return null
}

/** Scrub value → the css text we preview/commit ('13px', '300ms', '0.5'). */
export function toCssText(prop: string, n: number): string {
  const meta = STYLE_PROP_META[prop]
  if (meta?.unit === 'ms') return formatMs(n)
  return formatCssNumber({ n, unit: meta?.unit ?? '' })
}

/** '#rrggbb[aa]' / rgb()/rgba() / transparent → channels; anything else null. */
export function parseColorLike(
  text: string
): { r: number; g: number; b: number; a: number } | null {
  const t = text.trim().toLowerCase()
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(t)) {
    let hex = t.slice(1)
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('')
    const int = (at: number): number => parseInt(hex.slice(at, at + 2), 16)
    return { r: int(0), g: int(2), b: int(4), a: hex.length === 8 ? int(6) / 255 : 1 }
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(t)
  if (!m) return null
  const parts = m[1]
    .replace('/', ' ')
    .trim()
    .split(/[\s,]+/)
  if (parts.length !== 3 && parts.length !== 4) return null
  const nums = parts.map(Number)
  if (!nums.every(Number.isFinite)) return null
  return { r: nums[0], g: nums[1], b: nums[2], a: parts.length === 4 ? nums[3] : 1 }
}

/**
 * Does a fresh computed value (`a`) equal what we committed (`b`)? Textual
 * equality is not enough: we commit '#ff0000' and read back 'rgb(255, 0, 0)',
 * commit '300ms' and read back '0.3s', commit 'ease-out' and read back its
 * (Tailwind) curve. Normalize per control kind before comparing.
 *
 * Used by StylePanel's post-commit reconcile, by CustomPanel's style-strategy
 * params, and as the comparator injected into the token matcher
 * (`shared/token-match.ts` → `resolveTokenForValue`), which is why a token
 * whose file value is '#6c6c6c' still matches a computed 'rgb(108, 108, 108)'.
 */
export function sameCssValue(prop: string, a: string, b: string): boolean {
  if (a === b) return true
  const meta = STYLE_PROP_META[prop]
  if (meta?.control === 'color') {
    const ca = parseColorLike(a)
    const cb = parseColorLike(b)
    if (!ca || !cb) return false
    return ca.r === cb.r && ca.g === cb.g && ca.b === cb.b && Math.abs(ca.a - cb.a) < 0.02
  }
  if (meta?.control === 'bezier') {
    const ba = parseBezier(a)
    if (ba) {
      const bb = parseBezier(b)
      if (bb && sameBezier(ba, bb)) return true
      const tw = TW_EASE_EQUIV[b.trim().toLowerCase()]
      if (tw && sameBezier(ba, tw)) return true
    }
    return a.trim().toLowerCase() === b.trim().toLowerCase()
  }
  if (meta?.unit === 'ms') {
    const ma = normalizeMs(a)
    return ma !== null && ma === normalizeMs(b)
  }
  const na = parseCssNumber(a)
  const nb = parseCssNumber(b)
  if (na && nb) return na.n === nb.n && na.unit === nb.unit
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
