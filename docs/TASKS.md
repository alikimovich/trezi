# TASKS

Roadmap / next steps. Tick items as you finish them and log in PROGRESS.md.
Full narrative for shipped work lives in `docs/PROGRESS.md`.

## Landing commit messages describe the change (LKM-189)

- [x] `commit-message.ts`/`chat-commit.ts`: subject (imperative, <= 72 chars) and 3–6 bullets from the turn's diff and final reply via the provider's background model (`complete` one-shot), 3 s timeout, deterministic file-list fallback, Conventional Commits when the repo uses them, `Trezi-Turn`/`Trezi-Chat` trailers; never the prompt.
- [x] Used for every landing (turn, reconcile, resolve, Keep, parked apply, chat release); a re-squash after a park describes the combined diff.
- [x] Publish PR title/body summarise the branch's commits; tests (mocked model, timeout, no prompt, combined diff, trailers, PR), CHANGELOG line, docs/WORKTREES.md.

## Branch menu aligned with the address (LKM-184)

- [x] `BranchPopUpButton`/`BranchPopUpCell` (`ToolbarAddress.swift`): the branch title starts on the address text's left edge; the chevron follows it, tail truncation and the frame-sized click target kept.
- [x] `toolbar-address` smoke check measures both rendered text origins (window x, |dx| <= 0.5 pt) and the title–chevron gap at three widths, with light and dark window captures at two; CHANGELOG line.

## Movable islands (LKM-180)

- [x] One shared island (`FloatingIsland.swift`): glass, opaque face, AppKit header that drags (open/closed hand), header controls never start a drag, double-click resets, whole frame keeps the pointer from the page.
- [x] Snap to preview edges and the other island (8 pt), no overlap on drop, kept inside on resize by corner, default when it no longer fits (`IslandLayout.swift`).
- [x] Position saved per island in `trezi:native-panel-sizes` (`inspectorX`/`inspectorCorner`, `layersCorner`) and restored on reopen; Reset Position in the editing island's … menu.
- [x] `movable-islands` smoke check (group `core`) with light/dark captures; CHANGELOG line.

## Native smoke focus guard and failure lines (LKM-176)

- [x] Host `smokeFocus` test command restores focus (activate, key window, at most 2 s) before and after every check; a check that failed after focus was lost during it is retried once; `focus restored` is logged.
- [x] One `SMOKE FAIL <group>/<check>: … (expected …, actual …) [artifact: …]` line per failure, for timeouts (step and label) and host exits (code/signal, last host log lines); the launcher prints them last.
- [x] Exit 3 with `SMOKE ENV <reason>` when every failure is an environment failure (focus not obtainable or lost, display asleep); 1 otherwise.
- [x] `TREZI_NATIVE_SMOKE_STEAL_FOCUS` simulation, on by default in `test:native` (`chat-ready`); unit tests for formatter and runner; docs/TESTING.md.

## Fast native test builds (LKM-175)

- [x] Content-addressed Swift binary cache in `~/Library/Caches/Trezi/build` (last 20 per product); a hit copies, signing still runs.
- [x] `TREZI_BUILD_PROFILE=test` (-Onone, no WMO, -j<cores>) from test:native, native-runtime and `dev:native --test`; release stays -O.
- [x] Swift products and esbuild bundles in parallel; shared module cache; a timing line per step.
- [x] Chat-scroll never rebuilds (confirmed); two pacing waits removed; `[timing]` lines for both native suites.
- [x] `TREZI_SIGN_IDENTITY=-` skips the keychain identity listing; test builds still never create an identity.

## Select mode hover lost under the LKM-162 pointer gate (LKM-173)

- [x] Remove `PreviewWebView`/`PreviewPointerGate`: WebKit keeps its own tracking areas and the preview is a plain `WKWebView`; no per-move window hit test.
- [x] The host sends the page the viewport rects the island and its resize edge cover, on layout and only when changed (`src/native/PreviewCover.swift`, `native-cover` event); main forwards them on `trezi:preview:covered` and re-sends them after every load.
- [x] The preview script shields those rects (`src/preview/native-cover.ts`): no hover box, page `:hover` or page pointer listener under the island.
- [x] Native `checkPointer` moves through WebKit's tracking-area owners: page hovers, island does not, page hovers again; the shield matches the island; a click and wheel on the island still pick nothing.
- [x] Repair the native inspector crash by reading page state between pointer commands; verify interact-mode CSS `:hover`, cursor and `mouseenter` on the page and their absence under the island (`core` native group passed).
- [x] Verify hover travel before the island click and wheel, assert no pick or page scroll afterward, and restore the island after an assertion fails (`core,composer` native groups passed).
- [x] Add the visible native toast to the page cover, refresh that cover after toast show/hide, and check the native hit target and preview shield in the settings smoke.
- [x] Drive the island-to-page return hover through a short AppKit pointer path and confirm the inspector in two consecutive native `core` runs.
- [x] Drive page-to-island entry through the same pointer path in select and interact modes, with native cover diagnostics on a failed clear; scoped native `core` passed.
- [ ] Operator: on a real Mac, hover in select mode around and over the open island (real pointer, real cursor).
## Editing inspector follows its project (LKM-172)

- [x] Hide the island, chip and preview overlays during a project switch; restore each project's selection and inspector tab only if the element still resolves on return.
- [x] Clear the selection quietly after page navigation or element removal, with native coverage for return and removal.
## Product logging: one log folder, Copy Logs for Support, trezi logs (LKM-168)

- [x] Repair the failed-open native chat gate: clear the loaded chat on selection failure and hide it when a loaded preview enters error.
- [x] After merging LKM-169, verify the Resolve queue's real provider prompt by its queued-text suffix and exact call count in the native chat smoke.
- [x] Review repair: omit arbitrary dev-server output and helper stderr, lock the shared size check, and make the native turn check use `agent:send` and the provider event hook.
- [x] One folder, `~/Library/Logs/Trezi/trezi-YYYY-MM-DD.log`, 7 days, 20 MB a day; `app`, `service`, `backend`, `helper`, `preview` and `devserver` lines (`src/main/product-log.ts`, `src/service/ProductLog.swift`).
- [x] Turn start/end/error with provider and resolved model, landing/parking/resolve with the Git result, worktree create/remove, helper start/exit/crash, preview load/reload/crash, slow host commands (>250 ms), XPC errors.
- [x] Redaction of secrets and `~` paths, identical in Bun and Swift (`test/product-log.mjs`).
- [x] Help › Copy Logs for Support, Show Logs in Finder, Export Logs… (`src/native/HostLogs.swift`, `src/native/log-support.ts`); `trezi logs [--since] [--follow]`.
- [x] Feedback diagnostics attach the last 30 minutes with consent; `docs/agent-guide/logs.md`.
- [x] Native chat smoke checks a turn's start and end lines in the test run's own log folder (`src/native/smoke-logs.ts`).
## Preview select slowdown with image attachments (LKM-171, issue #231)

- [x] Confirm LKM-165 transcript suppression and LKM-166 thumbnail caching; trace hover in WebContent and coalesce its redraw to one per frame.
- [x] Add a synthetic 100-hover regression test with two SVG attachments and 2 KB of pasted code.
- [x] Move latency assertions into the native sent-attachment fixture and stamp selection across page, host, service and Bun; cancel hover on mouseout, scroll and blur.
- [x] Record synthetic foreground hover and select timing with rendered SVG/code chat, including bridge hops and WebContent, and enforce the 16 ms / 50 ms budgets in the native fixture.
## Unstamped inspector fields (LKM-174)

- [x] Explain missing source links in the island, with Connect project to Trezi and Ask the agent actions.
- [x] Resolve one matching project CSS or CSS-module class rule for an unstamped selection; keep ambiguous matches read-only.
- [x] Cover Vite 8 React with a CSS module and an img in the setup fixture, plus class resolution and island state tests.
## Messages sent while a chat needs Resolve go to the queue (LKM-169)

- [x] One send rule (`src/native/chat-queue.ts`): a running turn, a landing, a park waiting for Resolve or a provider login queues the message with its reason; the queue drains when the block clears.
- [x] A backend Resolve refusal (`RESOLVE_NEEDED`) takes the message back into the queue: no error turn, no "Worked for 0s", no duplicate.
- [x] Queued messages can be edited (back into the composer) or removed.
- [x] `test/chat-send-queue.mjs` (unit) covers Resolve, the refusal race, running, landing and login; the native chat smoke edits and requeues a message.
- [x] Native `chat` smoke captures a parked Resolve card and one waiting queued message at 440 pt and 320 pt, checks the rendered reason and Resolve action, then confirms the queue sends once after the park clears.

## Standard feedback confirmation and alert sheets (LKM-170)

- [x] Sent feedback: an auto-dismissing "Feedback sent — View on GitHub" toast in the main window (`src/native/Toast.swift`, `NativeSheetController.toast`), no "Feedback sent" window.
- [x] Failed feedback: a standard sheet with Copy details, Cancel and Retry (default) that posts the same input again (`src/native/support-sheets.ts`).
- [x] Field-less presenter states are NSAlert-style sheets attached to the main window, sized to content, Return = default, Esc = cancel (`src/native/SheetAlert.swift`); Suggested fix and Update setup files opt in, Running servers and Git updates stay form windows.
- [x] Native capture check `src/native/smoke-alerts.ts` (group `settings`): updates alert, feedback error sheet, Retry, toast and its action.
## Long chat slows the app and edits never land (LKM-165, issue #230)

- [x] Root cause documented: the drift-park send guard refused the Resolve turn, and landing exceptions were swallowed (`docs/WORKTREES.md`, `docs/PROGRESS.md`).
- [x] A Codex→Claude chat lands after failed Codex turns; stale and stuck parks recover (`test/chat-landing-recovery.mjs`).
- [x] An unlandable turn shows Retry/Resolve/Discard with its reason; `workspace_state` never reports "pending".
- [x] Unchanged transcripts are not re-sent or re-decoded; mode switch and attachment add stay under 100 ms at 2,000 messages (`test/native-long-chat-perf.mjs`).
- [x] Trezi MCP tools pre-approved for Codex (`test/codex-mcp-approvals.mjs`).
- [x] Feedback sheet diagnostics consent; redacted bundle with `~` paths (`test/feedback-diagnostics.mjs`, `test/native-support-sheets.mjs`).
- [x] "Already running" is never a dead end: Bun and the service agree on what runs, the activity row names it and Stop works, a stuck turn or landing ends on its own with a note, and a message sent meanwhile is queued (`test/chat-stuck-turn.mjs`).
- [x] A failed Claude resume recovers: one canonical cwd for start and resume, a new session seeded with a chat summary and one note, no raw error (`test/claude-resume.mjs`, `test/claude-cwd.mjs`).
## Compact sent and composer attachment thumbnails (LKM-166)

- [x] Sent bubble: 72 pt aspect-fit thumbnails in a wrapping row (`src/native/ChatAttachments.swift`), checkerboard behind transparent SVG/PNG, the name on hover, a larger preview on click.
- [x] Composer tiles use the same cells (`src/native/AttachmentThumbnail.swift`); the strip is 84 pt.
- [x] Native `sent-attachments` smoke check (group `chat`) bounds thumbnail size, wrapping and text position, and opens and closes the preview.
- [x] Attachments never fail the turn: SVG/other formats send a 512 px PNG preview and keep the original by path, other files go by path, oversized rasters are downscaled, leftovers are named (`src/native/chat-attachments.ts`, `AttachmentPayload`; `test/chat-attachments.mjs`).
## Editing inspector island click-through and ghosting (LKM-162)

- [x] The island's frame takes the pointer (`NativeEditingInspector` hit-test fallback, swallowed clicks and scrolls) and `PreviewWebView` (`src/native/PreviewPointer.swift`) gates WebKit's tracking areas, first-responder moves and clicks by the window's hit view.
- [x] Opaque island surface under the controls; native smoke (`checkPointer` in `src/native/smoke-inspector-island.ts`) hit-tests field, slider and tabs, counts what reaches the page, and edits padding-top through the real field.
## Current Claude and Codex models (LKM-164)

- [x] Bump `@anthropic-ai/claude-agent-sdk` (0.3.186 → 0.3.289) and `@openai/codex-sdk` with its `@openai/codex` CLI (0.154.0 → 0.160.1) in `package.json` and `bun.lock`; no API changes needed, backend and provider-helper bundles build.
- [x] `model-catalog.json` entries carry the SDK/CLI `harness` stamp and are ignored after a bump; daily refresh (`CATALOG_TTL_MS`, hourly due-check, Claude written once a day).
- [x] The init message's resolved model labels the Model picker's selected row (`src/shared/model-label.ts`, `model` event relayed by `ProviderFrames.swift`).
- [x] Codex fallback, background comments and PR descriptions on `gpt-6-sol`/`gpt-6-astra`; Claude aliases kept.
- [x] `test/model-catalog.mjs`, `test/model-label.mjs`, `test/provider-data.mjs`, `test/provider-owner.mjs`.
- [ ] Operator, after merge: ask each seat "which model are you" and check the picker label (live).
## Agent file access, full by default; symlinked paths (LKM-163)

- [x] Codex gets the real worktree path; the Claude guard compares as-given and resolved paths (`realPath` in `src/main/agent-file-access.ts`), tested with the profile's `Trezi Native` alias.
- [x] Settings → General → Agent file access (`trezi:agent-file-access:v1`): Full access (default, Codex `danger-full-access`) or Project only (LKM-156 sandbox); passed to every helper session.
- [x] Worktree isolation in both modes: the Claude guard unchanged; Codex direct live writes in Full access named in one chat note (`src/main/backends/live-tree-watch.ts`).
- [x] `test/live-write-guard.mjs` covers both modes and symlinks; `test/agent-file-access.mjs` drives the adapter with a stand-in CLI.

## Split chat-isolation.ts, one unpark and one landing (LKM-159, F5)

- [x] `clearPark` (`src/main/chat-park.ts`) at all 9 unpark sites; no other `parked = false`.
- [x] `landTurn` (`src/main/chat-landing.ts`) is the landing for `afterTurn`, Keep and a clean Resolve, covered by `test/chat-landing.mjs`.
- [x] Park records, helper sync, parked-chat actions and state in their own modules; `setup.ts` imports `chat-helpers.ts`; `stopped-turn.ts` uses `stoppedHold`/`markStoppedReverted`/`landStoppedTurn` instead of `ChatState`; `chat-isolation.ts` is 417 lines.
## Bash and Codex writes to the live checkout (LKM-156, F2)

- [x] Claude `PreToolUse` hook denies Bash commands that name the live root from a worktree chat, with the worktree path (`src/main/live-write-guard.ts`); reads included, documented in `docs/WORKTREES.md`.
- [x] Codex and Responses connections: worktree-only `workspace-write` sandbox, user `writable_roots` dropped, temp roots excluded when they overlap the live tree (`src/main/backends/codex-sandbox.ts`), proven against the real CLI in `test/live-write-guard.mjs`.
## Project-relative sources in every agent prompt (LKM-155, review F1)

- [x] One helper, `projectRelative` (`src/shared/project-path.ts`), replaces `projectRelativeSource` (selection-context) and `projectPath` (dev-error, now `{ served: true }`).
- [x] Controls/animation, props, text, style, Svelte props/text/style, move and the inspector's text fallback prompts name stamp sources relative to the project root; the three movers share `src/main/move-node-agent.ts`.
- [x] `test/project-path.mjs` (unit): helper cases plus every prompt from absolute stamps under a fake live root.
## Typed island override wire format (LKM-161, review follow-up F8)

- [x] `IslandOverrideMessage` lives in `src/shared/preview-channels.ts`; `islandPreviewPort` sends it and the preview narrows to it; `test/types/island-override-wire.ts` rejects malformed messages at compile time.
## Split Host.swift menus and test broker (LKM-160, review F6)

- [x] Menu bar (Trezi, File with Open Recent, Edit, Actions, Develop, Window → Activity ⌘L with its badge) in `src/native/HostMenus.swift`; test-broker inspect/perform/verification/capture commands (incl. `activityInspect`, `activityMenu`, `settingsMenu`) in `src/native/HostInspect.swift`. `Host.swift` 618 → 325 lines; no behaviour change.
- [x] Both files in the `scripts/build-native.mjs` host list; `docs/SWIFT-BACKEND-EVENTS.md` Host/Activity anchors point at the current lines (removed cases marked with the ticket that removed them).

## Review of recent changes and commit audit (LKM-154)

- [x] Review report with findings by severity and a commit audit of `ee301e2..515779b` (`docs/REVIEW-2026-10.md`); no history rewritten, no reverts.
- [x] Safe cleanups: unused `unread`/`unreadLevel` in `src/native/Activity.swift`, unused `readFile` import in `src/main/backends/claude.ts`; `test/setup-vite.mjs` no longer depends on Bun's global install cache.
- [ ] Follow-ups F1–F8 in `docs/REVIEW-2026-10.md`. Relative sources in every prompt, Bash/non-Claude live-write guard, re-offer setup after `done`, lint baseline, split `chat-isolation.ts` and `Host.swift`, commit subjects, typed island-override messages.
- [x] F3 (LKM-157): a `done` project whose restarted preview stays unstamped for `verifyGraceMs` becomes `unstamped` and offers Reconnect; stamps return it to `done`; Not now is remembered.
- [x] F4 (LKM-158): Biome formatter and organizeImports over `src` + `test`, the remaining lint errors fixed, `test/fixtures/**` and the cat SVG assets overridden in `biome.json`; `bun run lint` exits 0 and `test/lint.mjs` runs it in the unit tier (quick verification).

## Activity opens only when attention is needed (LKM-152)

- [x] Every Activity line has a severity (info, warning, needs-action); only needs-action opens the window, once per event kind per session (`src/native/activity-controller.ts`). Needs-action: failed project open, dev-server crash loop (`NativePreviewSupervisor` gave up), damaged repository/source journals.
- [x] Startup recovery notices are gray `notice` lines; restored chats and rolled-back source changes collapse into one summary line (`src/native/activity-startup.ts`).
- [x] Unread dot in the sidebar and a badge on Window → Activity (⌘L, replaces Actions → Toggle Logs); viewing Activity clears both (`src/native/ActivityIndicator.swift`).
- [x] Settings → General → Show Activity automatically: Never / For problems that need me (default) / Always (`trezi:activity-auto-open:v1`).
- [x] Tests: `test/activity-attention.mjs`, `test/native-settings.mjs`, `test/native-support.mjs`; native `sheets` (unread dot, ⌘L), `chat-gate` (failed open raises Activity without taking key) and `settings` checks.
## Shadow Light drags without flicker (LKM-140)

- [x] Formula (H3) and write order (H2) measured and refuted; HMR swap gap (H1) is the remaining cause (`test/island-flicker.mjs`, numbers in PROGRESS).
- [x] Shadow block drag frames show through an isolated-world box-shadow override; one source write per gesture (release or 600 ms idle); override removed only once the page's own style shows the final value; one Undo group; LKM-133 conflict rules kept.
- [x] Native `shadow-light` check: 8-step drag with 0 gaps, 0 out of order, 0 foreign and no write before release; `shadow-light-drag.png`, `shadow-light-released.png`, `shadow-light-drag.json`.
- [x] Real Next.js (`/shadow-flicker` in `test/fixtures/next-app`) and Vite/CSS (`test/fixtures/island-flicker-vite`) scripted drag measurements: `test/island-flicker-frameworks.mjs` logs `ISLAND-FLICKER next-*` and `vite-*` counts (requires TreziHost + `bun install` on the fixtures).
- [x] Reopen fixes: `settle()` never treats disconnected targets (Next HMR remount) as settled, re-finds the bound elements and holds them before paint (MutationObserver); removal needs shown and own to equal `computed(css)` (`test/island-override.mjs`). Harness injects the production module, waits for the dev server to serve the reverted source and reloads until the card matches, with observed-vs-expected errors.
## Keychain and network-volume prompts after stable signing (LKM-144)

- [x] Rebuild loop `test/keychain-rebuild.mjs`: the helper builds byte-identical (same CDHash) across folders; on a temporary keychain the rebuild reads the first build's item with no UI, and changed code is refused. No-UI calls only; the keychain part SKIPs where no keychain can be created. A manual probe found that "Trezi Local" items trust the designated requirement, and ad hoc items the CDHash.
- [x] Repeated migration prompts: `ProviderData.crypto` runs `TreziSecrets` one call at a time with a 180 s timeout (was parallel, killed at 30 s). Test: `test/provider-data.mjs` `keychain-serial`.
- [x] Migration idempotent and tested (`test/keychain-migration.mjs`). The delete of the old item may ask once; manual cleanup and the expected prompts are documented (README, `docs/PROVIDERS.md`).
- [x] Network volume: the access comes from the Claude CLI process, outside its own Bash sandbox, so no Trezi setting can stop it while the sandbox stays on. Documented, plus a one-time status line on the first Claude turn (`src/native/network-volume-note.ts`, `test/network-volume-note.mjs`).
- [x] Bundle ID `dev.praxis.native` kept and recorded as legacy (`docs/agent-guide/legacy-names.md`).
- [ ] Manager/operator: run the login-keychain steps in `docs/PROVIDERS.md` (LKM-144) on the operator Mac. Record whether a `cdhash:` partition exists and whether a rebuild asks again. Also run `bun run test:keychain-rebuild` outside a sandbox so `rebuild-read` PASSes rather than SKIPs.
## Chat footer regression from LKM-145/147 (LKM-149)

- [x] Counter line only on the running turn; the latest response keeps it empty once done (completion moves nothing), and older responses have one 28 pt footer row (`ChatLayout.footerHeight`).
- [x] `ChatLatestSettle.step` never settles while the latest row is below (or not measured at) the reading edge: it relayouts in place (`.relayout`) and re-measures. A pin unresolved three times relayouts too; settled must hold on two consecutive frames; the marker nudge is reset when a settle ends.
- [x] Tests: `native-chat-latest-settle` (`--cases`: settle/relayout/escalation decisions and 28/44 pt footer heights; offscreen samples end at the reading edge without exhausting the settle), `native-chat-scroll` progress stage (running footer 44 pt, history footers 28 pt) and chat acceptance (every capture: history footers 28 pt, latest 44 pt).
- [ ] Manager: repeated chat-acceptance passes (the worker had 3 native calls; see PROGRESS).
## Git-version-independent patch error messages (LKM-150)

- [x] Parser: `src/service/GitMessages.swift` parses each `git apply` `error:` line into reason, file and line; both location spellings (2.50 "line N", 2.55 "<patch>:N") read the same and no scratch patch path reaches a message.
- [x] Tests: `test/git-messages.mjs` (unit) pins recorded 2.50 and 2.55 stderr; the real-git `malformed-patch` section asserts the parsed fields.
- [x] Audit: the three-way conflict check reads unmerged index entries instead of Git's text; the publish push retry keys on the untranslated ref status (`GitMessages.pushRejected`). No other Git-stderr match in `src/service` or `src/main`.
- [x] CI prints `git --version` in the Toolchain step.
- [ ] Manager: confirm on the next candidate CI run (git 2.55 runner).

## Dependency changes never break the preview (LKM-146)

- [x] Reproduction findings documented (PROGRESS 2026-10-01). A chat install wrote through the `node_modules` link into the live tree; a crashed server left the preview dead.
- [x] Worktree isolation: each worktree has its own `node_modules`, an APFS clone of the live one when the manifests match, otherwise its own install. The legacy link is removed (`EditingProject.dependencyState`, `provisionDependencies`). Rationale in `docs/WORKTREES.md`.
- [x] Landing: stop → "Installing dependencies…" (`devserver:install`, live checkout) → start → reload preview.
- [x] Recovery: exit reason plus health probes in the runtime owner; `preview-supervisor.ts` restarts with backoff (1/2/4/8/16 s); PreviewStatus shows the reason and Restart.
- [x] Tests: editing-owner `dependencies`, chat-worktrees (live untouched), native-workspace-controller (landing order), preview-supervisor (new), runtime-owner `exit and health`.
- [ ] Manager/operator: on a real Next and a real Vite project, add and remove a dependency in a chat, land it, and confirm the preview comes back by itself. Not possible in the worker sandbox (no port binding or registry).

## Live turn progress: timer, current step, streaming tokens (LKM-147)

- [x] One status line: the current step and its elapsed time ("Running bun test · 1:24", "Thinking · 0:45"), ticked by a local one-second clock (`ChatActivityClock.swift`). The owner's "Still thinking…" is a `progress` step, not a transcript row.
- [x] Live tokens: Claude's partial messages add a throttled chars/4 output estimate between usage reports (`stream-usage.ts`); the counter is the running activity's, on its own line under the status, and gone when the turn ends (LKM-145 layout).
- [x] Helper heartbeat every 5 s while a turn is open; "No activity for N min" only after 60 s with no event or heartbeat. Heartbeats never count as output for the owner's deadlines.
- [x] Tests: `test/turn-progress.mjs` (estimate, heartbeat, clock), `test/native-chat-controller.mjs` (progress reduction, live counter), `test/provider-cold-start.mjs` (heartbeats through the owner, no "Still …" status), native-chat-scroll progress stage (one ticking line, idle hint, counter row, footer height) at 440/320 pt.
## Stable app identity and no surprise permission prompts (LKM-137)

- [x] The build signs the app, the XPC service, the helpers and the bundled Bun with one identity: `TREZI_SIGN_IDENTITY`, else Apple Development, else "Trezi Local" (created once in the login keychain). "Trezi Local" builds pin the designated requirement to identifier + certificate. Ad hoc fallback with one warning line (`scripts/signing.mjs`).
- [x] Keychain work moved to its own stable binary `Contents/Helpers/TreziSecrets` (`src/native/Secrets.swift`). The master key migrates once from the earlier item to `dev.trezi.native.secrets`, and the old item is deleted only after the write. New items get an access list that trusts the helper.
- [x] Photos trigger: Check login without a project ran the helper and `claude auth status` with cwd `$HOME`. Helpers never run in a home, `/` or an ancestor (`ProviderHelperProcess.workingDirectory`). Check login, the login-shell probe and `skills add -g` use the temporary folder.
- [x] Tests: `test/signing-identity.mjs`, `test/keychain-migration.mjs`, `test/provider-login.mjs` `helper-cwd`. Docs: README "Code signing" (one more Keychain approval, then none), `docs/PROVIDERS.md`, `docs/agent-guide/legacy-names.md`.
- [x] Review fixes: an identity that cannot sign (locked keychain, denied key access) re-signs every piece ad hoc with the one warning instead of failing the build; a real "Trezi Local" signature in a temporary keychain proves the designated requirement is the same across two builds.
- [ ] Manager/operator: after this build, confirm on the operator Mac that `codesign -d -r- out/native/Trezi.app` stays the same across two rebuilds, and that the Keychain asks once and then not again.
## Token counter only while working; Copy/Revert on hover (LKM-145)

- [x] Counter only while a turn runs, on its own line under the status; finished responses have none. The footer always reserves the counter line (and a hidden "Worked for" placeholder holds its line while running), so completion moves nothing above it.
- [x] Copy/Revert always laid out, glyphs hidden until the message is hovered or a button has keyboard focus; explicit accessibility labels, still focusable.
- [x] `native-chat-scroll` `progress` stage: running/done/hover captures at 440/320 pt; frames unchanged on completion and with/without hover (in-app hover override).
- [ ] Manager/operator: VoiceOver and Full Keyboard Access check of Copy/Revert on a real session (the SwiftUI accessibility tree cannot be read without an assistive client).
## Token counter inline; centered scroll-to-latest button (LKM-141)

- [x] No pinned counter above the composer; each turn counts its own tokens on its response (chat total kept in the tooltip and mirror).
- [x] Running: counter right after the Thinking…/working status, secondary style.
- [x] Done: counter under the response's Copy/Revert row; the footer keeps one height, so completion does not move the transcript.
- [x] Latest button: round chevron.down, centered over the column, 8 pt above the composer, inside the composer clearance; visibility logic and label unchanged.
- [x] Fixtures: composer-layout placement at 320/440/521 pt, acceptance scrolled-up captures at 440/320 pt, chat-scroll running/done token captures at 440/320 pt.
## Versioning: SemVer, changelog, tags and app version (LKM-143)

- [x] package.json `version` is the one SemVer source; build number = commit count of HEAD, plus the short sha (`scripts/version.mjs`).
- [x] Trezi.app and the XPC service Info.plists carry CFBundleShortVersionString, CFBundleVersion and `TreziCommit` (no hard-coded 1); the backend and provider-helper bundles carry the label.
- [x] `trezi --version`, Settings › General › Version and About Trezi show "Trezi X.Y.Z (build N, sha)".
- [x] CHANGELOG.md (Keep a Changelog, Unreleased, seeded), union merge, AGENTS.md rule.
- [x] `bun run release <major|minor|patch>`: main + clean tree only; bumps, moves Unreleased, commits, annotated tag, no push.
- [x] CI `scripts/check-version.mjs`; `test/versioning.mjs` (unit) covers the release script in a temp repo and the plist values.
- [ ] Cut the first native release from main: `bun run release minor` → 0.1.0 (maintainer, after merge).
## Short paths; chat worktree cleanup (LKM-136)

- [x] One display-path formatter (`src/shared/display-path.ts`): project-relative paths, "chat workspace" / "Trezi data" / "temporary patch" / "recovery copy" labels, never truncated mid-path.
- [x] Collapsed chat tool rows, the activity line, error/conflict cards, Activity lines and the preview error use it; full paths only in expanded rows, tooltips, Copy and Copy All. Logs and the ledger unchanged.
- [x] Idle cleanup (default 7 days, Settings → General), lazy recreate on the next turn; parked, running and dirty checkouts kept (dirty work to an `idle-<id>` recovery ref).
- [x] Closing a chat removes its clean checkout; old-name worktree folders removed once migrated or empty.
- [x] Settings shows the chat workspaces' disk use and "Clean up now".
- [ ] Manager: foreground check of Settings → General (usage row and Clean up now) in the native capture.
## Preview inspection tools; the WebKit preview over external browsers (LKM-138)

- [x] `preview_inspect`, `preview_evaluate`, `preview_console`, `preview_viewport` and element-cropped `preview_screenshot` run on the live preview through an isolated WKContentWorld (`TreziAgent`, no message handler); results are bounded and sanitized.
- [x] `preview_evaluate` is read-only and bounded: parse-time rejection of loops and dynamic code, a membrane that throws on writes, navigation and storage, read-only call allowlist, 2 s and 64 KB limits.
- [x] Exposed to Claude (in-process MCP and helper route) and Codex (MCP bridge); provider policy lists in TS, Swift and the golden fixture agree.
- [x] Rules v25, the trezi-preview skill, README and PROVIDERS prefer the preview tools; agent-browser only for scripted multi-step interactions.
- [x] Claude chats skip the user's own Claude Code plugins and MCP servers (`strictMcpConfig`, `enabledPlugins` false) but keep CLAUDE.md files and skills; Settings › General "Allow my Claude Code plugins in Trezi chats", off by default and persisted.
- [x] Proof: `test/preview-agent-tools.mjs` (unit), `test/native-settings.mjs`, `test/rules.mjs`, the helper/MCP tool lists, and the native `agent-preview` check in the core group.
- [ ] Async microtask recursion in `preview_evaluate` can still keep the page busy until the time limit; consider running evaluate off the main world's event loop if it bites.

## Claude first turn: no false "did not respond" (LKM-135)

- [x] Cold-start phases (helper ready, auth probe, CLI started, session init, first model event, no-response/exit) logged at debug level in the service log.
- [x] Deadline by phase: 90 s only until the CLI starts; then 10 min for the session init and the first output, renewed by `phase`/`progress` reports; "Still starting Claude…"/"Still thinking…" after 20 s instead of an error.
- [x] The no-response card (and a pre-output exit) names the phase it stopped in.
- [x] Auth probes once per app session (owner cache passed in `open`), bundled and installed in parallel, re-probed after a sign-in failure, a saved token or Check login.
- [x] Pre-warm: the Claude helper and CLI start when the chat opens (checked by the `cli` phase before any send).
- [x] `test/provider-cold-start.mjs` (unit): slow init/think/progress pass, three kinds of hang still fail with the named phase, probes parallel and cached.
- [ ] Codex and Gemini helpers report no phases yet (they keep the LKM-119 90 s deadline).
## Startup recovery reports each interrupted operation once (LKM-134)

- [x] Journal version 2: the service resolves every open interrupted entry when it opens the journal (synced first), so `status.recovered` reports each at exactly one launch; refs are kept.
- [x] Version 1 journals: open entries (already reported at every earlier launch) are closed silently and counted in `closedEarlier`; one summary line.
- [x] Saved work is reported at info level (missing/unreadable refs as a warning, not red); only a damaged journal is an error (`recoveryNotices`).
- [x] Activity › Recovery Refs… lists kept refs and deletes only selected, confirmed refs still at the listed commit (`recoveryRefs` / `deleteRecoveryRefs`). Nothing deletes them automatically.
- [x] `test/repository-recovery.mjs` (unit): once across two restarts, legacy close with one summary line, explicit delete.

## Shadow Light without a preview box; islands apply live (LKM-133)

- [x] Root cause of "Source changed. Reload before applying your adjustment." (also right after Reload): writes were checked against the whole-file hash the UI last rendered, and the owner's batch chain was dropped before the refreshed view reached Swift. Writes now check the island's own bindings (`writeIsland` + `ChatIslands.seen`); unrelated edits in the file are kept.
- [x] A bound value changed outside the island: nothing is written, no error card; the controls refresh to the source with an inline notice and the rest of that gesture is dropped.
- [x] One island's queued commits of a gesture coalesce (latest value wins).
- [x] Every control writes through one path (`IslandLiveWrites`, 80 ms throttle, one gesture id = one Undo group); typed fields apply on Return and blur and never write invalid values (`IslandEntry`).
- [x] Shadow Light panel has no Preview box; the capture semantics fail on a "Preview" label.

## Trezi names only, read compatibility kept (LKM-132)

- [x] XPC service `dev.trezi.service`; the build leaves no other service in `Trezi.app/Contents/XPCServices` (checked by `test/distribution.mjs`).
- [x] Agent tools `mcp__trezi__*` (Claude MCP server, Codex bridge, plugin namespace, provider policy in TS and Swift).
- [x] `bin/praxis` alias and old MCP entrypoint removed; `install.sh` stops linking it and removes its own old link; installer and README URLs use `alikimovich/trezi`.
- [x] Preview IPC aliases and legacy code identifiers removed; `PRAXIS_*` env, `~/.praxis` installs, profile, preference, branch, sidecar and stamp readers kept as documented shims.
- [x] One list of shims: `docs/agent-guide/legacy-names.md`, linked from AGENTS.md and enforced by `test/legacy-names-audit.mjs`; `docs/rename/` and `scripts/audit-rename.mjs` deleted.
- [x] One-time project migration (`EditingLegacyNames.swift`): automatic on a clean tree. On a dirty tree only after the user confirms in a sheet (`src/native/legacy-names.ts`). Never commits. Covered by `test/legacy-names-migrate.mjs`.
- [ ] Manager: run `codex-mcp`, `codex-model` and `provider-helper-tools` unsandboxed (Unix socket listen).

## Trezi tools work from provider helpers (LKM-131)

- [x] Audit every agent-exposed Trezi tool (Claude's in-process `praxis` server and the Codex bridge). The tools that need main's state are `chat_island`, the preview observers, `open_preview`/`open_code`, Gen UI, `workspace_state`/`prepare_conflict_resolution` and `install_skills`; the calculators are pure. Table in `docs/PROVIDERS.md`.
- [x] In a helper, `sessionTool` (`src/main/session-tools.ts`) sends those tools to main as helper `tool` frames. The Swift owner authorizes them against the grant first, and main runs them with the session's scope. The helper host settles tool answers outside its frame queue, since Codex's bridge check runs while opening.
- [x] `test/provider-helper-tools.mjs` (unit): the real helper with stand-in CLIs calls every tool. The test checks main's real answers, an island round trip, owner refusals for a background session, and that no tool answers with a missing-service error.
- [ ] Manager: run `bun run test:provider-helper-tools` unsandboxed (the Codex bridge listens on a Unix socket).

## Web Inspector must not cover the chat (LKM-129)

- [x] The preview's inspector attachment view (WebKit SPI `_setInspectorAttachmentView:`) sits in `PreviewInspectorSlot` (`src/native/Inspector.swift`), sized to the preview area, so a docked Web Inspector stays right of the chat and below the toolbar and resizes with the preview. The page and the LKM-122 island take the rest of the area. No detached fallback was needed.
- [x] `show` no longer calls `detach` first (it did nothing before the first open, so the inspector opened docked over the whole window). Open, close, show again and the ⌥⌘I / ⌥⌘C shortcuts are unchanged.
- [x] Core smoke `preview-inspector` runs `src/native/smoke-preview-inspector.ts`: the docked frame lies within the preview area and clears the chat column and page at the default, minimum, wider and restored window sizes, with the island open. Chat and inspector hit targets, and the page after closing, are checked too. Evidence: `preview-inspector-docked.png`, `preview-inspector.json`.

## provider-login test independent of the machine's keychain (LKM-127)

- [x] Every `test/provider-login.mjs` fixture gets a stand-in `security` through `--claude-security=` unless a part names one; no report depends on the default login keychain. No production change.
- [x] New `real-keychain` part: `/usr/bin/security` from the test and through Check login must agree (list, default, item lookup); with no user keychain it prints `PROVIDER-LOGIN real-keychain SKIP` and both exit codes. No keychain is created and the search list is never changed.
- [x] Native `sheets` smoke: Settings OCR check tolerates Vision reading "Default model" as "Detault model" (`f`/`t` fold in `src/native/settings-verification.ts`, cases in `test/native-settings-evidence.mjs`).
- [ ] Manager: the next candidate CI run is green on `macos-26` (the CI failure itself was not reproduced locally, see PROGRESS).
## Codex model fallback: detect the real CLI error stream (LKM-128)

- [x] Detect the rejection in stream `error` and `turn.failed` events (JSON body with nested `error.message`) and in the exec error (`unsupportedCodexModel`).
- [x] Warning items and unknown item types before the request do not count as output, so they no longer block the fallback (`OUTPUT_ITEMS` in `src/main/backends/codex.ts`).
- [x] `test/codex-model.mjs`: the stand-in reproduces the real CLI (two stream errors, exit 1 with "Reading prompt from stdin..."), plus `turn.failed`-only, exec-only, warning-first and explicit-model runs; no-model turns fall back; status line and no-model-left error kept; in-process and helper.
- [ ] Operator: rerun `TREZI_LIVE_PROVIDERS=1 bun run test:provider-live` on the real CLI.

## Codex seat: supported default model and MCP isolation (LKM-126)

- [x] A seat turn rejected with "not supported when using Codex with a ChatGPT account" falls back to the next listed model, says so in a status line, and keeps it for the chat (`src/main/backends/codex-model.ts`).
- [x] The rejection is remembered in-process and in main (read from the helper's status line). Later chats and Default skip the model, and the picker and persisted catalog drop it until the next probe. With every model rejected, the turn ends in a clear error.
- [x] Personal MCP root cause: plugin `.mcp.json` servers (mcp.vercel.com) and `apps` connectors are outside `mcp_servers`. `isolatedCodexConfig` now also sends `features.plugins=false` and `features.apps=false`, for both the in-process and helper paths.
- [x] Tests: `test/codex-mcp.mjs` (installed-plugin fixture against the real CLI) and `test/codex-model.mjs` (stand-in CLI, in-process and helper, fallback, memory, picker, clear message, real-CLI MCP inventory per run).
- [ ] Operator: after merge, rerun `TREZI_LIVE_PROVIDERS=1 bun run test:provider-live` (LKM-113 part 2).
- [ ] Manager: run `test/codex-mcp.mjs` and `test/codex-model.mjs` unsandboxed. The worker sandbox refuses the Trezi tool bridge's Unix socket.
## Claude seat: read the subscription login from the user session (LKM-124)

Root cause of the reported "not logged in" is open (Keychain/service context, see LKM-125); the allowlist below is hardening for one cause found on the way.

- [x] Helper allowlist: explicit Claude/Codex user settings plus proxy/CA, instead of the `CLAUDE_`/`CODEX_` prefixes; a parent Claude Code or Codex session's variables (incl. `CLAUDE_CODE_SIMPLE`) are dropped.
- [x] Check login lists passed and dropped variable names (never values) and flags `CLAUDE_CODE_SIMPLE`.
- [x] `test/provider-login.mjs` parent-session: env filtering (Claude and Codex), a bare-mode-aware stand-in CLI, the report and the setup-token path.
- [x] Root cause and allowlist in `docs/PROVIDERS.md` and `docs/SWIFT-BACKEND-PROVIDERS.md`.
- [x] Check login runs the Keychain probe (`security find-generic-password`, list-keychains, default-keychain) and a credentials-file stat inside the helper; typed report fields; deterministic test with a fake `security`.
- [ ] Operator: run Check login on the operator Mac and record the helper's Keychain/credentials lines in the `docs/PROVIDERS.md` three-context table (live, no model call); pick the LKM-125 fix from the result.
- [ ] Operator: start Trezi from a Claude Code shell with a normal `claude login` and confirm Check login says logged in (live, no model call).
- [ ] `src/main/diagnose.ts` (preview "Find a fix…") still inherits Bun's environment.
## Service keeps the user's Keychain (LKM-125)

- [x] The XPC service plist sets `JoinExistingSession` (`scripts/service-info.mjs`): the service, Bun, the `TreziHost --crypto` helper and provider helpers stay in the host's security session under `bun run dev` and `open -a`.
- [x] Check login reports `security list-keychains` / `default-keychain` exit codes from the helper (`keychain` field and detail line), never their output.
- [x] Tests: `service-session` (plist, probe), `provider-login` (keychain fields), native settings step `security-session` (host and service child share one session).

## Inspector as a floating island over the preview (LKM-122)

- [x] `NativeEditingInspector` is a Liquid Glass island (composer inset 10, radius 24; `NSVisualEffectView` popover before macOS 26) floating on the preview's right edge. `WorkspaceLayout` no longer subtracts it from the preview, so opening or closing it never reflows the page.
- [x] The island's height is the preview area minus the insets (above a docked source editor, below the toolbar); its fields scroll inside it. Dragging its left edge resizes it within 220–500, saved through `native-layout-sizes`.
- [x] Core smoke `inspector` runs `src/native/smoke-inspector-island.ts`: equal preview frames open/closed at the default and minimum windows, the clamped saved resize, toolbar clearance, hit targets around the island and scrolling at the minimum size. Evidence: `inspector-island-{default,narrow}-{open,closed}.png`, `inspector-island.json`.
## Settings: the native split-view sidebar (LKM-123)

- [x] Settings is a full-size-content window whose `NSSplitViewController` (`src/native/SheetSidebar.swift`) starts with a non-collapsible `NSSplitViewItem(sidebarWithViewController:)` (180–260 points) under the traffic lights, hosting a `.sourceList` `NSOutlineView`.
- [x] `src/native/SourceList.swift`: outline setup, symbol/label cell, scroll view and sidebar item shared with the projects sidebar (same row height, icon size, selection style, insets).
- [x] Arrow keys change the section; the window title names it. Detail pane, autosave, Command-, and Trezi → Settings… unchanged.
- [x] Tests: `native-settings-layout` (sidebar behavior/style, shared geometry, arrow keys, title), `native-settings-evidence` (parity and title rejection), native `sheets` step (parity with `shellInspect.sourceList`, arrows, foreground captures of every section, `settings-parity-projects-sidebar.png`).

## Claude seat: login detection and stuck turns (LKM-119)

- [x] Helper environment: allowlist unchanged, `USER`/`LOGNAME`/`HOME` from the account record and a default `PATH`; same cwd. Root-cause note in `docs/PROVIDERS.md`.
- [x] First-event deadline (90 s): "Claude did not respond — check login (claude auth status) and retry"; crash/exit/auth always an error; the next message reopens the helper.
- [x] "Not logged in" and `/login` are a login card (steps, Check login, Retry), not assistant text.
- [x] Check provider login through the helper path (`diagnose`), from the card and Settings → AI providers → Claude….
- [x] Subscription token field (Keychain-encrypted), injected only into Claude helpers as `CLAUDE_CODE_OAUTH_TOKEN`.
- [x] Installed `claude` used when it is logged in and the bundled CLI is not.
- [x] Deterministic `test/provider-login.mjs` (silent, missing/invalid auth, token, diagnose, card). No live calls.
- [ ] Operator: confirm with a real signed-in and signed-out Claude seat (live, needs authorization).
## Standard macOS Settings window with a sidebar (LKM-121)

- [x] Source-list sidebar with SF Symbols (General, AI Providers, Experimental); detail pane with large title and grouped rows (label and description left, control right).
- [x] General: default model. AI Providers: the providers sheet inline (button and sheet removed). Experimental: Gen UI, explanation, engine. Keys and autosave unchanged.
- [x] Window remembers the last selected section (`trezi:settings-section:v1`).
- [x] Gear removed from the main sidebar; Settings opens from Trezi → Settings… / Command-, with and without a project.
- [x] Foreground captures of every section at the minimum and default size, the no-project open and the gear-free sidebar.
- [ ] Back/forward buttons (skipped; optional in the issue).

## Simplify the code editor toolbar (LKM-118)

- [x] `src/native/SourceEditor.swift`: no Save, Reload or Open in Editor buttons. Back/forward icons sit left of a selectable path; pop out/dock (`arrow.up.left.and.arrow.down.right` / `arrow.down.right.and.arrow.up.left`) and close (`xmark`) are icon buttons on the right edge, with tooltips and accessibility labels.
- [x] ⌘S saves and ⌘R reloads while focus is inside the editor (same dirty-reload prompt and conflict handling); elsewhere ⌘R stays Reload Preview.
- [x] Core smoke `source-editor` (`src/native/smoke-source-editor.ts`): toolbar layout docked and popped, the shortcuts through the window's key-equivalent pass, conflict, discard prompt and path copy. Evidence: `source-toolbar-popped.png`, `source-toolbar-docked.png`.
## GitHub CI green for the native app (LKM-117)

- [x] `.github/workflows/ci.yml` runs on `macos-26` (Xcode 26, macOS 26 SDK, asserted by `bun scripts/requirements.mjs --build`): frozen install, `typecheck`, `typecheck:native`, unit tier with `--timeout-ms=120000`. No native GUI or live tier.
- [x] Triggers: push to `main`/`candidate` and pull requests only.
- [x] Swift-compiling unit tests SKIP with a reason off macOS (`test/helpers/darwin.mjs`); a Linux unit run exits 0 with SKIP reported apart from PASS.
- [x] `docs/TESTING.md` "GitHub CI".
- [ ] Operator: confirm a green GitHub run on the next `candidate` push.
## One-command install for users and development (LKM-116)

- [x] `install.sh` installs missing Bun (official installer, then on PATH) and starts and waits for the Xcode command-line tools; the version checks stay.
- [x] `--channel main|candidate` (and `TREZI_CHANNEL`), default main; a re-run keeps the installed channel unless one is given.
- [x] Inside a checkout (`./install.sh`, `bun run setup`): that checkout as it is (no clone, branch switch or pull without `--update`); links follow the last install and the script says which.
- [x] Finish: `claude setup-token` offered when the CLI is signed out (skipped unattended), then Trezi opens (`--no-open`). Re-runs update and rebuild.
- [x] README Install section: the user, tester and dev commands. `test/install-update.mjs` covers all of it with fake bun/curl/xcode-select/git/claude.
- [ ] The one-liner fetches `install.sh` from main, so `--channel candidate` works from that URL only once this installer reaches main.

## Slider tick marks in the inspector and chat islands (LKM-115)

- [x] Inspector and chat-island sliders use `SnappedSlider` (`src/native/SnappedSlider.swift`): no `step:` and so no tick marks, with snapping in the binding setter using the same default steps.
- [x] Windowless regression `test/native-slider-ticks.mjs`: no stepped `Slider` in `src/native`, `numberOfTickMarks == 0` on the real inspector field and on an island slider, and values still snap to the step. Evidence: `inspector.png`, `chat-island.png`, `shadow-light-*.png`.
## Remove content controls (LKM-114)

- [x] Removed the `content_controls` agent tool (Claude, Codex MCP bridge, custom endpoints, provider policy), `src/main/content-controls*.ts`, the native content controller and `ContentWindow.swift`, the Swift content-drafts store and the `content-controls.json` sidecar allowance, `PanelRecipe`, `vendor/content-controls` (package.json, bun.lock, .gitignore), the surface-controls skill wiring, the tests and `docs/CONTENT_CONTROLS.md`. Rules v24.
- [x] Users' `.trezi/content-controls.json` and profile `service/editing/content-drafts/` are left untouched and no longer read.
- [ ] Optional cleanup: the dated inventories (`SWIFT-BACKEND-AUDIT/MODULES/ROUTES/EVENTS/CONTRACTS/PLAN/ROADMAP`, `ELECTRON-REMOVAL`, `rename/*.json`) still list content-controls files as history.

## Codex live parity and MCP isolation for Codex sessions (LKM-113)

- [x] Part 1: Trezi's Codex sessions (chat turns and the project-memory pass) switch off every MCP server declared in the user's `$CODEX_HOME/config.toml`, re-read per turn (`isolatedCodexConfig`, `src/main/backends/codex-mcp.ts`). Proven without provider calls in `test/codex-mcp.mjs`: a fixture `CODEX_HOME` declaring `vercel` and a stdio server; the real CLI loads both without isolation, and the session reports both `disabled` with it.
- [ ] Part 2 (operator): after the Codex quota resets (2026-10-03 10:10), run `TREZI_LIVE_PROVIDERS=1 bun run test:provider-live`, confirm no MCP auth errors from personal servers, and record the Codex result next to Claude's in `test/artifacts/provider-live-parity.json`, `docs/PROGRESS.md` and the issue.

## Helpers by default, rollback removed, self-contained app and one start path (LKM-111)

- [x] Built-in Claude, Codex and Gemini adapters always run in Swift-supervised provider helpers (`ProviderHelperCommand.builtIn`, bundled `provider-helper.cjs` on the bundled Bun); no switch, no in-process fallback; v10 connections stay in Bun.
- [x] Removed `TREZI_BACKEND_OWNER`, `TREZI_PROVIDER_HELPERS`, `TreziService --legacy` (`LegacySupervisor.swift`) and every rollback twin (conversation/editing/provider models, workflow/feedback/platform/open-in-editor legacy, publish-reconcile, static-server, devserver-processes, managed-child, media, attachments, xcode, update, sidecar-migrate, setup-artifacts, codex-models, preview-processes, profile-path-legacy, legacy-restart); each Bun seam throws without the service.
- [x] Parity-vs-twin tests became goldens (conversation, editing, provider policy/data, workspace); suites run on the real Swift owners (`test/helpers/with-service-owners.mjs`, `with-provider-owner.mjs`, `with-repository-owner.mjs`).
- [x] Retirement census: classes helper/test/bun, gate open with 0 Bun-owned rows, and no shipped file may name the removed switches or `--legacy`.
- [x] `Trezi.app` carries the backend (`Contents/Resources/backend/`) and a Bun binary (`Contents/Helpers/bun`, `scripts/bundle-bun.mjs`); the host derives its launch under LaunchServices (`src/native/HostLaunch.swift`).
- [x] One start path: `open -a Trezi` and the thin `bin/trezi` (`trezi`, `trezi .`, `trezi <path>`, `--update`, `--help`, `--version`); `install.sh` links the app into Applications. README, AGENTS.md, agent guide and SWIFT-BACKEND docs updated.
- [x] Bounded live parity check written: `test/provider-live-parity.mjs` (live tier, `TREZI_LIVE_PROVIDERS=1 bun run test:provider-live`): Claude haiku/low and Codex low, in-process vs helper, one no-tool prompt, token usage to `test/artifacts/provider-live-parity.json`.
- [x] Authorized live parity check, Claude: run by the operator outside the worker sandbox (2026-09-29); in-process and helper both answered `PONG` (32665 in / 53 out and 32447 in / 59 out tokens). Numbers in RETIREMENT's LKM-111 evidence and `docs/PROGRESS.md`; the raw file `test/artifacts/provider-live-parity.json` is gitignored, so it is cited, not committed.
- [ ] Codex live parity (LKM-113, by the user's decision): the run hit Codex's usage limit until 2026-10-03 10:10; rerun `TREZI_LIVE_PROVIDERS=1 bun run test:provider-live` after the reset, together with isolating Trezi's Codex sessions from the user's personal Codex MCP config (the SDK loaded `mcp.vercel.com` during the run).
- [ ] Optional: replace the copied Bun binary with a `bun build --compile` single executable if a smaller app matters.
- [ ] Manager: stage the new files, run configured verification (incl. `test:native` unsandboxed: XPC, ports, sockets) and independent review.

## AGENTS.md as the short canonical agent guide (LKM-112)

- [x] Rewrite `AGENTS.md` (≤ 8 KB, tool-neutral): purpose, architecture map with links, commands, verification + Evidence budget, Git/worktree rules, head/grep-only reading of PROGRESS/TASKS.
- [x] Move the long material into `docs/agent-guide/*.md` (architecture, service-owners, backend-map, verification, git-worktrees, gotchas, conventions); no rule dropped (checklist in PROGRESS).
- [x] `CLAUDE.md` = `@AGENTS.md` + two Claude notes (≤ 1 KB).
- [x] `test/docs-links.mjs` also covers `AGENTS.md` + `docs/agent-guide/*.md` and enforces the size budgets and the import.
- [ ] Manager: run configured verification (typechecks, unit, `test:native`); commit notes carry the section checklist from PROGRESS.

## App name without "Native" (LKM-108)

- [x] Build `out/native/Trezi.app` (`CFBundleName`/`CFBundleDisplayName` `Trezi`, window title `Trezi`); every launcher, test helper and doc path follows; the build removes a stale `Trezi Native.app`.
- [x] Keep the bundle identifier, executable names and the `Trezi Native` profile directory (renaming that needs a migration).
- [ ] Manager: run configured verification (typechecks, unit, `test:native`) under the desktop lock.

## Merge-friendly docs and evidence budget (LKM-110)

- [x] Union-merge `docs/TASKS.md` and `docs/PROGRESS.md` via `.gitattributes`; scripted two-branch merge check (`test/docs-merge-union.mjs`).
- [x] Add the Evidence budget to AGENTS.md and CLAUDE.md.
- [x] Add `--only=group,group` to the native smoke (`core`, `islands`, `shadow-light`, `sidebar`, `settings`, `chat`, `composer`); unknown names fail before the build; full suite stays the default.
- [ ] Manager: run configured verification (full unit + native) and reconcile `smoke-core.ts` gating with LKM-109's check list if it lands first.
## Native verification reports all failures (LKM-109)

- [x] Split the native smoke into named checks with declared dependencies; collect failures, skip dependents with `skipped: depends on X`, restore foreground/window state after each failure.
- [x] Print and document the end-of-run summary (check, first assertion line, capture path); exit non-zero on any failure.
- [x] Default per-test runner timeout 600 s → 120 s.
- [x] Fixture unit test with a deliberately failing check (`test/native-smoke-runner.mjs`); `TREZI_NATIVE_SMOKE_FAIL` for real runs.
- [ ] Manager: run configured verification (typechecks, unit, `test:native`) under the desktop lock; optionally `TREZI_NATIVE_SMOKE_FAIL=composer bun run test:native` to see a real collect-all summary.

## Experimental Gen UI (LKM-106)

- [x] Rename settings, explain React/Svelte composition and conditionally show the explained engine while preserving saved choices.
- [x] Discover the documented Svelte legacy/rune subset and export validated `.svelte` source through both engines; preserve React export.
- [x] Add deterministic rendering/Jev, unsupported-shape, mixed-framework, escaping/path, stale/cancellation and turn-capture checks.
- [x] Document supported contracts and run focused non-GUI checks.
- [x] Add foreground Settings capture/OCR/geometry and native picker interactions at 600/800 points, including engine preservation and immediate-close autosave; register windowless and negative-evidence checks.
- [x] Reproduce NSHostingController minimum-size propagation without a window; exercise live minimum (540), normal (600) and wider (800) widths without relaxing evidence checks.
- [x] Make `test:native` produce the Settings evidence itself; retain the original `settings.png` capture and `sheetPerform change` autosave check alongside it.
- [ ] Manager: run configured verification and inspect native Settings help/conditional engine at minimum and wider widths under the desktop lock; complete independent review.

## Composer spacing and chat scrollbar (LKM-103)

- [x] Native latest button (NSButton) over the conversation: the SwiftUI button never ran its action for the acceptance click (buttonClickCount 0); harness asserts the action runs; fixture regression with SwiftUI negative control.
- [x] Match exterior bottom/side gaps and adjust composer height budget, status/message clearance and resize following.
- [x] Identify the SwiftUI conversation scroll view; configure its native small scroller using macOS preferences, including live Always-show changes.
- [x] Extend windowless composer tests for spacing/clearance and native scrollbar policy; run focused controller and TypeScript checks.
- [x] Repair CGFloat/Double bounds handoff causing empty composer captures; prove failure before the fix and pass through real windowless composer update/layout.
- [x] Wire growth/resize/scroll acceptance into test:native; capture real SwiftUI probe identity, native preference transitions and wheel/thumb/latest-button interactions.
- [x] Add normal/narrow multiline/capped foreground fixtures and preference restoration unit coverage, with PNG/OCR/geometry paths documented in TESTING.
- [x] Diagnose stale document-bound clamping after composer growth; retry following on settled AppKit dimensions and add a windowless regression with a negative control.
- [x] Fix capped-draft + short-resize follow shortfall: pin to the document end from settled AppKit metrics (no stale fractional anchor); cover grow→resize and resize→grow at 440pt windowless and in native acceptance.
- [x] Probe-owned latest state: probe-owned pinned state changed only by user input (wheel/key monitor, live scroll) or explicit latest/chat attach; windowless regression + negative controls.
- [x] Diagnose the TIFF-paste composerInspect timeout: step runs no recent LKM-103 code; window lost key during the wait. Smoke timeouts now report last state, focus and Bun chat context (smoke-wait.ts + unit test with negative control).
- [ ] Manager: rerun test:native; if the paste step fails again, read the reported lastState/context fields.
- [x] Acceptance drag reveals the overlay knob (flashScrollers + bounded hit-test wait) and refuses mouseDown unless the knob hit-tests to NSScroller; fixture regression.
- [x] Ignore stale didEndLiveScroll after the latest attach (reviewed Cursor patch: no SwiftUI callbacks from attach, post-click diagnostics); three-order fixture regression with negative controls.
- [x] Route the acceptance thumb drag through the scroller's own tracking loop (queue drag, window.sendEvent mouseDown); drag diagnostics; direction-strict assertion; fixture regression with unrouted negative control.
- [x] Remove all system-preference writes from verification; in-process ChatSystemEnvironment override (scroller style + Increase Contrast/Reduce Transparency/Reduce Motion) through the probe and SwiftUI environment; system-settings guard test; provider defaults test.
- [x] Report the latest button's rendered frame via onGeometryChange (PreferenceKey never arrived); offscreen NSHostingView regression with negative control.
- [x] Drive the latest button from the probe's pinned state + scroll position; windowless visibility regression.
- [x] Route the acceptance wheel/mouse input as window-targeted events through NSApp.postEvent (pid-posted events had no window and were dropped); accept nil-window wheels over the chat; add input diagnostics and windowless routing coverage.
- [ ] Manager: run native verification and inspect foreground normal/narrow/multiline captures, latest-message reachability, scrollbar idle/hover/drag/wheel behavior and Always-show/accessibility preferences.

## Chat goes blank after sending until scrolled (LKM-139)

- [x] Find the cause: the probe's AppKit pin jumps the clip view outside SwiftUI's scroll machinery; with far-off row estimates the LazyVStack realizes no row in the viewport (offset stays ≤ max, scroll view/document identity unchanged).
- [x] Fix: `ChatLatestSettle` re-scrolls through SwiftUI per frame until a row is in view (pin held, 1pt bottom-marker relayout, periodic first-row reset), then lets the pin land; offsets outside the document are clamped.
- [x] Windowless fixture `native-chat-latest-settle` (unit) with `--no-settle` negative control; native `send-visibility` stage in native-chat-scroll (440/320pt × fixed/growing composer, after send/mid-stream/done, captures).
- [ ] Manager: run `test:native`; inspect `send-after-send.png`, `send-mid-stream.png` and `send-visibility.json`.

## Sidebar folder icons (LKM-105)

- [x] Diagnose sidebar capture timeout with a windowless AppKit reproduction; compensate measured split wrapper insets and add content-width regression coverage.
- [x] Use the native outline folder symbol for every project row, preserving metadata, layout, selection tint and actions.
- [x] Run focused non-GUI checks.
- [x] Repair Shadow Light capture fixture foreground readiness after manager review failure, preserving strict capture/OCR checks.
- [x] Add foreground sidebar captures at 260/180 points, both selections and hover states, menu/memory and drag-delegate/backend reorder evidence to the native suite; add negative evidence assertions to the unit tier.
- [x] Draw sidebar folder symbols in exact integral 16×16 frames (zero symbol alignment insets) with a windowless regression test.
- [x] Restore and assert the foreground after sidebar menu/sheet, reorder and hover steps (teardown runs on failure; leftovers named) with windowless/unit regression coverage.
- [ ] Manager: inspect foreground selected/unselected/hover states at standard and narrow widths; verify open/select/context menu/reorder and run required native checks.

## Local Apple Intelligence exploration (2026-09-28)

- [x] Audit suitable Trezi workflows and Apple APIs; rank opportunities and propose a bounded first experiment in [the exploration](APPLE-INTELLIGENCE.md).
- [ ] If selected for implementation, benchmark optional local chat titles before expanding to copy drafts and prepared-control selection.

## Composer bottom row (LKM-104)

- [x] Align attachment, provider/model, Auto and Send in one centered bottom row; retain text above and selector compression.
- [x] Check windowless normal/narrow empty/multiline/capped layout and rejected raised Send; run focused controller and TypeScript checks.
- [x] Repair smoke draft inputs for the additional text space; preserve growth assertions and verify the smoke sequence against actual windowless AppKit viewports.
- [x] Reproduce and repair capped-to-wrapped overflow with legacy scroller gutters; test fresh bridge updates with both scroller styles and preserve desktop fit diagnostics.
- [x] ~~Reconcile LKM-103 commit d0c6803 in this branch~~ — reverted: exterior insets and scrollbar styling stay in LKM-103; composer checks tolerate it landing separately.
- [x] Add foreground normal/narrow empty/multiline capture pairs including the full chat column and latest-reply OCR.
- [x] Diagnose initial foreground capture timeout from empty/setup-card state; regress capture readiness while retaining populated latest-message checks and diagnostic geometry.
- [x] Repeat attachment/model/Auto interactions, disabled empty Send/Return, Return (normal) and Send-click (narrow) multiline submission, and a Stop-state capture at each matrix width, so manager verification produces the evidence.
- [x] Repair "latest message did not settle above composer": the check sampled the lazy bottom anchor (`bottomPosition`); it now waits on the newest message's measured frame against the composer top and requires the last painted line. Pinning itself is LKM-103's (candidate); regressions: shrink-after-submit at 440/320pt in the layout fixture and `native-composer-latest`.
- [x] Merge candidate (LKM-103/109/110): the latest-row check now reads LKM-103's `chatAcceptance` geometry (`latestBottom` ≤ `readingHeight`) and capture; LKM-104's own `latest` field, `captureVisibleChatColumn`, `smoke-composer-latest.ts`, `native-composer-latest` and the latest-line OCR are removed.
- [ ] Manager: after merging candidate, run `test:native`; inspect the 440/320 `initial`, `draft`, `sending` and `submitted` captures (`composer-visible-<width>-*`, `-chat.png`/`-chat.json` pairs) for the shared row, compact-after-submit composer and the latest line above it; complete independent review.

## Composer container (LKM-87)

- [x] Place attachment/provider/model/Auto controls inside the rounded input surface, preserving alignment and handlers.
- [x] Remove the external composer gradient/footer fill and unused fade view.
- [x] Run focused non-GUI composer/controller checks and TypeScript checks.
- [x] Add foreground composer PNG/OCR capture and native attachment/model/Auto/typing/submission verification to the manager suite.
- [x] Correct popup alignment-rectangle verification; add windowless layout/overlap regressions and retain captures on assertion failures.
- [ ] Manager: verify native rendering and control interactions under the shared desktop lock; complete independent review and candidate integration.

## Legacy retirement, launcher and distribution (LKM-102 / S15)

- [x] Executable census of every Bun module with a file, process or signal effect (`docs/SWIFT-BACKEND-RETIREMENT.md`, `test/retirement-census.mjs`): rollback / helper / test / Bun-owned, gate line counted, legacy switch required while blocked.
- [x] Reviewer notes (`annotations.json`) and starter `tokens.json` committed by the editing owner (hash-bound, repository lane; Swift/TS parity; `annotation-store` re-run on the Swift owner).
- [x] One platform source (`scripts/requirements.mjs`: macOS 13.3, SDK 26.0, Bun 1.3.0) stamped by the build and enforced by build, launcher, dev, CLI and installer (`test/distribution.mjs`).
- [x] Removed dead Git/fs adapter imports from `agent.ts`.
- [x] Moved to Swift owners: `setup-artifacts`, `sidecar-migrate`, `worktree-dependencies` (EditingOwner, `EditingProject.swift`) and the update check (`WorkflowOwner.updateCheck`); 13 → 9 Bun-owned rows.
- [x] Moved `feedback:submit` (`gh issue create`) and the skill-pack install (`npx skills add`) to journaled WorkflowOwner workflows (`WorkflowTools.swift`); 9 → 7 Bun-owned rows.
- [x] `test/install-update.mjs` (clean install, launch, update, interrupted update, diverged checkout, lockfile drift) and profile-lock recovery after a SIGKILLed owner in `test/service-process.mjs`.
- [x] Transfer the remaining 7 Bun-owned census rows (each with its own rollback plan): `codex-models`, `model-catalog`, `providers-store` (ProviderOwner, `ProviderData.swift`); `props` editor CLIs and `native/platform` Keychain crypto/`open` (PlatformOwner `PlatformOpen.swift`, crypto in ProviderData); `native/profile-path` (`ProfilePaths.swift`), `native/index` and the legacy `native.lock` (the service's lock; Bun refuses without it). 7 → 0 Bun-owned rows (reduced acceptance, `docs/SWIFT-BACKEND-RETIREMENT.md`).
- [x] Provider helper routing is an explicit opt-in (`TREZI_PROVIDER_HELPERS=1`); the default launch installs no helper and runs the adapters in Bun. v10 connections always stay in-process (`test/provider-data.mjs`).
- [x] Deferred to LKM-111: move the provider SDK adapters into supervised helpers (LKM-98 follow-up). Done in LKM-111; the Claude live parity passed, Codex's moved to LKM-113.
- [x] Deferred to LKM-111: delete `TREZI_BACKEND_OWNER=legacy`, `TreziService --legacy`, the rollback rows and old Bun copies, keeping every store, journal and worktree. Done in LKM-111.
- [x] After the LKM-102 + LKM-112 merge: `docs/agent-guide/` brought up to LKM-102 (done; the list below is what changed). `service-owners.md`: "Every other domain writer remains in Bun…" / annotation storage, the provider owner block (+ `ProviderData.swift`, adapters in Bun by default, helpers opt-in via `TREZI_PROVIDER_HELPERS=1`, connections in-process), the editing, workflow and platform blocks (+ `EditingProject.swift`, `WorkflowTools.swift`/`WorkflowContext.swift`, `PlatformOpen.swift`), a `ProfilePaths.swift` entry and the profile lock; `backend-map.md`: `providers-store`/`model-catalog`/`codex-models` are rollback twins of `main/provider-data.ts`, `annotation-store` renders and the editing owner commits; `architecture.md`: `platform.ts` has no Keychain helper (`platform-legacy.ts` is the twin), `profile-path.ts` only resolves; `verification.md`: `scripts/requirements.mjs` and the `docs/SWIFT-BACKEND-RETIREMENT.md` census.
- [x] Worker native verification (latest run on the merged tree): configured verification passes, native smoke 20 passed, 0 failed, 0 skipped; no host/UI Swift changed here.
- [ ] Manager: stage the new files (docs-links checks tracked paths), configured verification and independent review.

## Swift platform owner: Simulator, media, attachments, server recovery (LKM-101 / S14)

- [x] Name the domain exactly and tighten its rollback (`docs/SWIFT-BACKEND-PLATFORM.md`): simulator tools, launch command, bridge; media grants; attachments; running-servers recovery. Retire the unreachable `trezi-media` scheme route (Host `media`/`mediaReply`, Bun `protocol.handle`).
- [x] Swift `PlatformOwner` on the private pipe; Bun client `src/native/platform-service.ts`, seam `src/main/platform-owner.ts`; the TS code (`simulator.ts`, `media.ts`, `attachments.ts`, `preview-processes.ts`) is the rollback owner.
- [x] Simulator coordinator: bounded, cancellable tool runs (`ToolScope`), supersede/stop cancels a start still booting or building, restart never overlaps, Metro as a journaled process group, loopback bridge with host/token/body/viewer limits, idb input, picks and stale-companion recovery.
- [x] Media grants bound to the source editor view, the file's identity, size and SHA-256, expiring; re-granted by the client after expiry or a change. Attachments uploaded in hash-checked chunks with the legacy caps, names and pruning.
- [x] `test/platform-owner.mjs` (unit tier): preflight/pure parity, unavailable, bridge, idb, restart, cancel, supersede, failures, drain, crash sweep, media, attachments, server recovery, schema. Scripted xcrun/idb/Metro only.
- [ ] Live platform check (needs Xcode + a simulator runtime, not run by the worker): a real Expo/React Native launch, `open -a Simulator` from the XPC service, idb input on a device.
- [ ] Remaining Bun-owned OS effects for S15 (census, 2026-09-29): provider CLIs and probes (claude/codex SDK spawns, `codex --version`/`debug models`, gemini), the Codex MCP unix socket (`trezi-agent-tools.ts`), `npx skills add` (`skills-install.ts`), Keychain crypto via `TreziHost --crypto`, `/usr/bin/open` and editor CLIs (`source:open-in-editor`), profile migration symlinks, the provider store and catalog cache, `feedback:submit` (`gh issue create`), the update check's `git fetch`, the PR-description temp directory; and in project `.trezi/`: annotations, tokens, legacy-sidecar migration, worktree setup helpers and dependency markers.
- [x] Worker native verification (staged, groups core/chat/composer): 139 unit checks, typechecks, native smoke 17/17, chat acceptance pass (read from the run log; the tool call timed out client-side).
- [ ] Manager: configured verification (full native run) and independent review.

## Swift workflow owner (LKM-100 / S13)

- [x] Name the domain exactly (publication, remote Git actions, setup helpers, new projects, Trezi update, diagnosis memory; Bun-kept proposing helpers and sheets) and tighten its rollback and partial-effect recovery (`docs/SWIFT-BACKEND-WORKFLOWS.md`).
- [x] Swift `WorkflowOwner` on the private pipe with a durable journal (`service/workflows/`), operation-ID dedupe, resume/busy/cancel/dismiss and redaction; Bun client `src/native/workflow-service.ts`, seam `src/main/workflow-owner.ts`, rollback twin `src/main/workflow-legacy.ts` (legacy publish code moved to `src/main/publish.ts`).
- [x] Publish (merge / PR only), handoff and saved-run PRs in two phases around the description helper; open PRs adopted, merges checked on the journal's PR number, cleanup skipped if the branch moved.
- [x] Connect (repository creation adopted only when this run asked for it), remote status/pull/switch in the repository lane.
- [x] Setup helpers (create-only, plain `.trezi`), removal (fixed list, no linked folders), new projects (install resumed), Trezi update (retry never pulls twice), diagnoses (same file; damaged file kept).
- [x] `test/workflow-owner.mjs` (unit tier): 12 parity scenarios, lost replies, crashes after PR/merge/repository/pull, GitHub failing after acting, install/build failures, cancellation, busy, restart, rollback both ways, redaction, drain, schema. Scripted `gh`/package manager only.
- [ ] S13 sub-boundary: feedback issues (`feedback:submit`, a remote creation in Trezi's own repository) stay in Bun without a receipt; move with S15 or give them a journal entry.
- [ ] S13 sub-boundary: shared sheet routing and autosave, and the read-only probes (`github:status`, `setup:detect`, update check) stay in Bun.
- [ ] Follow-up: surface interrupted workflows (`workflows()`) in the UI with Resume/Dismiss; today the next explicit request resumes them.
- [x] Worker native verification (staged, full): 138 unit checks, typechecks, native smoke 20/20, chat acceptance and chat scroll pass (read from the run log; the tool call timed out client-side).
- [ ] Manager: configured verification and independent review. Real GitHub and installs are not exercised (no live publish authorized).

## Swift editing coordinator (LKM-99 / S12)

- [x] Name the domain exactly (island histories and state machine, controls sidecars, content drafts, deferred navigation; Bun-kept JS helpers, inspector views, DOM instrumentation) and tighten its rollback plan (`docs/SWIFT-BACKEND-EDITING.md`).
- [x] Swift `EditingOwner` on the private pipe; Bun client `src/native/editing-service.ts`, seam `src/main/editing-owner.ts`, rollback twin `src/main/editing-model.ts`.
- [x] Islands: definitions bound to the conversation owner's turn (`origin`), activation only by that turn's terminal (`TurnBoundaries`; stale terminals ignored), command admission, batch revision chain, per-island Undo through the source owner; `ChatIslands` keeps views and JS helpers.
- [x] Controls sidecars committed hash-bound in the repository lane (hand edits refused and kept; symlinks refused).
- [x] Content-editor drafts persisted and restored; a stale draft stays bound to its base and cannot be saved over newer content.
- [x] Deferred `open_preview` navigation restored (held until its turn lands; `NavigationController` loads it in the asking chat once the server runs).
- [x] `test/editing-owner.mjs` (unit tier): parity, turns, legacy suites on the Swift owners, drafts, lanes, crash, rollback, drain, schema.
- [ ] S12 sub-boundary: the composer's queued-message list, drafts and attachments stay in the Bun native chat controller.
- [ ] S12 sub-boundary: the workspace controller's persisted server fields (S06 adapter) and project UI composition enablement (per-turn, in memory) stay in Bun.
- [ ] Follow-up: an island removal action (today an island stays in its chat's history).
- [x] Worker native verification (staged): full native smoke 20/20 and chat acceptance pass; the islands check now waits for the preview reload it causes (a filtered run had raced `shell-layout`).
- [ ] Manager: stage the new files (docs-links checks tracked paths), run the unit tier unsandboxed, `bun run test:native`, inspect `chat-island.png` and `shadow-light-*.png`, independent review.

## Swift provider owner and helper capability enforcement (LKM-98 / S10)

- [x] Decide the integration boundary (SDK adapters, one supervised helper per session in the end state), name the domain exactly (grants, permission decisions, tool authorization, Stop's deadline, sessions journal, resume ids, helpers; Bun-kept SDK sessions and credentials in their own stores) and tighten its rollback plan (`docs/SWIFT-BACKEND-PROVIDERS.md`).
- [x] Swift `ProviderOwner` on the private pipe; Bun client `src/native/provider-service.ts`, seam `src/main/provider-owner.ts`, rollback twin `src/main/provider-model.ts` with the shared policy `src/main/provider-policy.ts` (mirrored by `ProviderPolicy.swift`).
- [x] Every session agent.ts starts is opened with the owner (`provider-sessions.ts`): Claude's `canUseTool` asks it, Claude's in-process tools and Codex's MCP bridge are authorized against the grant (`session-tools.ts`), Stop runs on the owner's deadline with the adapter's kill switch (`ProviderSession.forceStop`), thread ids are persisted and used when a record lacks one.
- [x] Helper runtime: `ProviderHelper.swift` (stdio only, allowlisted environment, own process group with watchdog and journal, bounded lines), frame validation and violations in `ProviderOwner.swift`, helper host `backends/helper-host.ts`, Bun's side `backends/helper-session.ts`.
- [x] `test/provider-owner.mjs` (unit tier): policy parity, fake-provider helper (stream/tool/error/resume/permission/question/model), screenshot and pasted-image transport, privilege enforcement, crash/hang/stall/failed start, recovery, rollback, drain, adapter wrapper, schema.
- [x] The helper runtime and entry are built (`provider-helper.cjs`, `ServiceRuntime` helper command, `pickProvider`); routing is opt-in only (`TREZI_PROVIDER_HELPERS=1`, default = adapters in Bun, v10 connections always in-process); fake-provider parity only — live Claude/Codex SKIP.
- [x] Deferred to LKM-111: move the Claude/Codex/Gemini adapters out of Bun into the helpers by default. Done in LKM-111 (live parity: Claude passed, Codex deferred to LKM-113).
- [ ] Hand a Codex connection's key to its helper in the open frame and route the Claude model-catalog update through Bun without Bun-owned catalog/store writes.
- [ ] Unverified: real Claude/Codex sessions under the owner (permission answers, tool authorization, Stop escalation) need an authorized live run (`test:native-live`).
- [ ] Title and memory generation still run in Bun beside the adapters (they move with them).
- [ ] Manager: stage the new files (docs-links checks tracked paths), run the unit tier unsandboxed, `bun run test:native`, independent review.

## Swift conversation state and chat orchestration (LKM-97 / S11)

- [x] Name the domain exactly (session records and History, live checkpoints, turn state machine and completion policy, titles, handoff, approvals, spawn admission; Bun-kept provider sessions, prompts, composer queue and drafts) and tighten its rollback plan (`docs/SWIFT-BACKEND-CONVERSATION.md`).
- [x] Swift `ConversationOwner` on the private pipe; Bun client `src/native/conversation-service.ts`, seam `src/main/conversation-owner.ts`, rollback twin `src/main/conversation-model.ts`.
- [x] Turn identity: `TurnTracker` attributes provider events to their turn and run; the owner claims one terminal per run and refuses duplicate and late ones; the chat controller ignores terminals of another turn (`AgentEvent.turn`/`stale`).
- [x] Session records written only by the owner (byte-identical; overlay for read-your-writes); live-chat checkpoints; crash recovery that never replaces newer records.
- [x] Completion policy, titles (user wins), model handoff once, approvals and permission mode, spawn admission (3 per project, FIFO) moved to the owner.
- [x] `test/conversation-owner.mjs` (unit tier): owner parity, agent streaming on both owners (Swift repository/source owners for landing), crash, rollback, schema, drain, `comment-agents` re-run on the owner, adapter boundary.
- [ ] S12: the composer's queued-message list, drafts and attachments stay in the Bun native chat controller (the owner enforces one turn at a time and turn identity). LKM-99 moved islands, sidecars, content drafts and navigation; this sub-boundary remains.
- [ ] S10 (LKM-98): provider sessions are opened with the Swift provider owner; the SDK adapters, prompt assembly, title and memory generation stay in Bun until the helper move above.
- [ ] Follow-up: a UI for chats recovered from checkpoints (today they are listed in the Activity log and restored to History or as the project's current chat).
- [ ] Manager: stage the new files (docs-links checks tracked paths), run the unit tier unsandboxed, `bun run test:native`, independent review.

## Swift source transactions, file operations, Undo and parser proposals (LKM-96 / S08+S09)

- [x] Name the domain exactly (proposal commits, editor reads/saves, file-tree operations, Undo/redo/revert, drafts, journal; Bun-kept parsers, listing, media, sidecar stores, setup/scaffold) and tighten its rollback plan (`docs/SWIFT-BACKEND-SOURCE.md`).
- [x] Parsers only propose `{path, expectedHash, content}` through `proposeEdit` (`src/main/source-commit.ts`); stale, external-edit, out-of-order and deadline-expired proposals write nothing; static check keeps writes and Undo state out of the engines.
- [x] Canonical path authorization: root, traversal, protected folders, symlinked file/folder containment.
- [x] Journaled multi-file transactions in the repository lanes (inside held leases); midway failure puts files back; crash rollback at launch never overwrites newer work and keeps pre-images; `status`/`acknowledge`.
- [x] Grouped Undo/redo/revert in Swift (landed chat turns recorded into it); interrupted Undo rolled back like any transaction.
- [x] Editor saves bound to owner-issued baseline hashes; unsaved drafts persisted and restored after restart (stale ones open as conflicts).
- [x] `TREZI_BACKEND_OWNER=legacy` keeps the TS writers; journal, reports and drafts survive the switch; drain refuses queued writes.
- [x] `test/source-owner.mjs` (unit tier): React/Svelte/HTML/layers fixture parity, `shadow-controls` re-run on the owner, proposals, paths, transactions, crash, history, files, drafts, lanes, rollback, drain.
- [ ] S08 sub-boundary: file-tree listing (`source:tree`), media (`trezi-media://`), component resolution and open-in-editor stay Bun read-only; move with S12/S15.
- [x] S08 sub-boundary: sidecar stores — `control-panels.json` and `content-controls.json` moved to the Swift editing owner (LKM-99); `tokens.json` and annotations followed (LKM-102).
- [x] S13: setup/scaffold instrumentation writers (`setup.ts`, `scaffold.ts`) moved to the Swift workflow owner (LKM-100); the TS writers are its rollback twin.
- [ ] S09 follow-up: run the parsers in a separate supervised helper process (today they run in Bun and are bound by the seam, not by process privileges).
- [ ] Follow-up: a UI to review and acknowledge interrupted source transactions (today they are listed in the Activity log at launch).
- [ ] Manager: stage the new files (docs-links checks tracked paths), run the unit tier unsandboxed, `bun run test:native`, independent review.

## Swift repository coordinator: Git, worktrees and recovery (LKM-95 / S07)

- [x] Name the domain exactly (lanes/leases, worktree lifecycle, landings, explicit apply/reconcile/discard, live commits, branch switches, startup recovery, journal, recovery refs; Bun-kept chat state, park records, Undo, setup helpers, reads) and tighten its rollback plan (`docs/SWIFT-BACKEND-REPOSITORY.md`).
- [x] Swift lanes per repository common directory; Bun leases via `enqueueRepoWrite` (re-entrant per async chain); branch switches, orphan/branch recovery and spawn-branch apply now serialized.
- [x] Swift effects with parity to the TS Git code (legacy suites re-run on the owner); private-index snapshots; scoped to linked worktrees under the profile; path-like checkout names refused.
- [x] Durable intent journal, interrupted entries reported (never replayed), `acknowledge` intent; recovery refs before every effect that could orphan work; explicit intents for landing, reconciliation, discard, removal and branch deletion.
- [x] Landing hardened: byte comparison, no writes through symlinks or outside the checkout, partial writes restored, oversized batches park.
- [x] `TREZI_BACKEND_OWNER=legacy` keeps the TS Git code; worktrees, journal and refs survive the switch; drain releases leases and settles running effects.
- [x] `test/repository-owner.mjs` (unit tier); `service-process` builds the owner.
- [x] S07 sub-boundary: remote fetch/pull/checkout (`git-remote.ts`) and publishing (`annotations.ts`, now `publish.ts`) moved to the Swift workflow owner in the repository lane (LKM-100).
- [x] S07 sub-boundary: the annotation sidecar writer moved through the repository lane (LKM-102).
- [x] S07 sub-boundary: content/island/control source writes move to the S08 source service (LKM-96); scaffolding stays in Bun inside the lease (see S13 item under LKM-96).
- [ ] Follow-up: a UI to review and acknowledge interrupted repository operations (today they are listed in the Activity log at launch).
- [ ] Manager: stage the new files (docs-links checks tracked paths), run the unit tier unsandboxed (full `service-process`), `bun run test:native`, independent review.

## Swift-owned managed project runtime (LKM-94 / S06)

- [x] Name the domain exactly (detection, process groups, ports, readiness, installs, static site, watcher, SSE, journal; Bun-owned command choice, install repository lease, stamping helper, sidecar migration, evidence mirror, persisted server fields) and tighten its rollback plan (`docs/SWIFT-BACKEND-RUNTIME.md`).
- [x] Swift `RuntimeDetect`/`RuntimeNet` with parity to `project-detect.ts`/`devserver-net.ts`; the project's own package manager and the user's PATH preserved.
- [x] Swift process groups: descendants stopped before the leader is reaped, repeated/concurrent stops joined, TERM grace then KILL, restart without overlap, failed readiness answered after the group is gone.
- [x] Crash recovery without adoption: per-group `--watch-group` watchdog, journal with leader start time, sweep at Swift and `--legacy` launch; unrelated reused pids untouched.
- [x] Swift static site: traversal (lexical + real path), MIME/404/405/431/400, live-reload SSE, FSEvents watcher; stamping through the JS helper with a bounded fallback.
- [x] Installs in Swift under Bun's repository write lease; failures, timeouts and missing managers reported; `devserver:*` routes on the owner.
- [x] Drain at quit before the profile lock is released; `TREZI_BACKEND_OWNER=legacy` keeps Bun's runner as the rollback owner.
- [x] `test/runtime-owner.mjs` (unit tier); `service-process` legacy journal sweep.
- [ ] Remaining S06 sub-boundary: the workspace controller's persisted server fields (`url`, `launchSpec`, dependency flags) stay on the S04 adapter until the controller moves (S12).
- [x] Remaining S06 sub-boundary: the user-driven "Servers" recovery sheet moved to the Swift platform owner (LKM-101); `preview-processes.ts` is its rollback twin.
- [ ] Manager: stage the new files (docs-links checks tracked paths), run the unit tier unsandboxed (runtime-owner watcher + socket sections, full `service-process`, `devserver-net`), `bun run test:native` through the Swift static site, independent review.

## Swift-owned project memory; annotation storage split (LKM-93 / S05)

- [x] Name the domain exactly (memory files, temp files, per-project ledger domains `memory/<id>`, evaluation helper, injection state, editor drafts, annotation sidecar) and tighten its rollback plan (`docs/SWIFT-BACKEND-MEMORY.md`).
- [x] Swift `MemoryFile`/`MemoryOwner` with byte parity to the shared TS rules; damaged files refused untouched; unchanged saves write nothing; session-store alias guard.
- [x] Manual `save` vs generated `propose` ordered by revision in Swift; Bun retries manual intents and re-evaluates stale proposals; evaluation has no write authority.
- [x] Injection keyed by the owner's digest (`createProjectMemoryInjection`); unreadable memory never fails a chat.
- [x] `TREZI_BACKEND_OWNER=legacy` keeps the Bun writer; Swift adopts newer legacy writes; no old-version restore.
- [x] Annotation storage split from publication (`annotation-store.ts`): CRUD parity, per-project serialization, unknown entries kept, damaged files kept, no Git side effects; stale note responses dropped in the context controller.
- [x] `test/memory-owner.mjs`, `test/annotation-store.mjs` (unit tier); `project-memory` and `native-context` extended.
- [x] Unblocked by S07 (LKM-95): move the annotation sidecar writer to Swift through the repository lane (LKM-102: editing owner's sidecar commit).
- [x] S05 remainder: attachments (scratch/blob bounds) moved to the Swift platform owner (LKM-101): chunked, hash-checked uploads.
- [ ] Manager: stage the new files (docs-links checks tracked paths), run unit + unsandboxed `service-process` + `bun run test:native` through the service path, independent review.

## Swift-owned workspace identity (LKM-92 / S04)

- [x] Name the domain exactly (`workspace.json` membership/order/root/key/`touchedAt`/`activeKey`/recents, temp file, ledger domain `workspace`, legacy-owned metadata slice, display state and drafts) and tighten its rollback plan (`docs/SWIFT-BACKEND-WORKSPACE.md`).
- [x] Swift document model and operations byte-identical to a shared TS model: unknown fields, invalid/duplicate entries and recents kept; JS number/key-order serialization; invalid files refused untouched.
- [x] Canonical-root identity (string key unchanged; `realpath` aliases resolve to the existing project); typed `update` adapter for session/server/Git/display fields (no dual writers).
- [x] Ledger-backed `WorkspaceOwner` on the supervised pipe (shared `DomainChannel` with preferences): import, receipts, conflicts, external-edit adoption, crash reconciliation with journaled answers, bounded drain.
- [x] Controller reads identity/order/selection from acknowledged snapshots; open/select/close persisted before sessions, servers, Git or activation; a refused selection starts nothing; restart and UI reattach preserve projects and selection.
- [x] `TREZI_BACKEND_OWNER=legacy` keeps a byte-identical Bun writer; Swift adopts newer legacy writes; no backup restore.
- [x] `test/workspace-owner.mjs` (unit tier), controller/legacy-writer checks, real-service workspace round trip in `test/service-process.mjs`.
- [ ] Manager: stage the new files (docs-links checks tracked paths), run unit + unsandboxed `service-process` + `bun run test:native` through the service path, independent review.

## Swift-owned preferences (LKM-91 / S03)

- [x] Name the domain exactly (v1 `preferences.json`, temp file, ledger domain `preferences`, drafts) and tighten its rollback plan (`docs/SWIFT-BACKEND-PREFERENCES.md`).
- [x] Swift v1 reader/writer with byte parity: unknown keys, null vs absence, UTF-16 limits, lone surrogates, `praxis` copies; invalid files refused untouched.
- [x] Ledger-backed owner in the service: import under the profile lock, atomic batches, idempotent receipts, conflicts, external-edit adoption, crash reconciliation from the file (journaled target digest).
- [x] Bun client over the supervised pipe: acknowledged reads, one batch at a time, no fallback write on timeout; all callers converted to awaited batches; startup holds host events while it awaits the snapshot.
- [x] Stop/drain on quit; `TREZI_BACKEND_OWNER=legacy` keeps Bun's writer as the rollback owner, reading the newest file; Swift adopts newer legacy writes.
- [x] `test/preferences-owner.mjs` (unit tier), settings failed-draft/close-waits checks, real-service preferences check in `test/service-process.mjs`.
- [ ] Manager: stage the new files (docs-links checks tracked paths), run unit + `bun run test:native` through the service path, independent review.

## Durable operation ledger (LKM-90 / S03)

- [x] Persistent intent/effect/receipt phases with canonical intent digest; stable duplicates, `idempotencyMismatch`, identity before revision check.
- [x] Per-domain revisions and FIFO commit lane held across actor suspension; cancellation before effect vs `tooLate`; late results discarded.
- [x] Restart recovery: intent → abandoned, effect → uncertain (domain blocked) → explicit reconcile, never replay.
- [x] Checksummed, fully synced journal + generation snapshots; torn-tail quarantine; corrupt/newer-format stores refused untouched; explicit quarantine.
- [x] Persisted event cursors, retained window, `snapshotRequired` for gaps/epochs; consumer mirror ordering; 7-day retry horizon with expired IDs.
- [x] Opened by the Swift service under the profile lock; legacy owner never opens it; storage layout/compatibility/rollback documented (`docs/SWIFT-BACKEND-LEDGER.md`).
- [x] `test/operation-ledger.mjs` (SIGKILL at each boundary + arbitrary kills, restart) in the unit tier.
- [ ] Manager: full unsandboxed `service-process` (ledger created at XPC launch, epoch kept across service restart), unit + native verification, independent review.
- [x] After acceptance: transfer the preferences writer through the adoption gate (LKM-91; see "Swift-owned preferences" above).

## Swift service, XPC and legacy supervision (LKM-89 / S02)

- [x] Separate signed XPC service bundled in the app; versioned control codec with closed negotiation and signed-peer validation both ways.
- [x] Swift-owned profile exclusion (`service.lock` flock + legacy `native.lock` reservation) held across service-crash drain by the backend guardian.
- [x] Supervise legacy Bun and detached servers/Metro through lifetime-pipe guardians; Bun stays the single domain writer.
- [x] Reattach requires the negotiated epoch; a restarted service refuses (`recoveryRequired`) instead of launching a second Bun. No replay of uncertain sends; never-submitted frames queue in a bounded outbox.
- [x] Propagate Bun's exit status through `quit`/`serviceStopped` to the host and launcher, so failing `--test` runs cannot exit 0; terminal signals drain through the service.
- [x] Launch-time owner switch (`TREZI_BACKEND_OWNER=swift|legacy`) through `scripts/start-native.mjs`; rollback tested under the same lock with newest data retained.
- [x] Real-process fixture `test/service-process.mjs`; supervision, guardian, crash-drain, codec and rollback sections pass in the worker sandbox.
- [x] Fix the XPC relay stall from manager verification (pipe reads waited for 64 KiB) and make `serviceStopped` final so a crashed backend no longer waits on launchd's respawn throttle; full `test/service-process.mjs` passes.
- [x] Native smoke through the service: drain without `.terminateLater` (plus 20 s watchdog), pass host stderr to Bun over XPC, remove the two-pipe deadlock hazard, re-reveal disturbed Shadow Light captures.
- [ ] Manager: rerun unit + `bun run test:native` through the service path (Bun's output is visible again); independent review and candidate integration.

## Swift migration contracts (LKM-88 / S01)

- [x] Add shared versioned Swift/TypeScript DTOs, strict codecs and cross-language golden fixtures without changing a writer.
- [x] Verify Unicode/null/absence, malformed and bounded payloads, versions, scopes, revisions and operation-versus-request identity.
- [x] Reconcile separate-service/XPC/supervision/durable-intent requirements and map every audited module/route/event to the 15-step roadmap.
- [x] Run focused Foundation-only fixture checks, TypeScript/native typechecks and docs links.
- [x] Reproduce manager cleanup failure and stop the fixture-owned esbuild service; pass the real focused unit runner without weakening assertions or cleanup.
- [x] Gate Shadow Light capture on bounded foreground readiness; verify delayed/failing activation and capture errors without GUI, preserving visible-capture guards.
- [x] Reproduce capture-time foreground loss; bound fresh-capture reacquisition and retain strict foreground guards and unrelated error propagation.
- [x] Reconcile candidate Apple Intelligence tracking with S01 tracking; verify a conflict-free three-way TASKS merge without changing Git metadata.
- [x] Fix reviewed method-authorization collisions with structured pairs and align Swift slash escaping; pass 100 cross-language cases.
- [x] Reject non-finite TypeScript values before serialization; verify nine direct/nested rejection cases and fifteen valid numeric/null controls.
- [x] Manager: rerun verification and independent review after contract fixes, then candidate integration (accepted; merged into the candidate as 51fb928).

## Shadow Light (LKM-86)

- [x] Add bounded Shadow Light generation and a native compound chat-island panel.
- [x] Bind inputs/output atomically; cover Tailwind and inline edits, Reset and Undo.
- [x] Run focused non-GUI regression checks and TypeScript/Swift typechecks.
- [x] Fix JSX attribute quoting and preserve quoted/escaped Tailwind classes in parser-backed round trips.
- [x] Add a native shadow-block fixture covering every control, computed preview CSS, Undo and rendering captures.
- [x] Preserve literal controls in non-JSX TypeScript assertion/generic files.
- [x] Replace offscreen captures with visible window captures and chat-only OCR assertions; scroll to both ends of the actual island.
- [x] Replace external screencapture with current-process ScreenCaptureKit; preserve foreground/OCR requirements.
- [x] Await final native host output before removing the disposable test profile.
- [x] Reveal the Shadow Light panel's true top and require title/Preview evidence independently from lower controls and output.
- [x] Retry nested island reveals after SwiftUI layout and acknowledge only measured top/bottom settlement.
- [x] Resolve overlapping island reveals against their own revision/anchor; superseded requests fail as superseded (Swift unit fixture + native chat-scroll overlap case).
- [ ] Manager: run the new fixture and inspect shadow-light-initial/adjusted/restored PNGs and their -bottom companions against the approved mockup.
- [ ] Manager: verify native layout and live HMR under the shared desktop lock; complete independent review.

## Trezi rename (LKM-85, 2026-09-27)

- [x] Preserve component-only legacy JSX locations across rendering and repeated transforms.

- [x] Forward legacy Next component instance stamps with canonical precedence.

- [x] Preserve legacy/current mappings in generated Svelte and MDX instrumentation.

- [x] Preserve legacy GitHub connection base planning and JSX source mappings.

- [x] Preserve relative current/legacy profile overrides during repeated session alias migration.

- [x] Enforce canonical source-selector precedence and add conflicting/legacy-only stamp regression coverage.

- [x] Reproduce capped-to-wrapped composer sizing failure without a window; fix lazy TextKit sizing and add regression coverage.
- [x] Manager: rerun native desktop verification after the composer sizing correction.
- [x] Extract the sticky request overlay to bound clean-build SwiftUI type checking.

- [x] Audit the native baseline, rename owned surfaces and document residual aliases.
- [x] Preserve profiles, sessions, Git paths and project data with tested compatibility handling.
- [x] Supply migration/rollback guidance and independent LKM-84 reconciliation mapping.
- [x] Reproduce manager failures against the native base; repair SDK declaration and runner fixtures.
- [x] Add/lock the React fixture types and verify a clean frozen install of the type dependency graph.
- [x] Require foreground/WebKit focus before native smoke gestures and improve timeout diagnostics; retain pointer assertions.
- [x] Repair navigation/style-selection smoke races and reject premature test-host exit.
- [x] Manager: commit and pass full/native typechecks, all 101 unit tests and real native smoke verification.
- [ ] Independent review and verification of integration with candidate.
- [x] Repair reviewed legacy chat recovery and HTML stamp preservation; pin implementation/candidate coordination references.

## Swift backend architecture audit (LKM-84, 2026-09-27)

- [x] Preserve candidate plan, audit and contract snapshots exactly; keep compatibility guidance and first-slice additions in the separate audit proposal.

- [x] Inventory current Bun services/routes/controllers, dependencies and background lifecycle with source references.
- [x] Propose typed Swift ownership/contracts, narrow JS helpers and a bounded first slice with acceptance checks and rollback; documentation ready for review, not migration acceptance.

Review package: [audit](SWIFT-BACKEND-AUDIT.md), [contracts](SWIFT-BACKEND-CONTRACTS.md), [compatibility guide, first slice and ordered follow-ups](SWIFT-BACKEND-AUDIT-PROPOSAL.md).

## Viewport resize feedback (2026-09-25)

- [x] Remove the duplicate AppKit dimensions and verify the single CSS viewport badge.
- [ ] Reproduce the brief page shift with visible frame timing and verify WebKit paint synchronization during divider drags.

## Island placement and scrolling (2026-09-25)

- [x] Create a fresh island for later-turn revisions without overwriting historical definitions.
- [x] Exclude control-value refreshes from automatic scrolling and pause following while adjusting controls.

## Control latency and chat timing (2026-09-25)

- [x] Surface pending controls before Jev completes and guide existing-control requests toward early definitions.
- [x] Show elapsed turn duration and hover timestamps, with persisted timing for new history.

## Chat activity (2026-09-25)

- [x] Remove the cat from the live status line while retaining text animation.

## Live website controls (2026-09-25)

- [x] Reproduce stale imperative hover callbacks, fix the website lifecycle, and cover source commit/Undo without reload in native WebKit.

## Source editor popout (2026-09-25)

- [x] Prevent hidden viewers from collapsing the code window, provide a useful minimum size, and verify resizing/docking/reopening.

## Mobile preview scrollbars (2026-09-25)

- [x] Hide page/nested scrollbars in native mobile mode, preserve scrolling through navigation, and restore desktop defaults.

## Floating chat composer (2026-09-25)

- [x] Move the follow target into the message stack and cover visible sent/streamed rows across history and draft sizes.

- [x] Extend the conversation behind the composer with a progressive gradient fade, readable token footer, and dynamic bottom clearance for growing drafts.

## Terminal shutdown (2026-09-25)

- [x] Await managed server shutdown, escalate surviving process groups, and cover terminal-group signals and launcher exit.

## Native dialog windows (2026-09-25)

- [x] Simplify dialog copy and make action labels, autosave behavior, feedback destination and destructive outcomes clear.

- [x] Remove redundant Close buttons and autosave settings/project memory, preserving explicit consequential actions and failed drafts.

- [x] Present app forms in standalone native windows with traffic lights, scrolling content and a fixed, conventionally ordered action bar.
- [x] Route close controls through controller dismissal and remove destructive Return shortcuts.

## Composer glow refinement (2026-09-25)

- [x] Give the Stop/Send button a thin full-perimeter glow, stronger at 135°, with uneven smooth energy pulses.
- [x] Soften the chat-ready glow into an even, slower breath.
- [x] Rotate the button highlight around the glowing rim while retaining uneven pulses.

## Chat actions and comment agents (2026-09-25)

- [x] Add response Copy/Revert hover and pressed states.
- [x] Show background comment activity and truthful outcomes; cover concurrent landing, cancellation and finalizer failure without provider calls.
- [ ] Verify pointer states on an unlocked Mac and capture timing for a slow real comment run.

## PR descriptions (2026-09-25)

- [x] Analyze the committed PR diff with Luna and generate short descriptions instead of reusing chat-derived commit subjects.

## Retirement cleanup (2026-09-25)

- [x] Remove unused orb/prototype, renderer freeze-frame and media registration, old token-edit endpoint, and vendored content-controls web distribution.
- [x] Document retained uncalled helpers and current alternatives in [helper review](UNUSED-HELPERS.md).
- [ ] Decide whether to remove or reconnect the retained helpers after review.

## Provider tool connection (2026-09-25)

- [x] Verify the real Codex MCP inventory/socket before chat startup and require the bridge on subsequent turns.
- [ ] Identify the origin of the reported tool-less session and confirm controls there after updating.

## Provider preview observation (2026-09-24)

- [x] Wire live preview location and MCP screenshot image results into Codex and custom endpoint sessions.

## Preview HMR (2026-09-25)

- [x] Reproduce the affected Next preview, verify a per-project Webpack workaround, and cover source/control/Undo Fast Refresh in native WebKit.
- [ ] Recheck Turbopack after upstream Next PR #98215 ships before removing the affected project's custom command.

## On-demand native chat islands (2026-09-24)

- [x] Apply purpose-based selection, binding/replay verification and capability limits through shared provider/catalog guidance and the surface-controls skill.

- [x] Review DialKit controls and purposes; record [selection lessons and Trezi gaps](DIALKIT-REVIEW.md).

- [x] Apply throttled slider/point/curve changes during dragging, serialize overlapping updates, and preserve gesture Undo and external-edit guards.

Implementation sequence and exit checks: [Chat islands plan](CHAT-ISLANDS.md).

- [x] Define the product direction and staged plan for Jev-composed native chat islands.
- [x] Retire agent panel tools and the animation-controls skill; route all requested tuning through inline chat islands.
- [x] Ship the first chat-island slice: scoped tools, Jev block selection, SwiftUI groups/points/curves, source transactions, restoration and next-turn context.
- [x] Verify a 2D light control changes real multilayer shadows through source/HMR and undoes the coordinate batch.
- [ ] Complete flexible nested composition, previous-revision retention, rich color/spring editors and visible gesture/accessibility acceptance.
- [ ] Add repeatable shadow-layer groups with add/remove/reorder and supported runtime-live preview adapters.
- [x] Islands 1: versioned contracts, native catalog and constrained Jev composition spike.
- [ ] Islands 2: inline SwiftUI rendering, typed interactions and durable history restoration.
- [ ] Islands 3: revision-checked source bindings, grouped Undo/Reset, Replay and landing lifecycle.
- [ ] Islands 4: provider tools, on-demand Jev composition and follow-up island revisions.
- [ ] Islands 5: Bézier/spring editors, combined animations and typography acceptance scenarios.
- [ ] Islands later: runtime preview adapters, retained prop/style targets and timeline/keyframe blocks.

## Native attachment previews (2026-09-25)

- [x] Replace the composer attachment menu with image thumbnails, larger click previews, file cards, individual removal and horizontal overflow.

## Native runtime development entrypoint (2026-09-23)

- [x] Keep live chat activity labels on one truncated line.

- [x] Exit cleanly when the Swift host is launched without Bun startup arguments.

- [x] Reload the current preview page without resetting its route, query or fragment.

- [x] Show the full current preview URL when the address field is not being edited.

- [x] Add 8 points of bottom padding below composer selectors.

- [x] Group History and New Chat in a shared rounded native toolbar control.

- [x] Remove the Chat total prefix from the token footer.

- [x] Add native project drag reordering with persistent order and remove Move Up/Down menu actions.

- [x] Use plain folder/plus sidebar actions and stable animal emoji for projects without favicons.

- [x] Match sidebar project actions and project rows in height, typography and symbol color.

- [x] Move the footer cat into live activity, replacing the thinking orb at 20 points.

- [x] Move queued messages into compact stacked rows behind the composer, with removal, copy and paused-queue resume.

- [x] Speed up the beam, restrict it to active generation, and add a native thinking orb, live status transitions and streamed word reveals.

- [x] Add a native border beam to running Stop/Queue buttons and a one-time chat-ready sweep on the composer.

- [x] Improve chat typography with a shared regular body font, relaxed line/paragraph spacing and monospaced activity rows.

- [x] Clarify cumulative chat token totals with compact counts and a cached-input breakdown.

- [x] Filter recurring Codex skill-budget advice from new chat activity and preserve complete actionable warnings.

- [x] Open the inspector sidebar only from the selection toolbar, preserving explicit visibility across picks.

- [x] Grow the native composer with wrapped/multiline drafts up to a bounded height, then scroll.

- [x] Add local Running Servers inspection and confirmed Stop & Retry recovery to native preview errors and Actions.

- [x] Fix native sidebar switching between open projects and cover repeated project/chat/preview transitions.

- [x] Enable native composer Paste for clipboard images and copied files, with AppKit validation and attachment regression coverage.
- [x] Enlarge History and New Chat glyphs to correct the previous size reduction; keep the sidebar toggle unchanged.
- [x] Align sidebar action labels/icons with project rows and preserve symbol aspect ratios.
- [x] Put Open Project and New Project in the native sidebar with neutral text, distinct icons and spacing before projects.

- [x] Remove solid welcome/preview-status backgrounds so the native window surface shows through.

Migration sequence and exit checks: [Native migration plan](NATIVE-MIGRATION.md).

- [x] Native migration 1: Bun project/chat navigation, preferences, shell state, branch/publish and chat context.
  - [x] Bun project/chat navigation, restore, warm-project lifetime and profile-owned preferences.
  - [x] Service-owned native chat context, setup/token offers, annotations and background-agent state.
  - [x] Native branch/publish orchestration and landed environment refresh.
- [x] Native migration 2: authoritative AppKit layout and preview presentation.
  - [x] AppKit frames, column clipping, mobile artwork and persisted divider width; remove native DOM rectangle observers.
  - [x] Native preview loading, setup, failure and retry surfaces.
- [x] Native migration 3: core workflows without the main UI WebView.
- [x] Native migration 4: native settings, project/Git sheets, review and activity screens.
  - [x] Native New Project, project memory, Settings and provider connection forms.
  - [x] Native selectable activity log and saved-session review/actions.
  - [x] Native Git updates, GitHub connection and publish conflict output.
  - [x] Native feedback attachments and propose-first diagnosis/retry sheets.
- [x] Native migration 5: native layers, properties, styles/tokens and editing controls.
  - [x] Native layers tree, preview hover/selection and source-backed reorder routing.
  - [x] Native property/style/token/custom controls and recipe-driven content windows.
  - [x] Native inspector selection/controls and recipe-backed content save checks; see NATIVE.md for verification scope.
- [x] Native migration 6: native source editor and remaining chat/sidebar parity.
  - [x] AppKit source editor, scoped drafts/conflict-safe saves, file operations and reusable pop-out.
  - [x] Native file tree/navigation/find, streaming Markdown/tables, IME guard, drafts/conflicts, and repeated resizing checks.
- [x] Native migration 7: remove native React build/assets and validate core native workflows.

- [x] Move startup/empty workspace UI and animated cat into Swift; remove empty chat toolbar and own repeated chat resizing in AppKit.

- [x] Render native chat and interactive cards in SwiftUI; replace hidden React form forwarding with typed composer actions.
- [x] Move native chat drafts, streaming, composer actions, queues and model/permission control out of React into Bun.
- [x] Move workspace/session navigation and layout into native/Bun; replace remaining web panels and remove the main UI WebView/React bundle.
- [x] Native Markdown tables, code coloring, attachment errors and sticky request context.

- [x] Block preview app input during selection and inline editing, preserving caret movement and verifying native WebKit event isolation.
- [x] Preserve native sidebar projects and active selection across launches in profile-owned workspace storage.

- [x] Reduce native idle work and unused renderer memory; verify lazy panel state, composer parity and paired performance measurements.
- [x] Retire Electron, its React UI/browser mode, build pipeline and unused dependencies; review remaining native backend ownership.
- [ ] Validate remaining native platform/provider parity, older macOS releases and iOS Simulator for release.

- [x] Fix persistent toolbar highlights with explicit momentary segmented controls and exercise their action callback in native checks.

- [x] Animate preview expand/restore, preserve conversation width during clipping, and follow the transition in the native sidebar/header.

- [x] Expose native preview Web Inspector, Console shortcuts, and WebKit Inspect Element context menu.

- [x] Make toolbar action groups momentary and bundle/set the Trezi icon for the native app.

- [x] Compare current native/Electron build size, startup, resident memory, idle CPU and preview frame timing; document failures and measurement limits.

- [x] Adjust compact toolbar icons to approximately 20% below their original rendered size.

- [x] Enforce smaller rendered toolbar glyphs using fixed-size template artwork; verify actual screenshot pixel bounds.

- [x] Keep native preview action groups visible at narrow widths, shrink toolbar icons, and remove Projects while the sidebar is closed.

- [x] Adapt preview domain/branch contrast to page background and remove the duplicate web resize-divider paint.

- [x] Extend preview page background behind the native toolbar, use a lighter full-height divider, and remove delayed/zero-size resize updates.

- [x] Include the standalone macOS prototype in the repo and expose `bun run dev:native`, forwarding preview URL and integration-test arguments.
- [x] Connect the shared Trezi UI and application core to the native host while retaining Electron as the default.
- [x] Verify a successful live provider edit through the native composer (Codex source edit and WebKit preview reload passed; Claude still requires login).
- [x] Add a standard macOS project/chat sidebar, split-view divider and toolbar around the shared web content.
- [x] Add a native multiline composer, actual macOS 26 Liquid Glass, shared draft/action bridge and attachment controls.
- [x] Move project actions into the sidebar and preview branch/publish/code/expand into the native toolbar, with a leading sidebar toggle.
- [x] Move Home/address/device controls into the native toolbar, make Publish the trailing primary action, and remove persistent sidebar/composer scrollbar tracks.
- [x] Remove the extra gray chat-pane fill in native mode and align its fades with the theme content background.
- [x] Align native toolbar actions with the sidebar, chat and preview columns, following chat resizing and sidebar collapse.
- [x] Extend the open native sidebar through the titlebar to include the traffic lights, keeping content below the toolbar.
- [x] Make the entire Projects toolbar button open its menu, including the folder icon.
- [x] Show projects only in the native sidebar with hover actions; move chat history beside the plain chat title and New Chat button.
- [x] Use an icon-only circular Liquid Glass Settings button at the bottom of the sidebar.
- [x] Remove the chat fill, collapse empty composer chip spacing, compact selectors to their labels, and enlarge/right-align Send.
- [x] Replace the native slash dropdown with a visible skill list above the composer, including descriptions and keyboard completion.
- [x] Separate the native device button, group Code/Layers/Expand, and use a standard standalone Publish button.
- [x] Clean up native managed servers on terminal hangup and expose the native window surface through transparent WebKit/chat layers.
- [x] Stack the branch menu below the editable preview domain and remove the native Home button.
- [x] Move native composer selectors below the glass form and use a smaller standard Send arrow inside it.
- [x] Use a plain left-hand plus, text-only selectors capped at 60 points, and a smaller empty native form.
- [x] Move Select Object from the composer menu into the native toolbar group with desktop/mobile.
- [x] Fit native project rows and hover actions inside the sidebar and display available project favicons.
- [ ] Native composer polish: image thumbnails and attachment error feedback; verify pointer interaction and IME on an unlocked desktop.
- [ ] Native sidebar parity: inline rename, manual ordering and background-agent rows.
- [ ] Native parity: shared-profile migration/coordination, app-shell HMR, updater/relaunch, browser permission and download handling.

## Comment agent model routing (2026-09-22)

- [x] Use latest Sonnet for Claude comments, Sol for Codex comments and the exact selected model for Gateway comments, with matching child labels and unchanged parent settings.

## Selection toolbar cleanup (2026-09-22)

- [x] Remove the annotation action from the selection toolbar and update the expected action order.

## Per-chat composer model restoration (2026-09-22)

- [x] Keep last-used Gateway model IDs and connections out of existing chats when restoring their composer settings; cover persisted snapshots and sidebar switching.

## Compact preview address input (2026-09-21)

- [x] Cap the editable preview path at 200px and verify focused width in a wide window.

## Controls workflow skill and no-key fallback (2026-09-21)

- [x] Bundle surface-controls, expose it in provider skill menus and route natural controls requests through it.
- [x] Register validated chat-model candidates when Gateway credentials are absent, reporting the engine and fallback explicitly.

## Jev saved credentials and unavailable content (2026-09-21)

- [x] Reuse the encrypted Settings Gateway key for content, animation and component Jev requests, with deterministic connection selection.
- [x] Bound missing-source retries, recover editors after landing and retain drafts.
- [x] Fall back to chat for unsupported or malformed source during text editing.

## Property inspection console errors (2026-09-21)

- [x] Skip unsupported source formats during React inspection and handle incomplete source syntax without rejected IPC; verify recovery after repair.

## Content controls and Jev (2026-09-21)

- [x] Integrate the local content-controls package into persistent preview-area editors.
- [x] Expose catalog/registration to Claude and Codex, with JSON source saves, drafts, collections, Undo and stale-write protection.
- [x] Let Jev choose content sections and animation/component parameters from validated candidates.
- [x] Complete regression and live Jev verification; retain the recorded unrelated agent-multi failure.

## History row styling (2026-09-21)

- [x] Pull candidate updates and place History in the chat list with matching typography and row spacing, retaining muted gray.

## Subagent cat entrance (2026-09-21)

- [x] Play the existing appearance sprites once before each subagent runs or idles; respect reduced motion.

## Actual portfolio source access (2026-09-21)

- [x] Diagnose the running Next portfolio, install the missing development integration, and verify selection → Code → exact source after navigation and refresh.

## Project component composition (2026-09-18)

- [x] Add a default-off, persistent Settings toggle captured per submitted message.
- [x] Discover exported React components and styles, build a json-render catalog, and export validated TSX.
- [x] Gate Claude/Codex composition tools per chat across desktop and browser transports.
- [x] Cover source rendering, invalid specs, tool transport, toggle persistence and a live Codex preview flow.
- [x] Add selectable Jev composition, bounded Gateway requests and a real Jev-to-preview test.
- [ ] Extend discovery to imported/conditional prop types, custom adapters and other frameworks.

## Candidate push reconciliation (2026-09-18)

- [x] Integrate remote candidate history and adapt newer tests to native pickers.

## Preview address alignment (2026-09-18)

- [x] Center Home and URL text with consistent spacing in the preview toolbar.

## Test execution and evaluation (2026-09-18)

- [x] Add bounded unit concurrency and an audited Electron allowlist with exclusive barriers.
- [x] Add per-test logs, JSON reports, timeouts, cleanup, filters, and a checkout lock.
- [x] Separate skipped coverage from passing tests and benchmark serial versus concurrent units.
- [x] Build an opt-in Jev failure-triage pilot with curated splits, a baseline, cost limits, redaction, and offline tests.
- [ ] Run the live Jev pilot after configuring an ignored local TypeSafe credential; independently review labels before broader evaluation.

## Code access in exploded view (2026-09-18)

- [x] Keep the selected layer's Code action available inside the 3D workspace.

## Composer queue action (2026-09-18)

- [x] Show queued messages in an inset card above the composer, with queue/trash icons.

- [x] Replace the running Stop button with Queue while composing a follow-up.

## Automatic chat conflict reconciliation (2026-09-18)

- [x] Merge independent edits to existing text files without a Resolve click.
- [x] Try one automatic AI reconciliation for overlapping text in the originating chat.
- [x] Hold queued messages through landing; preserve Stop and manual recovery.
- [x] Cover clean/overlapping edits, staged work, bounded retries, and fallback behavior.

## Open project pages from chat (2026-09-17)

- [x] Add scoped `open_preview` to Claude and Codex/custom endpoints.
- [x] Navigate desktop/browser previews after landing, preserving route query/hash.

## Next.js setup and inspection (2026-09-17)

- [x] Separate Next framework/version/router and script-derived bundler detection.
- [x] Add development-only Next config/loader adapters and an MDX source transform.
- [x] Synchronize and hash setup helpers in new and existing agent worktrees.
- [x] Remove bulk prop-typing prompts; add a TypeScript schema fallback.
- [x] Provision Next dependencies inside worktrees and refresh changed manifests.
- [x] Reject stale-document setup verification; expose separate preview/Git evidence.
- [x] Exercise the Next 15.5.12/16.1.6 fixture matrix and run full regression verification (remaining failures recorded in PROGRESS).
- [ ] Attribute the exact compiled revision (currently explicitly unverified).

## Native animation panels (2026-09-17)

- [x] Replace DialKit integration with Trezi's existing control primitives.
- [x] Persist animation panels independently of selection, with collapse/reopen.
- [x] Wire targeted Replay and existing source-edit/Undo behavior.

## Candidate merge reconciliation (2026-09-17) — SHIPPED

- [x] **Merge remote updates while retaining native composer pickers and local
      regression fixes.** Reconcile both logs and check desktop menu behavior on
      the project action menu.

## Show exact code from chat (2026-09-17)

- [x] Add `open_code` for Claude and Codex/custom endpoints.
- [x] Open the mini editor with exact highlighted source, independent of selection.
- [x] Scope requests to the active chat/project, wait for landing, and preserve drafts.

## Selection-independent animation controls (2026-09-17)

- [x] Bundle animation tuning guidance (superseded by `/surface-controls` and inline chat islands).
- [x] Make the skill discoverable by Claude, Codex/custom endpoints, and Gemini.
- [x] Add selection-independent panels (now native panels in Trezi; supersedes the initial project UI approach).
- [x] Keep native inspector controls distinct and update the animation action prompt.

## Selection, message queues, and preview navigation (2026-09-17)

- [x] Shift-click to add/remove selected objects and send the full group as chat context.
- [x] Queue follow-ups per chat with captured attachments, removal, and pause/resume.
- [x] Keep successful merges quiet while retaining Revert and conflict notices.
- [x] Open chat links separately, guard the desktop renderer, and add Back to project.

## Consistent sidebar hover (2026-09-17)

- [x] Match project and Open/New action hovers to chat rows using one shared
      translucent fill and 6px corners in both themes.

## Compact chat composer (2026-09-17)

- [x] Hide the draft scrollbar, equalize attachment spacing at 8px, reduce content
      and control insets to 8px, and size Send/Stop to 28×28px.

## Local branch preview refresh (2026-09-17)

- [x] Refresh the preview after ordinary local-branch and named work-branch switches.
- [x] Re-detect the destination environment and install dependencies when manifests
      or lockfiles differ; reload attached previews and explain external-server restarts.

## Git updates and remote branches (2026-09-16)

- [x] Preserve the preview freeze when handing off from the branch menu to Git
      updates, and verify native visibility through updates and dismissal.

- [x] Add Git updates to the branch menu: fetch remotes, pull a selected remote
      branch into the current branch, and check out remote branches locally.
- [x] Preserve local branches and commits; reject dirty trees, active agents,
      stale branch selections, and existing Git operations; abort conflicting pulls.
- [x] Serialize with the repository writer and refresh previews after changes;
      expose the same root-scoped controls in browser mode.

## Project setup and environment changes (2026-09-16)

- [x] Ask how to start before scaffolding: defaults, Next.js, Svelte, or a custom
      setup conversation in an empty repository.
- [x] Open empty projects in chat and retain chat when preview startup fails.
- [x] Refresh managed web previews after landed environment changes; re-detect
      framework/package manager, install live-checkout dependencies, preserve
      custom commands, and defer background refreshes until activation.
- [x] Wait for setup edits to land before verifying instrumentation.

## Subagent tooltip clipping (2026-09-16) — FIXED

- [x] Keep cat tooltips inside the chat pane so the native preview cannot cover
      long labels; verify hover and keyboard focus placement.

## Desktop surfaces (2026-09-15, user-requested)

- [x] Inset the default-model chevron and capture the project actions menu.

- [x] Restyle shared dialogs and dropdowns with compact desktop proportions,
      quiet light/dark surfaces, inset menu separators, and reduced-motion fades.
- [x] Rework Settings into grouped preferences with a persistent header and a
      scrolling form; bring history review onto the shared accessible dialog.
- [x] Cover keyboard dismissal, focus return, small windows, and form cleanup
      in the Electron regression suite.

## Chat-render regression (2026-09-15) — FIXED

- [x] Supply the required permission mode in synthetic per-chat settings so
      switching chats preserves a valid permission picker; log renderer errors.

## Sidebar ordering (2026-09-15, user-requested) — SHIPPED

- [x] **Drag projects and chats to reorder the sidebar.** Project groups, live
      chats within a project, and History rows have a native lifted drag image,
      before/after drop indicator, Escape cancellation, and edge auto-scroll.
- [x] **Persist manual display order independently of session lifecycle.** Keep
      session keys, active chat, expansion state, and LRU recency unchanged;
      reconcile new/deleted entries and retain ordering across renderer reloads.
- [x] **Support keyboard reordering.** Alt+Up/Down on a row name retains focus
      and announces the move. Rename/close buttons remain separate actions.

## 3D component inspection (2026-09-15, user-requested)

- [x] **Isolate a selected component in an exploded 3D workspace.** Desktop
      selection-toolbar entry, orbit/pan/zoom, separation, front/reset, and
      surface/dropdown selection connected to the existing inspector.
- [x] **Keep edits connected to the live page.** Refresh captured surfaces after
      DOM/style changes, retain source edits and undo, recover only unambiguous
      replaced nodes, and return without navigating or remounting the page.
- [ ] **Expand rendering fidelity.** Pseudo-elements, clip/transform/effect
      reconstruction, portals and framework component grouping, continuously
      animated surfaces, and browser-mode parity. See `docs/THREE_D.md`.

## Controls from chat and authored inspector fields (2026-09-14) — SHIPPED

- [x] **Select objects and open their inspector from the agent.** Add
      `open_controls` for Claude, Codex, and custom endpoints; registering a
      custom panel requests its Custom tab, with landing retries and project scoping.
- [x] **Register animation controls on the Codex harness.** Share validated
      manifests and literal-anchor checks with Claude, including background edits.
- [x] **Show authored fields by default.** Hide absent optional props and
      browser-default styles behind Show all; retain declared falsy defaults,
      add numeric prop scrubbing, and keep rows stable while edits settle.

## Required agent-browser workflow (2026-09-14, user-requested) — SHIPPED

- [x] **Require agent-browser for browser verification when available.** Shared
      provider instructions check availability, use isolated sessions, cover three
      responsive sizes, require screenshots, and report missing/stale verification.
      Document prompt-level enforcement and preserve explicit user tool choices.

## Optional agent-browser installation (2026-09-14, user-requested) — SHIPPED

- [x] **Recommend agent-browser and offer to install it during setup.** Prompt via
      the terminal for piped installers, default to No, skip existing installs or
      absent terminals, and keep optional failures from blocking Trezi setup.

## Simultaneous startup reveal (2026-09-14, user-requested) — SHIPPED

- [x] **Reveal the entire startup cat equally at once.** Synchronize contour
      opacity and blur, preserving the four-second intro and app crossfade.

## Cat animation test reliability (2026-09-16) — SHIPPED

- [x] **Replace the long reduced-motion sleep with idle-timer assertions.** Check
      suppression and cancellation while retaining real sprite timing coverage.

## Candidate remote sync (2026-09-16) — SHIPPED

- [x] **Pull the latest sentence-case sidebar headings and preserve local commits.**

## Chat regression failures (2026-09-15) — SHIPPED

- [x] **Repair chat-render's incomplete settings fixture and surface renderer errors.**
- [x] **Wait for the asynchronous provider restart in provider-skills-menu.**

## Sync remote main (2026-09-15) — SHIPPED

- [x] **Merge the latest remote main updates and reconcile both project logs.**

## System accent focus rings (2026-09-14, user-requested) — SHIPPED

- [x] **Replace the orange/white browser focus outline with a single system-accent
      ring.** Use the same accent for shared focus tokens in both themes and keep
      the ring inside controls so sidebar clipping does not cut it off.

## Control cursors and chat action hover (2026-09-14, user-requested) — SHIPPED

- [x] **Use the arrow on remaining clickable controls.** Include selects, links,
      annotation pins, editor folding controls, and the shadow-DOM file tree.
- [x] **Remove the hover fill from chat rename and close buttons.**

## Cat activity animations (2026-09-12, user-requested) — SHIPPED

- [x] **Play the supplied thinking animation while a question awaits an answer.**
- [x] **Play idle occasionally and jump once when the active task completes.**
      Use a randomized 15–30 second rest interval, suppress completion jumps for
      errors and Stop, reset on chat switches, and respect reduced motion.
- [x] **Save all 12 supplied animations and their original timings for future use.**

## Default button cursor (2026-09-12, user-requested) — SHIPPED

- [x] **Use the default arrow on Trezi buttons.** Cover the shell, expandable
      chat messages, and preview-overlay action buttons.

## Merge local and remote main (2026-09-12) — SHIPPED

- [x] **Integrate origin/main while preserving native composer pickers.** Retain
      remote startup artwork/test changes and reconcile the progress log.

## Faster test startup (2026-09-12, user-requested) — SHIPPED

- [x] **Skip the desktop intro in ordinary suite runs.** Keep the dedicated
      startup test animated, retain app/profile isolation and other motion, and
      document the environment switch for targeted tests.

## Project action icon hover (2026-09-11, user-requested) — SHIPPED

- [x] **Use lighter gray project action icons, black on hover, with no hover fill.**

## Svelte inspector defaults (2026-09-11, user-reported) — SHIPPED

- [x] **Show declared Svelte defaults without turning them into overrides.** Cover
      Svelte 4/5, falsy values, negative numbers, expressions, definition routing,
      mounted-input refresh, and reset-to-default in the Electron regression.

## System-style dropdown menus (2026-09-11, user-requested)

- [x] **Polish existing branch, publish, and project action dropdowns.** Retain
      shadcn, softer corners/shadow, and checkmarks for selected choices.
- [x] **Restore the original provider, model, and permission pickers.** The user
      prefers their native menus; composer pickers are outside this work's scope.
- [ ] **Add a quick spring zoom with Motion to the existing action menus.**

## Supplied icon artwork (2026-09-11, user-requested) — SHIPPED

- [x] **Replace the 35 Lucide imports with the supplied SVG set.** Preserve
      artwork, sizes, and theme inheritance; retain source SVGs for future edits.
- [x] **Animate project folders and the sidebar toggle between supplied states.**
      Morph mounted paths with CSS, keep folders visible on hover, and respect
      reduced motion.

## Centered startup animation (2026-09-11, user-requested) — SHIPPED

- [x] **Use the supplied joined SVG contours.** Reveal its 21 shapes as whole
      pieces instead of animating 60 individual squares.

- [x] **Crossfade into the app after the reveal.** Fade the completed cat out and
      the interface in over 500ms; keep native preview bounds suppressed until
      the transition ends and preserve reduced-motion behavior.

- [x] **Play the supplied blue pixel-cat reveal before showing the app.** Center
      it in the window, preserve 4s/16px/24% settings, omit demo controls, and
      skip for reduced motion. Keep native previews behind the intro on reload.

## Live viewport resizing (2026-09-11, user-reported) — SHIPPED

- [x] **Reflow the preview continuously during divider dragging.** Capture the
      pointer on the divider and keep the native view live so text and responsive
      layouts update before release. Recover on cancellation and lost focus.

## Preview size readout (2026-09-11, user-requested) — SHIPPED

- [x] **Show the actual preview dimensions while resizing.** Display width ×
      height in CSS pixels at the top right, including divider-drag snapshots,
      then hide after one second without a size change.

## Scrollable project memory (2026-09-11, user-reported) — SHIPPED

- [x] **Keep long memory inside the window.** Bound the dialog and editor height,
      scroll the text internally, and keep Save and Close accessible.

## Subagent cats (2026-09-10, user-requested) — SHIPPED

- [x] **Replace nested subagent rows with smaller cats beside the composer.**
      Show up to six cats on the right of the status line for the active chat;
      hover/focus explains each operation, queued cats idle, and clicking cancels.
- [x] **Align the small cats with the border beneath the big cat.**

## Compact composer selectors (2026-09-10, user-requested) — SHIPPED

- [x] **Size provider, model, and permission selectors to their selected text.**
      Display at most 10 characters followed by `...` for longer names, retaining
      full native menu labels and allowing further truncation in narrow panes.

## Sent file attachments (2026-09-10, user-requested) — SHIPPED

- [x] **Keep files visible on sent messages.** Show an icon and filename badge
      beside image thumbnails, with the full file path on hover.

## Expanded preview header (2026-09-10, user-reported) — SHIPPED

- [x] **Keep the branch clear of traffic lights when the preview is expanded.**
      Apply clearance only to native macOS windows outside fullscreen.

## Sidebar toggle alignment (2026-09-09, user-requested) — SHIPPED

- [x] **Move the sidebar toggle up one pixel.**
- [x] **Add 8px of space beside the traffic lights, preserving the fullscreen inset.**

## Copy-on-write workspace investigation (2026-09-09)

- [x] **Measure current worktrees against native CoW workspace creation.** Added a
      reproducible disposable-repo benchmark and recorded results/limitations in
      `docs/COW-INVESTIGATION.md`; retain current production behavior.
- [x] **Profile recurring snapshot/index work before choosing an optimization.**
      Recorded per-command timings, 13 passing oracle checks, and three semantic
      hazards in `docs/SNAPSHOT-INVESTIGATION.md`. Retained-index prototypes reduce
      warm snapshot costs substantially; production remains unchanged.
- [ ] **Implement and measure a guarded private-index fast path.** Include attribute/
      config invalidation, stat-setting fallbacks, cache-boundary locking and
      recovery. Keep fresh-index fallback; CoW remains exploratory.

## Model-switch conversation handoff (2026-09-09, user-requested) — SHIPPED

- [x] **Preserve conversation context when changing models mid-chat.** Replay
      recorded history once to the selected model after explicit confirmation
      explaining additional input-token usage. Cancel preserves the current model;
      empty chats switch directly; active responses block switching.

## Escape selection shortcut (2026-09-09, user-requested) — SHIPPED

- [x] **Escape turns off S selection mode across the app and floating inspector.**
      Inline text edits cancel and disarm together; focused controls cannot swallow
      the main renderer's selection cancellation.

## Automatic visual-edit subagents (2026-09-09, user-requested) — SHIPPED

- [x] **Start AI-required preview/inspector edits immediately in background agents.**
      Props, styles, custom controls, inline text, and layer moves preserve the
      draft/main transcript and auto-apply successful results. Codex and gateway
      sessions now support detached children; failures/cancellation keep partial
      work recoverable. Literal edits retain immediate direct source writes.

## Chat title marquee (2026-09-09, user-requested) — SHIPPED

- [x] **Fit titles around revealed buttons and marquee overflowing text.** Reserve
      the action width on hover/focus, reveal the final words, reset on exit,
      and preserve static ellipsis for reduced motion.

## Chat scroll fade (2026-09-09, user-requested) — SHIPPED

- [x] **Replace the top blur with shadcn scroll-fade.** Use the real scroller's
      scroll-driven mask, keep the pinned request crisp above its answer, and
      preserve the visible scrollbar gutter.

## Codex runtime and cross-provider skills (2026-09-09, user-reported) — SHIPPED

- [x] **Update the bundled Codex SDK/CLI for GPT-6 Astra.** Upgrade from 0.146.0
      to 0.154.0; verify a live `gpt-6-astra` request succeeds.
- [x] **Populate `/` skills for Codex, custom endpoints, and experimental Gemini.**
      Discover project/user skills before the first turn and attach the selected
      skill file reference to the prompt; retain project precedence and symlinks.

## Preview sibling dragging (2026-09-04, user-requested) — SHIPPED

- [x] **Cmd/Ctrl-drag the selected element among its siblings in the native preview.**
      Generic geometry supports columns, rows, and grids, promotes nested hit
      content to the selected object, and never changes parents. Includes insertion
      feedback, movement threshold, boundary tolerance, cancellation, source edits,
      undo, and the existing agent-prompt fallback for ambiguous moves.
- [ ] **Bring the gesture to the browser preview bridge.** Native preview ships first;
      browser Layers/selection editing parity remains tracked below.

## Chat/preview divider (2026-09-04, user-requested) — SHIPPED

- [x] **Add a border between chat and preview.** The existing resize handle is
      a full-height 1px line using the shared border token; hiding chat removes it.

## Compact sidebar and flush preview (2026-09-04, user-requested) — SHIPPED

- [x] **Remove Chats headings and chat-row model labels.** Keep titles and actions.
- [x] **Keep the chat scrollbar above the fades.** Reserve its gutter at both ends.
- [x] **Use the full desktop preview pane.** Remove outer padding and rounded corners.

## Reliable rail-status regression (2026-09-04, user-requested) — SHIPPED

- [x] **Fix the recurring rail-chat-status failure.** Target Finished chat by
      identity instead of its DOM child position, wait for project initialization
      before seeding chats, and isolate the test in a temporary profile.

## Browse project chats without switching (2026-09-04, user-requested) — SHIPPED

- [x] **Project names toggle their chat lists.** Clicking the expanded project
      collapses it; clicking a collapsed project expands it and folds the others.
      Header clicks preserve the active chat and preview. Select a chat directly
      to switch to it.

## Project header actions (2026-09-04, user-requested) — SHIPPED

- [x] **Reveal project actions on hover.** Memory and Remove project share an
      ellipsis menu, followed by a New chat compose icon at the header's right edge.
      Keyboard focus reveals the controls too; touch keeps them available.

## Red measurement labels (2026-09-04, user-requested) — SHIPPED

- [x] **Match measurement value badges to their red geometry.** Value labels now
      use the same `#f24822` fill as measurement lines and caps, with an end-to-end
      assertion preventing the fills from diverging again.

## Quiet remote status (2026-09-04, user-requested) — SHIPPED

- [x] **Reduce the remote badge's visual weight.** The bordered accent pill is now
      a small connection dot with an accessible status label and full tooltip.

## Compact composer controls (2026-09-04, user-requested) — SHIPPED

- [x] **Truncate long provider/model labels instead of wrapping the toolbar.**
      The provider, model, and permission pickers now stay on one line with bounded,
      shrinkable widths while the send button remains visible in narrow chat panes.

> **The Electron tier runs on a machine with NO display** (found 2026-08-12),
> which the 2026-08-07 correction below didn't cover: after an
> `electron-vite build`, `TREZI_USER_DATA=$(mktemp -d) xvfb-run -a node
> test/<name>.mjs` launches a real window under a virtual X server, screenshots
> and all. So "needs a display" is no longer a reason to leave an electron-tier
> assertion unrun anywhere below.

## Clean selection titles (2026-09-04, user-reported) — SHIPPED

- [x] **Hide compiler style-scope classes everywhere selections are named.**
      PR #223's predicate is now shared by Layers, the native preview badge and
      `SelectedElement` payload, and the browser preview bridge. CSS selectors retain
      raw classes; only human-facing identity is filtered. `test/select-element.mjs`
      covers both the visible badge and renderer payload.

## Option-hover spacing measurement (2026-09-04, user-reported) — SHIPPED

- [x] **Restore the unmerged Figma-style measurement overlay.** ✅ 2026-09-04 —
      The pure geometry and preview input/rendering path are integrated. Select an
      element, hold Option/Alt, and hover another to see facing-edge
      gaps or matched-edge insets. `test/measure-distance.mjs` and
      `test/measure-alt.mjs` cover geometry, the real gesture, cleanup, and pixels.

## Flat peer chats (2026-09-04, user-requested) — SHIPPED

- [x] **Remove the Main/secondary hierarchy.** Every live chat now uses its own
      title, renders in the same newest-first list, and has the same rename and
      close actions. The Main-only context reset was removed; a fresh context is
      simply a new peer chat. When sessions stop, relaunch continuity follows the
      last-active chat instead of privileging the project's first-created key.
      Legacy `slot: 'main'` records remain readable and migrate to `slot: 'current'`.

## Rail accordion (2026-09-04, user-requested) — SHIPPED

- [x] **Switching projects hands the open chat list over.** ✅ 2026-09-04 — the
      rail keeps exactly one project unfolded: `foldOthers` in `store.ts` runs on
      `activate`/`openOrActivate` and on the chevron (which unfolds exclusively
      too), so the project you leave folds as the one you pick opens instead of
      every visited project stacking up. `.rail__project-body` animates from
      `height: 0` to `auto` so the swap is motion, not a pop. `test/rail.mjs`.
      See PROGRESS 2026-09-04.

## Browser and hosted Trezi (2026-09-03, user-requested) — IN PROGRESS

- [x] **Write the architecture plan.** ✅ 2026-09-03 — `docs/BROWSER.md` covers a
      shared browser client for localhost, remote access to a local workstation, and
      a Railway-style hosted workspace; it includes security boundaries, persistence,
      preview bridging, delivery phases, and acceptance criteria.
- [x] **Build the local-browser foundation.** ✅ 2026-09-03 — `trezi serve <repo>`
      runs the existing workspace engine without a desktop window and serves the
      shared React UI on loopback. A single-use launch exchange, scoped HTTP RPC,
      WebSocket events, sandboxed preview gateway, and browser `postMessage` bridge
      cover project open, dev-server startup, agent commands/streaming, preview, and
      stamped element selection. `test/browser-mode.mjs` covers auth, scope/origin
      rejection, agent event completion, dev-server proxying, and bridge injection;
      the real browser flow was also driven through source selection.
- [x] **Restore browser design-token detection and starter scaffolding.** ✅
      2026-09-04 — the browser router now shares the Electron token service, so
      **Add tokens** writes the root-scoped, idempotent `.trezi/tokens.json` and
      existing Tailwind/CSS/manifest tokens are detected instead of receiving a
      false offer.
- [ ] **Bring the remaining native editing tools to browser parity.** Move the
      props/styles/text/source/history/setup/publish handlers onto the shared router,
      expand the browser preview runtime beyond selection, and run a real provider
      edit through the browser adapter. Native-only affordances should keep explicit
      browser fallbacks.
- [x] **Add secure single-client remote-workstation access.** ✅ 2026-09-04 —
      `trezi serve <repo> --remote` keeps control and preview services on separate
      loopback ports and publishes them as separate, tailnet-only Tailscale Serve
      HTTPS origins. It adds one-time browser pairing, exact public-origin checks,
      secure cookies, reconnect replay, graceful route cleanup, and a visible remote
      indicator. The CLI detects disconnected/disabled Tailscale state and existing
      port conflicts before exposing anything.
- [ ] **Harden mode 2 for multiple clients and unattended use.** Add presence and
      selective revocation UI, writer arbitration, suspend/lock controls, and a
      launchd/systemd user service. The current process-lifetime mode intentionally
      pairs one browser profile.
- [ ] **Deferred: personal Railway alpha and multi-tenancy.** The 2026-09-03 product
      decision prioritizes local-browser and remote-workstation modes first. Later,
      containerize the web runtime, persist `/data`, add application/Git/provider
      auth and quotas, and verify edit/recovery/publish across a redeploy. Multi-user
      workspaces require the separate control-plane/isolated-worker phase in
      `docs/BROWSER.md`.

## Git-based PR descriptions (2026-09-02, user-reported) — SHIPPED

- [x] **Create PR must not paste the chat transcript.** ✅ 2026-09-02 — PR title
      and body now come from change-bearing branch commits, changed-file scopes, and
      diffstat. Conversation-only messages, logs, slash commands, and old
      `Changes requested in Trezi` publish commits are excluded. Existing PRs get
      their title/body refreshed on the next Create PR. Regression fixture mirrors
      the broken `about-me-2026` PR #8.

## Inline chat color previews (2026-09-02, user-requested) — SHIPPED

- [x] **Show a swatch beside hex colors in assistant messages.** ✅ 2026-09-02 —
      assistant prose and inline code now preview 3/4/6/8-digit CSS hex literals with
      a small outlined swatch. Fenced code and links remain untouched. Covered by the
      pure `test/markdown-color.mjs` component regression and the visual
      `test/chat-render.mjs` Electron regression.

## Automatic background agents for complex text edits (2026-09-01, user-reported) — SHIPPED

- [x] **Run agent-required inline text edits without posting in chat.** ✅ 2026-09-01 —
      direct text splices remain instant; expression/mixed/error fallbacks now enter
      the detached worktree queue automatically with the active model. A `text-edit`
      event origin keeps the composer and transcript untouched, uses the rail for
      progress, and reports completion in the activity log. The prompt is constrained
      to the smallest selected-element edit. Unsupported backends/non-repos retain the
      composer fallback so intent is never lost. `test/text-edit.mjs`.

## Automatic cleanup for completed chat branches (2026-09-01, user-reported) — SHIPPED

- [x] **Prune branch-only residue without risking unfinished work.** ✅ 2026-09-01 —
      project open now follows orphan-worktree recovery with a local
      `trezi/chat-*` branch sweep. It removes only unattached, unparked refs whose tip
      is reachable from live `HEAD` or has a patch-equivalent commit there; unique
      patches remain recoverable. Backup, normal work, comment-agent, remote, and
      checked-out branches are outside the deletion set. `test/worktrees.mjs` covers
      the equivalent-commit case plus every preservation boundary.

## Contextual animation controls + opt-in generation (2026-09-01, user-requested) — SHIPPED

- [x] **Hide inert transition controls.** ✅ 2026-09-01 — browser computed defaults
      (`all 0s ease`) no longer materialize the Transition group. A positive-duration,
      non-`none` transition restores the existing duration/delay/Bezier/Replay editor.
- [x] **Generate animation controls only on request.** ✅ 2026-09-01 — the empty
      transition state offers a separate description input; submitting it asks the
      agent to add motion in the project's existing idiom and expose meaningful values
      through the Dialkit-style custom-control path.
- [x] **Evaluate `interface-kit`.** ✅ 2026-09-01 — inspected npm `0.1.3` and its
      published bundle without installing it. Its broader visual property coverage is
      useful reference material, but React 19-only integration and a DOM-preview → copy-
      prompt edit model are a regression from Trezi's source-aware editing seam, so it
      was not adopted. See PROGRESS 2026-09-01.

## Codex can operate Trezi-owned worktree recovery (2026-08-28, user-requested) — SHIPPED

- [x] **Stop handing complex landing conflicts back to the user.** ✅ 2026-08-28 —
      Codex and gateway sessions now receive session-scoped `workspace_state` and
      `prepare_conflict_resolution` MCP tools. They read/mutate the authoritative
      in-process coordinator through a token-scoped local socket and the existing
      repository queue; Codex resolves the staged markers in its own checkout and
      normal turn completion lands them. No raw Git or discard/reset capability is
      exposed. `test/trezi-agent-tools.mjs`, `test/chat-worktrees.mjs`, `test/rules.mjs`.

## Remote publish reconciliation (2026-08-27, user-reported)

- [x] **Preserve and reconcile both work-branch histories before push.** ✅
      2026-08-27 — Publish now holds a per-repository lock, fetches/prunes origin,
      records recovery refs for both tips, chooses normal push vs fast-forward vs
      explicit merge from ancestry, and retries a remote-moved rejection at most
      three total attempts. Conflicts pause with their exact files and never use
      force/rebase/reset or a blanket ours/theirs strategy. Existing conflicts are
      refused before staging. `test/publish-reconcile.mjs` covers the full graph
      matrix plus a real push race.
- [ ] **Replace permanent work-branch publishing with unique publish branches.**
      Build each `trezi/publish/<session-id>` from a freshly fetched
      `origin/<base>`, apply the session's squashed changes there, open/merge its
      PR, delete the temporary branch, and seed the next chat from the newly
      fetched base. This removes cross-session branch-name collisions entirely;
      it needs a deliberate migration for current PR-only mode and existing open
      PRs rather than being hidden inside the rejection repair.

## Terminal shutdown errors (2026-08-24, user-reported) — SHIPPED

- [x] **Stop the endless `write EIO` dialog loop after the launch terminal closes.** ✅
      2026-08-24 — stdout/stderr now absorb only write-side `EIO`/`EPIPE` from a
      vanished PTY before those errors reach the global crash reporter and get
      logged recursively. Other stream errors still surface.
      `test/terminal-streams.mjs` covers the classifier and guard behavior.

## Default model + Main surviving reload (2026-08-18, user-requested) — SUPERSEDED

- [x] **New chats follow last-used, or a Settings default.** ✅ 2026-08-18 —
      Claude is no longer hardcoded as the only fallback. `preferred-model.ts`
      remembers the last picker choice (any chat) and Settings → Models can pin
      a specific model instead. Existing chats keep their own `chatSettings`.
      See PROGRESS 2026-08-18.
- [x] **Main keeps its thread across quit/relaunch.** ✅ 2026-08-18 — closing or
      quitting persists Main as `slot: 'main'` (hidden from History). The next
      `open-project` restores the transcript in place and resumes the Claude SDK
      session when it can. **Clear context** is still what archives it into
      History. `test/agent-history.mjs`, `test/restore-reload.mjs`.

## Cross-origin iframe navigation (2026-08-18, user-reported) — SHIPPED

- [x] **Let iframe redirects load without weakening the pinned preview origin.** ✅
      2026-08-18 — `will-navigate` / `will-redirect` now use Electron 43's
      `details.url` and `details.isMainFrame`; subframes proceed untouched while the
      main frame remains pinned to the exact origin and port. Preview popup requests
      are denied silently because `setWindowOpenHandler` exposes no reliable
      user-activation signal. `test/preview-iframe-navigation.mjs` covers a
      cross-origin iframe 302, the no-external-open invariant during mount, and a
      blocked/externalized top-level navigation to the iframe's localhost port.

## Architecture + security review fixes (2026-08-14, user-requested) — SHIPPED

- [x] **Preview hardening.** ✅ 2026-08-14 — untrusted preview moved to its own
      `persist:trezi-preview` partition with deny-all permission handlers;
      `will-redirect` guarded like `will-navigate`; navigation pinned to the
      loaded dev-server origin (was: any localhost port); `shell:true`
      invariants documented at both spawn sites. See PROGRESS 2026-08-14.
- [x] **Background chats' permission/question cards were dead.** ✅ 2026-08-14 —
      cards now carry `sessionKey` and render only in their own chat; main
      resolves responses across ALL sessions instead of only the active one.
- [x] **Cross-boundary mirrors made single-source.** ✅ 2026-08-14 — layer types
      import from `shared/api.ts`; preview channel names in
      `shared/preview-channels.ts`; style-prop allowlist in
      `shared/style-props.ts` with a `satisfies` check on the renderer meta;
      `SimElementPick`/`ProjectCreateResult` named and drift-fixed.
- [x] **Lifecycle fixes.** ✅ 2026-08-14 — `nativeTheme` listener registered
      once (was leaking per dock re-activate); spawn cap reserved synchronously
      (was racy under concurrent `pumpQueue`).
- [x] **Size/duplication.** ✅ 2026-08-14 — `preview-ipc.ts` extracted from
      `index.ts` (1263 → 968) with a shared `requestReply` helper; preload's 24
      subscribe wrappers → one `on<T>()` factory; new `test/style-tokens.mjs`
      unit test.
- [ ] **Deferred splits (each its own PR):** `App.tsx` (2194 lines, 31
      useEffects), `store.ts` (1755 — ~25 stores + helpers + test handles),
      `ChatPanel.tsx` (1704 — composer vs message list), and `props.ts` (1330 —
      extract the shared source-file plumbing used by styles/move-node/controls
      into a `source.ts`).

## A project's favicon leads its rail row (2026-08-12, user-requested) — SHIPPED

- [x] **Show the project's own favicon instead of the folder icon.** ✅ 2026-08-12
      — new `src/main/project-icon.ts` resolves an icon from the project's source
      tree (declared `<link rel="icon">` first, then the conventional paths) and
      inlines it as a `data:` URL over a new `project:icon` IPC; a
      `useProjectIcons` store feeds `Rail.tsx`, where the `<img>` rides
      `.rail__folder` so it keeps the 16px slot and the hover-to-chevron
      cross-fade. Reads FILES, not the running page, so a cold project has an
      icon too. `test/project-icon.mjs` (unit), `test/rail-favicon.mjs`
      (electron, screenshot 19). See PROGRESS 2026-08-12.
- [ ] **Follow-up: a first favicon added mid-session needs a relaunch.** Main
      revalidates a *changed* icon by mtime, but the renderer caches a miss for
      the session, so a project that gains its first favicon while open keeps
      the folder until next launch. A `refresh()` on the store (called after a
      turn touches the project) closes it; not worth a poll.

## Editor media previews (2026-08-09, user-reported)

- [x] **Opening an image in the editor showed its bytes as text.** ✅ 2026-08-09 —
      `source:read` now classifies media/binary instead of always decoding utf8, and
      the drawer renders `MediaPreview` (image on a checkerboard, video/audio with
      controls, placeholder otherwise) served over a token-scoped, range-capable
      `trezi-media://` protocol. See PROGRESS 2026-08-09.
- [ ] **Give the file tree a type hint.** `source:tree` returns bare paths, so the
      sidebar can't show an image icon or a thumbnail until it carries per-entry
      metadata — and the editor can't warn before opening a 200 MB asset.
- [ ] **No video fixture in the suite.** `test/code-drawer.mjs` proves the protocol's
      206/`Content-Range` path with a PNG, but nothing exercises a real `<video>`
      (seeking, `video/quicktime` on a .mov). Needs a checked-in seconds-long clip.

## Main chat, child agents, and project memory (2026-08-08) — SUPERSEDED

- [x] **Make Main a stable, visible project role.** ✅ 2026-08-08 — Main is pinned
      first, cannot be closed like a secondary, and History is a separate rail section.
- [x] **Show comment agents under the chat that launched them.** ✅ 2026-08-08 —
      spawn identity now carries the parent session key; rows show their inherited
      model and aggregate onto the parent/project working status.
- [x] **Durable per-project memory + clear Main context.** ✅ 2026-08-08 — curated,
      16k-bounded memory lives outside Git in Trezi userData, enters every provider,
      and survives a Main reset; the old transcript is archived into History.
- [x] **Sort the rail's per-project controls by what they act on.** ✅ 2026-08-09 —
      project memory is a brain action on the project row (× is hover-only now),
      "New chat" is a full-width button under the chat list it appends to, and
      History folds as an accordion. See PROGRESS 2026-08-09.
- [x] **Put the whole rail block on one indent grid.** ✅ 2026-08-09 — the "New chat"
      + and the History chevron moved into the same 16px glyph slot as the folder and
      the status dots (labels all at 31px); row actions became a hover overlay so
      every row's model/time ends on one trailing edge instead of Main's running 34px
      further right; History now starts folded and the memory brain is hover-revealed
      like ×. See PROGRESS 2026-08-09.
- [x] **Learn unified project memory from conversation decisions.** ✅ 2026-09-04 —
      after each successful turn, Claude and Codex run a tool-free, conservative
      evaluator that merges durable decisions into shared memory. Per-project queues
      prevent peer-chat races and protect concurrent manual edits; the memory editor
      remains the user's direct review and override surface. See PROGRESS 2026-09-04.
- [x] **Enable detached background agents on Codex/gateway sessions.** Shipped
      2026-09-09 with tagged child output, automatic visual-edit routing, safe
      terminal outcomes, and real Codex auto-landing/cancellation verification.

## Per-chat isolation (2026-08-08, user-reported)

- [x] **Merge conflict on almost every turn, listing `node_modules`.** ✅ 2026-08-08
      — a trailing-slash `node_modules/` `.gitignore` is directory-only and doesn't
      match the symlink Trezi stitches into each worktree, so `git add -A` staged
      it and the auto-merge choked (`EISDIR`) → parked every turn. Fixed by
      excluding `RUNTIME_DEPS` (node_modules/.env) from every stage explicitly
      instead of trusting `.gitignore` (`worktrees.ts`, `chat-worktrees.ts`), plus a
      slash-free scaffold `.gitignore`. Regression: `test/chat-worktrees.mjs` repo9.

## Codex turn streaming (2026-08-08, user-reported)

- [x] **A connection running DeepSeek works end-to-end.** ✅ 2026-08-08 — the user
      ran `deepseek/deepseek-v4-flash` through a gateway connection and got real
      multi-turn replies (38k in / 513 out). That closes the "Kimi/DeepSeek
      unproven" item below for DeepSeek: an open model really does drive a chat on
      the Codex harness. Its `apply_patch` reliability is still unmeasured — that
      needs a turn that actually EDITS a file.
- [x] **Assistant replies were missing their opening, mid-word.** ✅ 2026-08-08 —
      "ve reliable visibility…", "ing else?". Codex streams whole items and trezi
      emits the unsent SUFFIX, but the CLI numbers items PER TURN while the
      tracker lived for the whole SESSION — so turn 2's `item_0` inherited turn
      1's length and lost exactly that many leading characters. Longer replies
      still rendered, just beheaded, which is why it went unnoticed. New pure
      `backends/codex-stream.ts`, reset each turn. Same bug silently DROPPED tool
      steps on later turns (an id already "surfaced"). `test/codex-stream.mjs`.
- [ ] **"Model metadata for `<model>` not found" is repeated every turn.** The
      string lives in the vendored `codex` binary, so it's the CLI warning about a
      non-OpenAI model id, and it lands in the chat's step list on EVERY turn —
      pure noise after the first. Worth finding which event carries it (it renders
      as a step, not a red error) and showing it at most once per session, or
      dropping it: the user can't act on it and it isn't wrong, just loud.

## Props island + preview port (2026-08-07, five failing Electron tests)

- [x] **The island's first state push had nowhere to land.** ✅ 2026-08-07 — the
      view is created by `panel:show`, which follows the first `setState`, and
      the `did-finish-load` re-push races the island's own listener. The island
      now PULLS (`panel:request-state`) after subscribing. See PROGRESS.
- [x] **A reopened island could stay at its 160px default.** ✅ 2026-08-07 —
      `PanelHost` remounts with a fresh size state while the island page (and its
      ResizeObserver) lives on, so an unchanged card height reported nothing.
      `PanelApp` re-measures on every state push.
- [x] **`isPortFree` missed a dual-stack occupant.** ✅ 2026-08-07 — SO_REUSEADDR
      lets a 127.0.0.1 bind succeed under a wildcard listener, so trezi handed
      out an occupied port and then previewed whatever already answered there.
      Both probes now run; the wildcard one only votes on `EADDRINUSE`.
- [ ] **`custom-controls`'s burst assert is still latency-sensitive.** It needs
      three `applyLiteral` records inside edit-history's 500ms window; main-side
      apply latency is usually 15–135ms but was measured at 496ms once under
      load. If it flakes again, the honest fix is main-side (why does a
      read-splice-write occasionally take half a second?), not a bigger
      COALESCE_MS.
- [ ] **Leaked fixture dev servers survive a killed test run.** Seven `node
      server.mjs` processes from July/August runs were still holding 7777–7783 on
      this machine (`before-quit` → `stopAll` only runs on a graceful quit). The
      port fix makes trezi route around them; nothing reaps them.

## Settings "Connecting…" hang + publish guidance (2026-08-07, user-reported)

- [ ] **STILL NOT REPRODUCED — the user's Connect hangs, mine doesn't.** They see
      "Contacting ai-gateway.vercel.sh… 94s" with no error. Measured inside the
      BUILT app's main process on this machine, every case ends promptly: real
      gateway + bogus key → 401 in 0.7s, closed port → instant, blackhole IP →
      the 10s abort fires. So main is healthy here and the difference is on their
      machine or in their build. Two theories, neither confirmed: (a) they run
      `bun run dev`, where React.StrictMode double-invokes mount effects — the
      `live` ref was cleanup-only, so `live.current` would stay false forever and
      `stale()` would be permanently true, meaning the probe could never render,
      error, OR hit its own deadline. Fixed the ref regardless (it was a real
      bug), but a `--mode development` build did NOT reproduce it, so this is
      unproven. (b) something network-level (proxy/VPN/DNS) that main's own abort
      somehow doesn't cover. NEXT: ask which command they launch with, and get
      the error text now that the state-driven deadline forces one after 12s.
- [x] **Made the hang structurally impossible instead of guessing.** ✅
      2026-08-07 — the deadline is now driven by the rendered `inFlight` state,
      not by a closure gated on `stale()`. Any path that disowns a probe without
      clearing the state used to strand the button; now if `inFlight` is set it
      is cleared when the deadline passes, whatever went wrong. Plus the first
      real UI test of the dialog (`test/settings-connect.mjs`) — two rounds of
      fixing this shipped without one, which is why both missed.
- [ ] **The never-answering-IPC path isn't test-reachable.** The preload bridge is
      frozen so a test can't stub `providers.catalog` to hang, and main always
      answers within its 10s abort — so the state-driven deadline is reasoned,
      not asserted. Needs either an injectable IPC seam or a main-side switch to
      stall a probe on demand.
- [x] **Publish failure now says how to fix it.** ✅ 2026-08-07 — "this folder
      isn't the repository root" named no repo and no action. It now distinguishes
      "not a git repository at all" (→ `git init` here) from "inside the repo at
      <path>" (→ open that, or `git init` here), and `scaffold.ts` no longer
      SWALLOWS a failed `git init`/first commit — that silence is what let a new
      project look fine until publish blamed something unrelated.

## Stop / interrupt (2026-08-07, user-reported)

- [x] **Stop was a dead button on Claude, and a silent no-op on Gemini.** ✅
      2026-08-07 — the SDK's `interrupt()` control request has no timeout, so a
      wedged subprocess made Stop hang forever with the spinner still running.
      New pure `src/main/backends/interrupt.ts` (ask, then kill), claude.ts
      escalates to its abort signal and emits the missing `done`, agent.ts caps
      its wait and rebuilds the dead session. Gemini gained a real `interrupt`.
      `test/interrupt-escalation.mjs`. See PROGRESS 2026-08-07.
- [ ] **The wedge itself was never reproduced.** The fix is reasoned from the SDK
      source + event paths and its escalation logic is unit-tested, but nobody has
      seen it rescue a real hang. If it recurs: confirm Stop now returns within
      ~3s, the chat restarts, and the "force-stopped" message appears. Worth
      capturing what triggers it (large image attachment? long session? a
      particular tool?) — the user reported it as intermittent.
- [ ] **A hard stop loses the model's context.** The restarted chat is a fresh SDK
      query, so earlier turns are gone from the model's view even though trezi
      still shows them. The record captures `sdkSessionId`, and v9 resume already
      exists, so restarting via `resume` instead of fresh would keep the context —
      not attempted here because a wedged session's id may itself be unusable.
- [ ] **Codex/connection turns can't be force-stopped, only aborted locally.** Its
      `turnAbort` cancels trezi's read of the stream; whether the underlying CLI
      process actually dies wasn't verified. Worth checking a connection turn
      against a slow endpoint.

## v10 — bring-your-own-model connections (2026-08-07, user-requested)

- [x] **Connections: user-added OpenAI-compatible endpoints.** ✅ 2026-08-07 —
      harness and endpoint split apart (`AgentOptions.connectionId` beside
      `provider`); `src/main/providers-store.ts` (pure) +
      `src/main/providers.ts` (safeStorage cipher, `providers:*` IPC, `/models`
      probe, `resolveConnection`); Codex SDK aimed at the endpoint via a
      dedicated `model_providers."trezi-connection"` block.
      `test/providers-store.mjs`. See PROGRESS 2026-08-07.
- [x] **Settings dialog + model-first picker.** ✅ 2026-08-07 —
      `SettingsDialog.tsx` / `ProviderForm.tsx` / `renderer/src/providers-store.ts`;
      `ChatPanel.tsx`'s hardcoded model arrays and Backend dropdown deleted in
      favour of one grouped list from `providers.choices()`.
- [ ] **NOTHING here has hit a live third-party endpoint.** Every verification
      was a local probe server plus the real SDK/CLI. SUPERSEDED 2026-08-07 for the
      gateway — see the next item; still open for Groq and other hosts.
- [x] **The connection path works against a live AI Gateway.** ✅ 2026-08-07 —
      real key, real turn, real edit: `anthropic/claude-sonnet-4.6` through
      `https://ai-gateway.vercel.sh/v1` on the Codex harness read the file, wrote
      a correct edit, left the untargeted function alone, and finished in 15.5s
      with ZERO error events. That settles the two big unknowns: the gateway's
      `/responses` accepts Codex's request shape, and the
      `model_providers."trezi-connection"` block (websockets off) is right — no
      reconnect attempts appeared. `/models` returned 322 models including all
      eight Kimi variants and nine DeepSeek ones.
- [ ] **Kimi/DeepSeek still unproven — the test key was free-tier.** Every open
      model returns 403 "Free tier users do not have access to this model", then
      429 once the free allowance is spent; only `anthropic/*` was reachable. So
      the `apply_patch` question below is still open, and needs paid gateway
      credits to answer. (Note the irony: the first fully working connection ran
      Claude through the Codex harness.)
- [ ] **Open models may fumble Codex's `apply_patch` format.** GPT-5 was trained
      on it; Kimi/DeepSeek weren't, so edits may need retries or fail. Blocked on
      paid credits (above). If it's bad, the fix the user asked for is an appended
      system-prompt section teaching the patch format (trezi already prepends its
      rules to the first Codex turn, so there's a hook).
- [ ] **Connection runs inherit the user's global `~/.codex/config.toml` MCP
      servers.** Observed live: an unauthenticated `mcp.vercel.com` entry on the
      dev machine dumped an OAuth `AuthRequired` blob into the turn's error text.
      Trezi only overrides `model_provider`, so this is expected — but it means a
      user's unrelated MCP config can pollute a connection chat. Decide whether a
      connection run should start from a clean MCP set.
- [ ] **A chat pointing at a deleted connection.** The picker falls back to an
      option echoing the raw stored value and `AgentOptions` still carries the
      dead `connectionId`; main fails the turn soft with "re-add it in Settings".
      Deliberate (don't silently rewrite a user's chat settings) but the UX of
      that state hasn't been designed.
- [ ] **Untested UI paths:** the `unsupported: true` free-text fallback (host
      with no `/models` route) and the edit-an-existing-connection auto-probe.
      Both need a host that exhibits them.
- [x] **Both seats' model lists are discovered, not curated.** ✅ 2026-08-07 —
      `src/main/model-catalog.ts` (pure: parsers + TTL cache, injected
      clock/baseDir, persisted to `<userData>/trezi/model-catalog.json`) +
      `src/main/codex-models.ts` (runs `codex debug models` on the SDK's vendored
      binary). Claude answers `Query.supportedModels()`, handed back from
      `backends/claude.ts` since it needs a live session. `test/model-catalog.mjs`.
      See PROGRESS 2026-08-07.
- [ ] **Codex-seat parity holes** (these now matter for every connection model,
      not just ChatGPT users): trezi's in-process tools aren't available (serve
      them over a local MCP server injected via `CodexOptions.config`, whose
      `mcp_tool_call` events `backends/codex.ts` already maps); no
      `AskUserQuestion` equivalent; no resume (`resumeThread(id)` +
      `ThreadStartedEvent.thread_id` make this nearly free). Background spawning shipped
      2026-09-09; provider-thread resume remains open.
      Per-tool approve/deny cards are NOT closable — the SDK event stream has no
      approval-request event; user accepted that trade-off 2026-08-07.

## Design-token naming accuracy (2026-07-30/31, user-reported)

- [x] **A token from another property family can't name a row.** ✅ 2026-07-30 —
      `--rmt-radius-none` was labelling `padding: 0`. `groupAffinity` (a coarse
      `TokenKind`) became `groupRole` (a semantic `TokenRole`). Superseded the
      next day by the proof requirement below for `css`/`tailwind` sources
      (role-based ranking is no longer how naming is decided for them — proof
      is); still load-bearing for `manifest`, which has no proof mechanism.
      `src/shared/token-match.ts`, `test/token-match.mjs`. See PROGRESS 2026-07-30.
- [x] **Naming requires PROOF a value comes from a token, not just equals one.**
      ✅ 2026-07-31 — `getComputedStyle` always resolves `var()` away, so value
      equality alone can never distinguish "IS this token" from "coincidentally
      equals it." New `src/preview/style-provenance.ts` reads the SPECIFIED
      (unresolved) declaration — inline `style=` or a matched stylesheet/scoped-
      `<style>` rule — threaded through `styles:read` as `declaredVars`.
      `resolveTokenForValue` now requires it for `css`/`tailwind` sources;
      `manifest` (no reference mechanism exists) keeps the value+role heuristic
      above. `test/token-match.mjs`, `test/style-provenance.mjs` (new, real
      headless-Chromium DOM/CSSOM test), `test/style-edit.mjs`. See PROGRESS
      2026-07-31.
- [ ] **`sameCssValue` doesn't equate bare `0` with `0px`.** Found 2026-07-30
      while writing the above. A theme declaring `--space-0: 0` (unitless —
      legal CSS, and `tokenValueKind` already accepts it as a length) can never
      match a computed `0px`, so that token is offered but never names anything.
      Fix belongs in the renderer's `css-values.ts` comparator; it shifts
      matching for every property, so it wants its own pass.
- [ ] **`test/style-edit.mjs`'s token assertions are written but unrun.**
      CORRECTED 2026-08-07: the reason recorded here ("the Electron tier can't
      launch a window on this machine") was WRONG — see the new gotcha in
      CLAUDE.md. The tier runs fine through `test/run.mjs`, which gives each test
      a fresh `TREZI_USER_DATA`; the `.empty__open` timeout only happens when a
      test is invoked DIRECTLY (`node test/style-edit.mjs`), because it then uses
      the real app state, and if any project is open the empty state never
      renders. `style-edit` does still fail under the runner, but on a genuine
      assertion ("inspector never showed src/Styled.tsx:5 after clicking
      #tw-box") — that's the real bug to chase. Same gap as the styles-ladder
      fix (2026-07-30); worth a real run wherever the Electron window can
      reliably take focus.

## Styles ladder — respect the project's styling convention (2026-07-30, user-requested)

- [x] **Never INTRODUCE an inline style.** ✅ 2026-07-30 — S2 now only extends a
      `style` attribute that already exists; absent → S3, whose prompt names the
      project's own approaches and forbids the agent from adding one either.
      Fixes a token pick writing `style="color: var(--color-title)"` onto a bare
      `<h1>` in a CSS-variable project. `src/main/styles.ts`,
      `styles-svelte.ts`; contrast case + `BareCard` fixture in
      `test/style-edit.mjs`. See PROGRESS 2026-07-30.
      Deliberately NOT planned (dropped 2026-07-30, user call): teaching S1 to
      CREATE a class attribute for Tailwind projects. The mirror-image gap is
      real — an unclassed element in a Tailwind project pays an agent turn it
      shouldn't — but reliable project-level Tailwind detection is the blocker
      (v4 is CSS-first and often ships no `tailwind.config.*`), and agent-routing
      it is correct, just slower.
- [ ] **A runnable tier for the styles ladder.** CORRECTED 2026-08-07 — the
      premise ("can't launch a window on the current dev machine, dies at
      `.empty__open`, at HEAD too") was wrong: that only happens when the test is
      run directly instead of through `test/run.mjs`, which isolates
      `TREZI_USER_DATA` per test. The window launches fine. The S2-refusal
      assertion is still unrun because `style-edit` fails earlier on a real
      inspector assertion. Verified instead with a throwaway harness driving
      the real `applyStyleEdit` in node (PROGRESS 2026-07-30 has the details).
      Worth making permanent if the Electron tier stays unrunnable.

## Rail chat statuses + rename (2026-08-05, user-requested) — SHIPPED

- [x] **A status dot per chat row + inline rename.** ✅ 2026-08-05 — hollow ring
      = stale, filled grey and blinking = a turn in flight, filled green = a turn
      finished while you were on another chat. Dots occupy the project row's own
      16px folder-glyph slot, so they share its centre line while the chat names
      keep their indent. New `needsReview` on the chat slice (set by `finish`
      only for a chat that isn't on screen, cleared by `setActiveChat`). Rename
      goes through main, the only writer of a chat's name:
      `agent:rename-chat` for a live chat (it also blocks the auto-namer),
      `sessions:rename` for a past one. New
      `src/renderer/src/components/RailChatRow.tsx`,
      `test/rail-chat-status.mjs`. See PROGRESS 2026-08-05.

## Layers panel (2026-07-29, user-requested) — SHIPPED

- [x] **DOM tree + click-select + drag-to-reorder.** ✅ 2026-07-29 — a tree of
      the previewed page above the chat, toggled from the composer. Selecting
      a row reuses the real in-page click path; dragging writes a real source
      edit for a same-parent sibling reorder (React/Svelte/static HTML), and
      seeds a chat prompt for anything ambiguous (list items, reparenting,
      cross-file). New `src/preview/layers.ts`, `src/main/move-node*.ts`,
      `src/main/ast-walk.ts`, `LayersPanel.tsx`/`LayersTree.tsx`.
      `test/layers-move.mjs` (unit), `test/layers-panel.mjs` (electron, new
      `test/fixtures/layers-app/`). See PROGRESS 2026-07-29.
      Deliberately NOT planned (dropped 2026-07-30, user call): reparenting /
      cross-parent / cross-file moves stay agent-routed; label live-refresh
      and tree virtualization only if real use demands them.

## Design tokens in the Styles panel (2026-07-28, user-requested) — SHIPPED

- [x] **Name the token instead of the value, and offer a picker.** ✅ 2026-07-28
      — every token-able row (colors, padding/margin/gap, radius, font-size /
      -weight, line-height, letter-spacing, opacity) shows the matching token's
      name and expands an inline `TokenPicker`; picking one writes a *reference*
      (`var(--name)` / a Tailwind token class), never the resolved value.
      New `src/shared/token-match.ts` + `src/main/style-tokens.ts`,
      `TokenSet` on `PanelState`, `.less`/`.sass` detection. `test/token-match.mjs`,
      extended `tw-styles.mjs` / `tokens.mjs` / `style-edit.mjs`. See PROGRESS 2026-07-28.
      Deliberately NOT planned (dropped 2026-07-30, user call): Svelte
      scoped-`<style>` editing (token picks there keep seeding the agent),
      "save this value as a token", and deleting the dead token-apply path (that earlier keep decision was
      superseded by the authorized 2026-09-25 retirement cleanup).

## Vanilla HTML / static sites (2026-07-09, user-requested) — SHIPPED

- [x] **Open plain HTML/CSS/JS projects.** ✅ 2026-07-09 — `detect()` falls back
      to `framework:'static'` for folders with an HTML entry and no runnable dev
      command; a new in-process `src/main/static-server.ts` serves them (with
      live-reload). Anything un-auto-launchable now errors with "Enter a command
      to launch this project", which the preview error bar already turns into a
      custom-command retry. `test/static-serve.mjs`.
- [x] **Don't offer/greypanel setup on a project that can't be instrumented.**
      ✅ 2026-07-27 — `setup:detect` read-only probe (`{ framework, canInstrument }`);
      the on-open offer gates on `canInstrument` (no dead-end "Set it up" on a
      static/vanilla repo) and the Styles tab's no-source state shows tailored
      guidance + an "Ask Trezi to restyle it" seed instead of greyed controls.
      Extended `test/setup-detect.mjs`. See PROGRESS 2026-07-27.
- [ ] **Follow-up:** driven screenshot test for the static path — offer absent +
      StylePanel read-only guidance rendered on a JS-generated (no-source) element.

## v9 — in-tool code view  ⭐ (2026-07-03, user-requested) — SHIPPED

- [x] **Phase 1 — read-only code peek + open-in-editor.** ✅ 2026-07-03 — a "Code"
      toggle on the Inspector shows the stamped file (highlight.js, line-number
      gutter, element line-span marked, auto-scrolled to the stamp) via a new
      `source:read` IPC; `source:open-in-editor` jumps to `file:line:col` in
      code/cursor/zed/subl (fallback: OS default app). `test/code-peek.mjs`.
- [x] **Phase 2 — editable code drawer.** ✅ 2026-07-02 — CodeMirror 6 in a bottom
      drawer under the preview. Save (⌘S) routes through `source:write` →
      `commitEdit`, so undo/redo + HMR are free; a stale-baseline write is refused
      as a conflict. `test/code-drawer.mjs`.
      **Known limit:** the floating PropPanel overlaps the drawer's top-right in a
      narrow window — complementary but unaware of each other's inset.
- [x] **Phase 3 — pop the drawer out into its own window.** ✅ 2026-07-14 (LKM-48)
      — a pop-out button opens the editor in a standalone, freely-resizable
      `BrowserWindow` (same renderer bundle via `?treziEditor=1`, new `EditorWindow`
      entry + `CodeDrawer` `variant="window"`). One window per project root;
      re-focuses + retargets on a repeat pop-out. `source.popout/closeWindow/
      onNavigate` IPC. `test/code-drawer.mjs`.
- [x] **Phase 4 — file-tree sidebar in the pop-out.** ✅ 2026-07-20 — the pop-out
      window gains a left file tree (`@pierre/trees`, vanilla/shadow-DOM entry so
      it's decoupled from the renderer's React 18). Click a file → opens in the
      shared drawer store. `src/main/file-tree.ts` + `source:tree` IPC list the
      project (git ls-files, fs-walk fallback). `test/file-tree.mjs`. Also renamed
      the toolbar "Editor" button → "IDE" and dropped the pop-out's redundant
      close button (native traffic lights close it).
- [x] **Phase 5 — the sidebar became a file manager.** ✅ 2026-08-05
      (user-requested) — new file / rename / delete from the tree: a toolbar above
      it plus Finder's click-the-selected-file-again to rename. New
      `src/main/file-ops.ts` (pure) behind `source:create-file`/`rename-file`/
      `delete-file`; every renderer path is re-validated (no traversal, no
      `.git`/`.trezi`/`.dsgn`/`node_modules`), create/rename never clobber, and
      delete goes to the OS trash because the content-diff undo history can't
      represent a deleted file. `test/file-ops.mjs`. See PROGRESS 2026-08-05.
      Deliberately out of scope: directory create/rename/delete (a nested path
      makes dirs implicitly; git doesn't track empty ones anyway) and drag-to-move.
- [ ] **Follow-up:** see the sidebar's new chrome rendered. CORRECTED 2026-08-07
      — "the Electron tier can't launch a window here (`test:codedrawer` dies at
      `.empty__open`, at HEAD too)" was wrong; that's the run-it-directly trap
      (see CLAUDE.md). `code-drawer` PASSES through `test/run.mjs`, so the
      toolbar / rename field / delete confirm are unverified
      visually, as is whether the tree widget re-fires a selection change for an
      already-selected row (the `dblclick` fallback exists because it might not).

## Per-chat worktree isolation (2026-07-16, concurrent-chat safety) — SHIPPED

- [x] **Isolate concurrent chats in per-repo worktrees.** ✅ 2026-07-16 —
      Every interactive chat on a git repo root gets its own long-lived worktree,
      created before `startSession` and removed on close. A `trezi/chat-<id>`
      recovery branch is attached during a turn; successful `done` events land via
      the repo queue and delete it, while errors/interruption or conflicts park on
      the branch for review. The preview always serves live, never a worktree. The
      `SessionReview` UI. `src/main/chat-worktrees.ts` (turn operations),
      `src/main/chat-isolation.ts` (lifecycle + crash recovery), extended
      `src/main/worktrees.ts` (C1 primitives), `test/chat-worktrees.mjs` (unit),
      `test/chat-isolation.mjs` (Electron).
- [x] **Parked-conflict UX — sidebar badge + AI "Resolve it".** ✅ 2026-07-16 —
      a parked live chat shows an amber "conflict" badge in the rail, and an
      in-chat `ConflictCard` explains the collision in plain language and offers
      **Resolve it** (the AI reconciles both sides — `stageResolve` re-lays the
      chat's diff onto the user's live tree, then either auto-merges cleanly with
      no turn or runs a resolution turn on the conflict markers) / **Discard
      changes**. New `agent.resolveConflict`/`discardConflict` IPC keyed by the
      active session; `src/renderer/src/components/ConflictCard.tsx`;
      `stageResolve` + `resolveParkedChat`/`discardParkedChat`; extended
      `test/chat-worktrees.mjs`.
- [x] **One commit per turn on the LIVE checkout.** ✅ 2026-08-05 (user-requested
      — "so that I can easily revert or follow the progress") — the merge back
      onto the live tree is now also committed there, one commit per turn, with
      the prompt as the subject. Only the turn's own files are staged and it's a
      partial (pathspec) commit, so the user's unrelated dirty/staged work is
      untouched; non-repo-root projects are skipped. `src/main/live-commit.ts`,
      wired from `chat-isolation.ts` + `agent.ts`'s spawn finalizer;
      `publishToPr`'s file list now diffs vs the default branch instead of HEAD
      (extracted to `src/main/publish-scope.ts`).
      `test/live-commit.mjs`. See PROGRESS 2026-08-05.
      Not done deliberately: no user-facing toggle (the whole point is that it's
      always on) and no UI surfacing of the commit sha — `git log` is the UI.
- [x] **One repository landing writer + ephemeral chat branches.** ✅ 2026-08-08 —
      per-chat chains did not protect the shared live index from two different chats.
      Every snapshot/landing/resolve/teardown now crosses a repo-scoped queue. A chat's
      `trezi/chat-*` branch exists only during a turn or while parked; successful
      landing/discard detaches the still-live worktree and deletes the branch, and the
      next `beforeTurn` recreates it for crash recovery. `src/main/repo-write-queue.ts`,
      `src/main/{chat-isolation,chat-worktrees,worktrees}.ts`, `test/live-commit.mjs`.
- [x] **Resolver independence + artifact/marker safety.** ✅ 2026-08-08 — the
      3-way path now uses a temporary index seeded from the live working tree, leaving
      the user's staged state untouched and eliminating `does not match index` failures.
      `.env*` secrets, `node_modules`, `*.tsbuildinfo`, and sidecars are excluded at
      snapshot/turn/live-commit boundaries; unresolved marker triplets remain parked.
      Isolation setup fails closed. `src/main/{worktrees,chat-worktrees,live-commit}.ts`,
      `test/{chat-worktrees,live-commit}.mjs`.
- [x] **Terminal outcomes are explicit and idempotent.** ✅ 2026-08-08 — only a
      clean `done` auto-lands; `error`/interruption commits partial work to the recovery
      branch and parks it. A per-turn tracker collapses Codex's `error→done` sequence so
      finalization runs once. `src/main/turn-terminal.ts`, `src/main/{agent,
      chat-isolation,chat-worktrees}.ts`, `test/{turn-terminal,live-commit}.mjs`.

## v10 — Styles tab + AI-surfaced control panels (2026-07-18, user-requested) — SHIPPED

- [x] **Dialkit-style Styles tab.** ✅ 2026-07-18 — the island gained a
      `Props | Styles` switch; scrub-to-adjust controls over the v1 CSS set with
      live preview injection, committing via Tailwind class rewrite → inline
      splice → agent fallback through `commitEdit`. `src/main/styles.ts`,
      `styles-svelte.ts`, `tw-styles.ts`, `inline-style.ts`,
      `src/renderer/src/lib/css-values.ts`, `components/StylePanel.tsx` +
      `components/styles/{ScrubInput,ColorControl,BezierEditor}.tsx`.
      `test/{tw-styles,inline-style,css-values}.mjs`, `test/style-edit.mjs`.
- [x] **Transitions + cubic-bezier editor.** ✅ 2026-07-18 — duration/delay/
      property plus a draggable bezier editor with preset snap and replay.
- [x] **AI-surfaced control panels.** ✅ 2026-07-18 — "Surface controls with AI"
      runs a real agent turn that instruments the source and calls a new
      `define_controls` tool; main validates and owns
      `.trezi/control-panels.json`; the Custom tab renders the manifest with the
      Styles primitives. `src/main/control-manifest.ts`, `control-panels.ts`,
      `components/CustomPanel.tsx`, `lib/controls-prompt.ts`.
      `test/control-panels.mjs` (unit), `test/custom-controls.mjs` (Electron),
      `test/controls-agent.mjs` (live).

**Follow-ups (not started):**

- [ ] **Springs / framer-motion animation params.** v1 is CSS transitions only;
      a spring config isn't a single CSS value, so it needs its own control
      shape and a library-aware apply path. The 2026-09-01 opt-in generator can
      now surface these through Custom controls; this item remains the native,
      automatically detected apply path.
- [ ] **More style properties** — width/height, per-corner radius,
      borders, position/inset; each needs a family mapping + a sane control.
- [ ] **Responsive / state variants** (`hover:`, `md:`) — the rewrite currently
      treats variant-prefixed classes as neither candidates nor blockers, so
      editing them at all is unimplemented, not merely unsupported.
- [ ] **Auto re-pick after navigation.** A full navigation wipes the preview
      preload's selection; the panel asks for a manual re-click today.
- [x] **`define_controls` for Codex and custom endpoints.** Shared validated
      registration through the session-scoped MCP bridge, including background edits.
- [ ] **`define_controls` for experimental Gemini.** Still uses typed-prop fallback.

## Health / infra (from the 2026-07-07 review)

Ranked by leverage. Deferred items note *why* they're not auto-completable.

- [x] **Test runner to replace the package.json mega-chains.** ✅ 2026-07-07 —
      `test/run.mjs` (`node test/run.mjs unit|electron|live|all`): keep-going,
      exit-0=pass (incl. e2e self-SKIP), builds once before the electron tier,
      summary table, non-zero exit on any failure. `test` = `unit electron`,
      `verify` = `all`; the ~40 `test:*` aliases are unchanged. Verified: unit
      tier 15/15 green.
- [x] **CI.** ✅ 2026-07-07 — `.github/workflows/ci.yml`: checkout → setup-bun
      1.3.x → `bun install --frozen-lockfile` → `bun run typecheck` →
      `node test/run.mjs unit`. Electron/live tiers left for a macOS runner (noted
      inline).
- [x] **Lint/format tool.** ✅ 2026-07-07 — Biome 2.5.2 (dev dep) + `biome.json`
      tuned to the existing style (2-space, single quotes, no semicolons, width
      100); `lint`/`format` scripts. The repo-wide `biome check --write` reformat
      is deliberately NOT done — run it as its own commit when ready.
- [x] **Gemini backend gated.** ✅ 2026-07-07 — `pickProvider` returns Claude for
      `provider:'gemini'` unless `TREZI_EXPERIMENTAL_GEMINI=1`; `gemini.ts` banner
      marks it experimental/unwired; removed from the renderer picker so it can't be
      silently selected. Add the SDK dep + a self-skipping e2e test to un-gate.
- [ ] **Shared test harness.** 55 `.mjs` tests re-derive root + Playwright/Electron
      launch (~6.2k lines, much boilerplate). Add `test/lib/harness.mjs`
      (`launchApp`, `openFixture`, `shot`) and migrate opportunistically.
      *Deferred: large, migrate-when-touched, not a single-shot task.*
- [ ] **Split the god files.** `App.tsx` (1646), `styles.css` (1836), `props.ts`
      (1189), `simulator.ts` (1169), `store.ts` (981). Extract, don't append.
      *Deferred: high-risk refactor; needs the Electron UI running to verify, which
      isn't possible headless — do interactively with the app open.*
- [x] **Rename the `dsgn` internals to Praxis.** Done 2026-07-17: `data-praxis-source`,
      `PraxisApi`, `.praxis/`, `praxis/*` branches, `<userData>/praxis`. Clean break for
      stamped target repos (re-run setup); legacy shims cover uninstall, old work
      branches, and one-time sidecar/userData migration. See PROGRESS 2026-07-17.

- [ ] Fix startup-intro regression: recognize localhost native previews and keep the restored preview hidden throughout the intro crossfade (observed during Git-update verification, 2026-09-16).
