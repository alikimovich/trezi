---
name: depth-shadows
description: Generate realistic, layered CSS box-shadows and elevation scales. Use whenever you add a shadow, elevation, or depth to a card, popover, dropdown, modal, button, or any raised surface, or the user asks for a nicer/softer/more realistic shadow or a shadow/elevation token system. Avoids the flat single-layer shadow that reads as AI-generated.
---

# Depth & shadows in Trezi

A realistic cast shadow is never one `box-shadow` — it's several stacked layers
whose offset and blur grow while opacity fades, all sharing one light-source angle.
A single flat `0 4px 6px rgba(0,0,0,.1)` is a giveaway of low-effort/AI UI. Use the
`layered_shadow` tool to derive the correlated multi-layer stack from one elevation
number.

## Using `layered_shadow`

- **One shadow:** `elevation` (0 = flush, larger = more raised; ~0..24). Higher
  elevation → larger, softer, slightly darker shadow.
- **A scale:** `scale: true` (+ optional `levels`, default 5) → a coherent set of
  elevation tokens (all sharing the same light angle, so they read as one light).
- Tunables: `layers` (default 5), `lightAngleDeg` (default 180 = light from top →
  shadow cast downward), `colorRgb` (default black — tint it toward the surface's
  hue for a richer look), `baseAlpha` (default 0.12).
- `format: "css-vars"` emits `--shadow-*` custom properties.

## Applying it well

- Keep **one light angle** across the whole UI — generate a `scale` once and use its
  tokens (`sm`, `md`, `lg`, …) rather than ad-hoc per-component shadows, so every
  raised surface agrees on where the light is.
- Map elevation to meaning: resting cards low, hovered/active higher, popovers and
  modals highest. Raise on hover by swapping to the next token.
- Slightly **tinted** shadows (a dark version of the background hue, via `colorRgb`)
  look more natural than pure black on colored surfaces.
- On dark backgrounds, shadows read weakly — lean on higher elevation, borders, or a
  subtle light top-edge instead of only shadow.
