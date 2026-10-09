# 3D component inspection

In the desktop web preview, select an element and choose **Inspect in 3D** (the
stacked-layers icon in its selection toolbar). The selected subtree opens in an
isolated workspace. Drag to orbit, Shift-drag to pan, and scroll to zoom. The
focused canvas also accepts arrow keys and +/−. **Separation** spreads the layers
apart; **Front** assembles them; **Reset view** restores the initial camera.

Click a surface or choose a **Component layer** to open the existing inspector.
Choose **Code** in the workspace header to open that layer's source in the code
drawer while keeping the exploded view open. It appears for source-backed layers.
Props, Styles, and Custom controls still target the original source-backed
selection. Style previews update the live component and its 3D representation;
commits and undo use the existing editing engine. **Back to page** or Escape
closes the workspace without navigating or remounting the application. To operate
buttons, inputs, menus, and other live application behavior, return to the page.

## Implementation

`src/preview/three-d.ts` owns the modal shadow-DOM workspace, CSS perspective
camera, layer selection, observers, and teardown. `src/preview/three-d-paint.ts`
measures the live DOM and builds inert paint surfaces. The original component
stays mounted in its original document, retaining inherited styles, fonts,
application state, and layout context. Inspection never reparents or restyles it.
No new renderer/main IPC contract or WebGL dependency is needed: selection and
editing reuse the existing preview → main → inspector path.

Each surface includes only its element's own backgrounds, borders, and direct
text, so descendants are not duplicated on ancestor layers. Text ranges preserve
line positions. Images, SVG rendered in image context, and bounded canvas
snapshots are atomic surfaces. Copies never instantiate page custom elements or
copy executable page markup into the inspector DOM.

Mutation, resize, asset load, font load, and animation/transition completion
refresh the scene on a bounded cadence while the workspace is open. HMR can
recover a replaced node using an initially unique ID or source stamp, with tag
and source checks. Repeated stamps are not sufficient identity. An ambiguous or
removed target invalidates the selection instead of redirecting edits to another
instance. Page navigation destroys the workspace normally; full reloads do not
restore its camera or promise to preserve application state.

## First-version boundaries

- Depth represents DOM nesting, not CSS z-index, compositor layers, or a complete
  React/Svelte component tree. Display labels use DOM tags and IDs.
- CSS transforms, clipping, filters, blending, pseudo-elements, and shadow-root
  internals are not fully reconstructed. The workspace marks captures containing
  these cases as simplified. The original live page remains authoritative.
- Video, iframes, and native form controls use placeholders or static text.
  Portals outside the selected DOM subtree are excluded. Canvas contents are
  snapshots; CSS animations are not continuously replayed in 3D.
- Large subtrees are bounded to 160 surfaces, 500 visited elements, and depth 18.
  Text capture is bounded per element, SVG image capture is limited to 1,000
  descendants, and canvas snapshots have a maximum dimension of 2,048 pixels.
  Partial subtree capture is indicated in the workspace.
- Browser serving mode and the native iOS simulator do not expose this desktop
  preload feature.

`test/three-d-inspector.mjs` exercises the native preview, trusted camera and
selection input, live style preview/clear, source edit/undo, simulated HMR subtree
replacement, state-preserving exit, Escape, capture limits, and duplicate-stamp
protection. It belongs to the Electron tier of `bun run test`.
