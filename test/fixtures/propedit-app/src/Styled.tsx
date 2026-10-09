// v10 Styles-tab fixtures: a Tailwind-utility-classed element (the S1
// class-rewrite target) and an inline-styled element (the S2 style-object
// merge target). index.html mirrors both with matching data-trezi-source stamps.
export function TwCard(): JSX.Element {
  return <div className="p-4 rounded-md">Padded box</div>
}

export function InlineCard(): JSX.Element {
  return <div style={{ padding: '8px' }}>Inline padded</div>
}

// v10 design tokens: the color is spelled as a LITERAL here, and it happens to
// equal `--color-text`'s value in src/theme.css — but nothing in this source
// references that variable, so the Styles tab must show the raw hex, NOT name
// the token (2026-07-31: this used to assert the opposite — the panel named
// the token from value coincidence alone, exactly the hallucination this
// fixture now guards against). Picking a token here must still replace the
// literal with a `var(--…)` reference — the WRITE path is unaffected, only
// naming an unproven value is.
export function TokenCard(): JSX.Element {
  return <div style={{ color: '#6c6c6c' }}>Token colored</div>
}

// v10 Custom Controls fixture (custom-controls.mjs): module constants a canned
// .trezi/control-panels.json anchors on with the 'literal' strategy. CustomCard
// USES them, so each write-through commit would repaint under a real dev
// server's HMR — the literal tier's whole preview story.
const DEMO_SCALE = 1.5
const DEMO_LABEL = 'Hello caption'
const DEMO_ALIGN = 'left'

export function CustomCard(): JSX.Element {
  return (
    <p style={{ opacity: DEMO_SCALE / 10, textAlign: DEMO_ALIGN as 'left' | 'center' | 'right' }}>
      {DEMO_LABEL}
    </p>
  )
}

// The S2-refusal fixture: no className, no style attribute — nothing for the
// ladder to extend. A style edit here must route to the agent rather than INVENT
// a `style={{…}}` prop, which would impose an inline-style convention on a
// project that may well keep its styles in a stylesheet. Kept LAST in the file
// so its arrival can't shift the line numbers the other stamps above pin to.
export function BareCard(): JSX.Element {
  return <div>Bare box</div>
}

// The PROVEN-token fixture: unlike TokenCard, this element's inline style IS a
// literal `var(--color-text)` reference — `el.style.getPropertyValue('color')`
// preserves that string unresolved (unlike `getComputedStyle`), so this is what
// should show the token chip. Kept LAST alongside BareCard for the same reason.
export function ProvenTokenCard(): JSX.Element {
  return <div style={{ color: 'var(--color-text)' }}>Proven token colored</div>
}
