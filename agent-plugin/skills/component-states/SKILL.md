---
name: component-states
description: Render implemented states of one selected component on Trezi's app-owned canvas. Only run when the user invokes /states, Show states, or the element's menu.
disable-model-invocation: true
---

# Component states canvas

Adapted for Trezi from the "state-machine" skill by Jakub Krehel
(github.com/jakubkrehel/skills), MIT licensed; see `LICENSE` in this folder.

The canvas is Trezi-owned. Do not create project routes, pages, fixture files,
manifests, config changes, dependencies, production seams, or HTML controls.
Existing generated workbenches are legacy user files: leave them alone.

1. Read the selected component's source and its call site. Identify states that
   the code **already renders**. Record states the code lacks separately as
   `missing`; never synthesize missing UI. Use deterministic, local JSON fixture
   props only. Do not use real accounts, network responses, secrets, or live stores.
2. Use a supported Vite React module. `source` is the project-relative file
   exporting the real component; `exportName` is its named export or `default`.
   Use the project's Vite-served React and `react-dom/client` module URLs, both
   same-origin root paths; copy the exact URL (including a `?v=<hash>` key) from
   the component module's own React import so hooks and context share one React. If the component needs a provider, name an **existing**
   module/export in `provider`. That wrapper must be safe to mount independently
   for each state. Do not claim support for a loader, server-only component,
   global store mutation, network data, or a provider that cannot be isolated.
3. Call `register_states_canvas` with component, source/export, runtime URLs,
   width, a bounded
   ordered `states` list (`id`, `label`, JSON `props`), `missing` list (`id`,
   `label`, `note`), and the existing `id` only when rebuilding. Trezi validates
   the selected instance identity and stores the recipe through its Swift preference owner outside
   the repository. Registration never writes the project.
4. Call `open_states_canvas` with the returned id and first state. Use
   `inspect_states_canvas`, `preview_screenshot` with `target: user`, and read-only
   `preview_evaluate` with `target: user` to check real rendered content. Open each
   state and `all`, checking distinct fixtures, preserved page URL and original
   state, and unsupported/error status. End on the first state. A private agent
   browser is separate; its observations do not prove the visible canvas.
5. If a state cannot render, report the exact reason. Do not fall back to a
   generated page or alter production code. Rebuild by registering the same id
   with updated fixtures; the menu reopens the last state and Continue in Chat
   returns to the creating chat.
