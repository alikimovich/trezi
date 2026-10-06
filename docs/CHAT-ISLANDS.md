# On-demand interactive islands in native chat

Status: first working slice implemented, 2026-09-25. The target design and remaining
stages follow below; the current implementation is deliberately bounded.

## Implemented slice

- Claude/Codex/custom endpoints expose `chat_island` catalog/define/read. Background
  children cannot create islands. Agent-prepared groups and 2D points render in
  SwiftUI inside the originating assistant turn, with standard fields and Bézier
  handles/presets. Springs use grouped parameters for the project's actual engine.
- Jev selects and orders whole prepared blocks via the installed json-render
  evaluator. The coding agent determines group membership. Arbitrary nested layout
  and Jev-generated regrouping are not implemented yet. Missing credentials retain
  the prepared layout and report the actual agent engine.
- Up to 12 literal fields in one source file; points batch x/y into one queued,
  revision-checked write and undo group. Reset, Reload and instrumented Replay are
  supported. Sliders, points and curves write at most once per 120 ms during dragging,
  plus the final value on release; project HMR/reload updates the website. Pending
  writes run in order, and one gesture remains one Undo step. A Shadow block's
  drag frames are the exception (LKM-140). Each frame's derived box-shadow is
  shown as a temporary override in the preview's isolated world. The source is
  written once, on release or after 600 ms idle. The override is removed only
  after the page's own style shows that value.
- Profile-owned records attach to a durable session record and user-turn ordinal,
  independent of regenerated message IDs. Revisions update the same island. A
  pending replacement disables that island until landing; keeping the previous
  usable revision during this wait remains follow-up work. Undo history is
  in-memory and is not restored across app launches.
- Provider-only next-turn context includes committed values; ordinary gestures do
  not call models. Closed/stopped chats and failed/parked turns cannot activate a
  pending island. Source drift requires Reload; unsupported literals require rebind.
- The shadow fixture verifies a 2D light control drives actual multilayer CSS
  shadows after source commit. Layer addition/removal remains an agent edit; a
  repeatable native collection editor is not implemented. Color currently uses
  validated text entry, not a native color picker. Curve motion samples, specialized
  spring previews, row/tab layouts and timelines remain follow-ups.

Validation: deterministic composition for tween/spring/combined/typography/shadow,
source/undo/conflict/history tests, MCP transport and Swift native integration.
Inspected the native island capture. Background integration passed with reduced
pointer/animation coverage. Full native integration passed the island checks but
later hit the existing style-inspector source-edit timeout. No live provider or
Jev network call was made; pointer dragging/IME/accessibility acceptance remains.

## Status, user control and references (LKM-181)

- **Binding check.** `checkBindings` (`src/main/chat-island-bindings.ts`) re-reads
  every binding on landing, after each write, on a file change (`layers:changed`,
  debounced 400 ms, active chat) and on `read`. A binding holds while its anchor
  occurs once in the file and a literal of the param's kind follows it, so moves
  inside the file are followed. A token (`var(--x)` replacing a literal), a variable,
  an expression, a second match or a removed declaration disables that field with
  one line ("Tint is now set by the token --brand; this control can't edit it.").
  A compound block (point, shadow) is disabled as a whole when any of its bindings
  breaks. Writes to a broken field are refused before touching the source.
- **Statuses.** The view's `status` is `waiting`, `ready`, `partially-disabled`,
  `disabled` (`disabledBy: code` or `user`) or `hidden`. The record keeps the
  lifecycle `status` (waiting/ready/unavailable, which the service still uses for
  admission) and adds `health`, `reason`, `reasons` (param → line) and `user`
  (`disabled`/`hidden`); Bun computes health and the Swift owner persists it
  (`islandHealth`), so a restart shows the same state before the first read. A
  turn that did not land shows as disabled with that reason. Island UI errors pass
  through `islandProblem`: Trezi's own one-line refusals pass, anything else
  (stacks, paths, errno codes) becomes a plain fallback line.
- **User control.** The header's … menu has Disable/Enable, Hide, Show all hidden
  islands and Copy reference (`islandMark`). User-disabled islands are read-only and
  collapse to their title row; Enable re-validates first. A hidden island is a
  one-line placeholder, "Hidden island: <title> — Show". A code-disabled island
  shows its reason with Recreate with agent (drafts a message naming it) and Hide.
- **References.** Every record has a stable short name (`island-<word>-<n>`, shown
  as `#island-shadow-2` in the header; older records are named by position). "#" in
  the composer lists the chat's islands, and Copy reference adds a chip whose name
  is prepended to the sent message. A message naming an island sends the agent its
  definition: title, file, blocks, params with anchors, values, status and reasons
  (`islandMessageContext`, `src/main/chat-island-context.ts`).
- **Agent ops.** `chat_island` adds `show {id}` (the same island moves to the end
  of the chat, `islandShow`; never-activated islands must be cloned) and
  `clone {id, rebind?}` (a new island through the normal define and landing path;
  `rebind.params` points broken params at new anchors, `rebind.file` moves every
  binding). `id` accepts the island id or its `#island-…` name. Defining over a
  broken binding is refused with the reason; the agent clones instead of redefining
  a disabled island in place.
- Tests: `test/chat-island-status.mjs`; the islands smoke group captures
  `chat-island-disabled.png` and `chat-island-hidden.png`
  (`src/native/smoke-island-status.ts`).


## Product outcome

The agent can respond with a purpose-built interactive island embedded in the
conversation. Its blocks, grouping and actions fit the user's request and the
project's actual capabilities. Jev chooses the composition from prepared native
blocks. Users interact directly, then use follow-up messages to revise the island.
Animation is the first application of a general chat capability.

Example conversation:

1. “Let me tune this entrance.” The agent discovers a position spring and an
   opacity tween. An island appears with separate spring and easing groups and
   shared Replay and Undo actions.
2. The user adjusts damping and opacity duration. The project changes without
   another model call for either adjustment.
3. “Expose the stagger between the items too.” The agent discovers or implements
   that parameter; Jev revises the existing island while preserving compatible
   controls and their current values.
4. Reopening the conversation restores the island and resolves current values
   from the project. A removed or changed source target becomes unavailable.

Success includes different compositions for a tween, a spring, and combined
animations, plus a typography example proving the protocol is not animation-only.
An island may contain text, inputs, visual editors, groups and actions together.
An inspector tab or one fixed animation card does not satisfy this goal.

## Responsibilities and implementation choice

```text
Coding agent: inspect code, expose parameters, prepare typed block candidates
    → Bun: validate capabilities and candidates
    → Jev: choose membership, grouping and order
    → Bun: validate and persist the resulting island
    → SwiftUI: render native blocks inline in the assistant message

Native interaction → Bun binding/action service → project edit or preview action
                                             → refreshed island state
```

Use the installed json-render core behind a Bun composition adapter. Keep the
persisted island protocol owned and versioned by Trezi: Swift should receive a
small normalized tree, not implement every json-render expression or directive.
Jev composes prepared candidates; it does not invent executable handlers, source
locations or unrestricted UI code. Candidate preparation includes meaningful
labels, limits, units, groups, alternatives and relationships.

Implement the native block registry in SwiftUI/AppKit. No island WebView or React
chat dependency. Trezi is now native-only: Electron/browser clients are retired.
Keep provider capability checks and useful text for unsupported history entries.
The implementation uses the Bun/Swift seam directly with no application WebView.

References for the intended interaction:

- [OpenUI chat](https://www.openui.com/chat?form_factor=desktop)
- [Jeverative UI](https://jeverative-ui.vercel.app)
- [Shapeshift demo](https://shapeshiftui.vercel.app)
- [Shapeshift source](https://github.com/anishfn/shapeshift): an example of intent
  choosing implemented cards; Trezi additionally needs composition within cards.
- [json-render](https://github.com/vercel-labs/json-render)

## Existing foundations and gaps

| Foundation | Reuse / required extension |
| --- | --- |
| `src/main/controls-jev.ts` | Existing bounded/cancellable Jev call selects a flat Panel → Control list. Add a separate nested composition adapter and verify the installed experimental API's grouping behavior. |
| `src/main/control-selection.ts` | Retain explicit engine reporting and missing-credential fallback behavior. |
| `src/main/control-manifest.ts`, `control-panels.ts` | Reuse literal validation, Bézier serialization and edit services; add revision-checked transactions and explicit retained targets where needed. |
| `src/main/chat-islands.ts` | Registers controls against worktree source and delivers islands to the originating chat turn. Legacy agent panel tools are retired. |
| `src/shared/native-chat.ts` | Add a typed island message segment and typed interaction payloads. Current text/tool segments and string-valued actions are insufficient. |
| `src/native/chat-controller.ts`, `chat-snapshot.ts`, `chat-state.ts` | Own lifecycle, pending state, message association, history rehydration and model-context summaries in Bun. |
| `src/native/Chat.swift` | Render island segments at their actual conversation position through a separate native registry. |

Extract reusable logic into focused modules. Keep the existing flat controls API
working while adding the new protocol. Do not make islands depend on the current
selection, a React store, or transient provider tool-output text.

## Protocol and state

Define shared TypeScript contracts and matching Swift decoding with cross-language
fixtures. Names below are proposed contracts, not existing APIs.

- `IslandSpec`: schema/catalog version, host-assigned ID, revision, title, root and
  bounded nodes. Each node has a stable ID, known block type, validated props,
  child references and opaque binding/action references.
- `IslandBinding`: a host-owned capability scoped to project and target identity,
  with value type, constraints, resolver, writer, source revision and availability.
  UI specs reference IDs; source locations remain in the validated service layer.
- `IslandAttachment`: session/message/turn association, spec revision and lifecycle
  (`composing`, `waiting-for-source`, `ready`, `unavailable`, `failed`).
- `IslandState`: committed values, transient drafts, field errors, pending gestures
  and operation acknowledgements. It is separate from the composition spec.
- `IslandInteraction`: session/island/node IDs, spec revision, operation/gesture ID,
  typed value, and phase (`begin`, `change`, `commit`, `cancel`) or named action.

Validate value kinds, finite numbers, ranges, node counts/depth, references, cycles,
action allowlists and ownership before activation. A compound editor may reference
several existing bindings. Shared parameters retain one binding even if displayed
in multiple places; aliases refresh together. Jev cannot substitute incompatible
controls or remove required dependencies from a chosen compound block.

Keep text-entry drafts and gesture feedback local in Swift while interacting;
Bun remains authoritative for committed values. Use acknowledgements/revisions so
late snapshots cannot reset a drag or overwrite newer input. Update affected nodes
without replacing focused controls or forcing chat to scroll on every change.

Persist versioned specs and message associations in native profile-owned storage,
coordinated with conversation history. Reuse existing project control manifests
where appropriate rather than creating a competing copy of source values. Audit
current history reconstruction: app-generated message IDs alone cannot be assumed
stable after provider history reload. Introduce durable turn/message mapping and
restore it without duplicate islands. Persist after creation and successful edits;
do not restore an unfinished drag as a source write. Unknown versions render a
readable unavailable entry with regeneration/recovery actions.

See [DialKit review and control-selection lessons](DIALKIT-REVIEW.md) for the
reference inventory, current gaps and recommended acceptance criteria.

## First native block catalog

| Block | Behavior |
| --- | --- |
| Group, row, text | Bounded composition, optional collapse, labels/help; narrow widths stack predictably. |
| Number / slider | Shared numeric binding, explicit units/range/step, keyboard entry and scrubbing. |
| Text, toggle, select, color | Typed values and inline validation. |
| Bézier editor | Draggable handles, named presets, numeric coordinates and a local motion sample. Reuse existing array/string serializers; constrain x coordinates to [0,1], allow supported y overshoot. |
| Spring editor | Compound controls selected from the library's actual parameterization; physics stiffness/damping/mass and duration/bounce remain distinct. A sample requires a matching adapter or an explicit illustrative label. |
| Point / vector | Two bounded numbers edited together; useful for light position and transforms. Implemented. |
| Repeatable groups | Future add/remove/reorder controls for shadow layers and other collections. |
| Action button | Validated Replay, Undo, Reset or agent-request action. Reset restores captured initial values as one undoable edit. |

Combined animations initially use labeled groups for targets/tracks and shared
parameters. Support exposed delay, stagger and overlap bindings. A full timeline,
keyframe editor, arbitrary code widgets and unrestricted layout generation are
later catalog additions. Changing animation models or restructuring a sequence
invokes an explicit agent edit and normal landing; it is not a scalar write.

## Interaction and source lifecycle

Resolve current values from source. First support validated literal bindings and
the existing Bézier shapes. Retain explicit source/element identity when adding
prop/style bindings; a changed selection must never redirect an old control.
Unsupported expressions ask the agent to expose a stable editable parameter.

All commits use the repository write queue and edit-history services. Check the
loaded source revision inside the write transaction, validate the whole batch,
and make a multi-binding gesture one undo unit. On drift, preserve the user's
draft and offer reload/rebind; never overwrite silently. Existing literal apply
helpers must be audited rather than assumed to provide this entire transaction.

Native value/curve feedback is immediate. Throttled source writes during a drag
and a final release write use project HMR; refresh speed depends on the project.
Shadow blocks are the exception: they preview through the override and write
at the end of the gesture. `src/main/island-overrides.ts` documents this; if the
preview cannot apply the override, the drag falls back to live writes.
Queued updates advance only through this batch’s own successful source revisions,
never through external edits. This is source-backed tuning, not a runtime adapter.
Add throttled ephemeral preview updates later for explicitly supported adapters;
clear overrides on cancel, navigation and source commit. Pointer-frequency events
never call Jev, the coding agent, or the filesystem.

Newly instrumented worktree targets remain pending until successful landing and
live-source resolution. Parked, failed or cancelled turns cannot enable them.
Existing valid targets may remain usable during unrelated agent work, subject to
the same queue and revision checks. On branch change or project reopening,
invalidate and re-resolve bindings. Closing a project cancels pending composition
and gestures; late events cannot act on a replacement project/session.

Reuse targeted animation replay where supported. If no replay capability exists,
omit/disable the action or offer an explicit instrumentation step. Undo refreshes
all affected surfaces. Replay alone does not write source.

## Agent tools and Jev behavior

Add tools to discover the supported block catalog, compose/update an island, and
read an existing island's state. Exact names should follow provider conventions.
The host supplies session/turn identity; tool arguments cannot redirect delivery.
Expose tools through supported provider seams and update the bundled controls
workflow guidance. Scope tools to native clients that advertise the capability.

Use Jev when configured to select prepared block alternatives and group structure.
First verify the installed API supports the required constraints. If nested output
is insufficient, use bounded typed decisions for block/group membership and order,
then deterministically assemble the same validated tree. This is a composition
adapter detail, not a reason to replace native rendering or upgrade dependencies
without validation. Make evaluator injection available for deterministic tests.

Reuse saved Gateway credential selection, cancellation, timeout and bounded input
policies. Missing credentials may use the coding agent's prepared valid layout
with an explicit fallback reason, consistent with current controls. Jev network,
malformed-output or timeout failures leave an existing island intact and offer
retry; never label another engine's result as Jev. Record the actual engine.

Updates keep island/binding IDs stable where semantics match. Merge against current
source values, preserving compatible drafts; conflicting revisions need explicit
resolution. Keep the previous usable spec until its replacement is fully valid.
Stream explanatory text and a composing placeholder initially; partial specs do
not activate actions. On the next agent turn include compact island IDs, current
committed values and recent edit summaries, not a message per pointer movement.

## Delivery sequence and exit checks

1. **Contracts and Jev composition spike.** Define versioned protocol, ownership,
   persistence design and native catalog. Prove tween, spring, combined animation
   and typography compositions with injected evaluators; separately exercise a
   real configured Jev call when authorized. Exit: nested composition and invalid
   result handling demonstrated against the installed dependency version.
2. **Inline native islands.** Implement message attachment, basic native registry,
   typed interactions, controller state and durable history mapping. Use fixtures
   to exercise layout, focus, scrolling, switching and restart before source writes.
   Exit: differently composed islands render and retain identity in real native chat.
3. **Source-backed interaction.** Connect literal/Bézier bindings, revision-checked
   batch edits, grouped Undo/Reset, Replay and landing availability. Exit: changing
   controls edits actual fixture source, HMR updates preview, and drift/concurrent
   edits cannot clobber source or redirect to another chat/project.
4. **On-demand agent → Jev → native flow.** Wire provider tools, credentials,
   composition/update lifecycle and compact model context. Exit: a natural request
   creates an island and a follow-up changes it without losing compatible state;
   missing keys, cancellation and malformed output have verified recovery paths.
5. **Animation editors and release acceptance.** Add native Bézier and compound
   spring editors, grouped multi-animation controls and a typography fixture.
   Exit: all four scenarios work through the same protocol, survive history restore
   and pass visible native interaction checks. This completes the initial feature.
6. **Later extensions.** Supported runtime preview adapters, precise retained
   prop/style bindings, timelines/keyframes, pinning/reopening islands outside chat,
   and additional client renderers. Each has its own capability and validation gate.

The workspace migration has completed. Use the typed Bun/Swift chat seam; no
React bridge should be introduced. Ship focused commits and update this plan and TASKS as each
exit check is met. The implemented slice spans the foundations of stages 1–4; remaining acceptance
work and catalog expansion are tracked in TASKS.

## Verification

Add meaningful pure tests for schema validation, composition constraints,
cross-language payloads, lifecycle/rehydration, version handling, stale gestures,
batch atomicity and repository conflicts. Register new tests in the appropriate
`test/run.mjs` tier. Use deterministic evaluators/providers in routine checks.

Run `bun run typecheck`, `bun run typecheck:native`, relevant pure tests and
`bun run test:native` for implementation slices. Native integration should verify
real source contents and undo results, history restore, pending/failed landing,
multiple sessions and no hidden React island. Inspect captured native PNGs.
Visible desktop checks must cover dragging, curve handles, keyboard navigation,
VoiceOver labels, IME, dark/light appearance and narrow-window layouts; background
checks that skip these are partial evidence. Validate text contrast using the
project's APCA workflow when choosing visual styles.

Do not run Electron suites for this native feature. Live provider/Jev tests are
separate, explicitly authorized checks; distinguish skipped calls from passed
coverage. Verify no model requests during ordinary control interaction. Measure
composition latency and interaction responsiveness before making performance claims.
