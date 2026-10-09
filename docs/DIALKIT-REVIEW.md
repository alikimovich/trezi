# DialKit lessons for Trezi

Reviewed 2026-09-25 against the current official [site](https://www.dialkit.dev/),
[README](https://github.com/joshpuckett/dialkit),
[API reference](https://github.com/joshpuckett/dialkit/blob/main/docs/reference.md)
and [timeline guide](https://github.com/joshpuckett/dialkit/blob/main/docs/timeline.md).
Inspected the site's rendered control examples and accessibility tree; this was
an inventory/design review, not an exhaustive interaction or performance test.
Upstream main is mutable; recheck the installed version before implementation.

## Control inventory and selection

The official site presents these controls. The purpose column is our guidance for
choosing controls in Trezi, not a claim that DialKit discovers bindings itself.

| Control | Use in Trezi |
| --- | --- |
| Slider / numeric input | A bounded scalar: radius, gap, opacity, scale, duration. |
| Toggle | A genuine binary choice, such as enabling a trail. |
| Text | Copy, labels and editable strings. |
| Select | Discrete supported alternatives: shape, layout, blend mode. |
| Color | Color and alpha; use a visual picker instead of raw text alone. |
| Image | Pick an asset or replace a photograph. |
| XY pad | Explore two related numbers together: light direction or an offset. |
| Spring | Tune a spring's time/bounce or stiffness/damping/mass. |
| Easing | Tune duration with a Bézier curve. |
| Action | Replay, reset or another explicitly connected behavior. |
| Folder | Keep related controls together; collapse secondary detail. |

Source: [official control examples](https://www.dialkit.dev/#api).

The reference adds useful interaction details: numeric keyboard editing, fine and
coarse adjustment, XY axis locking, step snapping and drag cancellation. Transition
modes preserve their previous edits while mounted. Versions support comparing
alternatives; controllers support programmatic updates and reset. Color support
includes alpha and wide-gamut formats; image controls accept supplied choices and
local files. These are documented capabilities, not all verified by interaction.
Source: [API reference](https://github.com/joshpuckett/dialkit/blob/main/docs/reference.md).

Timeline controls address a different task: organizing motion over time. Clips,
sequences and property tracks expose start times, durations and curves, with
playback, replay and scrubbing. True scrubbing binds sampled `current` values to
the interface. Endpoint animation bindings do not provide intermediate sampled
states. Spring samples are not guaranteed to match another runtime frame for
frame. Source: [timeline guide](https://github.com/joshpuckett/dialkit/blob/main/docs/timeline.md).

## Lessons to apply

These are Trezi recommendations derived from the review:

1. Choose by meaning, not by primitive type alone. A duration and a bounce amount
   belong together; unrelated numbers do not become an XY pad just because they
   can. Expose units, sensible bounds and useful precision from the actual code.
2. Confirm the complete path from control to visible behavior. DialKit's examples
   explicitly consume live values in rendering. A control definition alone does
   not make a website reactive. Trezi must verify the bound parameter reaches
   the running effect, including canvas loops and values captured by closures.
3. Preserve the project's animation model. Offer a spring editor only for real
   spring parameters, and a curve editor only for an actual timing curve. A
   smoothing coefficient named “easing” is still a scalar. Switching between
   physics and time models may require an agent source change and landing.
4. Give transient effects an explicit way to observe them again. Replay must
   target the actual effect; changing a constant may not retrigger an entrance.
5. Make exploration reversible. Keep gesture Undo, add named comparisons, preserve
   compatible edits when controls change, and support cancellation and keyboard
   operation. Test focus retention during incoming values.
6. Separate runtime feedback from source persistence when adding supported preview
   adapters. Current Trezi tuning writes source every 120 ms and depends on HMR.
   A future adapter should preview without restarting an effect on every sample,
   then persist a validated final value and remove temporary overrides. Preserve
   WebKit world isolation and host-owned scoped bindings.

## Current Trezi gaps and proposed order

Verified against `src/native/ChatIsland.swift`, `src/shared/chat-islands.ts` and
`src/main/chat-island-schema.ts`: basic fields, points and Bézier handles exist;
color is text entry, springs are numeric groups, groups are flat. Bindings are
literals in one file. There is no image field, version comparison, timeline or
general runtime adapter. The native UI should remain SwiftUI/AppKit.

Prioritize binding/replay verification and keyboard/cancel behavior; then compound
spring/easing editors, a native color picker, collapsible groups and comparisons.
Add image selection when a concrete content workflow needs it. Add runtime
adapters with a measured animation fixture before promising smooth scrubbing.
Defer timelines until timing and runtime capabilities can support them truthfully.
The selection and verification rules are now shared by the provider operating
instructions and chat-island catalog through `src/shared/chat-island-guidance.ts`;
the bundled surface-controls skill applies them. Richer editors remain follow-up
work. Guidance delivery is tested; model compliance is not a host guarantee.

## Applying this to the pixel-reveal example

Keep integer pixel controls for reveal radius and block size. Keep fringe opacity
bounded to 0–1. Inspect the algorithm before assigning units/ranges to persistence,
cursor follow and reveal easing: these may be coefficients, elapsed times or spring
parameters. Group geometry, trail appearance and response separately. Add a shape
selector only if shape alternatives exist, and a repeatable hover demonstration
only with explicit effect instrumentation. Do not invent a spring or Bézier binding
from a friendly label. Acceptance requires moving each control and observing the
actual reveal, then verifying Undo and persistence after reload.
