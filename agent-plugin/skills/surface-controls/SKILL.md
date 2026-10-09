---
name: surface-controls
description: Generate interactive controls inside the Trezi chat for animations, shadows, typography, styling and component values. Use when asked to show, expose, add or surface editing or tuning controls. Excludes controls intended for the target app's end users.
---

# Surface controls inside chat

Requested controls must appear as an interactive island in the conversation.
Use `chat_island`; do not open a separate inspector panel or install a
control-panel dependency in the target project. Selection is optional context.

## Keep the path short

For existing controls, inspect only the relevant implementation and define a small
useful panel promptly, before lengthy checks. Jev arranges prepared bindings; it
does not inspect source or implement effects. Do not add effect variants unless
the user asked for them. A controls-only definition without source edits does not
need unrelated refactors or redundant production builds. Follow required project
checks when changing code. Pending controls are visible while Jev arranges them;
source writes stay disabled until the turn lands.

## Inspect and bind

1. Call `chat_island` with `action: "catalog"`. Apply its `guidance` and
   `controlPurposes`; they are the current control-selection and verification rules.
2. Read the implementation. Preserve its behavior and reuse existing tunable
   constants. If necessary, extract clean literals in one source file and wire
   them into the actual implementation. Do not invent unused parameters.
3. Prepare `manifest` with file, component, title and literal params, and `blocks`
   with id, title, kind and parameter IDs. A group bundles related fields; a point
   takes exactly two bounded numbers for x/y. Parameters must have unique anchors
   ending immediately before their values, e.g. `const SHADOW_ELEVATION = `.
4. Call `chat_island` with `action: "define"`, the manifest/blocks, `engine: "auto"`
   and the user's original request as `prompt`. Require a successful result with
   an island ID. The host attaches it to this chat and enables it after landing.

## Match the implementation

- Choose by meaning: numeric smoothing named “easing” stays a number; a real
  cubic-Bézier timing function gets a Bézier editor with duration/delay fields.
- Give scalars useful units, ranges and steps. Counts/pixel blocks use integers;
  opacity and coefficients use fractions. Use selects only for implemented choices.
- Springs expose the current engine's actual time/bounce or stiffness/damping/mass
  together. Derived curves must regenerate when their parameters change.
- A point combines related numbers (light direction, position), not arbitrary
  scalars. Group by purpose, such as geometry, trail and response. Keep coupled
  values in one block so Jev cannot separate them.
- Trace each binding through styles/rendering, derived values and captured state
  into the running effect, including canvas loops. An unused constant is not a
  working control. For shadows, light coordinates must drive the shadow function.
- Use only the returned catalog. Color is currently text entry; springs are
  groups. Rich spring/color editors, nested folders, image pickers, comparisons
  and timelines require further implementation; do not promise them as available.

Keep all controls in Trezi. Do not add motion, change animation engines or alter
reduced-motion behavior unless requested. Never write `.trezi/` yourself.

## Updates, Replay and verification

Use `action: "read"` to inspect existing islands, then pass the returned `id` and
`revision` when updating one. Preserve compatible parameter IDs and current values.
Jev selects and orders prepared blocks. Missing Gateway credentials retain the
prepared layout and report `engine: "agent"` plus a fallback reason. Report the
actual engine; network/authentication/invalid-output errors require repair or retry.

For Replay, wire a `trezi:animation-replay` CustomEvent listener whose detail
matches this component; preserve unrelated state and clean it up on unmount/HMR.
Then set manifest presentation to animation and replay to true. Omit Replay when
no valid target exists.

Sliders, points and curves write source at throttled intervals during dragging,
plus the final value on release; project HMR/reload supplies preview feedback.
This is not a runtime adapter and gestures do not call a model.
Verify a representative adjustment for each independent effect on the actual
preview, Undo, and persistence after reload. A file diff alone does not prove
reactivity. When worktree landing or available observation tools prevent that
check, never report it as passed and never leave it as an ownerless "pending": Trezi checks the
preview after landing by itself, and anything else is a concrete user action you name (e.g. "Drag
the Blur slider and check the card's shadow"). Source created in a worktree waits
for successful landing; parked/failed changes do not activate. If this provider
lacks `chat_island`, explain that limitation rather than invoking an older panel
tool. Trezi owns the dev server; do not start another server.
