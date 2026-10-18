# LKM-276 evidence: generated native previews

From the native smoke check `swift-macros` (group `core`,
`src/native/smoke-swift-macros.ts`), run through Agent OS native verification with
`TREZI_SIGN_IDENTITY=-`. It opens a committed copy of
`test/fixtures/swift-preview-macros` that has no manifest and intact `#Preview` blocks.

- `swift-macros-preview.png`: the chosen `#Preview` "Counter with state" (`@Previewable`
  state, `.sizeThatFitsLayout`).
- `swift-macros-component.png`: the component `TagCounter` with its inferred sample.
- `swift-macros-catalog.png`: the page with the "#Preview" and "Components" groups and
  the "not shown" list opened, each entry with its reason.
- `swift-macros.json`: build state, the whole catalog (target, choices, entries with
  reasons and samples), the frames shown (PNG size and digest per entry: the
  `@Previewable` "Tags: 3" and the sample "Label: 1" of the same view differ), the
  page's groups and unsupported items, and the copy's content hash before and after
  (equal).

Captures are of the Trezi window; native frames are offscreen `cacheDisplay` renders.
