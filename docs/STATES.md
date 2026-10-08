# Component states workbench (LKM-207)

A states workbench is a scratch page that renders one component in every state it
can be in (loading, empty, error, typical, long, permission, flags), fed by local
fixtures, so a designer can step through the states in the preview. The agent
builds it with the bundled `component-states` skill; Trezi switches, lays out and
removes it.

The skill is adapted from the "state-machine" skill by Jakub Krehel
(github.com/jakubkrehel/skills), MIT licensed. The notice is
`agent-plugin/skills/component-states/LICENSE`.

## Invocation (user only)

- Composer: `/states` (the portable command; `src/main/bundled-skills.ts`).
- The selected element's toolbar: Show states (the 2×2 grid icon,
  `src/preview/preload.ts`), handled in `src/native/inspector-runtime.ts`.
- The selected element's … menu: Show states… (`src/native/inspector-controller.ts`).

Both element entries send `showStatesText` (`src/shared/states-workbench.ts`): `/states`,
the selection description (component, file and source location) and the instance
location. A `/states` turn also gets the chat key (`statesContext`), which the agent
records in the manifest. The skill has `disable-model-invocation: true`, so the model
never starts it on its own.

## What the agent leaves

One folder (e.g. `trezi-states/order-list/`, or `app/trezi-states/order-list/` in a
Next.js app) holding the route, its fixtures and `trezi-workbench.json`:

| Field | Meaning |
| --- | --- |
| `component`, `source` | The component and its source location |
| `route` | The page path, e.g. `/trezi-states/order-list` |
| `width` | Production width the states render at |
| `states` | `{id, label, note?}` in switcher order |
| `missing` | States the design needs but the code lacks (struck through on the switcher) |
| `seams` | Files outside the folder created only for the workbench (removed with it) |
| `fixtures` | Exported fixture names searched for after removal |
| `chat` | The chat that created it |

The manifest is the record: Trezi scans the live checkout read-only for it
(`scanWorkbenches`, `src/main/states-workbench.ts`, bounded, skipping dot folders and
generated trees). There is no separate store.

## Switching

The URL is the source of truth: `__state=<id>` is the shown state, `__state=all` the
grid. On a recorded route:

- The States island (`src/native/StatesSwitcher.swift`, bottom centre of the preview)
  lists the states, the missing ones, All and Hide. Clicks go to Bun as
  `states-action` (`src/native/states-controller.ts`).
- The preload (`src/preview/states-switch.ts`) takes ←/→ (wrapping), 1-9 and H while
  no Trezi mode owns the keyboard. A switch does `history.replaceState` with the new
  `__state` and dispatches `trezi:state` on `window`; the page re-renders without a
  reload and sets `data-trezi-state`, and the scroll position is kept. A page that
  does not mark the state within 600 ms gets a plain navigation, so pages without the
  listener, and in-page switchers that only change the URL, still work.
- H (trusted key presses only) or the island's eye button hide the island for
  screenshots; pressing again shows it.

## All states

`__state=all` is rendered by the page itself: one `<section data-trezi-state-frame>`
per state, each a live render of the real component at `width`. It stays in the one
preview WebKit view, so selection, the editing island and the agent's preview tools
work on every frame.

## Workbenches and removal

The preview toolbar's … menu gains Workbenches (only while the project has one), with
Open and Remove Workbench… per workbench. Remove always asks first, then the Swift
source owner's `removeWorkbench` moves the folder and its seams to the Trash in one
step (`src/service/SourceStore.swift`): the folder must hold a regular
`trezi-workbench.json` and seams must be regular files outside it. Trezi then
searches text files for the route, folder and fixture names and reports what still
refers to them in the activity log. Nothing removes a workbench without a user
action; the skill tells the agent never to delete one.

Publish warns while a workbench exists (`beforePublish`, `src/native/git-controller.ts`):
Cancel, Publish Anyway, or Remove and Publish. With no workbench the check is
synchronous, so Publish still shows progress on the click.

## Tests

- `test/states-workbench.mjs` (unit): manifest parsing, URL matching, scans and
  leftovers, the controller's actions and the Publish warning with a real sheet and
  Git controller.
- `test/source-owner.mjs`: `removeWorkbench` refusals and success.
- Native core smoke `states-workbench` (`src/native/smoke-states-workbench.ts`): a
  React fixture with loading/empty/list states; route detection, key and island
  switching in place, the All grid, Hide, and Remove from the … menu leaving no
  references.
