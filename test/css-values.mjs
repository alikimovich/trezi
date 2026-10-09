/**
 * css-values — pure unit test for the Styles panel's value math: numeric
 * parse/format round-trips, the v1 per-property metadata table, s/ms
 * normalization, cubic-bezier keyword ⇄ coords, preset snap tolerance, and
 * handle clamping. The module lives under renderer but is DOM-free by
 * contract, so it must run under plain bun (this file is the proof).
 *
 * Run with: bun test/css-values.mjs
 */

// Cross-module regression (finding: options were Tailwind family names, not
// CSS): the select options must be committable through the S1 class path.
import { tailwindClassFor } from '../src/main/tw-styles.ts'
import {
  BEZIER_PRESETS,
  clamp,
  clampBezier,
  clampBezierX,
  clampBezierY,
  formatBezier,
  formatCssNumber,
  formatMs,
  hasActiveTransition,
  normalizeMs,
  parseBezier,
  parseCssNumber,
  STYLE_GROUPS,
  STYLE_PROP_META,
  snapBezierPreset,
  stylePropMeta
} from '../src/shared/css-values.ts'

let failed = 0
let count = 0
const assert = (cond, msg) => {
  count++
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// --- parse: '12px' ⇄ {n, unit} round-trips ---
assert(eq(parseCssNumber('12px'), { n: 12, unit: 'px' }), 'parse 12px')
assert(eq(parseCssNumber('-4px'), { n: -4, unit: 'px' }), 'parse negative')
assert(eq(parseCssNumber('0.5'), { n: 0.5, unit: '' }), 'parse unitless')
assert(eq(parseCssNumber('.5'), { n: 0.5, unit: '' }), 'parse leading-dot')
assert(eq(parseCssNumber('1.5rem'), { n: 1.5, unit: 'rem' }), 'parse rem')
assert(eq(parseCssNumber('150ms'), { n: 150, unit: 'ms' }), 'parse ms')
assert(eq(parseCssNumber('100%'), { n: 100, unit: '%' }), 'parse percent')
assert(eq(parseCssNumber(' 13px '), { n: 13, unit: 'px' }), 'parse trims whitespace')
assert(eq(parseCssNumber('13PX'), { n: 13, unit: 'px' }), 'unit lowercased')
for (const bad of ['auto', '', 'px', '12 px', '1..2px', 'calc(1px + 2px)']) {
  assert(parseCssNumber(bad) === null, `reject non-numeric: ${JSON.stringify(bad)}`)
}
for (const s of ['12px', '-4px', '0.5', '1.5rem', '150ms', '0']) {
  assert(formatCssNumber(parseCssNumber(s)) === s, `round-trip ${s}`)
}
assert(formatCssNumber({ n: 0.1 + 0.2, unit: '' }) === '0.3', 'format rounds float noise')
assert(formatCssNumber({ n: 13, unit: 'px' }) === '13px', 'format 13px')

// --- metadata table: every v1 property present, correctly grouped/flagged ---
const V1 = {
  layout: [
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'gap'
  ],
  appearance: ['color', 'background-color', 'box-shadow', 'border-radius', 'opacity'],
  typography: [
    'font-size',
    'font-weight',
    'line-height',
    'letter-spacing',
    'font-family',
    'display'
  ],
  transition: [
    'transition-property',
    'transition-duration',
    'transition-delay',
    'transition-timing-function'
  ]
}
for (const [group, props] of Object.entries(V1)) {
  for (const prop of props) {
    const meta = stylePropMeta(prop)
    assert(meta != null, `metadata exists: ${prop}`)
    assert(meta?.group === group, `${prop} grouped as ${group}`)
  }
}
const v1Count = Object.values(V1).flat().length
assert(
  Object.keys(STYLE_PROP_META).length === v1Count,
  `table has exactly the ${v1Count} v1 props (no strays)`
)
assert(eq(STYLE_GROUPS, ['layout', 'appearance', 'typography', 'transition']), 'group order')

// flags the plan calls out
const m = stylePropMeta.bind(null)
assert(m('gap')?.flexGridOnly === true, 'gap is flex/grid-only')
assert(m('padding-top')?.flexGridOnly === undefined, 'padding not flex/grid-gated')
assert(m('padding-left')?.min === 0, 'padding min 0')
assert(m('margin-left')?.min < 0, 'margin allows negatives')
const op = m('opacity')
assert(op?.min === 0 && op?.max === 1 && op?.step === 0.01, 'opacity 0-1 step .01')
assert(op?.unit === '', 'opacity unitless')
const fw = m('font-weight')
assert(fw?.min === 100 && fw?.max === 900 && fw?.step === 100, 'font-weight 100-900 step 100')
assert(m('border-radius')?.min === 0, 'border-radius px >= 0')
assert(m('letter-spacing')?.step === 0.1, 'letter-spacing step .1')
assert(m('letter-spacing')?.min < 0, 'letter-spacing allows negatives')
for (const p of ['transition-duration', 'transition-delay']) {
  assert(m(p)?.unit === 'ms' && m(p)?.step === 10, `${p} in ms, step 10`)
}
// transition-property options are REAL CSS values (they feed the commit paths
// verbatim): 'colors'/'shadow' are Tailwind family names, and committing
// `transition-property: shadow` is inert — no such CSS property exists.
const TP_COLORS = 'color, background-color, border-color, text-decoration-color, fill, stroke'
assert(
  eq(m('transition-property')?.options, ['all', TP_COLORS, 'opacity', 'transform', 'box-shadow']),
  'transition-property select options are css values'
)
assert(
  eq(m('transition-property')?.optionLabels, { [TP_COLORS]: 'colors', 'box-shadow': 'shadow' }),
  'unwieldy option values carry display labels'
)
// Every option must map to a NAMED Tailwind transition class — an arbitrary
// `transition-[…]` here would mean the option isn't a value Tailwind knows.
{
  const expected = {
    all: 'transition-all',
    [TP_COLORS]: 'transition-colors',
    opacity: 'transition-opacity',
    transform: 'transition-transform',
    'box-shadow': 'transition-shadow'
  }
  for (const opt of m('transition-property')?.options ?? []) {
    assert(
      tailwindClassFor('transition-property', opt) === expected[opt],
      `option ${JSON.stringify(opt)} commits as ${expected[opt]}`
    )
  }
}
assert(m('transition-timing-function')?.control === 'bezier', 'timing-function is bezier')
assert(m('color')?.control === 'color', 'color uses ColorControl')
assert(m('background-color')?.control === 'color', 'background-color uses ColorControl')
assert(m('font-family')?.control === 'readonly', 'font-family read-only chip')
assert(m('display')?.control === 'readonly', 'display read-only chip')
assert(stylePropMeta('width') === null, 'width out of scope v1')
assert(stylePropMeta('box-shadow')?.control === 'text', 'box-shadow uses a CSS text control')

// --- s/ms normalization ---
assert(normalizeMs('0.3s') === 300, '0.3s -> 300')
assert(normalizeMs('250ms') === 250, '250ms -> 250')
assert(
  !hasActiveTransition({
    'transition-property': 'all',
    'transition-duration': '0s',
    'transition-timing-function': 'ease'
  }),
  'browser transition defaults are not an active transition'
)
assert(
  hasActiveTransition({
    'transition-property': 'opacity',
    'transition-duration': '0s, 180ms'
  }),
  'a positive duration activates transition controls'
)
assert(
  !hasActiveTransition({
    'transition-property': 'none',
    'transition-duration': '180ms'
  }),
  'transition-property none stays inactive even with duration'
)
assert(normalizeMs('.15s') === 150, '.15s -> 150')
assert(normalizeMs('2s') === 2000, '2s -> 2000')
assert(normalizeMs('0') === 0, 'bare 0 allowed for times')
assert(normalizeMs('250') === null, 'bare nonzero number rejected')
assert(normalizeMs('fast') === null, 'keyword rejected')
assert(formatMs(300) === '300ms', 'formatMs')
assert(normalizeMs(formatMs(150)) === 150, 'ms round-trip')

// --- bezier: keyword <-> coords, both directions ---
assert(
  eq(parseBezier('cubic-bezier(.17,.67,.83,.67)'), { x1: 0.17, y1: 0.67, x2: 0.83, y2: 0.67 }),
  'parse cubic-bezier()'
)
assert(
  eq(parseBezier('cubic-bezier(0.17, 0.67, 0.83, 0.67)'), {
    x1: 0.17,
    y1: 0.67,
    x2: 0.83,
    y2: 0.67
  }),
  'parse with spaces'
)
for (const [name, coords] of Object.entries(BEZIER_PRESETS)) {
  assert(eq(parseBezier(name), coords), `keyword -> coords: ${name}`)
  assert(snapBezierPreset(coords) === name, `coords -> keyword: ${name}`)
  assert(eq(parseBezier(formatBezier(coords)), coords), `format/parse round-trip: ${name}`)
}
assert(eq(parseBezier('EASE'), BEZIER_PRESETS.ease), 'keyword case-insensitive')
assert(
  formatBezier({ x1: 0.17, y1: 0.67, x2: 0.83, y2: 0.67 }) ===
    'cubic-bezier(0.17, 0.67, 0.83, 0.67)',
  'format shape'
)
assert(parseBezier('cubic-bezier(1,2,3)') === null, 'reject 3 coords')
assert(parseBezier('cubic-bezier(1.5,0,1,1)') === null, 'reject x out of [0,1]')
assert(parseBezier('steps(4)') === null, 'reject non-bezier function')
assert(parseBezier('cubic-bezier(0,-0.5,1,1.5)') !== null, 'y overshoot is valid css')

// --- snap tolerance boundaries (0.01/coord) ---
const off = (b, d) => ({ x1: b.x1 + d, y1: b.y1, x2: b.x2, y2: b.y2 })
const easeIn = BEZIER_PRESETS['ease-in']
assert(snapBezierPreset(off(easeIn, 0.01)) === 'ease-in', 'exactly 0.01 off -> still snaps')
assert(snapBezierPreset(off(easeIn, -0.01)) === 'ease-in', 'exactly -0.01 off -> still snaps')
assert(snapBezierPreset(off(easeIn, 0.011)) === null, '0.011 off -> no snap')
assert(
  snapBezierPreset({ x1: 0.17, y1: 0.67, x2: 0.83, y2: 0.67 }) === null,
  'custom curve -> null'
)
// every coord must be within tolerance, not just the total
assert(
  snapBezierPreset({ x1: easeIn.x1, y1: easeIn.y1 + 0.05, x2: easeIn.x2, y2: easeIn.y2 }) === null,
  'one coord 0.05 off -> no snap even if others exact'
)
// nearest preset wins when two are in range (ease-in vs ease-in-out differ in x2)
assert(
  snapBezierPreset({ x1: 0.42, y1: 0, x2: 0.99, y2: 1 }) === 'ease-in',
  'nearest preset wins: ~ease-in'
)
assert(
  snapBezierPreset({ x1: 0.42, y1: 0, x2: 0.59, y2: 1 }) === 'ease-in-out',
  'nearest preset wins: ~ease-in-out'
)

// --- clamp helpers: x in [0,1], y in [-1,2] ---
assert(clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0 && clamp(2, 0, 3) === 2, 'clamp')
assert(clampBezierX(-0.5) === 0 && clampBezierX(1.5) === 1 && clampBezierX(0.3) === 0.3, 'x clamp')
assert(clampBezierY(-2) === -1 && clampBezierY(3) === 2 && clampBezierY(1.9) === 1.9, 'y clamp')
assert(
  eq(clampBezier({ x1: -1, y1: -5, x2: 2, y2: 5 }), { x1: 0, y1: -1, x2: 1, y2: 2 }),
  'clampBezier all handles'
)

if (failed) {
  console.error(`CSS-VALUES: ${failed}/${count} assertion(s) failed`)
  process.exit(1)
}
console.log(
  `CSS-VALUES OK — ${count} assertions: parse/format, v1 metadata, ms normalization, bezier snap/clamp`
)
