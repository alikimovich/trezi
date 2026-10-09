---
name: fluid-typography
description: Build responsive (fluid) font-size and spacing that scales smoothly with the viewport using CSS clamp(). Use whenever you set a font-size, spacing, or gap that should grow between small and large screens, or the user asks for responsive/fluid type, a type scale, or spacing that adapts to screen size. Also use to generate a whole fluid type or spacing scale.
---

# Fluid typography & spacing in Trezi

When a size should scale smoothly with the viewport (instead of jumping at
breakpoints), use the `fluid_clamp` tool rather than hand-writing the `clamp()`.
The middle `calc()` term of a fluid clamp is a two-point solve in mixed `rem`/`vw`
units — easy to get subtly wrong so the text is the wrong size on real devices.
The tool computes it exactly and reports the verified size at each endpoint.

## Using `fluid_clamp`

- **One value:** `minPx` (size on small screens) + `maxPx` (size on large screens).
  Optional `minViewportPx` (default 320) / `maxViewportPx` (default 1280).
  → e.g. `fluid_clamp({minPx: 32, maxPx: 64})` → `clamp(2rem, 1.14rem + 2.86vw, 4rem)`.
- **A whole scale:** pass `scale: { baseMinPx, baseMaxPx, ratioMin, ratioMax, stepsUp, stepsDown }`
  to get every step of a modular type/space scale as its own fluid clamp. Using a
  *smaller* `ratioMin` than `ratioMax` (e.g. 1.2 vs 1.25) is the standard trick — a
  tighter scale on mobile, more dramatic on desktop.
- `format: "css-vars"` emits a `--step-*` custom-property block ready to paste.

## Applying it well

- Output is **rem-based on purpose** — it keeps responding when a user zooms text
  (a purely `vw` fluid size fails WCAG 1.4.4). Don't convert it back to `px`/`vw`-only.
- Use it for headings, body copy, section padding, and gaps — anywhere a fixed px
  value would feel too big on mobile or too small on a wide monitor.
- Pair it with a real type scale: pick a base body size (e.g. 16→18px) and a ratio,
  and let the `scale` mode generate the heading sizes rather than picking them ad hoc.
- The tool warns when `minPx` is below the root size — a very small floor can hurt
  readability. Heed it for body text.
