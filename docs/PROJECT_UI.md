# Experimental Gen UI

Settings → Experimental → **Gen UI** enables composition from existing React or Svelte
components and styles. The adjacent description reads: “Generate UI using your
project’s existing components and styles. Experimental; supports React and Svelte.”
It is off by default and saved on this device. A new message captures the current setting, including when queued.
An in-progress or already queued turn retains its captured setting. Turning it off
preserves generated files and returns subsequent messages to ordinary source editing.

With Claude or Codex (including Codex-backed custom endpoints), a UI request follows:

1. `project_ui_catalog` statically scans the chat's current worktree for exported
   React and Svelte components, their literal prop schemas, children support, and CSS tokens.
2. The agent reads source and usage examples to retain theme providers, layouts,
   fonts, styles and component conventions.
3. `compose_project_ui` validates a static json-render composition and returns React TSX or Svelte source
   importing the project's actual components. It does not write files.
4. The agent applies and integrates that source using ordinary editing tools.
   Existing permission checks, worktree landing, preview refresh and revert apply.

Both tools are gated in main by the destination chat's explicit turn option. The
setting crosses the native send bridge; it cannot enable a different
chat's tools. The default Chat model engine uses existing credentials. Other
providers receive a limitation notice instead of inaccessible tool instructions.

## Jev engine

When enabled, **UI layout method** offers **Chat model** (your selected chat
model arranges the components) and **Jev layout engine** (a separate layout model
requiring an AI Gateway API key). The field and its explanation are hidden while
Off, preserving the saved engine for the next time you enable it.
The engine is also saved per device and captured per submitted/queued message.
The normal chat model prepares atomic component candidates with concrete props and
copy; `typesafe-ai/jev` chooses membership, ordering and nesting through
json-render's experimental batch composer. It does not generate freeform source or
invent copy. Only a completed, validated tree is exported; errors or incomplete
results never silently fall back to the chat model.

Jev reuses the encrypted Vercel AI Gateway key saved in **Settings**. It prefers
this chat's selected Gateway connection; otherwise it uses the sole saved Gateway
connection. With multiple saved Gateways, select one for the chat. Custom endpoint
credentials are never reused. `JEV_AI_GATEWAY_API_KEY` explicitly overrides the
saved connection; `AI_GATEWAY_API_KEY` is a fallback when none is saved.
The Gateway credential is separate from a Codex/Claude subscription login. It stays in main; renderer state and tool results
never contain it. Requests send the UI prompt, prepared component descriptions and
candidate information to the Gateway. Do not place the credential in a target repo.
For development with an ignored, owner-only Trezi `.env.local`, Bun can explicitly
forward its loaded environment when launching, for example:

```sh
bun -e 'const p = Bun.spawn(["bun", "run", "dev"], {env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit"}); process.exit(await p.exited)'
```

Each tool invocation is limited to 24 candidates, 32 KB input, two evaluations,
25 seconds overall and 10 seconds per request, with no automatic retries. Stop
cancels an active composition. Core/codegen are pinned to 0.21.0 because the Jev
API is experimental. Turning the feature off disables both engines for later turns.

## Current scope

React `.tsx`/`.jsx` exports retain statically resolvable string, number, boolean and
literal-union props, default/named exports, and `children` composition.

Svelte discovery uses the installed Svelte 5 compiler (currently 5.56.4) and a
conservative TypeScript AST schema reader. It supports capitalized reusable
`.svelte` files with legacy `export let` props or one destructured Svelte 5
`$props()` declaration. String, finite number, boolean and literal-union types
are supported, as are primitive untyped defaults. Rune types may be inline or
local literal interfaces/type aliases; optional properties and defaults are
respected. Legacy default `<slot />` and Svelte 5 `children: Snippet` (or
`Snippet<[]>`, imported from `svelte`) support nested composition, including
optional `children?.()`. Required children must be supplied. Legacy syntax is
verified with the installed Svelte 5 compiler, not a separate Svelte 4 runtime.

SvelteKit route files are not reusable catalog components. Named slots, slot
props, parameterized/custom snippets, rest/nested props, dynamic `$$props` /
`$$restProps` / `$$slots`, imported/inherited/generic prop types, callbacks and
object adapters are rejected with a file-specific explanation. Custom
preprocessors are not loaded. Other frameworks are not supported by this path.
The schema reader intentionally does not reuse the prop editor's permissive
best-effort inference, which cannot prove a complete composition contract.

The reserved `Text` element emits escaped literal text without a wrapper.
Output is ordinary `.tsx` or `.svelte` with real project imports and no json-render
runtime dependency added to the target. Both engines validate the output extension
against every used component (Jev checks all candidates before evaluation); React
and Svelte cannot be mixed in one tree. Svelte output is compiler-checked before
being returned. Existing behavior still needs ordinary source integration.

Discovery is bounded to 3,000 entries, 150 source files, 40 components and seven
nested directory levels; it skips symlinks, hidden directories, dependencies,
build outputs and tests. It reads at most 12 stylesheets and 35 CSS declarations
per sheet. Limits and unsupported required props are reported. It does not execute
project source, infer a complete design system or automatically resolve every
imported/conditional prop type. React render props, dynamic JSON state/actions, and automatic server/client
boundary inference remain unsupported. Read actual
usage before placing a component in a server/client boundary.

Strict export checks reject unknown components/props, nonliteral values, invalid
variants, cycles, missing/shared/unreachable nodes, unsupported children, hidden or
escaping/dependency/build output paths (including existing symlink paths at the
tool boundary), and output replacing a component used by the composition.
Stale or cancelled turns cannot return late catalog/export results, even when
the next turn uses the same engine. The exporter returns an error for unsupported cases; the agent can explain the
limit and use ordinary editing. The on/off control is a generation preference,
not a restriction on the agent's existing general-purpose editing abilities.

## Verification

- `bun test/project-ui.mjs`: React discovery, real server rendering of Chat model
  and deterministic Jev output, strict specs,
  escaping, paths and per-chat gating.
- `bun test/project-ui-svelte.mjs`: legacy and rune component fixtures, strict
  unsupported-shape rejection, real compiled Svelte server rendering and source
  integration, mixed-framework rejection, offline deterministic Jev export,
  escaping, symlink paths and stale/cancelled results.
- `bun test/project-ui-jev.mjs`: offline real composer with a deterministic
  evaluator, candidate validation before requests, unavailable results and cancellation.
- `bun test/native-settings.mjs` and `bun test/native-chat-controller.mjs`:
  labels/help, conditional field metadata, autosave, saved engine preservation,
  in-flight and queued turn capture.

These checks require no paid provider calls. The manager owns native foreground
verification: inspect Settings at its minimum supported width and a wider size,
read all helper text, toggle Off/On, verify the engine disappears/reappears without
losing its saved choice, and verify autosave across close/reopen. No new native
capture or live-provider acceptance is claimed by the worker.

### Manager-owned native acceptance evidence

The configured verification reaches `checkVisibleSettings` through the existing
native core → sheets fixture. It uses ScreenCaptureKit foreground pixels and
Vision OCR, with no cacheDisplay fallback or background-mode skip. Test-only
host hooks require an ephemeral profile. Picker interactions dispatch the real
SwiftUI AppKit menu-item actions; the fixture never injects settings values.

Settings is one sidebar window (General, AI Providers, Experimental; LKM-121).
General and AI Providers are captured at the **live minimum (currently 680×420)**
and the **780×540 default size** as
`test/artifacts/native/settings-visible-{width}-{general|providers}.png`. The
Experimental pane is selected through the rendered source list; at the live
minimum, the **780-point default width** and the **960-point wider width**,
inspect each `test/artifacts/native/settings-visible-{width}-experimental-{state}.png`
and matching `.json`:

| State suffix | Required evidence |
| --- | --- |
| `off` | Default Off; complete Gen UI help; engine label, help and picker absent |
| `on-chat` | On; Chat model selected; complete engine explanation |
| `on-jev` | Jev selected through its native menu action |
| `off-preserved-jev` | Engine hidden while its saved value remains Jev |
| `reopened-off-jev` | Fresh window restores Off and saved Jev |
| `restored-on-jev` | On restores the visible Jev choice |
| `reopened-on-chat` | Immediate close after choosing Chat model flushes autosave |
| `reopened-off-chat` | Immediate close after Off restores Off and Chat model |

The current plan produces 28 PNG/JSON pairs. The interaction log records the
width plan derived from the live NSHostingController-managed window minimum.
Every reopen must return to the last selected section.
The JSON records foreground ownership, content/minimum size, the selected
section and source-list row, picker selected
labels, containment, hit targets, saved form values and OCR text. The fixture
requires all words of both visible explanations, rejects an engine rendered
while Off, and saves evidence before assertions. The action/reopen/capture trail
is `test/artifacts/native/settings-visible-interactions.json`. A fresh sheet ID
and unchanged values after close/reopen prove restoration from saved preferences.
Inspect PNGs for wrapping, clipping and overall readability in addition to the
automatic assertions. These new foreground captures are pending manager execution;
the worker does not claim to have observed them.

`bun test/native-settings-layout.mjs` verifies the actual SwiftUI pickers,
bindings, source-list selection, hidden controls, geometry and autosave emission
without displaying a window. It uses the same NSHostingController as production and
asserts its 680-point minimum and 680/780/960-point layouts.
`bun test/native-settings-evidence.mjs` injects missing text, wrong state,
clipping, occlusion and lost foreground into evidence and requires rejection.
Both are registered in the manager's unit tier.
