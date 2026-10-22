# LOCAL-SELECTION-FIX diagnosis

Confirmed in baseline e61c3ad9: `blockPageInput` prevents the outside pointer-down
default that would blur the inline editor; `onClick` then returns while editing.
An app switch can supply the missing blur. `endEdit` leaves its blur listener and
the browser text range installed, and mode exit removes editability without
explicitly committing or restoring the text. Overlay cleanup already exists in
`setActive(false)`, but does not clear that browser range.

The native shell sends `preview:set-select-mode` through preview IPC to SET_MODE;
Escape returns CANCELLED to reset the shell. No confirmed native focus defect:
do not change WKWebView focus policy based on the app-switch symptom alone.

Fix policy: a trusted outside page click commits once then selects its target;
Enter and explicit mode exit commit; Escape restores the original text and exits.
Teardown removes listeners before releasing focus and clears the editor range.
Detached-node/page teardown cancels. Existing text:apply/undo plumbing is retained.

Desktop checks and foreground capture are reserved for the manager under the
shared native-desktop lock; this worker runs only focused non-GUI checks.

## Worker evidence

- Original worker baseline: e61c3ad9. Manager committed the first implementation
  as cce2546b (`Implement LOCAL-SELECTION-FIX`). This repair starts at that head;
  its changes are left uncommitted for the manager. Record the manager's next
  committed head alongside the desktop command/results, not as the worker baseline.
- `bun test/preview-edit-lifecycle.mjs`: PASS. Runs production handlers in a DOM
  model, including changed-text commit ordering, cancel, Enter, blur/re-entry,
  mode exit, listener/range cleanup and normal page input after exit.
- `bun run typecheck`: PASS (node and isolated-preview TypeScript checks).
- `bun run lint`: PASS, with existing warnings/infos; no unrelated cleanup.
- `bun test/native-visible-capture.mjs`: PASS (mocked bridge only; no desktop).
- `bunx biome check src/preview/preload.ts src/native/smoke-input.ts src/native/smoke-core.ts test/preview-edit-lifecycle.mjs --max-diagnostics=0`:
  PASS, warnings/infos only.
- Extended existing native `selection-input` fixture: unchanged-text outside click
  must select the paragraph immediately; mode exit must remove ranges, selection
  boxes and toolbar; re-entry/Escape must work. Existing changed-text Escape and
  caret tests remain. Existing `text-edit` checks apply/undo/redo persistence.
- Native coverage is prepared, NOT executed. Manager must run those focused checks
  using its local native-locked.ts/withResource driver under native-desktop, with
  disposable fixtures/profile. Inspect `selection-lifecycle.png` (foreground window)
  and `selection-lifecycle.json`, alongside existing element-toolbar evidence.
  Do not treat the worker's model test as proof of WKWebView focus or paint.

## Focused acceptance preparation (repair)

- Added `selection` group: only `selection-input` and `text-edit`, plus the existing
  startup/open-project/chat-ready/final-shell prelude. Group selection unit test
  asserts the exact list, excluding other core checks.
- The native fixture types changed text in a controlled stamped leaf with genuine
  WebKit input. Its isolated-world transport wrapper captures only that leaf's
  text-edit messages and restores the transport in finally. No source write/HMR
  can race the outside-click selection assertion. Expected commits are exactly
  `Controlled textx`, `Controlled textxy`, `Controlled textxyz`, once each.
- While editing `Controlled textxy`, it activates the already-running Finder,
  verifies Finder is frontmost and the page lost focus, then restores Trezi via
  smokeFocus. It records whether WebKit retained the DOM editor; Enter finishes
  the edit if needed, and re-entry plus another changed outside click must work.
  This records actual WebKit behavior instead of assuming app blur ends editing.
- Existing `text-edit` exercises source persistence, undo and redo separately.
- Pending manager command: `bun test/native-runtime.mjs --only=selection`, run
  through native-locked.ts/withResource using resource `native-desktop` in
  `/Users/panda/dev/agent-os/.local/agent-os.sqlite`. No desktop execution or PNG
  inspection was performed by this worker. Inspect selection-lifecycle PNG/JSON;
  JSON now also includes exact intercepted commits and Finder/return focus state.

Repair worker non-GUI results (starting HEAD cce2546b; repair left uncommitted):

- `bun test/native-smoke-groups.mjs`: PASS, exact selection list and dependencies;
  launcher validation rejects invalid groups before building. No desktop run.
- `bun test/preview-edit-lifecycle.mjs`: PASS.
- `bun test/native-visible-capture.mjs`: PASS (mocked bridge only).
- `bun run typecheck`: PASS (node and isolated preview).
- `bunx biome check src/native/smoke-input.ts src/native/smoke-groups.ts test/native-smoke-groups.mjs --max-diagnostics=0`:
  PASS, three warnings only.
- `bun test/docs-links.mjs`: PASS, 277 path references resolve.
- Manager commit trailer: `Co-Authored-By: Codex <codex@openai.com>`.
