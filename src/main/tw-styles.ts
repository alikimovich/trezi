/**
 * CSS property → Tailwind utility mapping for the Styles panel's commit path
 * (strategy S1 in styles.ts): when the selected element already uses utility
 * classes, a scrubbed style commits as a class rewrite instead of an inline
 * style. Pure string logic — no electron/fs — bun-unit-testable.
 *
 * Unlike the token-swap path (tw-classes.ts), arbitrary-value classes of the
 * same family (`p-[13px]`) ARE replace candidates — they round-trip our own
 * edits. Variant-prefixed classes (`hover:p-4`, `md:text-lg`) are never
 * candidates and never blockers.
 */

import { CSS_NAMED_COLORS } from '../shared/token-match'
import { colorClassFamily, SAFE_CLASS_SUFFIX } from './tw-classes'

// --- value parsing -----------------------------------------------------------

function parseLength(value: string): { n: number; unit: string } | null {
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(value.trim())
  return m ? { n: parseFloat(m[1]), unit: m[2] } : null
}

function parseMs(value: string): number | null {
  const v = parseLength(value)
  if (!v) return null
  if (v.unit === 'ms' || v.unit === '') return v.n
  if (v.unit === 's') return v.n * 1000
  return null
}

/** Format `value` as an arbitrary-value class. Tailwind arbitrary values must
 * contain no spaces: drop them around commas, underscore any that remain. */
function arbitrary(prefix: string, value: string): string | null {
  const v = value
    .trim()
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, '_')
  if (!v || /[\]'"`;{}]/.test(v)) return null
  return `${prefix}-[${v}]`
}

// --- named scales (Tailwind v4 defaults) --------------------------------------

const SPACING_PREFIX: Record<string, string> = {
  padding: 'p',
  'padding-top': 'pt',
  'padding-right': 'pr',
  'padding-bottom': 'pb',
  'padding-left': 'pl',
  margin: 'm',
  'margin-top': 'mt',
  'margin-right': 'mr',
  'margin-bottom': 'mb',
  'margin-left': 'ml',
  gap: 'gap',
  'column-gap': 'gap-x',
  'row-gap': 'gap-y'
}
const RADIUS_PX = new Map([
  [0, 'none'],
  [2, 'xs'],
  [4, 'sm'],
  [6, 'md'],
  [8, 'lg'],
  [12, 'xl'],
  [16, '2xl'],
  [24, '3xl'],
  [9999, 'full']
])
const FONT_SIZE_PX = new Map([
  [12, 'xs'],
  [14, 'sm'],
  [16, 'base'],
  [18, 'lg'],
  [20, 'xl'],
  [24, '2xl'],
  [30, '3xl'],
  [36, '4xl'],
  [48, '5xl'],
  [60, '6xl'],
  [72, '7xl'],
  [96, '8xl'],
  [128, '9xl']
])
const FONT_WEIGHTS = new Map([
  [100, 'thin'],
  [200, 'extralight'],
  [300, 'light'],
  [400, 'normal'],
  [500, 'medium'],
  [600, 'semibold'],
  [700, 'bold'],
  [800, 'extrabold'],
  [900, 'black']
])
const LINE_HEIGHT_KEYWORDS = new Map([
  [1, 'none'],
  [1.25, 'tight'],
  [1.375, 'snug'],
  [1.5, 'normal'],
  [1.625, 'relaxed'],
  [2, 'loose']
])
const TRACKING_EM = new Map([
  [-0.05, 'tighter'],
  [-0.025, 'tight'],
  [0, 'normal'],
  [0.025, 'wide'],
  [0.05, 'wider'],
  [0.1, 'widest']
])
const TIME_SNAP_MS = new Set([75, 100, 150, 200, 300, 500, 700, 1000])
const EASE_KEYWORDS = new Map([
  ['linear', 'ease-linear'],
  ['ease-in', 'ease-in'],
  ['cubic-bezier(0.4,0,1,1)', 'ease-in'],
  ['ease-out', 'ease-out'],
  ['cubic-bezier(0,0,0.2,1)', 'ease-out'],
  ['ease-in-out', 'ease-in-out'],
  ['cubic-bezier(0.4,0,0.2,1)', 'ease-in-out']
])

/**
 * The Tailwind class for a css longhand + value: named-scale snap when the
 * value hits the scale exactly, else an arbitrary-value class (`p-[13px]`).
 * Null for props outside the v1 set or unusable values.
 */
export function tailwindClassFor(prop: string, value: string): string | null {
  const spacing = SPACING_PREFIX[prop]
  const v = parseLength(value)
  if (spacing) {
    if (v && v.n === 0) return `${spacing}-0`
    if (v && v.unit === 'px' && v.n > 0 && v.n % 4 === 0) return `${spacing}-${v.n / 4}`
    return arbitrary(spacing, value)
  }
  switch (prop) {
    case 'box-shadow':
      return value.trim() === 'none' ? 'shadow-none' : arbitrary('shadow', value)
    case 'border-radius': {
      const name = v && (v.unit === 'px' || v.n === 0) ? RADIUS_PX.get(v.n) : undefined
      return name ? `rounded-${name}` : arbitrary('rounded', value)
    }
    case 'color':
      return arbitrary('text', value)
    case 'background-color':
      return arbitrary('bg', value)
    case 'opacity': {
      if (!v || (v.unit !== '' && v.unit !== '%')) return arbitrary('opacity', value)
      const pct = Math.round((v.unit === '%' ? v.n : v.n * 100) * 1e6) / 1e6
      if (Number.isInteger(pct) && pct % 5 === 0 && pct >= 0 && pct <= 100) return `opacity-${pct}`
      return arbitrary('opacity', value)
    }
    case 'font-size': {
      const name = v && v.unit === 'px' ? FONT_SIZE_PX.get(v.n) : undefined
      return name ? `text-${name}` : arbitrary('text', value)
    }
    case 'font-weight': {
      const n =
        value.trim() === 'normal'
          ? 400
          : value.trim() === 'bold'
            ? 700
            : v?.unit === ''
              ? v.n
              : null
      const name = n != null ? FONT_WEIGHTS.get(n) : undefined
      return name ? `font-${name}` : arbitrary('font', value)
    }
    case 'line-height': {
      if (v && v.unit === '') {
        const name = LINE_HEIGHT_KEYWORDS.get(v.n)
        if (name) return `leading-${name}`
      }
      if (v && v.unit === 'px' && v.n >= 0 && v.n % 4 === 0) return `leading-${v.n / 4}`
      return arbitrary('leading', value)
    }
    case 'letter-spacing': {
      const name = v && (v.unit === 'em' || v.n === 0) ? TRACKING_EM.get(v.n) : undefined
      return name ? `tracking-${name}` : arbitrary('tracking', value)
    }
    case 'transition-duration':
    case 'transition-delay': {
      const prefix = prop === 'transition-delay' ? 'delay' : 'duration'
      const ms = parseMs(value)
      if (ms == null || !Number.isFinite(ms)) return arbitrary(prefix, value)
      return TIME_SNAP_MS.has(ms) ? `${prefix}-${ms}` : arbitrary(prefix, `${ms}ms`)
    }
    case 'transition-timing-function': {
      const norm = value.trim().toLowerCase().replace(/\s+/g, '')
      return EASE_KEYWORDS.get(norm) ?? arbitrary('ease', value)
    }
    case 'transition-property': {
      const norm = value.trim().toLowerCase()
      const direct: Record<string, string> = {
        none: 'transition-none',
        all: 'transition-all',
        opacity: 'transition-opacity',
        transform: 'transition-transform',
        'box-shadow': 'transition-shadow'
      }
      if (direct[norm]) return direct[norm]
      const items = norm
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (
        items.length &&
        items.every((i) => /(^|-)color$/.test(i) || i === 'fill' || i === 'stroke')
      ) {
        return 'transition-colors'
      }
      return arbitrary('transition', value)
    }
  }
  return null
}

// --- class-family matching -----------------------------------------------------

/** Variant-prefixed (`hover:`, `md:`, `dark:hover:`…)? A `:` inside an arbitrary
 * value (`bg-[url(http://…)]`) is not a variant. */
function isVariant(cls: string): boolean {
  const colon = cls.indexOf(':')
  if (colon === -1) return false
  const bracket = cls.indexOf('[')
  return bracket === -1 || colon < bracket
}

/** The inner text of `prefix-[…]`, or null when `cls` isn't that shape. */
function arbitraryInner(cls: string, prefix: string): string | null {
  if (!cls.startsWith(`${prefix}-[`) || !cls.endsWith(']')) return null
  return cls.slice(prefix.length + 2, -1)
}

const COLOR_VALUE_RE = /^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|var\(--)/
// CSS named colors (+ transparent/currentcolor): Tailwind accepts them as bare
// arbitrary values (`text-[red]`) and infers the color type, so they must be
// color-family — NOT font-size — or a font-size scrub deletes the color class.
const NAMED_COLORS = CSS_NAMED_COLORS

/** Is the inner text of an arbitrary-value class a color? Covers value grammars
 * (#hex, rgb()…, var(--…)), Tailwind's `color:` data-type hint
 * (`text-[color:red]`) and bare CSS color keywords (`text-[transparent]`). */
function isColorInner(inner: string): boolean {
  return (
    COLOR_VALUE_RE.test(inner) ||
    inner.startsWith('color:') ||
    NAMED_COLORS.has(inner.toLowerCase())
  )
}
const SCALE_SUFFIX_RE = /^(?:\d+(?:\.\d+)?|px|auto|full)$/
const RADIUS_CLASS_RE = /^rounded(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|full))?$/
const FONT_SIZE_CLASS_RE = /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/
const FONT_WEIGHT_CLASS_RE =
  /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/
const TRANSITION_CLASS_RE = /^transition(?:-(?:all|colors|opacity|transform|shadow|none))?$/

/** Anything after `prefix-` (named scale or arbitrary) counts as the family —
 * used for prefixes no other Tailwind utility shares (leading, duration, …). */
function anySuffix(cls: string, prefix: string): boolean {
  return cls.startsWith(`${prefix}-`) && cls.length > prefix.length + 1
}

/** Is `cls` a rewrite candidate for `prop`'s Tailwind family? Font-family
 * classes (`font-sans`, `font-mono`, `font-[family…]`) never match font-weight. */
function isFamilyMatch(prop: string, cls: string): boolean {
  const spacing = SPACING_PREFIX[prop]
  if (spacing) {
    const base = cls.startsWith('-') ? cls.slice(1) : cls // negative margins
    if (!base.startsWith(`${spacing}-`)) return false
    const suffix = base.slice(spacing.length + 1)
    return SCALE_SUFFIX_RE.test(suffix) || /^\[.+\]$/.test(suffix)
  }
  switch (prop) {
    case 'box-shadow': {
      const inner = arbitraryInner(cls, 'shadow')
      return (
        /^shadow(?:-(?:none|2xs|xs|sm|md|lg|xl|2xl|inner))?$/.test(cls) ||
        (inner != null && !isColorInner(inner))
      )
    }
    case 'border-radius':
      return RADIUS_CLASS_RE.test(cls) || arbitraryInner(cls, 'rounded') != null
    case 'color': {
      const inner = arbitraryInner(cls, 'text')
      return colorClassFamily(cls) === 'text' || (inner != null && isColorInner(inner))
    }
    case 'background-color': {
      const inner = arbitraryInner(cls, 'bg')
      return colorClassFamily(cls) === 'bg' || (inner != null && isColorInner(inner))
    }
    case 'opacity':
      return /^opacity-(?:\d+|\[.+\])$/.test(cls)
    case 'font-size': {
      // Non-color arbitrary text-[…] is font-size; `length:`/`font-size:`
      // data-type hints land here too (they're not color inners).
      const inner = arbitraryInner(cls, 'text')
      return FONT_SIZE_CLASS_RE.test(cls) || (inner != null && !isColorInner(inner))
    }
    case 'font-weight': {
      const inner = arbitraryInner(cls, 'font')
      return FONT_WEIGHT_CLASS_RE.test(cls) || (inner != null && /^\d/.test(inner))
    }
    case 'line-height':
      return anySuffix(cls, 'leading')
    case 'letter-spacing':
      return anySuffix(cls, 'tracking')
    case 'transition-duration':
      return anySuffix(cls, 'duration')
    case 'transition-delay':
      return anySuffix(cls, 'delay')
    case 'transition-timing-function':
      return anySuffix(cls, 'ease')
    case 'transition-property':
      return TRANSITION_CLASS_RE.test(cls) || arbitraryInner(cls, 'transition') != null
  }
  return false
}

/**
 * Put `next` into `classList` as the prop's family class: replace the single
 * un-variant-prefixed class of that family; append when none exists; null when
 * ambiguous (>1 family match — we can't know which one wins at runtime).
 */
function spliceClass(classList: string, prop: string, next: string): string | null {
  const classes = classList.split(/\s+/).filter(Boolean)
  const matches = classes.filter((c) => !isVariant(c) && isFamilyMatch(prop, c))
  if (matches.length > 1) return null
  if (matches.length === 0) return [...classes, next].join(' ')
  return classes.map((c) => (c === matches[0] ? next : c)).join(' ')
}

/**
 * Rewrite `classList` so `prop` renders as `value`: replace the single
 * un-variant-prefixed class of the prop's family; append when none exists;
 * null when ambiguous (>1 family match) or the prop/value can't map.
 */
export function rewriteClassList(classList: string, prop: string, value: string): string | null {
  const next = tailwindClassFor(prop, value)
  return next ? spliceClass(classList, prop, next) : null
}

// --- design tokens ---------------------------------------------------------

/** Utility prefix per property for a NAMED token suffix (no value math). The
 * spacing families come from SPACING_PREFIX; these are the rest. */
const TOKEN_CLASS_PREFIX: Record<string, string> = {
  'border-radius': 'rounded',
  color: 'text',
  'background-color': 'bg',
  'font-size': 'text',
  'font-weight': 'font',
  'line-height': 'leading',
  'letter-spacing': 'tracking',
  opacity: 'opacity'
}

/**
 * The Tailwind class that applies the design token `tokenName` to `prop` —
 * `('color', 'brand-500')` → `text-brand-500`. Unlike `tailwindClassFor` there
 * is no value math: the token name IS the scale key, which is only true when
 * the tokens were read from the project's own `tailwind.config.*` (callers gate
 * on `TokenSet.source === 'tailwind'`). Null for props with no token family or
 * a name that isn't a safe class suffix.
 */
export function tailwindTokenClassFor(prop: string, tokenName: string): string | null {
  if (!SAFE_CLASS_SUFFIX.test(tokenName)) return null
  const prefix = SPACING_PREFIX[prop] ?? TOKEN_CLASS_PREFIX[prop]
  return prefix ? `${prefix}-${tokenName}` : null
}

/** `rewriteClassList`'s token twin: splice in the token's class instead of a
 *  value-derived one. Same replace/append/ambiguity contract. */
export function rewriteClassListToken(
  classList: string,
  prop: string,
  tokenName: string
): string | null {
  const next = tailwindTokenClassFor(prop, tokenName)
  return next ? spliceClass(classList, prop, next) : null
}

// --- heuristic -----------------------------------------------------------------

const STANDALONE_UTILITIES = new Set([
  'flex',
  'grid',
  'block',
  'inline',
  'inline-block',
  'inline-flex',
  'hidden',
  'relative',
  'absolute',
  'fixed',
  'sticky',
  'static',
  'container',
  'transition',
  'rounded',
  'border',
  'shadow',
  'ring',
  'italic',
  'underline',
  'truncate',
  'uppercase',
  'lowercase',
  'capitalize',
  'grow',
  'shrink',
  'sr-only',
  'antialiased'
])
const NUMERIC_FAMILY_RE =
  /^-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|w|h|z|top|right|bottom|left|inset|inset-x|inset-y|size|space-x|space-y|translate-x|translate-y|scale|rotate|duration|delay|opacity|leading|order|basis|col-span|row-span)-(?:\d+(?:\.\d+)?|px|auto|full|screen|none|\[.+\])$/
const UTILITY_PREFIX_RE =
  /^(?:text|bg|border|ring|font|rounded|shadow|ease|tracking|items|justify|self|content|object|overflow|cursor|select|whitespace|align|list|grid-cols|grid-rows|flex|divide|from|via|to|outline|transition|max-w|min-w|max-h|min-h)-[a-z0-9[]/

/** Does the element's live class list look like Tailwind utilities? Gates the
 * class-rewrite strategy — false sends the edit down the inline-style path. */
export function looksTailwind(classes: string[]): boolean {
  for (const raw of classes) {
    let cls = raw
    while (isVariant(cls)) cls = cls.slice(cls.indexOf(':') + 1)
    if (
      STANDALONE_UTILITIES.has(cls) ||
      NUMERIC_FAMILY_RE.test(cls) ||
      UTILITY_PREFIX_RE.test(cls)
    ) {
      return true
    }
  }
  return false
}
