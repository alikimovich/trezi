/** Shared by provider instructions and the on-demand tool catalog. */
export const chatIslandGuidance = [
  'For Shadow Light use one shadow block with output css or tailwind and exactly eight literal bindings in order: x, y, distance, blur, layers, decay, color, output. The first six are number fields with bounds [-1,1], [-1,1], [0,64], [0,80], [1,8], [0,1]; layers step is 1. Color is rgba text (kind color). The last binding is kind text pointing immediately before the actual boxShadow string or full Tailwind className string. It is a derived, read-only output; Trezi updates it atomically with the seven input literals. Prepare separate input constants in the same file, and an existing literal output consumed by the rendered element. Do not recompute or overwrite that output in project code. The block renders the approved Shadow Light preview, light point, numeric controls, color and CSS readout.',
  'For requests to surface existing controls, read the relevant implementation, prepare a small binding set and call define with engine auto promptly. Jev selects/orders prepared blocks; it does not inspect source or implement effects. Do not add new effect variants unless explicitly requested. If no source changes are needed, avoid unrelated refactors and redundant full builds; obey required project checks when code changes. Define controls before long checks so the pending panel is visible.',
  'Choose controls by the meaning of the implemented value, not its name alone. Read how each value reaches the rendered style, animation or canvas loop; extract literals only when necessary and preserve existing behavior.',
  'Use bounded number fields with explicit units and useful steps for scalar values; integer steps for counts and pixel blocks, fractional steps for opacity or smoothing. Use toggle for booleans, select for implemented alternatives, and text/color for strings/colors.',
  'Use a point only for two meaningfully related bounded numbers, such as light direction or position. Group by user purpose (geometry, trail, response), keep coupled bindings together, and expose a small useful set rather than every constant.',
  'Use bezier only for an actual cubic-Bezier timing curve; pair it with existing duration/delay fields. A numeric smoothing coefficient called easing stays a number. Springs use grouped fields for the current engine’s actual time/bounce OR stiffness/damping/mass; do not invent a spring or switch engines to surface controls.',
  'Trace derived values and captured state: edits must recompute generated curves and reach running effects, including canvas loops and closures. An unused constant or a parameter behind a stale precomputed curve is not a working control.',
  'For transient effects provide a repeatable trigger. Enable Replay only after wiring trezi:animation-replay with the component name as event detail; restart only that effect and clean up listeners on unmount/HMR. Preserve unrelated state and reduced-motion behavior.',
  'Verify a representative adjustment per independent effect changes the actual preview, then Undo restores it and source values survive reload. Worktree edits are not visible until landing; if verification cannot run yet, report it as pending rather than claiming controls work.',
  'Gestures use throttled source writes and project HMR, not a runtime preview adapter; only a shadow block previews its derived box-shadow on the element while dragging and writes on release. Color is validated text; springs are groups. Nested folders, image pickers, saved comparisons, timelines and spring-mode switching are not supported. Use supported fields or explain the required follow-up; keep controls native inside chat.'
].join('\n')

export const chatIslandControlPurposes = {
  number:
    'Scalar magnitude: radius, spacing, duration, opacity or smoothing; specify units/range/step.',
  toggle: 'Existing binary behavior, such as enabling a trail.',
  select: 'Existing discrete alternatives, such as shape or layout.',
  text: 'Editable strings and labels.',
  color: 'Color literal, currently edited as validated text.',
  bezier: 'Actual cubic-Bezier timing curve, with related duration/delay in its group.',
  group: 'Related controls; springs use the actual engine’s parameters together.',
  shadow:
    'Shadow Light: seven inputs plus a derived CSS or Tailwind literal output, kept together.',
  point: 'Two related bounded numbers edited together, such as light x/y.'
}
