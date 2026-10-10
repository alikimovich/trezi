# Component states canvas (LKM-224)

`/states` is user-invoked. Show states on a selected element invokes the same
skill. Trezi renders the real component export in the existing visible preview
WebKit view, on a flat modal canvas. The original page remains mounted. Opening,
switching and closing do not navigate, change history or create project files.

## Recipe

The agent reads the selected component and registers a typed recipe with
`register_states_canvas`. A recipe names the existing project-relative source
module and export, production width, optional existing provider export, and
implemented states with deterministic JSON props. The selected element's
source stamp and Layers path are recorded by Trezi at Show states; the agent
cannot forge that identity. Missing states are labels with notes and are never
rendered as invented UI. Limits: 24 implemented and 24 missing states, 16 KiB
per fixture object, same-origin module URLs, a regular component/provider
source file inside the project, 120–1600 px width.

The Swift preference owner persists recipes outside the repository under
`trezi:states-canvases:v1`, keyed by project root. IDs start with `canvas:` so
they cannot collide with old generated-workbench folder IDs. Rebuild registers
the same ID with a new revision. The native States menu reopens the last state,
offers All states and Continue in Chat, and removes the app-owned recipe after a
confirmation sheet (Cancel keeps it). Menu actions are routed by id: only
`canvas:` ids (or a state action on the open canvas) reach the canvas, so a
legacy workbench folder id can never open, rebuild or remove the open canvas.
A canvas never triggers the Publish generated-file warning. A recipe whose
component or provider file no longer exists is **stale**: the menu says
"source missing", opening it shows the reason on the canvas and in the bar, and
nothing is imported.

## Runtime boundary

`states-canvas.js` is injected into the page world at document start, next to
Trezi's isolated preview instrumentation. It has no native IPC, evaluation
endpoint or credentials. The isolated preload receives a bounded recipe from
Bun and passes it through shared DOM to the page-world renderer. The renderer
imports the real source module, the project's React module and
`react-dom/client` from the same preview origin. The runtime URLs may carry the
dev server's `?v=<hash>` cache key so the recipe names the exact URL the
component itself imports (one React instance, so hooks and context work). Vite
serves optimized CommonJS dependencies as a module whose only export is
`default`; the adapter reads `createElement`, `Component` and `createRoot` from
the named exports or from `default`. CSS imported by that module
loads through the dev server. An optional existing provider component wraps
each render. Each state gets its own React root and JSON props; switching and
closing unmount all roots. Component pointer input is disabled on the canvas
so it cannot trigger ordinary production actions from the design surface.

The modal canvas uses system light/dark colors while the imported component
retains its project styles. Native Swift controls select a state or All, show
missing labels, close, hide and continue in chat. The canvas reports loading,
ready, error and stale status; a throwing component, a missing export or
unsupported React runtime shows its reason on the canvas and in the native bar.
Navigation tears it down.

Refresh uses the preview's existing signals, not file watchers: a reload of the
same URL (HMR full reload, dev-server restart) redraws the canvas from the new
modules, and the preview's "stylesheets changed in place" signal redraws it too
(ignored for 1.5 s after a draw, because rendering can inject CSS-in-JS).
Vite's React Fast Refresh updates the live roots in place. A different URL
disposes the canvas. The original page's URL,
history, scroll and DOM stay in place.

## Current adapter coverage

The adapter supports Vite-served React component exports whose states are
fully determined by serializable props, optionally wrapped by an existing
provider export that is safe to instantiate per state. It does not reconstruct
providers from the selected DOM, mutate React fibers, intercept fetch, or
rewrite application stores. Server components, loaders, components that need
live application stores or network data, and frameworks without an equivalent
module path are explicitly unsupported. The agent must report the reason and
must not create a route or production seam as a fallback.

## Legacy generated workbenches

Existing `trezi-workbench.json` folders remain user files. Trezi still scans,
opens and removes them only on the user's explicit command; their route-based
switcher and Publish protection remain for compatibility. New canvases do not
create, migrate or delete those files.

Unit coverage is in `test/states-canvas.mjs`. Native core smoke
`states-canvas` mounts a real React export and provider in the disposable
fixture, verifies loading/empty/populated/All, preserved original page state,
and unchanged file inventory from registration through removal. It also covers a
CommonJS-shaped (`default`-only) runtime with a `?v=` URL, a component using
hooks and context under a provider, light/dark canvas backgrounds switched live
through the window appearance override (`states-canvas-light.png`,
`states-canvas-dark.png`), 24 states with long labels at a narrow window
(compact bar inside the page, `states-canvas-narrow.png`), an edit to the
component source re-rendering the open canvas, a throwing component and a
missing export (error status and reason in the bar), a stale source, the legacy
id routing and the Remove confirmation.
