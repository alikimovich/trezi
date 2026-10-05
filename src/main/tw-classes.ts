/**
 * Tailwind color-utility class detection, shared by the React (props.ts) and
 * Svelte (props-svelte.ts) token-apply paths (T2 class swap). Its own module so
 * both adapters import it without an import cycle.
 */

// The color utility families. Every one of these prefixes is ALSO shared with
// non-color utilities (`text-center`, `border-2`, `shadow-lg`, `bg-cover`, …),
// so a prefix match alone is not enough — the suffix must be a color VALUE
// (see colorClassFamily → isColorValueSuffix).
export const COLOR_CLASS_FAMILIES = [
  'bg',
  'text',
  'border',
  'ring',
  'fill',
  'stroke',
  'decoration',
  'outline',
  'accent',
  'caret',
  'divide',
  'from',
  'via',
  'to',
  'placeholder',
  'shadow'
]

// Tailwind's default palette hues. A `<hue>` or `<hue>-<shade>` suffix is a color.
const COLOR_HUES = new Set([
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose'
])
// Bare color keywords valid across the color utilities.
const COLOR_KEYWORDS = new Set(['inherit', 'current', 'transparent', 'black', 'white'])
// Suffixes that share a color-family prefix but are NOT colors — Tailwind
// layout/size/style utilities. Semantic design tokens (`primary`, `card`,
// `muted-foreground`) are intentionally absent so they still swap. Anything
// containing a digit (widths, `10%` gradient stops) is rejected separately.
const NON_COLOR_SUFFIXES = new Set([
  // text alignment / wrap / overflow
  'left',
  'center',
  'right',
  'justify',
  'start',
  'end',
  'wrap',
  'nowrap',
  'balance',
  'pretty',
  'ellipsis',
  'clip',
  // font sizes (text-) + elevation sizes (shadow-)
  'xs',
  'sm',
  'base',
  'md',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
  '7xl',
  '8xl',
  '9xl',
  'inner',
  // line styles (border/ring/outline/divide/decoration)
  'solid',
  'dashed',
  'dotted',
  'double',
  'wavy',
  'hidden',
  'none',
  // sides / axes / corners (border-x, divide-y, …)
  'x',
  'y',
  't',
  'r',
  'b',
  'l',
  's',
  'e',
  'tl',
  'tr',
  'bl',
  'br',
  // misc modifiers
  'reverse',
  'collapse',
  'separate',
  'offset',
  'inset',
  'auto',
  'from-font',
  // bg-* non-color utilities
  'fixed',
  'local',
  'scroll',
  'cover',
  'contain',
  'repeat',
  'no-repeat',
  'top',
  'bottom',
  'origin',
  'blend'
])

/** Is a color-family class SUFFIX an actual color value (vs a layout/size/style
 * utility sharing the prefix)? Recognizes the palette, bare keywords, and — so
 * design-system swaps keep working — semantic token names. */
function isColorValueSuffix(suffix: string): boolean {
  const base = suffix.replace(/\/\d{1,3}$/, '') // strip a trailing `/opacity`
  if (!base) return false
  if (COLOR_KEYWORDS.has(base)) return true
  const palette = base.match(/^([a-z]+)(?:-(\d{1,3}))?$/)
  if (palette && COLOR_HUES.has(palette[1])) return true
  if (/\d/.test(base)) return false // widths, positions, any numeric utility
  if (NON_COLOR_SUFFIXES.has(base)) return false
  if (NON_COLOR_SUFFIXES.has(base.split('-')[0])) return false // e.g. `x-reverse`
  // A remaining bare/hyphenated word is a semantic color token
  // (`primary`, `secondary`, `muted-foreground`, `card`, `destructive`, …).
  return true
}

/** If `cls` is a color utility, return its family prefix (e.g. 'text' for
 * `text-gray-500`); null otherwise. Skips variants (`hover:…`) and arbitrary
 * values (`[…]`) — too ambiguous to rewrite safely. */
export function colorClassFamily(cls: string): string | null {
  if (cls.includes(':') || cls.includes('[')) return null
  for (const f of COLOR_CLASS_FAMILIES) {
    if (cls.startsWith(`${f}-`)) {
      return isColorValueSuffix(cls.slice(f.length + 1)) ? f : null
    }
  }
  return null
}

/** A token name is safe to splice as a class suffix (no spaces/quotes that could
 * inject extra classes; the full class string is JSON.stringify'd regardless). */
export const SAFE_CLASS_SUFFIX = /^[\w/.-]+$/

// Radius: `rounded`, `rounded-{side}`, optionally `-{size}`. Swap the size suffix.
const RADIUS_RE = /^(rounded(?:-(?:t|r|b|l|tl|tr|bl|br|s|e))?)(?:-[a-z0-9]+)?$/
// Spacing/sizing: padding/margin/gap/space/inset/size families, optional -{size}.
const SPACING_RE =
  /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|w|h|min-w|max-w|min-h|max-h|size|inset|inset-x|inset-y|top|right|bottom|left|start|end)(?:-[a-z0-9.]+)?$/

/**
 * The class "family prefix" to keep (whose size suffix the token replaces) for a
 * given token group, or null if `cls` isn't a swappable utility of that group.
 * Variants (`hover:…`) and arbitrary values (`[…]`) are skipped as too ambiguous.
 */
function classFamilyForGroup(cls: string, group: string): string | null {
  if (cls.includes(':') || cls.includes('[')) return null
  if (/colou?r/i.test(group)) return colorClassFamily(cls)
  if (/radi|round/i.test(group)) return RADIUS_RE.exec(cls)?.[1] ?? null
  if (/spac|gap|pad|margin|size|width|height|inset/i.test(group)) {
    return SPACING_RE.exec(cls)?.[1] ?? null
  }
  return null
}

/**
 * Swap the single utility of the token's family in `classList` to `tokenName`,
 * returning the new class string — or null when it's ambiguous (zero or >1
 * matches) or the token name isn't a safe suffix. Shared by both framework
 * adapters (T2). Supports color / radius / spacing-sizing families.
 */
export function swapTailwindClass(
  classList: string,
  group: string,
  tokenName: string
): string | null {
  if (!SAFE_CLASS_SUFFIX.test(tokenName)) return null
  const classes = classList.split(/\s+/).filter(Boolean)
  const matches = classes
    .map((c) => ({ c, fam: classFamilyForGroup(c, group) }))
    .filter((x) => x.fam != null)
  if (matches.length !== 1) return null
  const { c, fam } = matches[0]
  return classes.map((x) => (x === c ? `${fam}-${tokenName}` : x)).join(' ')
}
