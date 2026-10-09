/**
 * The Styles panel's v1 editable CSS-property allowlist. Both sides need the
 * SAME set:
 *
 *  - `main/styles.ts` rejects any `styles:apply` edit whose `prop` isn't in
 *    this list before touching a file — this is the actual security/
 *    correctness boundary (the island's claim about what's editable is never
 *    trusted).
 *  - `renderer/src/lib/css-values.ts`'s `STYLE_PROP_META` supplies the
 *    control/unit/range metadata the panel renders for each of these
 *    properties (plus two READ-ONLY display-only rows — `font-family` and
 *    `display` — that aren't part of this writable set at all).
 *
 * Previously the two lists were separate literals "kept in sync by hand"; this
 * is the single canonical list both derive from, so adding a property to one
 * side without the other is a compile error (see `StyleProp` + the `satisfies`
 * check on `STYLE_PROP_META`) rather than a silent runtime gap.
 *
 * Pure + DOM-free + fs-free, like `token-match.ts` — exercised transitively by
 * `test/css-values.mjs` (the renderer side) and `test/style-edit.mjs` (main's
 * `styles.ts`, which derives its allowlist from this module).
 */

export const STYLE_PROPS = [
  // layout
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
  // appearance
  'color',
  'background-color',
  'border-radius',
  'box-shadow',
  'opacity',
  // typography
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  // transition
  'transition-property',
  'transition-duration',
  'transition-delay',
  'transition-timing-function'
] as const

/** One of the v1 editable CSS longhands. */
export type StyleProp = (typeof STYLE_PROPS)[number]

const STYLE_PROP_SET: ReadonlySet<string> = new Set(STYLE_PROPS)

/** Is `prop` one of the v1 editable properties? */
export function isStyleProp(prop: string): prop is StyleProp {
  return STYLE_PROP_SET.has(prop)
}
