# Preview overlay: rulers, guides and layout grids

LKM-205. A design overlay over the preview, in the style of Squints. The user's project
DOM and CSS never change: everything is drawn by native views above the web view, and
the page keeps its input except on a ruler or within 3 pt of an unlocked guide.

## What the user gets

- **Rulers.** View → Show Rulers (⇧⌘R) or the toolbar's Rulers and Grids popover. They
  are 16 pt strips at the top and left of the preview area. While they show, the page is
  inset beside them, so they never cover it. Units are page CSS px at any zoom, agent
  viewport width or device frame. Labels are always at least 50 pt apart (1-2-5 steps).
  The rulers also show a pointer marker and the selected element's extent.
- **Guides.** Drag from the top ruler for a horizontal guide or from the left ruler for a
  vertical one. Drag a guide to move it. Dropping it on its ruler or off the page removes
  it, and so does Delete after clicking it. A label shows the position while dragging.
  - Snapping, within 5 pt: element edges and centres under the pointer, grid lines, or
    else the nearest whole pixel.
  - Lock Guides stops moving. Clear Guides removes them all.
  - Guides are page-anchored, scrolling with the document, unless "Fixed to Viewport" is on.
  - Guides show only while the rulers show.
- **Layout grids.** View → Show Layout Grid (⌃G). Turning it on with no grids adds the
  viewport's preset. Several grids can show at once, each with its own colour, opacity and
  visibility:
  - Columns: count, fixed width or stretch, gutter, margin, align left/center/stretch.
  - Rows (baseline): step and offset.
  - Square: size.

  Presets: 12 Columns 1200, 4 Columns Mobile, 8 pt Baseline and Square 8 pt.
- **Measurement.** With guides or a grid showing, hovering an element in select mode
  labels the distance from each of its edges to the nearest line outside it, in the
  existing measurement style.

## Where the pieces are

| Piece | File |
| --- | --- |
| Settings model and all math (columns, periodic lines, ruler steps, snapping, CSS↔view) | `src/native/PreviewOverlayModel.swift` |
| Controller: state, layout, guide drag, page messages, View menu items | `src/native/PreviewOverlay.swift` |
| Ruler, corner and guide/grid drawing (device-pixel aligned) | `src/native/PreviewRulers.swift` |
| Toolbar popover (SwiftUI) | `src/native/PreviewOverlayPanel.swift` |
| Test-broker commands `previewOverlayInspect` / `previewOverlayTest` | `src/native/PreviewOverlayVerification.swift` |
| Persistence and page relay (Bun) | `src/native/preview-overlay-controller.ts` |
| Shared types, clamping, per-project store | `src/shared/preview-overlay.ts` |
| Page side: geometry reports, hover distance labels | `src/preview/overlay-guides.ts`, `src/preview/guide-distance.ts` |
| Agent read-only view | `src/main/preview-overlay.ts` (`workspace_state.previewOverlay`) |

`WorkspaceLayout.layout()` insets the page by `PreviewOverlay.inset` and then calls
`PreviewOverlay.place`. The rulers are in `previewCoverRects`, like every native view that
can float over the page.

## Data flow

1. Main keeps everything in one preference, `trezi:preview-overlay:v1`:
   `{ [projectRoot]: { at, rulers, viewports: { desktop, mobile } } }`.
   - Ruler visibility is per project; guides, grids, lock and fixed are per viewport.
   - The least recently changed projects beyond 50 are dropped.
2. Main sends the host `previewOverlay {key, viewport, state}`, keyed by
   `JSON.stringify([root, viewport])`. It sends when the shell state's project or viewport
   changes, and again when another client changes the preference.
3. Every user edit goes through `PreviewOverlay.update`, which clamps it like a stored
   value and emits `preview-overlay {key, state}`. Main stores it under that echoed key,
   so a late edit never lands on the project opened after it.
4. The host emits `preview-overlay-lines`: guide positions, column edges, and row and
   square periods, plus whether the page should report. Main relays them to the page on
   `trezi:preview:overlay-lines`, and again after each load.
5. While something shows, the page reports scroll, client size and the selection's
   rect on `trezi:preview:overlay-geometry`, at most once per animation frame and only
   when changed. `Host.userContentController` hands that channel straight to the overlay;
   it never goes to Bun.
6. Snapping reads visible element rects once per drag, from the isolated world, never
   while the page is loading. Trezi's own hosts are skipped.

## Agent access

`workspace_state` includes `previewOverlay` for the chat's project: the stored settings
at the project's current viewport, with `readOnly: true`. No tool writes them.

## Tests

- Unit: `test/preview-overlay.mjs` (Swift math fixture) and `test/guide-distance.mjs`
  (hover distances, line normalisation, per-project store).
- Native smoke check `preview-overlay`, group `core` (`src/native/smoke-preview-overlay.ts`):
  - shortcuts through the menu and the toolbar popover;
  - ruler drags, snapping to the heading's edge, then moving and removing a guide;
  - columns at 600 and 900 px;
  - per-viewport and per-project persistence;
  - the agent view;
  - an unchanged DOM and no page input;
  - light and dark captures (`test/artifacts/native/preview-overlay-*.png`).
