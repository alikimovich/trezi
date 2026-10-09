---
name: spring-animations
description: Build spring / bouncy / physics-based UI animations that run on the compositor. Use whenever the user asks for a spring, bouncy, springy, elastic, or physics-based motion, gives spring parameters (stiffness/damping/mass, damping-ratio + frequency, or Framer-style bounce + duration), or wants a natural-feeling open/close, slide, pop, or bottom-sheet animation in CSS.
---

# Spring animations in Trezi

When the user wants a spring, bouncy, or physics-based motion, do **not** hand-write
`linear()` control points or guess a `cubic-bezier` — you can't integrate a spring
accurately in your head. Call the `spring_to_css` tool. It returns the exact easing
and duration for a mass-spring-damper, so the motion runs on the compositor as a
normal `transition` / `@keyframes` instead of a per-frame JS loop.

## Using `spring_to_css`

Describe the spring any one of these ways (plus optional `mass`, default 1):

- **Physical** — `stiffness` + `damping` (what react-spring / RN Animated use).
- **Feel** — `dampingRatio` (ζ: `<1` bounces, `1` critical, `>1` no overshoot) + `frequencyHz`.
- **Framer-style** — `bounce` (~0–1, higher = bouncier) + `durationMs`.
- **Preset** — `preset` (e.g. `ios`, `ios-wobbly`, `material`, `bouncy`, `snappy`, `smooth`).

Output knobs: `format` (`transition` | `linear` | `css-vars` | `keyframes` | `json`,
default `transition`), `property` (default `transform`), and `simplify` (an RDP
tolerance like `0.001` to trim long curves).

The result already carries the duration — paste it as-is. Example result for a
transition:

```css
.sheet {
  transition: transform 520ms linear(0, 0.02, 0.09, /* … */ 1.03, /* … */ 1);
}
```

## Applying it correctly

1. **Compositor-only properties.** Prefer `transform` and `opacity` — they're the only
   cheap ones. The tool warns when you pass anything else (`width`, `top`, `box-shadow`
   run on the main thread and can jank). Reach for `transform` (translate/scale) instead.
2. **Trigger pattern.** Set the start state with `transition: none`, force a reflow /
   wait one frame, then set the end state **with** the transition so the browser traces
   the spring curve. For enter animations, `@keyframes` (the `keyframes` format) avoids
   the reflow dance.
3. **Overshoot is real.** Underdamped springs (ζ<1) produce control points `>1` — that's
   the bounce, keep it. The curve always lands exactly on `1`.
4. **Reduced motion.** Wrap the transition in `@media (prefers-reduced-motion: reduce)`
   to disable it (duration 0 / no transition).
5. **Browser support.** `linear()` needs Chrome/Edge 113+, Firefox 112+, Safari 17.2+;
   older browsers ignore it and fall back to `ease` (still animates).
6. **Rest start only.** A single static easing assumes the element starts at rest. For
   drag-release / interrupted, velocity-carrying gestures, keep the motion in JS.

## Making it tweakable

For interactive animation controls, follow the sibling
[surface-controls skill](../surface-controls/SKILL.md) and use `chat_island`.
Sliders, inputs and easing editors belong inside the conversation. Bind them to
parameters that update the actual spring, including regenerating any derived
curve. Keep an existing runtime spring engine when the app already has one.
