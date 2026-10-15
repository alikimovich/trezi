# Component states (LKM-224, rebuilt in LKM-263)

Show states on a selected element opens an isolated Trezi view over the visible
preview, in the same spirit as the exploded view. It draws the real component in
each of its states, labelled, side by side (All) or one at a time. The original page
stays mounted underneath. Opening, switching and closing never navigate, change
history or write project files. `/states` asks the agent for a recipe when props
alone cannot reach a state.

## Architecture decision (LKM-263)

**Problem.** The LKM-224 canvas imported the component from the dev server at a
Vite module URL (`/src/Card.tsx`, `/node_modules/.vite/deps/react.js?v=…`). Next.js
serves no such URLs: webpack and Turbopack emit chunks, so the component URL was a
404 and the recipe could not name a React module. Every non-Vite React project was
unsupported, and even on Vite the recipe depended on cache-key URLs the agent had
to copy exactly.

**Options considered.**

1. *A generated route or fixture page in the project.* This works with any
   framework. It also writes files, triggers the framework's router and HMR, and was
   the retired workbench design. Rejected: no permanent project changes.
2. *Ask the dev server for modules.* There is no stable public module URL in Next
   (dev chunk ids change, and Turbopack has no per-module HTTP surface). Rejected.
3. *Screenshots or DOM clones of the live instance.* These can only show the state
   already on the page, not real variants. Out of scope.
4. **Trezi builds the component itself (chosen).** Bun's bundler, already in
   `Trezi.app`, compiles the component's source graph in memory with the project's
   own React from its `node_modules`. Each state is mounted in its own sandboxed
   frame. The page's dev server is never asked for modules, so the view behaves the
   same for Next.js and Vite.

**Rationale.** Building from source makes the framework only a matter of a few
shims (`next/*`) and conventions (aliases, public env, assets), not a module URL
protocol. Frames give every state its own document, React root, providers and
errors, and the page's own React tree is never touched. What stays approximate is
written down below rather than claimed.

## Pipeline

1. **Locate** (`src/main/states-locate.ts`). From the selection's
   `data-trezi-component-source` call-site stamp (or the element's own stamp), find
   the component's module and export. Barrels resolve to the definition. A
   `"use client"` / `"use server"` directive and an `async` component are recorded;
   an async Server Component stops here with a specific reason.
2. **Discover** (`src/main/states-propose.ts`, `src/main/states-schema.ts`,
   `src/native/states-probe.ts`). The TypeScript checker reads the props type
   (enums, booleans, arrays, nested objects, functions, nodes, dates, promises), and
   the call site's literal props seed the values. A read-only page-world probe
   reads the live instance's props from its React fiber. That answer is untrusted
   data, bounded to 16 KiB and only ever decoded inside a frame. States proposed:
   the page instance (or typed sample data), loading, empty, error, disabled, every
   enum value (one level deep), boolean flags and long text. `useState`/`useReducer`
   and data hooks are listed as *missing* (interactive, data loading), never
   claimed. A conventional `providers.tsx` (`app/`, `src/`, `components/`, …) wraps
   every state when present.
3. **Recipes** (`src/shared/states-canvas.ts`). `register_states_canvas` stores
   explicit fixtures: JSON props, an existing provider export, `actions` (click,
   focus, hover, press, type, key) for internal state, a `route` for
   `next/navigation`, and missing states. Recipe states come first, then discovered
   ones not already covered. Older recipes' `react`/`reactDom` URLs are ignored.
4. **Build** (`src/main/states-build.ts`, `src/main/states-shims.ts`). `Bun.build`
   bundles the frame runtime (`src/preview/states-frame.ts`), the component and the
   provider into one browser bundle and one CSS file, in memory. Details:
   - React and react-dom come from the component's package and are deduplicated
     (one React for hooks and context). React that is not installed gives an
     actionable message; Trezi never installs anything.
   - The `@/…` path aliases are resolved from `tsconfig.json` paths, `vite.config`
     aliases, or `@/` as `src/`.
   - CSS modules compile to the bundle CSS. Plain CSS imports are bundled.
   - `NEXT_PUBLIC_*` / `VITE_*` variables from `.env*` and `import.meta.env` are
     defined.
   - Images become Next's static image object (or Vite's URL), inlined up to
     2 MB. An SVG is a component when `next.config` wires SVGR.
   - Next shims cover `next/image`, `next/link`, `next/navigation`, `next/router`,
     `next/font/*` (the class name falls back to the page's font), `next/dynamic`,
     `next/head`, `next/script` and `next/config`.
   - `"use server"` modules become no-op actions, with a note.
   - A project import of `server-only`, `next/headers`, `next/cache`, Node
     built-ins or a database client fails with the importing file and what to do.
     The same import inside a package is stubbed quietly.
   - Bundles over 12 MB are refused.
5. **View** (`src/preview/states-canvas.ts`, isolated world). A shadow-root
   `<dialog>` over the page holds one `srcdoc` iframe per state. Each frame's
   document gets:
   - the page's stylesheets, so Tailwind, global CSS and fonts apply;
   - the bundle's CSS;
   - a `process.env` shim;
   - the state's JSON;
   - the bundle as an inline module.

   The frame mounts its own React root under the provider and an error
   boundary, decodes tagged props (`$fn`, `$date`, `$pending`, `$reject`,
   `$node`, `$undefined`), runs the actions and reports ready/error with its
   height by `postMessage`. The view checks the message source against its own
   frames and aggregates status for the native bar. A frame that never reports
   times out after 12 s.
6. **Native** (`src/native/states-canvas-controller.ts`,
   `src/native/states-subject.ts`). The Swift switcher selects a state or All,
   lists missing states, shows loading/ready/error/stale with the reason, and
   offers Back to page and Continue in Chat. The latter asks the agent for a recipe
   covering the missing states.

## Lifecycle and refresh

The controller watches the bundle's project inputs (at most 200 files, never
`node_modules`) in `src/native/states-watch.ts`. It polls every 400 ms rather than
using `fs.watch`, because Bun never again reports a path whose `fs.watch` was closed
once, so a component shown a second time would stop updating. An edit to anything
the component imports builds again and redraws, debounced 250 ms. Only an edit to
the component's own file also discovers its states again, because discovery probes
the page and the edit is live-reloading it. The probe gives up after 3 s and falls
back to sample data. A reload of the same URL redraws.
The preview's "stylesheets changed in place" signal redraws too, ignored for 1.5 s
after a draw because rendering can inject CSS-in-JS. Any other URL closes the view.
Back to page (or Esc) removes the view. The page's URL, history, scroll and DOM are
exactly as before. Nothing is written to the target repository: recipes are app
data under the Swift preference key `trezi:states-canvases:v1`, keyed by project
root, and bundles live only in memory.

## Recipe rules

The agent reads the selected component and registers a typed recipe. Trezi records
the selected element's source stamp and Layers path at Show states, so the agent
cannot forge that identity. Missing states are labels with notes, never invented
UI.

Limits:

- 24 implemented and 24 missing states;
- 16 KiB per fixture object;
- 8 actions per state;
- a regular component/provider source file inside the project;
- an optional width of 120–1600 px.

IDs start with `canvas:`, so they never collide with legacy workbench folder ids.
Rebuild registers the same ID with a new revision. The States menu reopens the last
state and removes a recipe after a confirmation sheet (Cancel keeps it). Menu
actions are routed by id. A recipe whose component or provider file is gone is
**stale**: the menu says "source missing", and the view and bar show the reason
without building.

## Unsupported and approximate

These get a specific message instead of a blank view:

- async Server Components;
- components whose own module graph imports server-only code;
- React that is not installed;
- a source that fails to compile (first error with file and line);
- a bundle that is too large;
- an element outside any project component.

Approximations that are documented, not hidden:

- Frames ignore pointer input (states are shown, not used).
- `next/font` uses the page's font rather than loading the Google font.
- `$node` props render as text.
- A CSS module the bundler cannot compile keeps its class names as written.
- A state's write requests (anything but GET/HEAD through `fetch` or XHR) are
  blocked, so a fixture never mutates real data.
- `next/navigation` hooks report the recipe's `route` (or `/`), and
  `redirect`/`notFound` show as errors.
- Discovery is a proposal: internal and data-loading states need a recipe.

## Legacy generated workbenches

Existing `trezi-workbench.json` folders remain user files. Trezi still scans,
opens and removes them only on the user's explicit command. Their route-based
switcher and Publish protection remain for compatibility. Show states never
creates, migrates or deletes them.

## Tests

- `test/states-build.mjs`:
  - discovery on a Next.js App Router fixture and a Vite fixture
    (`src/native/smoke-states-projects.ts`);
  - both real builds (CSS module, PNG, providers, aliases, watched inputs);
  - the server-only, async and React-not-installed messages;
  - an unchanged project inventory.
- `test/states-canvas.mjs`:
  - recipe parsing (actions, route, legacy fields);
  - probe validation;
  - controller flow: show, switch, a recipe merged in, legacy id routing, reload
    and navigation, unavailable components, stale sources and Remove.
- Native core smoke `states-canvas`:
  - shows states for the Next.js ProjectCard and checks real styled variants
    (default/loading/error/disabled/no tags, provider theme, CSS module background,
    `next/image`);
  - shows states for the Vite StatusBadge (enum variants, a click action from a
    recipe);
  - checks state switching, the server-only and async messages, and an edit to an
    imported module redrawing the view;
  - checks that Back to page leaves URL/history/scroll/DOM unchanged and that the
    file inventory is unchanged;
  - captures `states-next.png`, `states-vite.png` and `states-server-only.png`.
