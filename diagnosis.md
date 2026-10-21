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

- HEAD: e61c3ad9 (issue baseline); changes are uncommitted in this checkout.
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
