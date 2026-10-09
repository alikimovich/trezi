# Caches in the visual editing loop

LKM-216. The visual editor never shows stale styles. This page lists every cache
between a source file and what the editing island, Layers, the chat islands and the
preview show, and the rule that clears each one. The hub that applies the rules is
`src/native/editor-freshness.ts`; its signals are wired in
`src/native/editor-freshness-runtime.ts`.

## Inventory

| Cache | Where | What clears it |
| --- | --- | --- |
| WebKit HTTP and memory cache | the preview's `WKWebView` (`PreviewCache` in `src/native/PreviewLoad.swift`) | HMR or a live reload for normal edits. A stylesheet the page kept stale is swapped for a cache-busted copy (`reloadPreviewStyles` in `src/main/preview-freshness.ts`). A hard reload (`host.send('reload', { hard: true })`) clears WebKit's memory, disk and fetch caches first. |
| Dev-server HMR and dependency caches (Vite `.vite`, Next `.next`) | the target's dev server | The dependency watch (`src/native/dependency-watch.ts`) restarts the server with clean caches (LKM-197). Trezi never deletes them otherwise. Edits reach the page through the server's own HMR. |
| Token detection memo (1.5 s) | `src/main/style-tokens.ts` (`detectTokensCached`) | `invalidateTokenMemo(root)` on every source change in that project, not only on the TTL. |
| Inspector state and `styles:read` replies | `src/native/inspector-controller.ts` (`styles`, `inspection`, `tokens`, `controls`) | `invalidated()` re-reads all four in place (no new generation). During a reload the last values stay until the page has the element again. |
| The page's selection | `selectedEl` in `src/preview/preload.ts` | HMR heals it by source stamp (`resolveStyleTarget`). A full reload loses it, and `src/native/inspector-runtime.ts` re-picks the same element (`reattachSelection`, matched by tag, source and id). |
| Component/source maps and stamps | `data-trezi-source` attributes. Prop inspection reads the file on each call (`src/main/props.ts`). | Nothing is cached in Trezi. Stamps come from the page, so a re-read after HMR or a reload sees the new ones. |
| Chat island values and revisions | `src/main/chat-islands.ts` | `refreshChatIslands(root)` re-reads every idle island of the project. An island in the middle of a gesture or a write re-reads when that settles. |
| Layers tree | `src/native/layers-controller.ts` (`snapshot`) | `refresh()` on `layers:changed`, on a new document and on every source change (while open). |
| Agent browser pages (LKM-212) | private WebKit pages in the host (`src/native/PreviewPlatform.swift`, `src/main/agent-browser.ts`) | They load the live dev server, label each observation with its navigation and served revision, and reload on `reload_preview`. The editor's caches do not read them. |
| Screenshots | `open_preview` and agent captures (`src/main/preview-tools.ts`) | Each one is taken when it is asked for and labelled with the navigation it came from. None is reused for the editor. |

## Invalidation rules

Every change goes through `noteSourceChange` (`src/main/source-changes.ts`) or the hub
directly:

| Event | Signal |
| --- | --- |
| Island or inspector write, editor save, Undo/Redo/revert, file create/rename/delete | `observedSourceOwner` → `source-edit` |
| A landed chat turn recorded for Undo | `observedSourceOwner.record` → `landing` |
| Agent `done`, `landing-finished`, `spawn-finished`, merged isolation (incl. `land_now`) | `agent:event` → `landing` |
| Any file in the live checkout (the user's editor, a formatter, an agent) | `LiveTreeWatch` (`src/native/live-tree-watch.ts`) → `file-change`; generated and dependency folders are ignored |
| Lockfile or direct dependency change | dependency watch → `dependency` |
| The page's stylesheets changed in place (HMR) | `preview:styles-updated` from `src/preview/style-watch.ts` → `hmr` |
| A new document (reload, live reload) | `preview:url-changed` → `document` |

What the hub does:

1. Any change drops the project's token memo.
2. For the active project, after a 60 ms settle, the editing island re-reads the
   selection's computed styles, props, tokens and controls, Layers re-reads its tree,
   and the chat islands re-read their bound values. When the island's values changed,
   `updated` increments and the island plays a small "Updated" pulse. It does not
   reload.
3. A change to a stylesheet (CSS, a preprocessor, a Tailwind or PostCSS config) or to
   a dependency starts a 500 ms clock:
   - A new document restarts the clock, because WebKit may have served the
     stylesheet from its cache.
   - When the clock runs out, `previewFreshness` compares the page's loaded CSS/JS with
     what the dev server serves now. This always runs: the page's "styles changed"
     signal is not proof (a document load inserts `<link>`s and tools inject
     `<style>`s). Stale `<link>` stylesheets are swapped for copies with a
     `trezi-fresh` query.
   - If anything is still stale 400 ms later (or the stale asset is a script), the
     preview gets one hard reload, at most once every 3 s. If the page reported a CSS
     update after the change, that hard reload is skipped: an HMR update leaves the
     entry scripts stale on purpose.
4. `hmr` and `document` count only within 5 s of a change. CSS-in-JS churn and
   navigation never trigger a re-read on their own. Trezi's own stylesheet swap is not
   mistaken for HMR, and the page does not report styles inserted while the document is
   still loading.

## Checks

- `test/editor-freshness.mjs` (unit) covers the hub's rules with fakes, the live-tree
  watch, the source owner's notifications, the page's style-mutation filter and the
  deduplicated asset list.
- Native smoke `editor-freshness` (core group) covers these cases:
  - A CSS module rule saved through the editor reaches the computed style and the island
    within 1 s, with the pulse.
  - A token file updates the token list.
  - A component edit updates the props.
  - A page edit updates Layers.
  - A stale `node_modules` stylesheet is swapped without a page reload.
