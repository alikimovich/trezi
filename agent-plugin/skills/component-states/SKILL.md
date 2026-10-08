---
name: component-states
description: Build a scratch "states workbench" for one component so the user can switch between every state it can render (loading, empty, error, typical, long, permission, flags) in the Trezi preview. Only run when the user invokes it with /states, Show states or the element's … menu.
disable-model-invocation: true
---

# Component states workbench

Adapted for Trezi from the "state-machine" skill by Jakub Krehel
(github.com/jakubkrehel/skills), MIT licensed; see `LICENSE` in this folder.

The user picked one component. Build a scratch page that renders it in every
state it can be in, fed by fixtures, so they can step through the states in the
preview with Trezi's native switcher. The page is a design tool, not a feature:
it lives in one folder, never ships, and is removed by the user from Trezi.

## 1. Scope one component

- Use the component, file and source location Trezi gave you. If there is none,
  use the selected element; if nothing is selected, ask which component.
- Work on that one component. Do not build workbenches for its children or
  parents unless the user asks.

## 2. Find the states

Read the component and the data it receives. List each state the code already
handles, in the order a user meets them. Look at:

- **Data**: loading, empty, error, one item, typical, long or overflowing text,
  many items, partial or missing fields, stale or refreshing.
- **Account**: signed out, tier or plan, role, permission denied.
- **Feature**: flags on/off, limits reached, trials, disabled actions.
- **Interaction**: pending submit, success, validation errors, offline.

Then list states the design or product clearly needs but the code does not handle
yet as **missing**. Never invent UI for a missing state; show it on the workbench
as a labelled placeholder and mention it in your answer.

State ids are short kebab-case (`loading`, `empty`, `list`, `error`). Labels are
one or two words.

## 3. Build the route in one folder

Put everything in one new folder named for the route, e.g. `trezi-states/<component>`:

- Vite / static HTML: `trezi-states/<component>/index.html` plus a module next to it.
- Next.js App Router: `app/trezi-states/<component>/page.tsx` (not `_`-prefixed;
  Next treats `_folders` as private). Pages Router: `pages/trezi-states/<component>.tsx`
  plus a folder for its fixtures.
- Other routers: register one route under `/trezi-states/<component>`. Prefer a new
  route file the router picks up and record it in `seams` (below); if the route must
  be added to an existing file, add the fewest lines possible and do not list that
  file in `seams`.

Rules:

- Import the real component; never copy or fork it.
- Feed fixtures at the **data boundary**: the props, the query/loader result, the
  store or the fetch the component reads. Do not add a `state` prop or test flags
  to the component itself. If no boundary exists, add the smallest injectable seam
  (an optional prop or provider with the production default) and say so in your
  answer; it stays in the code after the workbench is removed. Ask before changing
  production code beyond that.
- Fixtures are plain local data in the folder: no network, no real accounts, no
  secrets, no real customer data. Loading states hold forever (a promise that never
  resolves) until the user switches away.
- Render at the component's production width (`width` in the manifest), centred.

## 4. The switcher contract

Trezi's native switcher (and the "All states" grid) drives the page through the URL.

- The current state is the `__state` query parameter. Missing or unknown means the
  first state.
- When Trezi switches, it replaces the URL with the new `__state` and dispatches a
  `trezi:state` event on `window` (`event.detail` is the id). Listen for it and for
  `popstate`, re-read `__state` and re-render without a reload, keeping scroll.
- Set `data-trezi-state="<id>"` on the workbench root after each render (`all`
  too); Trezi waits for it. Without it Trezi falls back to a full navigation.
- `__state=all` renders every state side by side, each in its own
  `<section data-trezi-state-frame="<id>">` with a small label, at `width`, wrapping
  onto rows. Each frame is a live render of the real component, not a picture.
- Trezi owns ←/→, 1-9 and H on the page; do not bind them.
- An in-page switcher is optional; if you add one, it must only change the URL.

## 5. Record the workbench

Write `trezi-workbench.json` in the folder. Trezi reads it to show the switcher,
the grid and the Workbenches list, and to remove the workbench later:

```json
{
  "version": 1,
  "component": "OrderList",
  "source": "src/components/OrderList.tsx:12",
  "route": "/trezi-states/order-list",
  "width": 420,
  "states": [{ "id": "loading", "label": "Loading" }, { "id": "empty", "label": "Empty" }],
  "missing": [{ "id": "error", "label": "Error", "note": "No error UI in the code" }],
  "seams": [],
  "fixtures": ["orderListFixtures"],
  "chat": "<the chat key Trezi gave you>"
}
```

`states` are in switcher order. `seams` lists repo-relative files outside the folder
that you **created** only for the workbench; removing the workbench moves them to
the Trash with the folder, so never list a file that existed before. `fixtures`
lists exported identifiers Trezi searches for after removal, along with the route
and the folder, so lines you added to existing files show up as leftovers.

## 6. Verify every state

1. Call `land_now` so the files reach the user's preview within this turn.
2. `open_preview` the route with `?__state=<first id>`.
3. For each state: `open_preview` with that `__state`, then `preview_screenshot`
   (and `preview_evaluate` when useful). Check that it renders the fixture data:
   not blank, not an error overlay, not real data. Fix and re-check.
4. Open `?__state=all` once and check that every frame is present.
5. Leave the preview on the first state and list the states (and missing ones) in
   your answer.

## 7. Afterwards

- After any visual change to the component while a workbench exists, re-check all
  states (open `?__state=all` and screenshot) before you finish, and say which
  states changed.
- Never delete the workbench yourself. The user removes it from Trezi's preview
  "…" menu (Workbenches), which deletes the folder and seams and searches for
  leftovers. Publish warns while one exists.
