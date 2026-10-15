---
name: component-states
description: Register states for one selected component in Trezi's isolated states view. Only run when the user invokes /states, Show states, or the element's menu.
disable-model-invocation: true
---

# Component states

Adapted for Trezi from the "state-machine" skill by Jakub Krehel
(github.com/jakubkrehel/skills), MIT licensed; see `LICENSE` in this folder.

The states view is Trezi-owned. Trezi builds the selected component from its
source with the project's own React (Next.js and Vite React) and draws each state
in an isolated frame. It already proposes states from the props type. Your recipe
adds what props alone cannot reach. Do not create project routes, pages, fixture
files, manifests, config changes, dependencies, production seams or HTML controls.
Existing generated workbenches are legacy user files: leave them alone.

1. Read the selected component's source and its call site. Identify states that
   the code **already renders**. Record states the code lacks separately as
   `missing`; never synthesize missing UI. Use deterministic, local JSON fixture
   props only. Do not use real accounts, network responses, secrets or live stores.
   Tagged values stand for what JSON cannot carry: `{"$fn":"onOpen"}`,
   `{"$date":"2026-01-01"}`, `{"$pending":true}`, `{"$reject":"Network error"}`,
   `{"$node":"text"}`, `{"$undefined":true}`.
2. `source` is the project-relative module exporting the real component and
   `exportName` its named export or `default`. If the component needs context
   (theme, query client, store), name an **existing** module/export in
   `provider` that wraps `children` and is safe to mount once per state. Trezi
   already uses a conventional `providers.tsx` when there is one. For internal
   state (an open menu, a focused field) add `actions` (`click`, `focus`, `hover`,
   `press`, `type`, `key`, with an optional `selector` inside the frame). For
   `next/navigation` give a `route` (`pathname`, `search`, `params`).
3. Server-only code cannot render in the browser: an async Server Component, or a
   module that imports `server-only`, `next/headers`, a database client or Node
   built-ins. Say so and point at the client component that receives the data as
   props; never add a seam to the project.
4. Call `register_states_canvas` with component, source/export, optional
   provider and width, a bounded ordered `states` list (`id`, `label`, JSON
   `props`, optional `actions`/`route`/`note`), a `missing` list (`id`, `label`,
   `note`), and the existing `id` only when rebuilding. Trezi validates the
   selected instance identity and stores the recipe outside the repository.
5. Call `open_states_canvas` with the returned id. Use `inspect_states_canvas`
   (status and reason), `preview_screenshot` with `target: user`, and read-only
   `preview_evaluate` with `target: user` to check real rendered content. Open each
   state and `all`; end on the first state. A private agent browser is separate;
   its observations do not prove the visible view.
6. If a state cannot render, report the exact reason from the view. Rebuild by
   registering the same id with updated fixtures.
