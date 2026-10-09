---
name: color-scales
description: Generate perceptually-even color ramps (tints/shades) and token palettes from a seed color using OKLCH. Use whenever you build a color system, need the shades of a brand color (50–950 / 1–12 steps), create design tokens for color, or the user asks for a palette, color scale, or lighter/darker variants of a color. Pairs with contrast checking to pick accessible pairs.
---

# Color scales in Trezi

When you need shades and tints of a color — a brand ramp, a gray scale, a token
palette — use the `color_scale` tool instead of hand-picking hex values. Eyeballed
ramps drift in hue and step unevenly in perceived lightness. `color_scale` walks
lightness in **OKLCH** (a perceptually-uniform space) at constant hue and
gamut-maps every step to valid sRGB, so the ramp looks even and stays on-hue.

## Using `color_scale`

- `seed` — any hex; the ramp is built around its hue.
- `steps` — default 12 (Radix-style; step 1 = lightest, N = darkest). Use 11 or 12
  for a full UI scale, fewer for a simple tint set.
- `hueShift` — rotate the hue (e.g. for a warm/cool variant or a secondary ramp).
- `lightnessRange` — `[darkestL, lightestL]` in OKLCH lightness 0..1 (default
  `[0.18, 0.98]`).
- `format` — `hex-list` (default), `css-vars` (`--color-1..N`), or `tailwind`
  (`50..950` keys for a `@theme`/config).

## Applying it well

- **Verify text pairs with `check_contrast`.** A perceptually-even ramp is not
  automatically accessible — before using a step for text on another step, run the
  pair through `check_contrast` (APCA) at the real font size/weight, and use its
  suggestion if it fails. A common pattern: body text on step ~11–12 over step ~1–2.
- Generate the ramp once and reference the steps as tokens; don't invent one-off
  hexes elsewhere in the UI.
- For a multi-hue system (primary/secondary/accent + neutrals), generate one ramp
  per hue with the same `steps` so they stay aligned.
- Dark mode: generate with the same seed and read the scale from the dark end, or
  regenerate with an adjusted `lightnessRange`.
