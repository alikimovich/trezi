/**
 * Layered elevation → CSS `box-shadow` engine.
 *
 * Real elevation (Material's "cast shadow", Tobias Ahlin's & Josh Comeau's
 * layered-shadow technique) is never one flat `box-shadow` — it's several
 * stacked layers whose offset/blur grow on a curve while alpha decays, all
 * sharing ONE light-source angle so the set reads as a single coherent light.
 * An LLM asked for "a shadow" tends to emit a single
 * `0 4px 6px rgba(0,0,0,.1)`; this module derives the correlated n-layer stack
 * from one `elevation` number instead, deterministically (no randomness).
 *
 * Pure, dependency-free, no Electron import — unit-testable under bun
 * (test/shadows.mjs) and usable from any process, matching src/main/spring.ts.
 *
 * THE CURVE (documented, not tunable via the public API):
 * - For layer i of n (0-indexed), t = (i+1)/n ∈ (0, 1] and f = t². Squaring
 *   pushes early layers tight together (soft contact shadow) and spreads the
 *   later layers out (the long, faint ambient falloff) — the standard
 *   "quadratic growth" shape used by both Ahlin's and Comeau's recipes.
 * - distance_i = elevation * f_i. This one distance is shared by BOTH the
 *   offset magnitude and the blur (blur = distance * BLUR_FACTOR, with
 *   BLUR_FACTOR > 1 so blur is always ≳ offset — a shadow whose blur is
 *   smaller than its offset looks like a hard-edged decal, not a soft cast
 *   shadow).
 * - spread is kept at 0 for every layer (soft, non-clipping falloff); the
 *   field is still emitted on `ShadowLayer` for API completeness/future use,
 *   but omitted from the rendered `css` string when it's zero — matching
 *   the common 3-value `x y blur rgba(...)` form.
 * - alpha_i = baseAlpha * ALPHA_DECAY^i, clamped into (0, 1]. Layer 0 (the
 *   tightest, closest layer) is the most opaque; each farther layer is
 *   fainter, never reaching exactly 0.
 *
 * LIGHT ANGLE (shared across every layer, and across a whole elevationScale
 * set, so the stack always reads as one consistent light source):
 * `lightAngleDeg` is the direction the light is coming FROM, expressed as the
 * angle of the light's position using the unit vector
 * `(sin θ, cos θ)` in screen space (+x right, +y DOWN):
 *   θ =   0°  → light position (0,  1)  → light from BELOW
 *   θ =  90°  → light position (1,  0)  → light from the RIGHT
 *   θ = 180°  → light position (0, -1)  → light from ABOVE (the default)
 *   θ = 270°  → light position (-1, 0)  → light from the LEFT
 * A shadow is cast in the direction opposite the light, so the shadow's unit
 * vector is the negation: `(-sin θ, -cos θ)`. At the default θ=180 that's
 * `(0, 1)` — straight down — matching "light from top → shadow cast
 * downward" in the brief. `xPx = distance * -sin θ`, `yPx = distance * -cos θ`.
 */

export interface LayeredShadowInput {
  /** Logical lift; 0 = flush (no shadow), larger = more lifted. Treat ~0..24. */
  elevation: number
  /** Number of stacked layers, default 5 (clamped to 2..8). */
  layers?: number
  /** Direction light comes FROM, default 180 (top) → shadow cast downward (positive y). */
  lightAngleDeg?: number
  colorRgb?: [number, number, number]
  /** Alpha of the topmost (closest) layer, default 0.12; decays across farther layers. */
  baseAlpha?: number
  precision?: number
}

export interface ShadowLayer {
  xPx: number
  yPx: number
  blurPx: number
  spreadPx: number
  alpha: number
}

export interface LayeredShadowResult {
  /** "0px 1px 2px rgba(0,0,0,0.12), 0px 2px 4px rgba(0,0,0,0.09), ..." */
  css: string
  /** In render order (closest/tightest first). */
  layers: ShadowLayer[]
  cssVar?: string
}

const DEFAULTS = {
  layers: 5,
  lightAngleDeg: 180,
  colorRgb: [0, 0, 0] as [number, number, number],
  baseAlpha: 0.12,
  precision: 3
}

// Merged field-by-field with `??` rather than object-spread: elevationScale
// forwards its own optional fields verbatim, which are `undefined` (not
// simply absent) when the caller didn't set them — a spread merge would let
// that explicit `undefined` clobber the default.
function withDefaults(input: LayeredShadowInput): Required<LayeredShadowInput> {
  return {
    elevation: input.elevation,
    layers: input.layers ?? DEFAULTS.layers,
    lightAngleDeg: input.lightAngleDeg ?? DEFAULTS.lightAngleDeg,
    colorRgb: input.colorRgb ?? DEFAULTS.colorRgb,
    baseAlpha: input.baseAlpha ?? DEFAULTS.baseAlpha,
    precision: input.precision ?? DEFAULTS.precision
  }
}

/** Blur is always this many times the offset distance — keeps shadows soft, never decal-hard. */
const BLUR_FACTOR = 2
/** Per-layer alpha multiplier — layer i's alpha is baseAlpha * ALPHA_DECAY^i. */
const ALPHA_DECAY = 0.7

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function rgba(colorRgb: [number, number, number], alpha: number): string {
  const [r, g, b] = colorRgb
  return `rgba(${r},${g},${b},${alpha})`
}

/** Build the correlated n-layer stack for one elevation value. */
export function layeredShadow(input: LayeredShadowInput): LayeredShadowResult {
  const opts = withDefaults(input)
  const { elevation, lightAngleDeg, colorRgb, baseAlpha, precision } = opts

  if (!(elevation > 0)) return { css: 'none', layers: [] }

  const n = clamp(Math.round(opts.layers), 2, 8)
  const rad = (lightAngleDeg * Math.PI) / 180
  const xUnit = -Math.sin(rad)
  const yUnit = -Math.cos(rad)
  const round = (v: number): number => Number(v.toFixed(precision))

  const layers: ShadowLayer[] = []
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n
    const f = t * t
    const distance = elevation * f
    const blurPx = distance * BLUR_FACTOR
    const alpha = clamp(baseAlpha * ALPHA_DECAY ** i, Number.EPSILON, 1)

    layers.push({
      xPx: round(distance * xUnit),
      yPx: round(distance * yUnit),
      blurPx: round(blurPx),
      spreadPx: 0,
      alpha: round(alpha)
    })
  }

  const css = layers
    .map((l) => `${l.xPx}px ${l.yPx}px ${l.blurPx}px ${rgba(colorRgb, l.alpha)}`)
    .join(', ')

  return { css, layers }
}

export interface ElevationScaleInput {
  /** Number of elevation tokens, default 5 (e.g. sm..2xl). */
  levels?: number
  layers?: number
  lightAngleDeg?: number
  colorRgb?: [number, number, number]
  baseAlpha?: number
  precision?: number
  /** Optional token names; default numeric ("1", "2", ...). */
  labels?: string[]
}

/** Geometric elevation ramp shared by every level in the set: start * ratio^i. */
const RAMP_START = 2
const RAMP_RATIO = 1.8

/**
 * Produce `levels` elevation tokens, each built by `layeredShadow`, all
 * sharing the same light angle (and every other shared option) so the whole
 * scale reads as one coherent light source at increasing heights. Elevation
 * grows geometrically (RAMP_START * RAMP_RATIO^i) — the same "small steps
 * near the ground, bigger jumps higher up" shape as Material's elevation
 * scale.
 */
export function elevationScale(
  input: ElevationScaleInput = {}
): Array<{ level: number; label: string; css: string }> {
  const { levels = 5, layers, lightAngleDeg, colorRgb, baseAlpha, precision, labels } = input
  const n = clamp(Math.round(levels), 1, 100)

  const result: Array<{ level: number; label: string; css: string }> = []
  for (let i = 0; i < n; i++) {
    const elevation = RAMP_START * RAMP_RATIO ** i
    const { css } = layeredShadow({
      elevation,
      layers,
      lightAngleDeg,
      colorRgb,
      baseAlpha,
      precision
    })
    result.push({ level: i + 1, label: labels?.[i] ?? String(i + 1), css })
  }
  return result
}

export interface ShadowLightInput {
  x: number
  y: number
  distance: number
  blur: number
  layers: number
  decay: number
  color: string
}

/** Screen-space light position: shadows fall opposite the light. Independent
 * blur permits a centered ambient shadow even when distance is zero. */
export function shadowLight(input: ShadowLightInput): LayeredShadowResult {
  for (const [key, min, max] of [
    ['x', -1, 1],
    ['y', -1, 1],
    ['distance', 0, 64],
    ['blur', 0, 80],
    ['layers', 1, 8],
    ['decay', 0, 1]
  ] as const) {
    const n = input[key]
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid shadow ${key}.`)
  }
  if (!Number.isInteger(input.layers)) throw new Error('Shadow layers must be an integer.')
  const color =
    typeof input.color === 'string' &&
    /^rgba\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d*\.?\d+)\s*\)$/.exec(
      input.color
    )
  if (!color) throw new Error('Shadow color must be rgba(r, g, b, a).')
  const [r, g, b, a] = color.slice(1).map(Number)
  if ([r, g, b].some((n) => n > 255) || a > 1) throw new Error('Invalid shadow color channels.')
  const round = (n: number) => Number(n.toFixed(3))
  const layers = Array.from({ length: input.layers }, (_, i): ShadowLayer => {
    const f = ((i + 1) / input.layers) ** 2
    return {
      xPx: round(-input.x * input.distance * f),
      yPx: round(-input.y * input.distance * f),
      blurPx: round(input.blur * f),
      spreadPx: 0,
      alpha: round(a * input.decay ** i)
    }
  })
  return {
    layers,
    css: layers
      .map((l) => `${l.xPx}px ${l.yPx}px ${l.blurPx}px ${rgba([r, g, b], l.alpha)}`)
      .join(', ')
  }
}
