# 3D component inspection

In the native desktop preview, select an element and choose **Inspect in 3D** (the
stacked-layers icon in its selection toolbar). The selected subtree opens in an
isolated workspace rendered natively over the preview. Drag to orbit, Shift-drag or
scroll with two fingers to pan, and pinch (or ⌘-scroll / a mouse wheel) to zoom.
The focused scene also accepts arrow keys and +/−. **Separation** spreads the
layers apart live; **Front** assembles them face-on and **Reset view** restores the
initial camera, both animated. Hovering a layer highlights it and shows its label.

Click a surface or choose a **Component layer** to open the existing inspector.
Choose **Code** in the workspace header to open that layer's source in the code
drawer while keeping the exploded view open. It appears for source-backed layers.
Props, Styles, and Custom controls still target the original source-backed
selection. Style previews update the live component and its 3D representation;
commits and undo use the existing editing engine. **Back to page** or Escape
closes the workspace without navigating or remounting the application. To operate
buttons, inputs, menus, and other live application behavior, return to the page.

## Implementation

The scene is native (LKM-227). `src/preview/three-d.ts` captures and owns layer
identity: `src/preview/three-d-paint.ts` measures the live DOM and builds one inert
paint surface per element, and `three-d.ts` shelf-packs them (`packAtlas` in
`src/shared/three-d-contract.ts`) into at most six viewport-sized atlas pages at one
shared scale inside a modal shadow-DOM dialog that paints nothing by default. It
sends only geometry, depth, labels and atlas slots, bounded and validated on both
sides (`threeDStateAllowed`, `THREE_D_LIMITS`); no pixels cross the bridge.
`src/native/ThreeDCapture.swift` then asks the preview world to show each page on
black and on white (`paint`, revision-checked, so a stale atlas is never captured),
snapshots WebKit at the window's backing scale, recovers alpha from the two shots
and crops one image per layer. `src/native/ThreeDScene.swift` renders them as
Core Animation planes in a `CATransformLayer` with perspective: orbit, pan, zoom,
live separation, animated Front/Reset, hover and a manual hit test (Core Animation
does not hit-test 3D transform layers). Its background, grid, highlight and labels
are semantic AppKit colors resolved under the effective appearance, so light/dark
switches need no recapture. The WKWebView stays mounted under the scene for
identity, selection and the next capture. If capture fails or times out, the scene
shows a native message instead of an empty stage. `src/native/ThreeDChrome.swift`
owns the system buttons, slider, picker ("1 layer", "N layers"), title, hint and
capture status, and places the scene between its bars. The original component
stays mounted in its original document, retaining inherited styles, fonts,
application state, and layout context. Inspection never reparents or restyles it.
Selection and editing reuse the existing preview → main → inspector path. The
native controls use a separate session/revision contract; delayed actions cannot
select a layer after an index refresh or close.

Each surface includes only its element's own backgrounds, borders, and direct
text, so descendants are not duplicated on ancestor layers. Text ranges preserve
line positions. Images, SVG rendered in image context, and bounded canvas
snapshots are atomic surfaces. Copies never instantiate page custom elements or
copy executable page markup into the inspector DOM.

Mutation, resize, asset load, font load, and animation/transition completion
refresh the capture on a bounded cadence while the workspace is open; the native
camera, separation and selection survive each recapture. HMR can
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
  Partial subtree capture is indicated in the workspace. The atlas holds at most
  six pages; very large subtrees are captured at a reduced scale, and surfaces that
  still do not fit are left out and marked as partial.
- Browser serving mode and the native iOS simulator do not expose this desktop
  preload feature.

The native `three-d` smoke check in `src/native/smoke-three-d.ts` belongs to the
`core` group. It opens a nested fixture card from the real preview toolbar; checks
that every layer renders as a native plane at backing scale, separation spacing,
Front/Reset, hover, clicking a layer through the scene's hit test, the plural
label, Code and inspector paths, stale layer rejection, the capture-failure
message and recovery, HMR recovery, removed targets, navigation cleanup, Back and
Escape with native focus, repeated open/close and page input isolation; and
captures foreground light, dark, failed, compact and Code-drawer views.
`test/three-d-contract.mjs` checks session, revision and action bounds, the state
shape and atlas packing in the unit tier. The capture bounds remain 160 surfaces,
500 visited elements and depth 18.
