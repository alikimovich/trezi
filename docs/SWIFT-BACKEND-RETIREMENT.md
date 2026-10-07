# Legacy retirement, launcher and distribution (S15)

LKM-102, step S15 of the [canonical plan](SWIFT-BACKEND-PLAN.md) and
[roadmap](SWIFT-BACKEND-ROADMAP.md). S15 may remove Bun application orchestration
only after the census confirms every route, event and module has its final owner.
This document is that census for the effects that matter (every Bun module that
writes files, runs a process or sends a signal) and the gate the removal waits on.
`test/retirement-census.mjs` (unit tier) keeps it executable: a new effect in an
unlisted module, a stale row, or a gate line that disagrees with the rows fails.

## Status (2026-09-29, LKM-111)

**Retirement gate: open.** The census has no Bun-owned row, and LKM-111 closed the rest
of the [gate](#gate-for-removing-the-legacy-owners):

- Built-in Claude, Codex and Gemini sessions always run in provider helpers the Swift
  service supervises (`ProviderHelperCommand.builtIn`, `backends/index.ts`); only a v10
  connection stays in Bun, so its key never crosses into another process. There is no
  opt-in and no in-process fallback: an unsupervised Bun refuses built-in providers.
- The rollback is gone: the launcher switch, the service's rollback launch and every
  Bun twin (provider, conversation, editing, preferences, workspace, memory, runtime,
  repository, source, workflow and platform writers, the profile alias creator and the
  in-app restart of that launch). With no service, those workflows refuse with
  "Trezi's service is not running" instead of writing. The parity suites that compared
  the owners with their twins now compare them with goldens recorded from the twins
  (`test/fixtures/*/…golden.json`).
- The retained JS ships inside the app (`Trezi.app/Contents/Resources/backend/`) with
  the Bun that built it (`Contents/Helpers/bun`), so `open -a Trezi` needs no installed
  Bun. The start path is `open -a Trezi` or the thin `trezi` command.
- Live parity: `test/provider-live-parity.mjs` (live tier, `TREZI_LIVE_PROVIDERS=1`) runs
  Claude and Codex, in-process and in the helper, on one minimal prompt and records the
  token usage. The operator's run passed for Claude (in-process and helper); Codex hit
  its usage limit and is deferred to LKM-113 ([evidence](#lkm-111-evidence)).

`test/retirement-census.mjs` now fails if a shipped file names the removed launch
switch or service flag, or if a Bun-owned row appears.

## LKM-102 status (2026-09-29, history)

**Retirement gate: open.** The census has no Bun-owned row. That is the first
condition of the [gate](#gate-for-removing-the-legacy-owners) only: the provider adapter
move and its live parity run are deferred to LKM-111, so the legacy owners,
`TREZI_BACKEND_OWNER=legacy` and every rollback row stay (the census test enforces this
while the deferral is recorded here). Nothing that the rollback switch needs was removed.

LKM-102's scope was reduced (a recorded decision): the SDK adapter move, the live
provider parity run and the removal of the legacy launch and old Bun copies belong to
LKM-111. Provider adapters remain in Bun by default; helper routing is an explicit
opt-in (`TREZI_PROVIDER_HELPERS=1`), and v10 connections stay in-process even with it.
See [the reduced acceptance](#lkm-102-reduced-acceptance-the-seven-bun-rows) below.

Moved in this step:

- The reviewer notes (`.trezi/annotations.json`), S05's writer that had to wait for
  the S07 repository lane. `src/main/annotation-store.ts` now only reads and renders;
  the editing owner commits the new text only if the file still holds the bytes it
  read, in the repository lane. A hand edit in between is read again and the change
  re-applied (three attempts), never overwritten.
- The starter design tokens (`.trezi/tokens.json`, `tokens:scaffold`): a create-only
  commit by the same owner. A file detection could not read is refused, where the old
  writer replaced it.
- Both use `EditingSidecar.commit` (Swift) and its legacy twin `commitSidecarLocally`,
  so they gain the controls sidecars' checks: a linked `.trezi` folder or file is
  refused (the old writers followed a link out of the project) and a store is capped at
  1 MiB (about 500 notes at the 2000-character maximum).
- The other `.trezi/` files, by the editing owner in the repository lane
  (`EditingProject.swift`): the legacy sidecar migration ([legacy names](agent-guide/legacy-names.md)), the setup helpers a
  chat worktree carries (with `setup-helpers.json`) and every worktree's own
  `node_modules` (an APFS clone of the live one since LKM-146) with its dependency marker
  (`.trezi/dependencies.sha256`). Bun keeps only the orchestration: it asks the owner,
  runs the install through the service installer when no clone fits, then asks it to
  record the marker.
  The legacy twins are `sidecar-migrate.ts`, `setup-artifacts.ts` and
  `editing-model.ts`. A `.trezi` (or legacy) folder or a helper that is a link is
  refused (the old code followed it).
- Trezi's own update check (`git fetch` and the behind count) is a workflow-owner lane
  request, `updateCheck`; `update-controller.ts` reaches `checkForUpdate` only with no
  owner.
- The in-app feedback issue (`gh issue create`) and the curated skill-pack install
  (`npx skills add`) are workflow-owner recorded workflows, `feedback` and `skills`
  (`WorkflowTools.swift`). Bun composes the title and body (at most 65,536 UTF-16
  units, far inside the 32 MiB pipe frame; a test sends the largest body the composer
  can build) and picks the pack from its catalog; the owner accepts only a GitHub
  `owner/name` and plain skill names and builds the argv itself. A feedback issue is
  never filed twice: the intent is journaled before `gh issue create`, and a retry
  after a crash or a `gh` failure looks for an issue with the same title and body
  before filing. Legacy twins: `feedback-legacy.ts` (no journal; it now also keeps the
  body out of the error text) and `skills-install.ts`.
- Dead adapter code: `agent.ts` still imported a Git runner and fs writers it no
  longer used.

Not moved, and why the gate stays closed:

1. (Done in the reduced LKM-102, below: the census has no Bun-owned row.)
2. The provider SDK adapters (`src/main/backends/`) still run in Bun by default. Helper
   routing is opt-in (`TREZI_PROVIDER_HELPERS=1`) and has only a fake-provider test;
   moving the adapters and the live Claude/Codex parity run are deferred to LKM-111
   (not authorized here: SKIP, not PASS). So is removing the legacy launch path.
3. The Bun controllers in `src/native/` (chat, composer queue and drafts, workspace
   server fields, sheets and their routing) are still the application's orchestration.
   They are views and adapters over the Swift owners, but they are Bun code.
4. No live check of a real provider, GitHub, package manager, Xcode or simulator was
   authorized. A removal would have to prove parity on exactly those paths.

## Rollback for this step's domain

History: LKM-111 removed the owner switch described here. The file formats below are
unchanged, and the Swift owner is their only writer.

- Files: `<project>/.trezi/annotations.json` and `<project>/.trezi/tokens.json`, bytes
  unchanged (`JSON.stringify(value, null, 2)` plus a newline). No journal, receipt or
  draft is added: each commit is a single atomic, hash-bound replace.
- The setup helpers and the dependency marker keep their bytes and names
  (`.trezi/setup-helpers.json`, `.trezi/dependencies.sha256`); the migration only ever
  copies (exclusive, then link) before it unlinks the legacy original, so an interrupted
  run repeats safely and a file that already exists in `.trezi/` always wins.
- Owner switch: quit (the service drains the editing owner before it releases the
  profile), relaunch with `TREZI_BACKEND_OWNER=legacy`; the legacy twin writes the same
  bytes with the same checks. A pre-S15 build reads both files as before.
- Newer data is never replaced: a commit only lands on the bytes it was computed from,
  so a note written by either owner, or by hand, survives a switch in either direction.

## Launcher and distribution

Since LKM-111 (the one start path):

```
install.sh ─ git clone/pull ─ bun scripts/requirements.mjs --build ─ bun install ─ bun run build
open -a Trezi  (Finder, Dock, Spotlight)  ─ TreziHost ─XPC─ TreziService ─ bundled Bun ─ backend/index.cjs
trezi [. | <folder>] (bin/trezi) ─ build if missing ─ open -a Trezi [folder]
trezi --update ─ bin/trezi.mjs: git pull --ff-only ─ bun install ─ bun run build   (the app is not running)
Settings ▸ Updates ─ workflow owner: pull, install, build (journaled) ─ restart the same way Trezi started
```

Under LaunchServices the host derives its own launch (`src/native/HostLaunch.swift`):
the Bun at `Trezi.app/Contents/Helpers/bun` (copied from the Bun that built the app,
`scripts/bundle-bun.mjs`), the backend at `Trezi.app/Contents/Resources/backend/`
(`index.cjs` and `provider-helper.cjs`), the profile `TreziService --resolve-profile`
names, and the login shell's environment. An installed Bun is needed only to build.
`bun run dev`/`bun run start` (`scripts/start-native.mjs`) remain the development
launcher with the same arguments on the command line.

Before LKM-111:

```
install.sh ─ git clone/pull ─ bun scripts/requirements.mjs --build ─ bun install ─ bun run build
trezi (bin/trezi.mjs) ─ build if missing ─ scripts/start-native.mjs ─ TreziHost ─XPC─ TreziService ─ Bun
trezi --update ─ git pull --ff-only ─ bun install ─ bun run build        (the app is not running)
Settings ▸ Updates ─ workflow owner: pull, install, build (journaled) ─ restart through start-native
```

- Supported: macOS 13.3 or later (both bundles' `LSMinimumSystemVersion` and the
  `swiftc -target`), the macOS 26.0 SDK or later to build, Bun 1.3.0 or later. One
  source, `scripts/requirements.mjs`: the build, the launcher, `bun run dev`, the CLI and
  `install.sh` refuse with one message instead of failing inside swiftc or dyld.
- Package layout (checked by `test/distribution.mjs`): `out/native/Trezi.app` with
  `Contents/MacOS/TreziHost`, the XPC service at
  `Contents/XPCServices/dev.trezi.service.xpc`, the bundled Bun at
  `Contents/Helpers/bun` and the backend at `Contents/Resources/backend/`; a copy of the
  service at `out/native/TreziService` answers the development launcher's
  `--resolve-profile`.
- Shutdown: the host quits through the service, which drains Bun, every owner and every
  managed process group before it releases the profile lock
  ([service](SWIFT-BACKEND-SERVICE.md)). In-app restart waits for that drain.
- An interrupted in-app update resumes from its journal without pulling twice
  ([workflows](SWIFT-BACKEND-WORKFLOWS.md)); `trezi --update` is the terminal path and
  runs only while the app is closed.

## Distribution and recovery evidence

History (LKM-102). LKM-111 removed the rollback launch and the twin these tests
switched to; its own evidence is [below](#lkm-111-evidence).

Deterministic (no provider, GitHub, Xcode build or app launch involved):

- `test/install-update.mjs` (unit tier) runs the real `install.sh` and `bin/trezi.mjs`
  against a local origin in a scratch `HOME`, with only `bun install`/`bun run build`
  scripted and `git clone` redirected to the origin: a clean install (clone, platform
  check, install, build, `trezi` link), a launch with the build present and with it
  missing, `trezi --update`, an update interrupted at its build (the pull is neither
  undone nor repeated, the earlier build stays, the next run completes), a diverged
  checkout (refused before install or build, its own commit kept), lockfile drift and an
  installer re-run.
- `test/service-process.mjs` (native tier): profile-lock contention; a lock holder
  SIGKILLed with no cleanup, after which a new owner acquires the profile and sees the
  crashed owner's data; the `--legacy` rollback launch sharing the same lock and keeping
  a newer file (`{"newer":"retained-after-rollback"}`); the runtime journal sweep;
  XPC reconnect with the service epoch (`resume`), refusing a stale or wrong epoch; a
  Swift (non-legacy) service restart with epoch resume and stale-resume refusal; and an
  assertion that the supervised Bun backend does not own `native.lock`.
- `test/workflow-owner.mjs`: an in-app update interrupted after the pull resumes
  without pulling again; rollback both ways (Swift owner ⇄ legacy twin) never replaces
  newer work.

Not covered, and not claimed: a real Xcode/SDK build, a real launch of the app from
`trezi`, real provider or GitHub calls, and `no Bun application backend`: Bun still hosts
the provider adapters and the controllers listed above, so the profile still gets writes
from Bun for every domain the census does not give an owner.

## Retained JavaScript (by design)

These stay JS in the end state, as the plan allows. They hold no application state and
commit nothing themselves:

- Provider SDK adapters (`src/main/backends/`), their session tools and the Codex tool
  bridge, and the pure calculators behind agent tools (spring, APCA, fluid, OKLCH,
  shadows, type metrics).
- Source analysis: React/Svelte/HTML parsers, prop, style, layer and move engines,
  tokens detection, controls and content validation. They propose hash-bound edits.
- Proposing helpers: PR descriptions, framework detection, starter files, diagnoses.
- The isolated WebKit instrumentation (`src/preview/`) and HTML stamping for the
  static site.
- Read-only Git probes that feed the owners (`git status`, `diff`, `ls-files`).

## Census

Classes: `helper` (retained JS whose effects are reads, a provider SDK's own process
inside its supervised helper, or a scratch directory it removes); `test` (native smoke
fixtures, never in the product path); `bun` (a Bun-owned effect, which blocks
retirement). LKM-111 removed the `rollback` class with the writers it listed.

| Module | Class | Final owner | Effect |
| --- | --- | --- | --- |
| `src/main/agent-git-access.ts` | helper | RepositoryOwner | `git symbolic-ref` read of the live branch for the agent command guard (LKM-188) |
| `src/main/backends/claude-login.ts` | helper | ProviderOwner (provider helper) | `claude auth status` probes (LKM-119), inside the supervised helper |
| `src/main/backends/codex.ts` | helper | ProviderOwner (provider helper) | Codex SDK process, inside the supervised helper |
| `src/main/backends/gemini.ts` | helper | ProviderOwner (provider helper) | Gemini CLI process, inside the supervised helper |
| `src/main/backends/live-tree-watch.ts` | helper | ProviderOwner (provider helper) | `git status` reads of the live checkout around a Full-access Codex turn (LKM-163), inside the supervised helper |
| `src/main/chat-park.ts` | helper | RepositoryOwner | Git reads (diff, show, status) |
| `src/main/chat-agent-git.ts` | helper | RepositoryOwner / WorkflowOwner | `git rev-parse` read; mutations route through the owners (LKM-188) |
| `src/main/chat-workspaces.ts` | helper | RepositoryOwner | `du` and `git rev-parse` reads (LKM-136 usage, old-name folders' repositories) |
| `src/main/chat-worktrees.ts` | helper | RepositoryOwner | `git show` reads of the live checkout |
| `src/main/conflict-markers.ts` | helper | RepositoryOwner | `git grep` and file reads for unresolved conflict markers in a chat worktree before installing (LKM-194) |
| `src/main/commit-message.ts` | helper | RepositoryOwner | Git reads (a chat worktree's diff and new files, recent subjects) for the landing commit message (LKM-189) |
| `src/main/feedback-diagnostics.ts` | helper | PlatformOwner | opt-in feedback diagnostics reads: `git status`, `log show`, `sample` of the host (LKM-165) |
| `src/main/file-tree.ts` | helper | SourceOwner | `git ls-files` read |
| `src/main/git.ts` | helper | RepositoryOwner | Git reads (work tree, top level, branches) |
| `src/main/github.ts` | helper | WorkflowOwner | `git remote` and `gh` status reads |
| `src/main/park-reconcile.ts` | helper | RepositoryOwner | `git show` reads of a parked chat's held files; the clear/rebuild runs through the owner (LKM-196) |
| `src/main/preview-tools.ts` | helper | PlatformOwner | `open_preview` screenshot: one scratch JPEG per chat in the system temp folder, overwritten on each call (LKM-196) |
| `src/main/product-log.ts` | helper | PlatformOwner | appends and prunes the product log day files in `~/Library/Logs/Trezi` (LKM-168) |
| `src/main/pull-request-status.ts` | helper | WorkflowOwner | `gh pr view` and `git merge-tree` reads of PR mergeability (LKM-188) |
| `src/main/project-memory-evaluation.ts` | helper | MemoryOwner | `git grep` reads of a chat's worktree and the live checkout: a new memory rule's design token must exist in code (LKM-177) |
| `src/main/publish-description.ts` | helper | WorkflowOwner | scratch directory for the description run |
| `src/main/publish-scope.ts` | helper | WorkflowOwner | Git reads |
| `src/main/publish.ts` | helper | WorkflowOwner | Git reads (work tree, branch) |
| `src/main/scaffold.ts` | helper | WorkflowOwner | `bun --version` probe |
| `src/main/trezi-agent-tools.ts` | helper | ProviderOwner (provider helper) | Codex tool bridge socket |
| `src/main/worktrees.ts` | helper | RepositoryOwner | Git reads (a branch's diff, chat refs) |
| `src/native/log-support.ts` | helper | PlatformOwner | Export Logs… zip (`ditto`) of a temporary folder and a `sw_vers` read (LKM-168) |
| `src/native/dreamer-export.ts` | helper | PlatformOwner | Export Dreamer Report… zip (`ditto`) of a temporary folder (LKM-202) |
| `src/native/smoke-agent-preview.ts` | test | — | smoke fixture |
| `src/native/smoke-alerts.ts` | test | — | smoke fixture |
| `src/native/smoke-chat.ts` | test | — | smoke fixture |
| `src/native/smoke-chat-gate.ts` | test | — | smoke fixture |
| `src/native/smoke-chat-text.ts` | test | — | smoke fixture |
| `src/native/smoke-comment-rows.ts` | test | — | smoke fixture |
| `src/native/smoke-landing-check.ts` | test | — | smoke fixture |
| `src/native/smoke-agent-question.ts` | test | — | smoke fixture |
| `src/native/smoke-composer.ts` | test | — | smoke fixture |
| `src/native/smoke-core.ts` | test | — | smoke fixture |
| `src/native/smoke-dreamer.ts` | test | — | smoke fixture |
| `src/native/smoke-fixture.ts` | test | — | `--test` project and failure capture |
| `src/native/smoke-inspector-island.ts` | test | — | smoke fixture |
| `src/native/smoke-island-status.ts` | test | — | smoke fixture |
| `src/native/smoke-islands.ts` | test | — | smoke fixture |
| `src/native/smoke-layers.ts` | test | — | smoke fixture |
| `src/native/smoke-legacy-project.ts` | test | — | smoke fixture |
| `src/native/smoke-movable-islands.ts` | test | — | smoke fixture |
| `src/native/smoke-preview-inspector.ts` | test | — | smoke fixture |
| `src/native/smoke-projects.ts` | test | — | smoke fixture |
| `src/native/smoke-publish.ts` | test | — | smoke fixture |
| `src/native/smoke-restore.ts` | test | — | smoke fixture |
| `src/native/smoke-sent-attachments.ts` | test | — | smoke fixture |
| `src/native/smoke-session.ts` | test | — | smoke fixture (`TreziHost --session`) |
| `src/native/smoke-settings.ts` | test | — | smoke fixture |
| `src/native/smoke-shadow-island.ts` | test | — | smoke fixture |
| `src/native/smoke-sheets.ts` | test | — | smoke fixture |
| `src/native/smoke-sidebar.ts` | test | — | smoke fixture |
| `src/native/smoke-source-editor.ts` | test | — | smoke fixture |
| `src/native/smoke-source-syntax.ts` | test | — | smoke fixture |
| `src/native/smoke-source-wrap.ts` | test | — | smoke fixture |
| `src/native/smoke-toolbar.ts` | test | — | smoke fixture |
| `src/native/smoke-toolbar-more.ts` | test | — | smoke fixture |

A row whose module no longer has an effect fails the test too, so a transfer removes
its row and the gate count in the same change.

## Gate for removing the legacy owners

All of these, in order. LKM-111 completed the list (the census test now checks the
first and that the removed switch and flag stay gone):

1. No `bun` row. Each transfer names its files, journals and drafts and tests
   restoration, as every earlier step did. (Done in LKM-102.)
2. The provider adapters run in supervised helpers after an authorized live parity run
   (`test/provider-live-parity.mjs`). The adapters moved in LKM-111; the Claude parity
   run passed, and Codex's is deferred to LKM-113 (see [evidence](#lkm-111-evidence)).
3. A full native and live verification of the Swift launch with no legacy module
   loaded, then the removal of the rollback switch, the `rollback` rows and the
   service's rollback launch, keeping every store, journal and worktree as is. The
   removal is done (LKM-111); every store keeps its name and bytes.

## LKM-102 reduced acceptance: the seven Bun rows

Recorded decision (option A): LKM-102 moves the seven Bun-owned rows and makes helper
routing opt-in. The SDK adapter move, the live provider parity run and the removal of
the legacy launch path and old Bun copies are LKM-111.

**Adapter state.** Provider adapters run in Bun by default. `ServiceRuntime` installs a
helper command only when the launch environment has `TREZI_PROVIDER_HELPERS=1` and the
bundled `provider-helper.cjs` exists (`ProviderHelperCommand.builtIn`); a bundled entry
alone does not opt in. `backends/index.ts` routes a built-in seat to the helper only on
the same opt-in, and a v10 connection (`options.connectionId`) always stays in-process.
Tests: `test/provider-owner.mjs` (routing: default installs no helper, the opt-in does)
and `test/provider-data.mjs` (a fake connection resolves and runs in-process in the
Swift launch with and without the opt-in, and in the legacy launch).

| Former Bun row | Swift owner now | Rollback twin | Parity tests |
| --- | --- | --- | --- |
| `codex-models.ts` | `ProviderData.swift` probe (`codexModels`) | `codex-models.ts` | `provider-data.mjs` probe |
| `model-catalog.ts` | `ProviderData.swift` `saveCatalog` (file order kept) | `model-catalog.ts` `set` | `provider-data.mjs` catalog, byte-identical |
| `providers-store.ts` | `ProviderData.swift` connections, key via `TreziSecrets --crypto` | `providers-store.ts` + `platform-legacy.ts` cipher | `provider-data.mjs` connections, byte-identical |
| `props.ts` (editor CLIs) | `PlatformOpen.swift` `openInEditor` | `open-in-editor-legacy.ts` | `platform-owner.mjs` `checkOpen` |
| `native/platform.ts` (crypto, `open`) | `PlatformOpen.swift` `openLink`/`openFile`; crypto in ProviderData | `platform-legacy.ts` | `platform-owner.mjs` `checkOpen`, `provider-data.mjs` |
| `native/profile-path.ts` | `ProfilePaths.swift` (`TreziService --resolve-profile`; session alias under the lock) | `profile-path-legacy.ts` | `rename-compat.mjs` Swift parity, `native-service-launch.mjs` |
| `native/index.ts` (`native.lock`) | the service's profile lock and `native.lock` reservation (`LegacySupervisor`) | `legacy-restart.ts` | `rename-compat.mjs`, `service-process.mjs` |

`native/index.ts` now refuses to start without the service's lock
(`TREZI_SERVICE_LOCKED=1`, set by both launches) and writes nothing; its `--test`
fixture moved to `smoke-fixture.ts`. `profile-path.ts` only resolves and checks; its
creating twin refuses under either service launch, so an alias is never made by Bun
there.

**Rollback.** Quit, relaunch with `TREZI_BACKEND_OWNER=legacy`. Every file keeps its
name and bytes (`providers.json`, `model-catalog.json`, the two alias links), so either
writer reads the other's. No journal, receipt or draft is added. Newer data is never
replaced from an old copy: the connections store rewrites untouched entries exactly as
parsed, the catalog keeps the other seat's entry as it is on disk, a corrupt store is
kept as `.corrupt`, and the alias migrations only add a link (never move, copy or
delete) and refuse a state they cannot reconcile with the same message as before.

## LKM-111 evidence

Recorded 2026-09-29 by the LKM-111 worker. Its sandbox allowed no provider network,
unix-socket listening, fixed local ports or LaunchServices, which bounds what ran.

- Twins to goldens: every owner suite that compared the Swift owner with its Bun twin
  now compares it with the answers the twin gave, recorded once before the twin was
  deleted (`test/fixtures/conversation-owner/parity-golden.json`,
  `editing-owner/parity-golden.json`, `provider-owner/data-golden.json` and
  `policy-golden.json`, `workspace-owner/golden.json`; paths normalized to `<root>`).
- Suites that wrote through a twin run on the real Swift owners instead:
  `test/helpers/with-service-owners.mjs` (conversation, editing, repository and source
  from one fixture process), `with-provider-owner.mjs` and `with-repository-owner.mjs`. The Git suites run through
  `test/repository-owner.mjs` on the same owners (`repository-owner-preload.mjs`).
- With no service, History, sidecars, chat islands and provider data refuse with
  "Trezi’s service is not running" (`test/sessions-store.mjs`,
  `test/editing-owner.mjs`, `test/provider-owner.mjs`).
- `test/retirement-census.mjs`: the gate is open, no Bun row, and no shipped file names
  the removed launch switch or service flag.
- `test/distribution.mjs`, `test/trezi-cli.mjs` and `test/install-update.mjs`: the
  backend and Bun inside the app, `open -a Trezi` as the start path, and the `trezi`
  command's arguments.
- Live parity (`TREZI_LIVE_PROVIDERS=1 bun run test:provider-live`): Claude (`haiku`,
  low effort) and Codex (account default, low effort), each in-process and in the
  supervised helper, one prompt (`PONG`), no tools, no Gemini: four calls, token usage
  written to `test/artifacts/provider-live-parity.json`. The worker sandbox denied
  `api.anthropic.com` and `chatgpt.com`, so the operator ran it outside the sandbox
  (2026-09-29):
  - **Claude passed on both hosts**: in-process `PONG` in 3066 ms (32665 input / 53
    output tokens, 32655 cached); helper `PONG` in 1886 ms (32447 / 59, 32437 cached);
    both emitted `delta` then one `done`, no errors.
  - **Codex did not run**: usage limit until 2026-10-03 10:10 (0 tokens, both hosts).
    The Codex live parity and isolating Trezi's Codex sessions from the personal Codex
    MCP config (the SDK loaded `mcp.vercel.com`) move to LKM-113.
  - The raw file is gitignored (`test/artifacts/`), so these numbers are the tracked
    record. Until Codex passes, its helper path is proven by the fake-provider helper
    suite only (`test/provider-owner.mjs`).
