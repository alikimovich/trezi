/**
 * Custom-control manifest core (v10) — pure unit test over control-manifest.ts.
 * The manifest is untrusted agent output, so this exercises the full validation
 * matrix (each structural rule violated once), anchor location (found /
 * missing / ambiguous), the kind-typed literal lexer, clamped + quote-safe
 * rendering, and the render → resolveLiteralValue round-trip — including after
 * unrelated edits elsewhere in the fixture (anchors are positionless).
 *
 * Run with: bun test/control-panels.mjs
 */
import {
  lexLiteral,
  locateAnchor,
  partitionStoreEntries,
  renderLiteral,
  resolveLiteralValue,
  upsertPanel,
  validateManifest
} from '../src/main/control-manifest.ts'

let failed = 0
let count = 0
const assert = (cond, msg) => {
  count++
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

// ---------- validation matrix ----------

const validParam = (over = {}) => ({
  id: 'stagger-ms',
  label: 'Stagger delay',
  kind: 'number',
  unit: 'ms',
  min: 0,
  max: 2000,
  step: 10,
  apply: { strategy: 'literal', anchor: 'const STAGGER_MS = ' },
  ...over
})
const validManifest = (over = {}) => ({
  id: 'hero-controls',
  file: 'src/components/Hero.tsx',
  component: 'Hero',
  title: 'Hero timing',
  createdAt: '2026-07-16T00:00:00.000Z',
  params: [validParam()],
  ...over
})

const animation = validateManifest(validManifest({ presentation: 'animation', replay: true }))
assert(
  !('error' in animation) && animation.presentation === 'animation' && animation.replay,
  'native animation metadata survives validation'
)
assert(
  'error' in
    validateManifest(
      validManifest({
        presentation: 'animation',
        params: [validParam({ apply: { strategy: 'prop', propName: 'delay' } })]
      })
    ),
  'animation controls cannot depend on selection'
)
assert(
  'error' in validateManifest(validManifest({ replay: true })),
  'replay requires an animation panel'
)

// A maximal valid manifest — every kind, every strategy, full caps in play.
const maximal = validManifest({
  params: [
    validParam(),
    {
      id: 'accent',
      label: 'Accent color',
      kind: 'color',
      apply: { strategy: 'literal', anchor: 'const ACCENT = ' }
    },
    {
      id: 'easing',
      label: 'Easing',
      kind: 'bezier',
      apply: { strategy: 'literal', anchor: 'const EASE = ' }
    },
    {
      id: 'looping',
      label: 'Loop',
      kind: 'toggle',
      apply: { strategy: 'literal', anchor: 'const LOOP = ' }
    },
    {
      id: 'greeting',
      label: 'Greeting',
      kind: 'text',
      apply: { strategy: 'prop', propName: 'greeting' }
    },
    {
      id: 'direction',
      label: 'Direction',
      kind: 'select',
      options: ['up', 'down'],
      apply: { strategy: 'style', styleProp: 'transition-property' }
    }
  ]
})
{
  const r = validateManifest(maximal)
  assert(!('error' in r), `maximal manifest validates: ${r.error ?? ''}`)
  assert(r.params?.length === 6, 'all six params survive')
  assert(r.params?.[0].min === 0 && r.params?.[0].max === 2000, 'numeric metadata preserved')
  // Rebuilt object: unknown keys stripped, input not returned by reference.
  const withJunk = validateManifest(validManifest({ __proto__2: 'x', extra: 'field' }))
  assert(!('error' in withJunk) && !('extra' in withJunk), 'unknown manifest keys stripped')
}

// Each structural rule violated once → error.
const violations = [
  ['non-object manifest', 'nope'],
  ['array manifest', []],
  ['bad manifest id', validManifest({ id: 'Bad_ID!' })],
  ['absolute file path', validManifest({ file: '/etc/passwd' })],
  ['.. traversal in file', validManifest({ file: 'src/../../secret.ts' })],
  ['backslash in file', validManifest({ file: 'src\\Hero.tsx' })],
  ['empty file', validManifest({ file: '' })],
  ['empty component', validManifest({ component: '  ' })],
  ['title too long', validManifest({ title: 'x'.repeat(81) })],
  ['missing createdAt', validManifest({ createdAt: undefined })],
  ['zero params', validManifest({ params: [] })],
  [
    '13 params',
    validManifest({ params: Array.from({ length: 13 }, (_, i) => validParam({ id: `p-${i}` })) })
  ],
  ['param id bad chars', validManifest({ params: [validParam({ id: 'Bad ID' })] })],
  ['param id too long', validManifest({ params: [validParam({ id: `a${'b'.repeat(41)}` })] })],
  ['duplicate param ids', validManifest({ params: [validParam(), validParam()] })],
  ['label too long', validManifest({ params: [validParam({ label: 'x'.repeat(81) })] })],
  ['unknown kind', validManifest({ params: [validParam({ kind: 'slider' })] })],
  ['min > max', validManifest({ params: [validParam({ min: 10, max: 5 })] })],
  ['non-finite min', validManifest({ params: [validParam({ min: Infinity })] })],
  ['step <= 0', validManifest({ params: [validParam({ step: 0 })] })],
  [
    'min on non-number kind',
    validManifest({
      params: [
        validParam({ kind: 'text', unit: undefined, min: 0, max: undefined, step: undefined })
      ]
    })
  ],
  [
    'select without options',
    validManifest({
      params: [
        validParam({
          kind: 'select',
          unit: undefined,
          min: undefined,
          max: undefined,
          step: undefined
        })
      ]
    })
  ],
  ['options on non-select', validManifest({ params: [validParam({ options: ['a'] })] })],
  [
    'empty options',
    validManifest({
      params: [
        validParam({
          kind: 'select',
          options: [],
          unit: undefined,
          min: undefined,
          max: undefined,
          step: undefined
        })
      ]
    })
  ],
  [
    'non-string option',
    validManifest({
      params: [
        validParam({
          kind: 'select',
          options: [3],
          unit: undefined,
          min: undefined,
          max: undefined,
          step: undefined
        })
      ]
    })
  ],
  [
    'markup in option (</script> injection)',
    validManifest({
      params: [
        validParam({
          kind: 'select',
          options: ['up', '</script><script src=//evil.example>'],
          unit: undefined,
          min: undefined,
          max: undefined,
          step: undefined
        })
      ]
    })
  ],
  ['missing apply', validManifest({ params: [validParam({ apply: undefined })] })],
  ['unknown strategy', validManifest({ params: [validParam({ apply: { strategy: 'magic' } })] })],
  [
    'bad propName',
    validManifest({ params: [validParam({ apply: { strategy: 'prop', propName: '1bad name' } })] })
  ],
  [
    'styleProp off-allowlist',
    validManifest({ params: [validParam({ apply: { strategy: 'style', styleProp: 'position' } })] })
  ],
  [
    'anchor too short',
    validManifest({ params: [validParam({ apply: { strategy: 'literal', anchor: 'ab' } })] })
  ],
  [
    'anchor too long',
    validManifest({
      params: [validParam({ apply: { strategy: 'literal', anchor: 'x'.repeat(201) } })]
    })
  ],
  [
    'anchor whitespace-only',
    validManifest({ params: [validParam({ apply: { strategy: 'literal', anchor: '    ' } })] })
  ],
  // 32KB total-JSON cap — oversize via a field the per-field caps don't bound.
  ['manifest JSON > 32KB', validManifest({ createdAt: `t${'0'.repeat(40000)}` })]
]
for (const [name, input] of violations) {
  const r = validateManifest(input)
  assert('error' in r, `rejects: ${name}`)
}

// ---------- anchor location ----------

const FIXTURE = [
  "import { motion } from 'framer-motion'",
  '',
  'const STAGGER_MS = 120',
  "const ACCENT = '#3b82f6'",
  'const EASE = [0.17, 0.67, 0.83, 0.67]',
  "const EASE_CSS = 'cubic-bezier(0.4, 0, 0.2, 1)'",
  'const LOOP = true',
  "const GREETING = 'say \\'hi\\' now'",
  'const SCALE = -0.75',
  'export function Hero() { return null }',
  ''
].join('\n')

{
  const found = locateAnchor(FIXTURE, 'const STAGGER_MS = ')
  assert('at' in found, 'anchor found')
  assert(FIXTURE.slice(found.at, found.at + 3) === '120', 'at points just past the anchor')
  assert(locateAnchor(FIXTURE, 'const NOPE = ').error === 'missing', 'missing anchor')
  assert(locateAnchor(FIXTURE, 'const ').error === 'ambiguous', 'ambiguous anchor (many matches)')
}

// ---------- per-kind lexing ----------

const lexAt = (anchor, kind) => {
  const loc = locateAnchor(FIXTURE, anchor)
  return 'at' in loc ? lexLiteral(FIXTURE, loc.at, kind) : null
}
{
  assert(lexAt('const STAGGER_MS = ', 'number')?.raw === '120', 'lex integer')
  assert(lexAt('const SCALE = ', 'number')?.raw === '-0.75', 'lex negative decimal')
  assert(lexLiteral('x = .5;', 4, 'number')?.raw === '.5', 'lex bare .5')
  assert(lexAt('const ACCENT = ', 'color')?.raw === "'#3b82f6'", 'lex quoted color string')
  assert(
    lexAt('const GREETING = ', 'text')?.raw === "'say \\'hi\\' now'",
    'lex string with escaped quotes'
  )
  assert(lexAt('const LOOP = ', 'toggle')?.raw === 'true', 'lex true')
  assert(lexLiteral('a = false;', 4, 'toggle')?.raw === 'false', 'lex false')
  assert(lexAt('const EASE = ', 'bezier')?.raw === '[0.17, 0.67, 0.83, 0.67]', 'lex bezier array')
  assert(
    lexAt('const EASE_CSS = ', 'bezier')?.raw === "'cubic-bezier(0.4, 0, 0.2, 1)'",
    'lex bezier cubic-bezier string'
  )
  assert(lexAt('const ACCENT = ', 'number') === null, 'kind mismatch → null (number over string)')
  assert(
    lexAt('const STAGGER_MS = ', 'toggle') === null,
    'kind mismatch → null (toggle over number)'
  )

  // Exponent forms lex in FULL — a partial span ('1' of '1e3') would corrupt
  // the value on splice (250e3) and misreport it on resolve.
  assert(lexLiteral('const D = 1e3', 10, 'number')?.raw === '1e3', 'lex exponent literal fully')
  assert(
    lexLiteral('const D = 1.5E-2;', 10, 'number')?.raw === '1.5E-2',
    'lex signed exponent fully'
  )
  assert(
    lexLiteral('const D = -2e10,', 10, 'number')?.raw === '-2e10',
    'lex negative exponent fully'
  )
  // Unlexable numeric forms REFUSE (stale) instead of truncating.
  assert(lexLiteral('const C = 0x1f', 10, 'number') === null, 'hex literal → null, not "0"')
  assert(
    lexLiteral('const D = 120_000', 10, 'number') === null,
    'separator literal → null, not "120"'
  )
  assert(lexLiteral('const B = 4n;', 10, 'number') === null, 'BigInt literal → null, not "4"')
  assert(lexLiteral('const P = 1.5.x', 10, 'number') === null, 'trailing property access → null')
  // Toggle needs a word boundary — identifier prefixes are not booleans.
  assert(lexLiteral('const F = trueish', 10, 'toggle') === null, 'trueish → null, not "true"')
  assert(lexLiteral('const F = falsey', 10, 'toggle') === null, 'falsey → null, not "false"')
  assert(
    lexLiteral('const F = true_x', 10, 'toggle') === null,
    'true_x → null (underscore continues)'
  )
  assert(lexLiteral('a = true', 4, 'toggle')?.raw === 'true', 'true at end of source still lexes')
  assert(lexLiteral('a = true,', 4, 'toggle')?.raw === 'true', 'true before comma still lexes')
  assert(lexLiteral('v = `has ${x} interp`', 4, 'text') === null, 'template interpolation refuses')
  const long = `e = [${'1,'.repeat(60)}1]`
  assert(lexLiteral(long, 4, 'bezier') === null, 'bezier array must be 4 numbers within 80 chars')
}

// ---------- rendering: clamping, escaping, grammar ----------

{
  const num = validParam()
  assert(renderLiteral('number', 5000, num) === '2000', 'clamps above max')
  assert(renderLiteral('number', -10, num) === '0', 'clamps below min')
  assert(renderLiteral('number', 150.5, num) === '150.5', 'in-range value untouched')
  assert(renderLiteral('number', NaN, num)?.error, 'NaN rejected')
  assert(renderLiteral('number', '12', num)?.error, 'string-typed number rejected')

  const text = validParam({ kind: 'text' })
  assert(
    renderLiteral('text', 'say "hi"\n', text) === '"say \\"hi\\"\\n"',
    'JSON.stringify escaping'
  )
  assert(renderLiteral('text', 'x'.repeat(501), text)?.error, 'string > 500 chars rejected')
  // JS-quote-safe is not HTML-context-safe: '</script>' inside a rendered
  // string would terminate an inline <script> in a previewed .html file.
  assert(
    renderLiteral('text', '</script><script src=//evil.example>', text)?.error,
    'HTML-breaking text rejected'
  )
  assert(renderLiteral('text', 'a < b', text)?.error, "'<' rejected in text")
  assert(renderLiteral('text', 'a > b', text)?.error, "'>' rejected in text")

  const color = validParam({ kind: 'color' })
  assert(renderLiteral('color', '#3b82f6', color) === '"#3b82f6"', 'hex color ok')
  assert(renderLiteral('color', 'rgb(59, 130, 246)', color) === '"rgb(59, 130, 246)"', 'rgb() ok')
  assert(renderLiteral('color', 'hsl(217 91% 60%)', color) === '"hsl(217 91% 60%)"', 'hsl() ok')
  assert(renderLiteral('color', 'var(--accent)', color) === '"var(--accent)"', 'var() ok')
  assert(renderLiteral('color', 'red; } body {', color)?.error, 'injection-shaped color rejected')
  assert(renderLiteral('color', 'url(javascript:x)', color)?.error, 'url() rejected')

  const sel = validParam({ kind: 'select', options: ['up', 'down'] })
  assert(renderLiteral('select', 'up', sel) === '"up"', 'select in options ok')
  assert(renderLiteral('select', 'sideways', sel)?.error, 'select off-options rejected')
  // Belt-and-suspenders: even if a markup option slipped into a stored panel
  // (validateManifest rejects them at registration), it never renders.
  const evil = validParam({ kind: 'select', options: ['</script><script>'] })
  assert(renderLiteral('select', '</script><script>', evil)?.error, 'markup select value rejected')

  assert(renderLiteral('toggle', true, validParam({ kind: 'toggle' })) === 'true', 'toggle true')
  assert(
    renderLiteral('toggle', 'true', validParam({ kind: 'toggle' }))?.error,
    'toggle non-boolean rejected'
  )

  const bez = validParam({ kind: 'bezier' })
  assert(
    renderLiteral('bezier', [0.17, 0.67, 0.83, 0.67], bez) === '[0.17, 0.67, 0.83, 0.67]',
    'bezier array shape'
  )
  assert(
    renderLiteral('bezier', [0.4, 0, 0.2, 1], bez, 'string') === '"cubic-bezier(0.4, 0, 0.2, 1)"',
    'bezier string shape via hint'
  )
  assert(
    renderLiteral('bezier', [1.5, 0, -0.2, 1], bez) === '[1, 0, 0, 1]',
    'bezier x coords clamped to [0,1]'
  )
  assert(renderLiteral('bezier', [0.1, 0.2, 0.3], bez)?.error, '3 numbers rejected')
  assert(renderLiteral('bezier', [0.1, NaN, 0.3, 0.4], bez)?.error, 'non-finite rejected')
}

// ---------- resolve + render round-trip ----------

const splice = (code, anchor, kind, rendered) => {
  const loc = locateAnchor(code, anchor)
  const lit = lexLiteral(code, loc.at, kind)
  return code.slice(0, lit.start) + rendered + code.slice(lit.end)
}
{
  const p = validParam()
  assert(resolveLiteralValue(FIXTURE, p) === 120, 'resolve current number')
  const edited = splice(FIXTURE, p.apply.anchor, 'number', renderLiteral('number', 340, p))
  assert(resolveLiteralValue(edited, p) === 340, 'round-trip: rendered number reads back')

  const c = validParam({ kind: 'color', apply: { strategy: 'literal', anchor: 'const ACCENT = ' } })
  assert(resolveLiteralValue(FIXTURE, c) === '#3b82f6', 'resolve current color')
  const edited2 = splice(FIXTURE, c.apply.anchor, 'color', renderLiteral('color', '#ff0000', c))
  assert(resolveLiteralValue(edited2, c) === '#ff0000', 'round-trip: color reads back')

  const t = validParam({ kind: 'toggle', apply: { strategy: 'literal', anchor: 'const LOOP = ' } })
  assert(resolveLiteralValue(FIXTURE, t) === true, 'resolve current toggle')
  assert(
    resolveLiteralValue(splice(FIXTURE, t.apply.anchor, 'toggle', 'false'), t) === false,
    'toggle round-trip'
  )

  const g = validParam({
    kind: 'text',
    apply: { strategy: 'literal', anchor: 'const GREETING = ' }
  })
  assert(resolveLiteralValue(FIXTURE, g) === "say 'hi' now", 'resolve unescapes quotes')
  const edited3 = splice(FIXTURE, g.apply.anchor, 'text', renderLiteral('text', 'a "b" c', g))
  assert(resolveLiteralValue(edited3, g) === 'a "b" c', 'round-trip: escaped string reads back')

  const b = validParam({ kind: 'bezier', apply: { strategy: 'literal', anchor: 'const EASE = ' } })
  assert(
    resolveLiteralValue(FIXTURE, b) === 'cubic-bezier(0.17, 0.67, 0.83, 0.67)',
    'bezier array normalizes to css text'
  )
  const bs = validParam({
    kind: 'bezier',
    apply: { strategy: 'literal', anchor: 'const EASE_CSS = ' }
  })
  assert(
    resolveLiteralValue(FIXTURE, bs) === 'cubic-bezier(0.4, 0, 0.2, 1)',
    'bezier string normalizes too'
  )
  const edited4 = splice(
    FIXTURE,
    b.apply.anchor,
    'bezier',
    renderLiteral('bezier', [0.1, 0.2, 0.3, 0.4], b)
  )
  assert(
    resolveLiteralValue(edited4, b) === 'cubic-bezier(0.1, 0.2, 0.3, 0.4)',
    'round-trip: bezier reads back'
  )

  assert(
    resolveLiteralValue(FIXTURE, validParam({ apply: { strategy: 'prop', propName: 'x' } })) ===
      null,
    'non-literal strategy → null'
  )
  assert(
    resolveLiteralValue(
      FIXTURE,
      validParam({ apply: { strategy: 'literal', anchor: 'const GONE = ' } })
    ) === null,
    'missing anchor → null'
  )

  // Exponent literal resolves to its true value and round-trips via splice.
  const e = validParam({ apply: { strategy: 'literal', anchor: 'const DELAY = ' } })
  const expCode = 'const DELAY = 1e3\n'
  assert(resolveLiteralValue(expCode, e) === 1000, '1e3 resolves as 1000, not 1')
  const expEdited = splice(expCode, e.apply.anchor, 'number', renderLiteral('number', 250, e))
  assert(expEdited === 'const DELAY = 250\n', 'splice replaces the WHOLE exponent literal')
  assert(resolveLiteralValue(expEdited, e) === 250, 'round-trip after exponent splice')
  // Shapes the lexer refuses resolve as stale (null), never a wrong value.
  assert(resolveLiteralValue('const DELAY = 120_000\n', e) === null, 'separator literal → stale')
  assert(resolveLiteralValue('const DELAY = 0xff8800\n', e) === null, 'hex literal → stale')
  const tb = validParam({
    kind: 'toggle',
    apply: { strategy: 'literal', anchor: 'const FEATURE = ' }
  })
  assert(
    resolveLiteralValue('const FEATURE = trueByDefault\n', tb) === null,
    'identifier starting with true → stale'
  )
}

// ---------- anchors survive unrelated edits (positionless) ----------

{
  const p = validParam()
  // Simulate the agent re-editing the file: new import, renamed component, code
  // moved around — everything except the anchored constant itself.
  const reEdited = FIXTURE.replace(
    "import { motion } from 'framer-motion'",
    "import { m } from 'framer-motion'\nimport { useMemo } from 'react'"
  )
    .replace('export function Hero()', 'export function HeroBanner()')
    .replace('const SCALE = -0.75', 'const SCALE = -0.75\nconst NEW_THING = 42')
  assert(resolveLiteralValue(reEdited, p) === 120, 'anchor still resolves after unrelated edits')
  const c = validParam({ kind: 'color', apply: { strategy: 'literal', anchor: 'const ACCENT = ' } })
  assert(resolveLiteralValue(reEdited, c) === '#3b82f6', 'second anchor also survives')
  // A rename of the constant itself flips to unresolvable — the stale path.
  const renamed = FIXTURE.replace('const STAGGER_MS = ', 'const STAGGER_DELAY_MS = ')
  assert(
    resolveLiteralValue(renamed, p) === null,
    'renamed constant → null (stale, never wrong-site)'
  )
  // A duplicated anchor is ambiguous — refuse rather than guess.
  const duplicated = `${FIXTURE}\n// const STAGGER_MS = old note\nconst STAGGER_MS = 999\n`
  assert(
    locateAnchor(duplicated, p.apply.anchor).error === 'ambiguous',
    'duplicated anchor → ambiguous'
  )
}

// ---------- upsert by (file, component) — regenerate replaces, never duplicates ----------

{
  const mkPanel = (over = {}) => {
    const r = validateManifest(validManifest(over))
    assert(!('error' in r), `upsert fixture manifest validates: ${r.error ?? ''}`)
    return r
  }
  const first = mkPanel()
  const one = upsertPanel([], first)
  assert(Array.isArray(one) && one.length === 1, 'insert into empty store')
  // Same file+component (different id/title/params) → replaced in place.
  const regen = mkPanel({ id: 'hero-controls-v2', title: 'Hero timing v2' })
  const replaced = upsertPanel(one, regen)
  assert(Array.isArray(replaced) && replaced.length === 1, 'regenerate replaces, never duplicates')
  assert(replaced[0].id === 'hero-controls-v2', 'replacement is the new manifest')
  // Different component in the same file → appends.
  const sibling = mkPanel({ id: 'footer-controls', component: 'Footer' })
  const two = upsertPanel(replaced, sibling)
  assert(Array.isArray(two) && two.length === 2, 'different component appends')
  // Same component in a different file → appends (keyed by file AND component).
  const otherFile = mkPanel({ id: 'other-hero', file: 'src/components/Other.tsx' })
  assert(upsertPanel(two, otherFile).length === 3, 'same component, different file appends')
  // Input array is never mutated.
  assert(one.length === 1 && one[0].id === 'hero-controls', 'upsert is pure (input untouched)')
  // ≤20 panels per repo: the 21st insert refuses, but replacing at the cap works.
  const twenty = Array.from({ length: 20 }, (_, i) =>
    mkPanel({ id: `p-${i}`, file: `src/F${i}.tsx` })
  )
  const overflow = upsertPanel(twenty, mkPanel({ id: 'p-20', file: 'src/F20.tsx' }))
  assert('error' in overflow, '21st panel → error (20-panel cap)')
  const replacedAtCap = upsertPanel(twenty, mkPanel({ id: 'p-5-v2', file: 'src/F5.tsx' }))
  assert(
    Array.isArray(replacedAtCap) && replacedAtCap.length === 20,
    'replace still allowed at the cap'
  )
  // Store-wide id uniqueness: applyLiteral/removePanel key on id alone, so an
  // id reused by a DIFFERENT (file, component) panel must refuse.
  const dupId = upsertPanel(
    two,
    mkPanel({ id: 'footer-controls', file: 'src/components/Elsewhere.tsx' })
  )
  assert('error' in dupId, 'duplicate id across (file, component) pairs → error')
  const sameSlot = upsertPanel(two, mkPanel({ id: 'hero-controls-v2', title: 'Hero timing v3' }))
  assert(
    Array.isArray(sameSlot) && sameSlot.length === 2 && sameSlot[0].title === 'Hero timing v3',
    'keeping the id while replacing the SAME (file, component) slot is fine'
  )
}

// ---------- store partition — invalid/duplicate/over-cap entries preserved, never dropped ----------

{
  const mk = (over = {}) => validateManifest(validManifest(over))
  const good = mk()
  const sibling = mk({ id: 'footer-controls', component: 'Footer' })
  const broken = { ...validManifest({ id: 'broken-one' }), params: [validParam({ id: 'Bad ID' })] }
  const skewed = validManifest({ id: 'from-the-future', component: 'Future' })
  skewed.params = [validParam({ kind: 'hologram' })] // a kind this version doesn't know
  const dup = validManifest({ component: 'Shadow' }) // same id as `good`
  const { panels, preserved } = partitionStoreEntries([good, broken, sibling, skewed, dup])
  assert(panels.length === 2, 'valid unique panels load')
  assert(
    panels[0].id === 'hero-controls' && panels[1].id === 'footer-controls',
    'load order preserved, first id occurrence wins'
  )
  assert(preserved.length === 3, 'invalid + version-skewed + duplicate-id entries preserved')
  assert(
    preserved[0] === broken && preserved[1] === skewed && preserved[2] === dup,
    'preserved entries are the raw objects, verbatim'
  )
  // Over-cap valid panels are preserved too (kept out of resolution, not erased).
  const many = Array.from({ length: 22 }, (_, i) => mk({ id: `p-${i}`, file: `src/F${i}.tsx` }))
  const capped = partitionStoreEntries(many)
  assert(capped.panels.length === 20, 'load capped at 20 panels')
  assert(
    capped.preserved.length === 2 && capped.preserved[0] === many[20],
    'over-cap panels preserved verbatim'
  )
}

if (failed) {
  console.error(`CONTROL-PANELS: ${failed}/${count} assertion(s) failed`)
  process.exit(1)
}
console.log(
  `CONTROL-PANELS OK — ${count} assertions: validation matrix, anchor locate, kind-typed lexing, clamped/quote-safe rendering, resolve round-trips, upsert-by-file+component, store partition (preserve-not-drop)`
)
