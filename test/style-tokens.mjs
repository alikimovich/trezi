/**
 * style-tokens.ts unit test (pure decision logic — no Electron). The Styles
 * panel's design-token half: the island sends only a token NAME + GROUP, and
 * this module re-detects the project's OWN tokens and re-resolves the pick
 * against them — the security-relevant re-validation that stops a
 * compromised/stale island claim (e.g. a color token aimed at `padding-top`)
 * from ever being trusted. Exercises `resolveTokenRef` (real temp-dir token
 * sources — manifest and CSS custom properties) and the fully pure
 * `tokenClassRewrite` (no I/O at all).
 *
 * `main/tokens.ts` (which `resolveTokenRef` calls into for detection) uses a
 * namespace `import * as electron` specifically so this module — and
 * `style-tokens.ts`, which never touches Electron itself — stay importable
 * under plain bun; `registerTokensIpc`'s `electron.ipcMain` calls are never
 * reached here.
 *
 * Run with: bun run test:style-tokens
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTokenRef, tokenClassRewrite } from '../src/main/style-tokens.ts'
import { rewriteClassList, rewriteClassListToken } from '../src/main/tw-styles.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (actual, expected, msg) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )

const base = mkdtempSync(join(tmpdir(), 'trezi-style-tokens-'))

// --- fixture A: manifest source (.trezi/tokens.json) ----------------------
const manifestRoot = join(base, 'manifest-project')
mkdirSync(join(manifestRoot, '.trezi'), { recursive: true })
writeFileSync(
  join(manifestRoot, '.trezi', 'tokens.json'),
  JSON.stringify({
    colors: { text: '#111111', brand: '#2563eb' },
    spacing: { sm: '4px' },
    weight: { bold: '700', offscale: '250' }, // 250 fails the %100 inRange gate
    'opacity-group': { muted: '0.5' }
  })
)

// --- fixture B: CSS custom-property source ----------------------------------
const cssRoot = join(base, 'css-project')
mkdirSync(cssRoot, { recursive: true })
writeFileSync(
  join(cssRoot, 'theme.css'),
  ':root {\n  --color-text: #1a1a1a;\n  --space-sm: 4px;\n  --radius-card: 10px;\n}\n'
)

const edit = (over) => ({ source: 'x.tsx:1', prop: 'color', value: '', classes: [], ...over })

try {
  // --- resolveTokenRef: manifest source --------------------------------------

  // Valid pick, color: writes the manifest's literal value (no runtime var()
  // — a manifest token has no live reference to point at).
  {
    const r = await resolveTokenRef(
      manifestRoot,
      edit({ prop: 'color', token: { name: 'text', group: 'colors' } })
    )
    ok(r !== null, 'manifest color: valid pick resolves')
    eq(r?.ref, '#111111', 'manifest color: ref is the raw value')
    eq(r?.name, 'text', 'manifest color: name echoed')
    eq(r?.source, 'manifest', 'manifest color: source tag')
    eq(r?.value, '#111111', 'manifest color: value echoed')
  }

  // Valid pick, spacing → a different property family, same manifest.
  {
    const r = await resolveTokenRef(
      manifestRoot,
      edit({ prop: 'padding-top', token: { name: 'sm', group: 'spacing' } })
    )
    eq(r?.ref, '4px', 'manifest spacing: ref is the raw value')
  }

  // In-range font-weight (700, a multiple of 100 within 100-900) resolves.
  {
    const r = await resolveTokenRef(
      manifestRoot,
      edit({ prop: 'font-weight', token: { name: 'bold', group: 'weight' } })
    )
    ok(r !== null, 'font-weight 700 is in range')
    eq(r?.ref, '700', 'font-weight ref')
  }

  // Out-of-range font-weight (250 — not a multiple of 100) is REJECTED even
  // though its value shape ('number') is correct — the `inRange` gate.
  {
    const r = await resolveTokenRef(
      manifestRoot,
      edit({ prop: 'font-weight', token: { name: 'offscale', group: 'weight' } })
    )
    eq(r, null, 'font-weight 250 fails inRange — rejected despite matching kind')
  }

  // Value-SHAPE mismatch: a color token aimed at a length property. This is
  // the actual security boundary — a compromised/stale island claim must not
  // land a color where a length is expected.
  {
    const r = await resolveTokenRef(
      manifestRoot,
      edit({ prop: 'padding-top', token: { name: 'text', group: 'colors' } })
    )
    eq(r, null, 'color token rejected for a length-only property')
  }

  // Unknown token NAME within a real group.
  {
    const r = await resolveTokenRef(
      manifestRoot,
      edit({ prop: 'color', token: { name: 'does-not-exist', group: 'colors' } })
    )
    eq(r, null, 'unknown token name in a real group → null')
  }

  // GROUP mismatch: the name exists, but under a different group than claimed.
  {
    const r = await resolveTokenRef(
      manifestRoot,
      edit({ prop: 'color', token: { name: 'text', group: 'spacing' } })
    )
    eq(r, null, 'right name, wrong group → null (group lookup fails first)')
  }

  // Unrecognized group entirely.
  {
    const r = await resolveTokenRef(
      manifestRoot,
      edit({ prop: 'color', token: { name: 'text', group: 'nope' } })
    )
    eq(r, null, 'nonexistent group → null')
  }

  // Property with no PROP_TOKEN_RULES entry at all (the transition family is
  // deliberately absent — durations/easings aren't design tokens).
  {
    const r = await resolveTokenRef(
      manifestRoot,
      edit({ prop: 'transition-duration', token: { name: 'text', group: 'colors' } })
    )
    eq(r, null, 'a property with no token rule at all → null')
  }

  // Malformed / absent pick — no token, or a non-string name/group (what a
  // renderer bug or a hostile island message might send).
  {
    eq(
      await resolveTokenRef(manifestRoot, edit({ prop: 'color' })),
      null,
      'no token on the edit → null'
    )
    eq(
      await resolveTokenRef(
        manifestRoot,
        edit({ prop: 'color', token: { name: 1, group: 'colors' } })
      ),
      null,
      'non-string token.name → null'
    )
  }

  // --- resolveTokenRef: CSS source --------------------------------------------

  // Valid pick against a real custom property: this DOES have a live runtime
  // reference, so the write is `var(--name)`, not the resolved value.
  {
    const r = await resolveTokenRef(
      cssRoot,
      edit({ prop: 'color', token: { name: '--color-text', group: 'color' } })
    )
    ok(r !== null, 'css color: valid pick resolves')
    eq(r?.ref, 'var(--color-text)', 'css color: ref is a var() reference')
    eq(r?.source, 'css', 'css color: source tag')
    eq(r?.value, '#1a1a1a', 'css color: raw value still carried (for the prompt/preview)')
  }
  {
    const r = await resolveTokenRef(
      cssRoot,
      edit({ prop: 'border-radius', token: { name: '--radius-card', group: 'radius' } })
    )
    eq(r?.ref, 'var(--radius-card)', 'css radius: ref is a var() reference')
  }
  // Same value-shape gate applies on the CSS source too.
  {
    const r = await resolveTokenRef(
      cssRoot,
      edit({ prop: 'padding-top', token: { name: '--color-text', group: 'color' } })
    )
    eq(r, null, 'css: color token rejected for a length property')
  }

  // A project with tokens nowhere near the pick's root just doesn't resolve
  // (rather than throwing) — same "race, not a failure" contract as a token
  // that vanished between the pick and the commit.
  {
    const emptyRoot = join(base, 'no-tokens-here')
    mkdirSync(emptyRoot, { recursive: true })
    const r = await resolveTokenRef(
      emptyRoot,
      edit({ prop: 'color', token: { name: 'text', group: 'colors' } })
    )
    eq(r, null, 'a project with no detectable tokens resolves to null, not a throw')
  }

  // --- tokenClassRewrite (fully pure — no I/O) --------------------------------

  // No token → falls straight through to the plain value-based Tailwind rewrite.
  {
    const classList = 'flex p-2'
    const e = edit({ prop: 'padding', value: '13px' })
    eq(
      tokenClassRewrite(classList, e, null),
      rewriteClassList(classList, e.prop, e.value),
      'null token delegates to rewriteClassList'
    )
  }

  // A `tailwind`-sourced token: the class form is real (the token NAME is the
  // theme's scale key) — delegates to rewriteClassListToken.
  {
    const classList = 'flex text-gray-500'
    const e = edit({ prop: 'color' })
    const tok = { ref: 'brand-500', name: 'brand-500', source: 'tailwind', value: '#2563eb' }
    eq(
      tokenClassRewrite(classList, e, tok),
      rewriteClassListToken(classList, e.prop, tok.name),
      'tailwind-sourced token delegates to rewriteClassListToken'
    )
    ok(
      tokenClassRewrite(classList, e, tok) === 'flex text-brand-500',
      'tailwind rewrite lands the token class'
    )
  }

  // A `css`-sourced token has NO class form — must drop to S2 (splice the
  // var() reference into an inline style) rather than hard-coding the
  // resolved value into an arbitrary-value class like `text-[#1a1a1a]`.
  {
    const classList = 'flex text-gray-500'
    const e = edit({ prop: 'color' })
    const tok = { ref: 'var(--color-text)', name: '--color-text', source: 'css', value: '#1a1a1a' }
    eq(
      tokenClassRewrite(classList, e, tok),
      null,
      'css-sourced token has no class form — drops to S2'
    )
  }

  // Same for `manifest` — no scale-key class form either.
  {
    const classList = 'flex text-gray-500'
    const e = edit({ prop: 'color' })
    const tok = { ref: '#111111', name: 'text', source: 'manifest', value: '#111111' }
    eq(
      tokenClassRewrite(classList, e, tok),
      null,
      'manifest-sourced token has no class form — drops to S2'
    )
  }

  if (failed === 0) {
    console.log(
      'STYLE-TOKENS OK — manifest/css resolution, value-shape + inRange re-validation gates, ' +
        'unknown name/group rejection, tokenClassRewrite delegation by source'
    )
  } else {
    console.error(`STYLE-TOKENS: ${failed} assertion(s) failed`)
  }
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('STYLE-TOKENS FAILED:', err?.stack ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
