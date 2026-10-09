# Agent guide — gotchas (hard-won; read before debugging these areas)

Moved from the old `CLAUDE.md` ("Gotchas"). Linked from [AGENTS.md](../../AGENTS.md).
The Git/worktree gotchas are in [git-worktrees.md](git-worktrees.md); the model-list
and provider-seat rules are here.

## Native app and service

- **Native shortcuts must route through AppKit menus/responders.** Preserve
  focus-based Undo/Redo and validate physical shortcuts; synthetic actions alone
  cannot prove menu/responder behavior.
- **The preview is the only WebKit view.** Do not reintroduce an application
  renderer. AppKit owns geometry and native inspectors reserve their own space.
- **Preview instrumentation is isolated.** Keep the WKContentWorld and restricted
  message allowlist; re-send select/style/layer state after navigation.
- **Native views over the preview don't block WebKit's pointer by hit-testing.**
  WebKit's tracking areas deliver moves anywhere in its visible rect, and the
  window hands it clicks an overlay left unhandled. Floating islands swallow
  their own clicks and scrolls (LKM-162). For moves, the host sends the page the
  rects native views cover on layout (`src/native/PreviewCover.swift`), main
  forwards them (and re-sends after each load), and the preview script shields
  them (`src/preview/native-cover.ts`). Don't replace or gate WebKit's tracking
  areas: that lost select-mode hover (LKM-173). Don't evaluate into the page
  straight from the host mid-navigation either: it crashed in WebKit's executor
  check. A new floating view over the page belongs in `previewCoverRects`.
- **Inspect WebKit through its native Web Inspector.** There is no Electron CDP
  port. Use the native host test protocol for deterministic integration checks.
- **In service mode the launcher reports the HOST's exit status**, and
  `NSApp.terminate` calls `exit` itself — code after `application.run()` never
  runs. Bun's status must travel in `quit {status}` / `serviceStopped {status}`
  and is applied in `applicationWillTerminate`; otherwise a failing `--test`
  smoke exits 0. Reconnect after a lost XPC connection must name the prior
  epoch (`resume`): launchd silently starts a FRESH service instance, which
  refuses (`recoveryRequired`) rather than launching a second Bun, but only
  after launchd's ~10 s respawn throttle, so `serviceStopped` is final (no
  reconnect, local shutdown). Frames are never replayed after an uncertain
  send; only never-submitted frames queue. Never read a bridge pipe with
  `FileHandle.read(upToCount:)`: it waits for the full count, so short lines
  never arrive — use `readAvailable(upTo:)`. Never answer quit with
  `.terminateLater` while waiting on main-queue work (modal-panel run loop);
  cancel, drain, terminate again. The one exception is the quit alert during
  a logout or restart (LKM-221, `src/native/QuitPrompt.swift`): cancelling
  would abort the logout, so it replies later, and the drain's backstop still
  bounds it. A quit that must not wait (signals, Bun's `quit`) sets
  `quitForced` first, or it shows the agent alert. An XPC service's stderr is discarded, so
  Bun's stderr is the host's, passed over XPC (`attachDiagnostics`).
- **Bun blocks postinstall for untrusted dependencies.** `esbuild` remains in
  `package.json#trustedDependencies` for its binary.
- **Stale styles in the editor come from a cache someone forgot to clear.** Every cache
  between a source file and the island, Layers, the chat islands and the preview has an
  invalidation rule in [CACHES.md](../CACHES.md). A new cache must be added there, and
  must listen to `onSourceChange` (`src/main/source-changes.ts`) or the freshness hub
  (`src/native/editor-freshness.ts`), not just to a TTL (LKM-216).

## Agent SDKs and providers

- **The Agent SDK's `interrupt()` can never return, so Stop must not just await it.**
  It's a CONTROL REQUEST: the SDK resolves it only when the CLI subprocess sends a
  matching `control_response`, and there is no timeout anywhere in that path. A
  wedged subprocess (symptom: turn running for minutes, `↑0 ↓0`) therefore made
  Stop a dead button — the IPC never resolved, and since `done` is only emitted
  from a `result` message, the spinner ran forever. The kill switch was present
  the whole time (`shutdown()`'s `abort.abort()`) but only teardown reached it.
  Since LKM-98 the provider owner holds the deadline: `provider-sessions.ts` runs a
  backend's graceful `interrupt` through `interruptWithOwner` and, when the owner says
  escalate, its `forceStop` kill switch once (it must end the turn: error + one done).
  Give any future backend a `forceStop` rather than its own timer, and keep the
  `hardStopped` report so agent.ts rebuilds the dead session. An unreachable owner
  falls back to the local bound. Codex was always safe here (its cancel is a local
  AbortController); Gemini had no `interrupt` at all, so Stop silently did nothing.
- **ESM/CJS**: the Agent SDK is ESM-only, `main` is CJS → dynamic `import()`
  only, never static/`require`.
- **Never hardcode a built-in seat's model list.** It rots invisibly: the picker
  offered "GPT-5 Codex"/"GPT-5" for months after the Codex CLI moved to the
  GPT-5.6 family, so a user's first act was to pick a model that no longer
  existed. Both harnesses can be ASKED (`src/main/model-catalog.ts`), and the
  arrays left in `providers.ts` are a last resort for "we could not ask", not
  curation. Two traps if you touch this: the Codex binary to ask is the SDK's
  VENDORED one (`@openai/codex-<plat>/vendor/…/bin/codex`), never the `codex` on
  PATH — a global CLI of a different version would answer for a binary that
  never runs the turns; and `Query.supportedModels()` leads with its own
  `{value:'default'}`, which collides with trezi's "Default" sentinel, so a
  discovered `default` is dropped in favour of ours (`agentModelId` maps that
  exact string to "send no model").
- **A tool callback's `root` is the chat's WORKTREE, not the live tree.**
  Anything persisting app state must use `SpawnContext.liveRoot` (threaded from
  every `agent.ts` startSession call site) — `define_controls` validates anchors
  against the worktree file the agent just wrote, but saves to the live root.

## Editing engines and sidecars

- **Prop editing is gated** on `PropInspection.hasSchema` (a resolved
  react-docgen/svelte schema). Unready components are prompt-only; the on-open
  setup offer instruments them. React and Svelte have separate splice engines.
- **The Styles ladder never INTRODUCES a styling convention.** S2 merges into a
  `style` attribute that already exists; it will not create one, and the S3
  prompt explicitly forbids the agent from creating one either. Re-adding an
  insert-when-absent branch to make edits feel snappier would push inline styles
  into projects that style from a stylesheet or a Svelte scoped `<style>` block
  — where the inserted attribute also silently outranks that block forever after.
  An element with no class and no `style` is SUPPOSED to cost an agent turn.
  (Note S1 has the mirror-image gap: it can only rewrite an existing class
  string, never add one, so Tailwind projects pay that turn too.)
- **The agent is denied writes under a target repo's `.trezi/`** (and the
  [legacy](legacy-names.md) sidecar directories) — annotations, scaffolded instrumentation, and
  control-panel manifests live there. The `define_controls` tool exists precisely
  because of this: the agent hands main a manifest, main validates it, and the
  editing owner (the Swift service) is the only writer —
  hash-bound, so a hand edit is never overwritten.
- **A control-panel manifest stores no values.** Every value is re-resolved from
  source on lookup (literal → lex the literal after the anchor; prop → the live
  inspection; style → computed styles), so an edit that moves a constant is
  harmless and one that renames it just marks the param stale. Anchors must
  occur exactly once — re-checked at save AND at every apply, so a drifted
  anchor can never splice the wrong site. Only main renders spliced literals;
  agent- and renderer-supplied strings are never written verbatim.
