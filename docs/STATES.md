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

## Going back and returning (LKM-220)

Trezi remembers, per workbench, the page it was opened from (URL, title, scroll and the
selected instance's Layers fingerprint), the state last viewed and the chat that made
it (`src/native/states-memory.ts`, pure helpers in `src/shared/states-records.ts`). The
records live in the `trezi:states-workbenches:v1` preference, keyed by project root
then folder, so they survive restarts; every scan prunes the records of folders that
no longer hold a manifest. The manifest stays the agent's record.

- Show states records the page and selection, and the next new workbench in that
  project (its manifest source file holds the selection, or it was not in the
  previous scan) takes them and the chat, for up to an hour. A workbench reached any
  other way gets the previous non-workbench page as its origin.
- Show states on an element whose component already has a workbench (the instance it
  was opened from, else the manifest's source file) opens that workbench at its last
  state instead of asking the agent.
- The island's "← Back to <page>" steps preview history back when the entry behind is
  that page (the `statesBack` host request, `PreviewHistory.back(to:)`), so ⌘] returns
  to the workbench; otherwise it loads the page and restores its scroll. Either way
  the instance is selected again by Layers fingerprint once the page is up (6 s at
  most).
- Preview ports change between runs, so the stored URL's path, query and hash are
  rebased onto the preview's current origin before Back loads or compares them
  (`rebaseUrl`).
- The island's Continue in Chat focuses the creating chat when it is still open, else
  opens a new chat with a `#states-<folder>` chip; sending describes the workbench
  (`workbenchReferenceText`).

## Workbenches and removal

The toolbar shows "States N" beside the branch under the address while the project has
workbenches (`src/native/ToolbarStates.swift`). Each workbench's submenu names where it
came from, its chat and last state, then Open (at the last state), Open All States,
Continue in Chat, Rebuild States (a `/states` turn in its chat that updates the same
folder and route) and Remove Workbench…. Remove always asks first, then the Swift
source owner's `removeWorkbench` moves the folder and its seams to the Trash in one
step (`src/service/SourceStore.swift`): the folder must hold a regular
`trezi-workbench.json` and seams must be regular files outside it. Trezi then
searches text files for the route, folder and fixture names and reports what still
refers to them in the activity log. Nothing removes a workbench without a user
action; the skill tells the agent never to delete one.

Publish warns while a workbench exists (`beforePublish`, `src/native/git-controller.ts`):
Cancel, Open Workbench (opens the first one, no publish), Publish Anyway, or Remove and
Publish. Four buttons do not fit one row of the alert, so `SheetAlert.swift` stacks
them, the default on top. With no workbench the check is synchronous, so Publish still
shows progress on the click.

The per-project workbench list is cached (that is what keeps Publish synchronous) and
rescanned when it may have changed: on a preview path change, on a same-path load while
no cached workbench matches the URL (at most every 1.5 s), when a turn lands in the
project (`src/native/states-install.ts`, any project, open or not), and after a Remove.

## Tests

- `test/states-workbench.mjs` (unit): manifest parsing, URL matching, scans and
  leftovers, the controller's actions and the Publish warning with a real sheet and
  Git controller.
- `test/states-return.mjs` (unit, LKM-220): records (validation, persistence across
  controllers, pruning), Show states reuse, Back by history or load with scroll and
  selection, Continue in Chat, Rebuild and the workbench chip.
- `test/source-owner.mjs`: `removeWorkbench` refusals and success.
- Native core smoke `states-workbench` (`src/native/smoke-states-workbench.ts`): a
  React fixture with loading/empty/list states; Show states on the fixture's title
  opens it, route detection, key and island switching in place, the All grid, Hide,
  Back to the same page with the title selected (⌘] available), the States menu and
  Show states reopening at the last state, the preference record, the Publish
  warning's Open Workbench, and Remove from the States menu leaving no references
  and no record.
