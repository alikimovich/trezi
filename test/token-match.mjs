/**
 * token-match unit test (pure — no Electron, no DOM). The design-token ⇄ css
 * property matcher behind the Styles panel's token chips and picker:
 * value-shape classification, group ROLES, the per-property gate, reference
 * forms per detection source, and value→token resolution incl. the
 * two-tokens-same-value tie and the cross-family naming bar (a `--radius-none`
 * must never label a `padding: 0`). Run with: bun test/token-match.mjs
 */

// Cross-module contract: the panel injects sameCssValue as the comparator, so
// resolution must survive '#6c6c6c' ⇄ 'rgb(108, 108, 108)'.
import { sameCssValue } from '../src/shared/css-values.ts'
import {
  customPropertyNames,
  groupRole,
  resolveTokenForValue,
  tokenReference,
  tokensForProp,
  tokenValueKind
} from '../src/shared/token-match.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (actual, expected, msg) =>
  ok(
    actual === expected,
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
const names = (cands) => cands.map((c) => c.token.name)

// --- tokenValueKind ---------------------------------------------------------

eq(tokenValueKind('#6c6c6c'), 'color', 'hex is a color')
eq(tokenValueKind('#FFF'), 'color', 'short hex, case-insensitive')
eq(tokenValueKind('rgb(108, 108, 108)'), 'color', 'rgb() is a color')
eq(tokenValueKind('oklch(0.7 0.1 250)'), 'color', 'oklch() is a color')
eq(tokenValueKind('rebeccapurple'), 'color', 'a named color is a color')
eq(tokenValueKind('transparent'), 'color', 'transparent is a color')
eq(tokenValueKind('16px'), 'length', 'px is a length')
eq(tokenValueKind('1.5rem'), 'length', 'rem is a length')
eq(tokenValueKind('100%'), 'length', '% is a length')
eq(tokenValueKind('clamp(1rem, 2vw, 2rem)'), 'length', 'a fluid clamp() is a length')
// A unitless zero is CSS-valid wherever a length is, and `--space-0: 0` is real.
eq(tokenValueKind('0'), 'length', 'bare 0 counts as a length')
eq(tokenValueKind('600'), 'number', 'a bare non-zero number is a number')
eq(tokenValueKind('1.5'), 'number', 'a bare decimal is a number')
eq(tokenValueKind('0 1px 2px #0003'), 'shadow', 'length + color is a shadow')
eq(tokenValueKind('"Geist Sans", sans-serif'), 'font', 'a comma-separated stack is a font')
eq(tokenValueKind('Menlo, Monaco, monospace'), 'font', 'an unquoted stack is a font')
eq(tokenValueKind(''), 'unknown', 'empty → unknown')
eq(tokenValueKind('ease-in-out'), 'unknown', 'a keyword we do not model → unknown')

// --- groupRole --------------------------------------------------------------

eq(groupRole('colors'), 'color', 'tailwind colors')
eq(groupRole('color'), 'color', 'css-var first-segment group')
eq(groupRole('colour'), 'color', 'british spelling')
eq(groupRole('spacing'), 'spacing', 'tailwind spacing')
eq(groupRole('space'), 'spacing', 'css-var space group')
// The whole point of roles: radius and spacing are BOTH lengths, so the coarse
// value kind cannot separate them — the group name is the only signal there is.
eq(groupRole('borderRadius'), 'radius', 'tailwind borderRadius')
eq(groupRole('radius'), 'radius', 'manifest radius')
ok(groupRole('radius') !== groupRole('spacing'), 'radius and spacing are distinct roles')
eq(groupRole('fontSize'), 'font-size', 'tailwind fontSize')
eq(groupRole('fontWeight'), 'font-weight', 'fontWeight before the bare font catch-all')
eq(groupRole('fontFamily'), 'font-family', 'fontFamily falls to the font catch-all')
eq(groupRole('tracking'), 'tracking', 'tracking is letter-spacing')
eq(groupRole('boxShadow'), 'shadow', 'tailwind boxShadow')
// Group names are unconstrained — an unrecognized one must stay NEUTRAL, never
// exclude, or a manifest with hand-written keys would surface nothing.
eq(groupRole('brand'), null, 'an unrecognized group name says nothing')
eq(groupRole('z'), null, 'a z-index group says nothing')

// --- tokensForProp: value shape GATES, group name only RANKS ----------------

const cssSet = {
  source: 'css',
  origin: 'src/routes/styles.less',
  groups: [
    {
      name: 'color',
      tokens: [
        { name: '--color-text', value: '#6c6c6c' },
        { name: '--color-title', value: '#212121' },
        { name: '--color-link', value: '#212121' }
      ]
    },
    { name: 'space', tokens: [{ name: '--space-md', value: '16px' }] },
    // The trap: a z-index token is a bare number in a group with no affinity.
    { name: 'z', tokens: [{ name: '--z-modal', value: '100' }] }
  ]
}

eq(
  names(tokensForProp(cssSet, 'color')).join(','),
  '--color-text,--color-title,--color-link',
  'color offers only the color tokens'
)
eq(names(tokensForProp(cssSet, 'padding-top')).join(','), '--space-md', 'padding offers lengths')
ok(
  !names(tokensForProp(cssSet, 'padding-top')).includes('--z-modal'),
  'a bare number is never offered for a length property'
)
ok(
  !names(tokensForProp(cssSet, 'color')).includes('--space-md'),
  'a length is never offered for a color property'
)
// font-weight accepts numbers, but only ones in the real weight domain. `100`
// IS a legal weight, so a z-index token of 100 is genuinely indistinguishable
// by value — it's offered, but ranked neutral rather than preferred, so it sits
// below any real weight scale instead of being hidden.
eq(names(tokensForProp(cssSet, 'font-weight')).join(','), '--z-modal', '100 is a legal weight')
eq(tokensForProp(cssSet, 'font-weight')[0].rank, 'neutral', '…but ranked neutral, not preferred')
eq(
  names(
    tokensForProp(
      { source: 'css', groups: [{ name: 'z', tokens: [{ name: '--z-drop', value: '250' }] }] },
      'font-weight'
    )
  ).length,
  0,
  '250 is not a step-100 weight → excluded'
)
eq(
  names(
    tokensForProp(
      { source: 'css', groups: [{ name: 'a', tokens: [{ name: '--o', value: '1.5' }] }] },
      'opacity'
    )
  ).length,
  0,
  'opacity rejects a number outside 0–1'
)
eq(
  names(
    tokensForProp(
      { source: 'css', groups: [{ name: 'a', tokens: [{ name: '--z', value: '100' }] }] },
      'line-height'
    )
  ).length,
  0,
  'line-height rejects an out-of-range unitless number'
)
eq(tokensForProp(cssSet, 'transition-duration').length, 0, 'transition props take no tokens')
eq(tokensForProp(null, 'color').length, 0, 'no token set → nothing offered')
eq(tokensForProp({ source: 'none', groups: [] }, 'color').length, 0, 'source none → nothing')

// Ranking: a matching-role group comes before a neutral one, and a
// contradicting one comes last — but all of them are still offered.
const mixed = {
  source: 'manifest',
  groups: [
    { name: 'fontWeight', tokens: [{ name: 'w', value: '12px' }] }, // contradicts → other
    { name: 'brand', tokens: [{ name: 'b', value: '14px' }] }, // no affinity → neutral
    { name: 'fontSize', tokens: [{ name: 'f', value: '16px' }] } // agrees → preferred
  ]
}
eq(
  names(tokensForProp(mixed, 'font-size')).join(','),
  'f,b,w',
  'preferred → neutral → other, all offered'
)
// line-height accepts BOTH lengths and unitless numbers, so a spacing group is
// a legitimate preferred source for it — not a contradiction.
eq(
  tokensForProp(
    { source: 'manifest', groups: [{ name: 'spacing', tokens: [{ name: 's', value: '24px' }] }] },
    'line-height'
  )[0].rank,
  'preferred',
  'a length group is preferred for line-height, which accepts lengths'
)

// --- tokenReference ---------------------------------------------------------

eq(
  tokenReference('css', { name: '--color-text', value: '#6c6c6c' }),
  'var(--color-text)',
  'a css var becomes a var() reference'
)
eq(
  tokenReference('css', { name: 'color-text', value: '#6c6c6c' }),
  'var(--color-text)',
  'a dash-less css name is normalized'
)
eq(
  tokenReference('css', { name: '--alias', value: 'var(--other)' }),
  'var(--other)',
  'an aliased value passes through'
)
eq(
  tokenReference('tailwind', { name: 'brand-500', value: '#3b82f6' }),
  '#3b82f6',
  'a tailwind token has no var() form — its value is the inline reference'
)
eq(
  tokenReference('manifest', { name: 'primary', value: '#2563eb' }),
  '#2563eb',
  'a manifest token writes its value'
)

// --- customPropertyNames ----------------------------------------------------

eq(
  customPropertyNames(cssSet).join(','),
  '--color-text,--color-title,--color-link,--space-md,--z-modal',
  'every -- name, in detection order'
)
eq(customPropertyNames({ source: 'tailwind', groups: cssSet.groups }).length, 0, 'tailwind → none')

// --- resolveTokenForValue: 'css' source requires PROOF, not just equality ---
// Reported bug: an element's color happened to equal `--color-title`'s value,
// and the panel confidently named it — even though the source never
// referenced that variable at all. `getComputedStyle` always resolves `var()`
// away, so value equality can NEVER tell "IS" from "coincidentally equals";
// only the property's SPECIFIED declaration (`provenVar`, threaded from
// `preview/style-provenance.ts` via `styles:read`) can. No proof, no name —
// this is the fix, at the strongest point in the pipeline.

const equals = (prop) => (a, b) => sameCssValue(prop, a, b)
const colorCands = tokensForProp(cssSet, 'color')
const cssOpts = (extra) => ({ source: 'css', equals: equals('color'), ...extra })

// THE regression test: a value that equals exactly one token, with no proof
// at all, must show nothing — not even the unambiguous, unopposed match the
// pre-fix code would have happily named.
eq(
  resolveTokenForValue(colorCands, 'rgb(108, 108, 108)', cssOpts({})),
  null,
  'no provenVar → no name, even for a unique match (the reported bug, reproduced)'
)
// The comparator still normalizes notation (#6c6c6c ⇄ rgb(108, 108, 108)) —
// value equality is still a real requirement, just no longer a sufficient one.
eq(
  resolveTokenForValue(colorCands, 'rgb(108, 108, 108)', cssOpts({ provenVar: '--color-text' }))
    ?.match.token.name,
  '--color-text',
  'provenVar + matching value → names it'
)
eq(
  resolveTokenForValue(colorCands, '#123456', cssOpts({ provenVar: '--color-text' })),
  null,
  'provenVar alone is not enough — the value must still tie out'
)
eq(resolveTokenForValue(colorCands, '', cssOpts({})), null, 'empty value → null')
eq(
  resolveTokenForValue(colorCands, '#6c6c6c', cssOpts({ provenVar: '--not-a-real-token' })),
  null,
  'a provenVar naming nothing we detected → null, never the closest guess'
)

// The LIVE resolved custom property still decides value equality — right
// under a dark-mode override — independent of proof.
eq(
  resolveTokenForValue(
    colorCands,
    '#c1c1c1',
    cssOpts({ resolved: { '--color-text': '#c1c1c1' }, provenVar: '--color-text' })
  )?.match.token.name,
  '--color-text',
  'the live var value decides, not the recorded one'
)
eq(
  resolveTokenForValue(
    colorCands,
    '#6c6c6c',
    cssOpts({ resolved: { '--color-text': '#c1c1c1' }, provenVar: '--color-text' })
  ),
  null,
  'the recorded value is NOT a fallback once the var resolved to something else'
)

// Ties: --color-title and --color-link are both #212121 — proof picks the
// right one outright, no detection-order guessing needed.
eq(
  resolveTokenForValue(colorCands, '#212121', cssOpts({ provenVar: '--color-link' }))?.match.token
    .name,
  '--color-link',
  'provenVar picks the correct tied token directly'
)
eq(
  names(
    resolveTokenForValue(colorCands, '#212121', cssOpts({ provenVar: '--color-title' }))?.ties ?? []
  ).join(','),
  '--color-link',
  'the equal-valued sibling is still reported as a tie for the picker'
)

// `sticky`: NOT a guessing tie-break here — it bridges the gap right after an
// explicit pick, before the write lands. The live preview injects the
// RESOLVED value (never a var()), so `provenVar` looks unproven for a few
// hundred ms; we know the pick happened, so we trust it until the reconcile
// (real proof) catches up or the value moves on.
eq(
  resolveTokenForValue(colorCands, '#212121', cssOpts({ sticky: '--color-link' }))?.match.token
    .name,
  '--color-link',
  'sticky bridges the reconcile gap when nothing is proven yet'
)
eq(
  resolveTokenForValue(
    colorCands,
    '#212121',
    cssOpts({ sticky: '--color-link', provenVar: '--color-title' })
  )?.match.token.name,
  '--color-title',
  'fresh proof outranks a stale sticky once the source actually changes'
)
eq(
  resolveTokenForValue(colorCands, '#123456', cssOpts({ sticky: '--color-link' })),
  null,
  'sticky only applies while the value still ties — scrub away and it drops out'
)

// --- resolveTokenForValue: 'tailwind' source — a class IS the proof --------
// No var() exists to check; Tailwind utilities encode their theme key in the
// class itself, so a class naming the token directly counts as proof.

const twSet = {
  source: 'tailwind',
  groups: [{ name: 'colors', tokens: [{ name: 'color-text', value: '#6c6c6c' }] }]
}
const twCands = tokensForProp(twSet, 'color')
const twOpts = (extra) => ({ source: 'tailwind', equals: equals('color'), ...extra })

eq(
  resolveTokenForValue(twCands, '#6c6c6c', twOpts({})),
  null,
  'tailwind: value equality alone is still not proof — no class, no name'
)
eq(
  resolveTokenForValue(twCands, '#6c6c6c', twOpts({ classes: ['text-color-text', 'p-4'] }))?.match
    .token.name,
  'color-text',
  'tailwind: a class naming the token IS the proof'
)
eq(
  resolveTokenForValue(twCands, '#6c6c6c', twOpts({ sticky: 'color-text' }))?.match.token.name,
  'color-text',
  'tailwind: sticky bridges the same reconcile gap as css'
)

// --- resolveTokenForValue: 'manifest' — no reference mechanism exists ------
// A manifest token is a hand-picked literal, not a live variable, so there is
// nothing to prove against. Falls back to the pre-existing value+role
// heuristic: rank 'other' excluded, then a class hint, then sticky, then
// detection order. A known, disclosed gap — not a silent regression.

const mfOpts = (extra) => ({ source: 'manifest', equals: equals('color'), ...extra })
const mfColorCands = tokensForProp({ ...cssSet, source: 'manifest' }, 'color')

eq(
  resolveTokenForValue(mfColorCands, 'rgb(108, 108, 108)', mfOpts({}))?.match.token.name,
  '--color-text',
  'manifest: value equality alone still names (no proof mechanism exists to require)'
)
const mfTie = resolveTokenForValue(mfColorCands, '#212121', mfOpts({}))
eq(mfTie?.match.token.name, '--color-title', 'manifest: an unresolved tie falls to detection order')
eq(names(mfTie?.ties ?? []).join(','), '--color-link', 'the equal-valued sibling is reported')
eq(
  resolveTokenForValue(mfColorCands, '#212121', mfOpts({ classes: ['text-color-link', 'p-4'] }))
    ?.match.token.name,
  '--color-link',
  'manifest: a class naming one of the tied tokens breaks the tie'
)
eq(
  resolveTokenForValue(mfColorCands, '#212121', mfOpts({ sticky: '--color-link' }))?.match.token
    .name,
  '--color-link',
  'manifest: the sticky previous pick breaks the tie, so the label does not flip'
)

// manifest still needs yesterday's role fix — `groupRole` is source-agnostic,
// so the exact same radius-vs-spacing collision can recur in a manifest's own
// hand-written groups, with no provenVar to fall back on at all.
const mfZeroSet = {
  source: 'manifest',
  groups: [
    { name: 'radius', tokens: [{ name: 'radius-none', value: '0px' }] },
    { name: 'spacing', tokens: [{ name: 'space-none', value: '0px' }] }
  ]
}
eq(
  resolveTokenForValue(
    tokensForProp(mfZeroSet, 'padding-top'),
    '0px',
    mfOpts({ equals: equals('padding-top') })
  )?.match.token.name,
  'space-none',
  'manifest: the same-family token names the row'
)
const mfRadiusOnly = tokensForProp(
  {
    source: 'manifest',
    groups: [{ name: 'radius', tokens: [{ name: 'radius-none', value: '0px' }] }]
  },
  'padding-top'
)
eq(
  resolveTokenForValue(mfRadiusOnly, '0px', mfOpts({ equals: equals('padding-top') })),
  null,
  'manifest: a foreign-family token never names the row, even unopposed'
)
eq(
  resolveTokenForValue(
    mfRadiusOnly,
    '0px',
    mfOpts({ equals: equals('padding-top'), sticky: 'radius-none' })
  )?.match.token.name,
  'radius-none',
  'manifest: an explicit pick still names the row'
)

// --- resolveTokenForValue: proof overrides an implausible role (css only) --
// Deliberate: if the SOURCE genuinely says `padding: var(--radius-none)`,
// that's true, however odd — showing it beats hiding real information because
// it looks implausible. This is why the 'css' branch never applies the role
// filter at all; only 'manifest' (no proof available) still needs it.
eq(
  resolveTokenForValue(
    tokensForProp(
      {
        source: 'css',
        groups: [{ name: 'radius', tokens: [{ name: '--radius-none', value: '0px' }] }]
      },
      'padding-top'
    ),
    '0px',
    { source: 'css', equals: equals('padding-top'), provenVar: '--radius-none' }
  )?.match.token.name,
  '--radius-none',
  'css: real proof names the row even when the role looks wrong'
)

if (failed === 0) {
  console.log('TOKEN-MATCH OK — value kinds, roles, per-prop gate, references, resolution')
} else {
  console.error(`TOKEN-MATCH: ${failed} assertion(s) failed`)
}
process.exitCode = failed === 0 ? 0 : 1
