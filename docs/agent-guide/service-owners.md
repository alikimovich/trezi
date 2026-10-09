# Agent guide — the Swift service and its owners

Moved from the old `CLAUDE.md` (architecture tree, `src/service/`) and `AGENTS.md`
(intro + architecture bullets). Linked from [AGENTS.md](../../AGENTS.md).

## Who writes what

A separate Swift XPC service owns profile exclusion, supervises the Bun backend and holds
the durable operation ledger (S03). One transfer at a time it has taken over domain
writers from Bun:

| Since | The service owns | Doc |
| --- | --- | --- |
| LKM-91 | preferences, written through the ledger | `docs/SWIFT-BACKEND-PREFERENCES.md` |
| LKM-92 | workspace identity, order and selection | `docs/SWIFT-BACKEND-WORKSPACE.md` |
| LKM-93 | project memory | `docs/SWIFT-BACKEND-MEMORY.md` |
| LKM-94 | managed project servers, installs and static sites | `docs/SWIFT-BACKEND-RUNTIME.md` |
| LKM-95 | every Trezi Git effect | `docs/SWIFT-BACKEND-REPOSITORY.md` |
| LKM-96 | source commits: Bun's parsers only propose hash-bound edits; the service owns source transactions, Undo, file-tree operations and editor drafts | `docs/SWIFT-BACKEND-SOURCE.md` |
| LKM-97 | conversation state: session records and History, live-chat checkpoints, turn transitions and completion policy, titles, model handoff, approvals and spawn admission; Bun's provider sessions report typed events to it | `docs/SWIFT-BACKEND-CONVERSATION.md` |
| LKM-98 | every provider session is opened with its provider owner, which fixes the session's grant, answers its permission requests, authorizes Trezi tools, holds Stop's deadline, persists resume ids and supervises provider helpers against their grant; the SDK adapters still run in Bun | `docs/SWIFT-BACKEND-PROVIDERS.md` |
| LKM-99 | the editing workflows' state: chat island histories and activation (bound to the defining turn), the controls sidecars (hash-bound commits) and deferred preview navigation (content-editor drafts until LKM-114 removed content controls); Bun keeps the JS helpers and inspector views | `docs/SWIFT-BACKEND-EDITING.md` |
| LKM-100 | Trezi's side-effecting workflows outside a chat turn (Publish and PRs, Connect to GitHub, remote pull/switch, setup helpers, new projects, Trezi's update, the diagnosis memory) as journaled workflows with receipts, so a lost reply or crash never repeats a PR, merge or update; Bun keeps the proposing helpers and the sheets | `docs/SWIFT-BACKEND-WORKFLOWS.md` |
| LKM-101 | the iOS Simulator preview (bounded, cancellable xcrun/idb runs, the launch command as a journaled group, the loopback bridge), scoped media grants to the source editor, pasted attachments and the running-servers recovery | `docs/SWIFT-BACKEND-PLATFORM.md` |
| LKM-102 | the last census rows: provider data (connections store, model catalog cache, Codex model discovery: `ProviderData.swift`), opening links, files and the editor (`PlatformOpen.swift`), the profile and session-store aliases (`ProfilePaths.swift`), the profile lock (Bun no longer takes one), the `annotations.json` and `tokens.json` sidecars (`EditingProject.swift`), the feedback issue and skill-pack installs (`WorkflowTools.swift`, `WorkflowContext.swift`) | `docs/SWIFT-BACKEND-RETIREMENT.md` |
| LKM-111 | the built-in Claude, Codex and Gemini adapters run by default in provider helpers the service supervises (v10 connections stay in Bun); the Bun rollback launch and its twins are gone; the retained JS and a Bun binary ship inside `Trezi.app` | `docs/SWIFT-BACKEND-RETIREMENT.md` |

The census in `docs/SWIFT-BACKEND-RETIREMENT.md` has 0 Bun-owned rows: every Bun module
that writes a file, spawns a process or signals is a helper or a test. There is no
fallback: without the service, each owner seam throws ("Trezi’s service is not
running, so …"). Bun still hosts the UI-side controllers, the source parsers and (in
helpers) the provider SDK adapters.

## The launch path

`open -a Trezi` and the `trezi` command start `Trezi.app` under LaunchServices
(`src/native/HostLaunch.swift` derives the launch); `bun run dev` goes through
`scripts/start-native.mjs` for development. Either way the host connects over XPC to
the bundled Swift service, which takes the profile lock and supervises the retained
Bun backend (`Contents/Resources/backend/index.cjs` on `Contents/Helpers/bun`) over
private pipes. The service writes `preferences.json`, `workspace.json`
and project memory, runs managed project servers, installs and static sites, performs
and serializes every Trezi Git effect in user repositories, commits every Trezi source
edit, Undo and file-tree operation from hash-bound parser proposals, owns chat records,
live-chat checkpoints and turn transitions, holds every provider session's grant,
permission answers, tool authorization, Stop's deadline and resume ids, owns chat island
histories and activation, the project sidecars and deferred preview navigation, runs publication, remote Git actions, setup, new projects, Trezi's update, the
feedback issue, skill-pack installs and the diagnosis memory as journaled workflows, and
runs the iOS Simulator preview, issues the source editor's media grants, writes pasted
attachments and performs the running-servers recovery. Since LKM-102 it also writes the
provider data (connections, model catalog), opens links, files and the editor, makes the
profile aliases (the launcher asks `TreziService --resolve-profile`) and alone holds the
profile lock: `src/native/index.ts` refuses to start without it
(`TREZI_SERVICE_LOCKED=1`). Docs per row in the table above.

There is no launch-time rollback since LKM-111: the Bun-writer launch
(`TreziService --legacy`) and its switch were removed with the Bun twins. See
`docs/SWIFT-BACKEND-SERVICE.md` for verification limits.

The host and Swift service communicate over authenticated XPC; the service and Bun use
private pipes. `src/native/bridge.ts` is the private JSON bridge to the supervising
service (tests that drive a bare `TreziHost` hand it the child they spawned).

## `src/service/` file map

```
src/service/      separate Swift XPC service (S02 of docs/SWIFT-BACKEND-PLAN.md)
  ServiceMain.swift / ServiceRuntime.swift / ServiceXPC.swift   XPC listener,
                  signed-peer + hello validation, the Bun relay (`legacy` frame kinds),
                  drain; `--resolve-profile` for the dev launcher
  BackendSupervisor.swift / ProcessGuardian.swift   exclusive profile lock, the Bun backend
                  process group, lifetime-pipe guardians for detached servers,
                  Bun/descendant lifetimes and crash cleanup
  ServiceContract.swift   S01 shared DTOs (TS twin: src/shared/service-contract/)
  OperationLedger.swift / LedgerStore.swift / LedgerMirror.swift   S03 durable
                  operation ledger: intent digest, receipts, per-domain revisions,
                  event cursors, crash recovery. Opened under the profile lock
                  (docs/SWIFT-BACKEND-LEDGER.md)
  PreferencesOwner.swift / PreferencesFile.swift   the preferences writer (LKM-91):
                  byte-compatible v1 preferences.json, ledger-backed batches,
                  external-edit adoption. Bun reads and sends awaited batches via
                  native/preferences-service.ts (native/preferences.ts is its interface)
                  (docs/SWIFT-BACKEND-PREFERENCES.md)
  WorkspaceOwner.swift / WorkspaceFile.swift / DomainChannel.swift   the
                  workspace writer (LKM-92): project identity (canonical root →
                  key), order, selection and recents in the unchanged workspace.json;
                  session/server/Git fields arrive through a typed `update`
                  adapter. Bun sends awaited intents via native/workspace-service.ts;
                  native/workspace.ts is its interface and
                  native/workspace-model.ts the TS operations and validation
                  (docs/SWIFT-BACKEND-WORKSPACE.md)
  MemoryOwner.swift / MemoryFile.swift   the project memory writer (LKM-93):
                  unchanged project-memories/<id>.json, one ledger domain per
                  project; a manual `save` always wins, a generated `propose`
                  commits only on the revision it was evaluated against. Bun's
                  client is native/project-memory-service.ts; main/project-memory.ts
                  holds the shared rules, the evaluation queue and injection (docs/SWIFT-BACKEND-MEMORY.md)
  RuntimeOwner.swift / RuntimeServer.swift / ManagedProcess.swift   the managed
                  project runtime (LKM-94): dev-server + install process groups
                  (descendants stopped with their leader, `--watch-group`
                  watchdog + journal for crash recovery, never adopting a pid),
                  ports, readiness. RuntimeDetect.swift / RuntimeNet.swift mirror
                  main/project-detect.ts (the shared detection rules) + devserver-net.ts;
                  StaticSite.swift / StaticServer.swift serve static projects (FSEvents,
                  SSE, real-path containment, watcher). Bun's client is
                  native/runtime-service.ts on the devserver:* routes
                  (main/devserver-service.ts, wired by main/devserver.ts). HTML stamping
                  stays a JS helper
                  (docs/SWIFT-BACKEND-RUNTIME.md)
  RepositoryOwner.swift / RepositoryEffects.swift / RepositoryLanding.swift /
  RepositoryBranches.swift / RepositoryCleanup.swift / RepositoryMerge.swift / RepositoryJournal.swift / RepositoryGit.swift /
  GitMessages.swift   the repository coordinator
                  (LKM-95): one FIFO lane per repository common directory (Bun's
                  `enqueueRepoWrite` becomes a lease on it), every Trezi Git effect
                  (worktrees, landings, live commits, branch switches, recovery),
                  journaled intent, `refs/trezi/recovery/*` before anything could
                  orphan work, explicit intents for landing/discard/removal. Bun's
                  client is native/repository-service.ts behind the seam
                  main/repository-owner.ts; the TS Git code only reads and orchestrates
                  (docs/SWIFT-BACKEND-REPOSITORY.md)
  SourceOwner.swift / SourceStore.swift / SourceJournal.swift / SourceHistory.swift /
  SourcePaths.swift / SourceDrafts.swift   the source transaction service (LKM-96):
                  parsers only PROPOSE `{path, expectedHash, content}` via
                  main/source-commit.ts `proposeEdit`; the service commits hash-bound,
                  journaled multi-file transactions in the repository lane (crash
                  rollback never overwrites newer work), authorizes paths (symlinks
                  included), owns grouped Undo/redo/revert, file-tree create/rename/
                  delete, editor reads/saves and persisted drafts. Bun's client is
                  native/source-service.ts behind main/source-owner.ts, which edit-history.ts
                  and file-ops.ts call (docs/SWIFT-BACKEND-SOURCE.md)
  ConversationOwner.swift / ConversationState.swift / ConversationStore.swift   the
                  conversation coordinator (LKM-97): the only writer of session records
                  and History (unchanged sessions/*.json), live-chat checkpoints with
                  crash recovery, the turn state machine (one turn per chat; one terminal
                  claimed per turn run; late/duplicate terminals refused), completion
                  policy, titles, model handoff, approvals, spawn admission. Bun's
                  provider sessions are adapters (main/chat-turns.ts tags events with
                  their turn); Bun's client is native/conversation-service.ts behind
                  main/conversation-owner.ts; test/fixtures/conversation-owner/parity-golden.json
                  pins its answers (docs/SWIFT-BACKEND-CONVERSATION.md)
  ProviderOwner.swift / ProviderFrames.swift / ProviderPolicy.swift / ProviderHelper.swift /
  ProviderStore.swift / ProviderData.swift
                  the provider owner (LKM-98): every provider session is opened here and
                  gets a grant (Trezi tools, roots, chat); it answers permission requests
                  (Claude's canUseTool asks it), authorizes Trezi tools (Claude's in-process
                  tools, Codex's MCP bridge), holds Stop's deadline, persists resume ids and
                  supervises provider helpers (stdio only, allowlisted env, own process
                  group, every frame checked against the grant). Since LKM-111 the built-in
                  Claude, Codex and Gemini adapters always run in those helpers
                  (main/backends/provider-helper-entry.ts); v10 connections stay in Bun
                  (main/provider-sessions.ts wires every session). ProviderData.swift (LKM-102) writes
                  the connections store (keys via `TreziSecrets --crypto`), the model catalog
                  cache and runs the Codex model probe on the SDK's vendored binary, behind
                  main/provider-data.ts. Bun's client is native/provider-service.ts behind
                  main/provider-owner.ts; the provider-owner goldens pin its answers
                  (docs/SWIFT-BACKEND-PROVIDERS.md)
  EditingOwner.swift / EditingIslands.swift / EditingStores.swift / EditingProject.swift
                  the editing
                  coordinator (LKM-99): the only writer of chat island histories
                  (unchanged chat-islands/*.json) and their state machine (activation
                  only by the defining turn, which it asks the conversation owner;
                  command admission, a queued batch's revision chain, per-island
                  Undo); hash-bound commits of the project sidecars in .trezi/
                  (control-panels.json, and since LKM-102 annotations.json and
                  tokens.json) in the repository lane, plus the sidecar migration,
                  setup helpers and each worktree's own node_modules (clone)
                  and dependency marker (EditingProject), and
                  the one-time legacy-name migration (EditingLegacyNames);
                  deferred open_preview navigation. Bun keeps the JS helpers
                  and views (main/chat-islands.ts, native/navigation-controller.ts, native/turn-boundaries.ts); Bun's
                  client is native/editing-service.ts behind main/editing-owner.ts;
                  test/fixtures/editing-owner/parity-golden.json pins its answers
                  (docs/SWIFT-BACKEND-EDITING.md)
  WorkflowOwner.swift / WorkflowJournal.swift / WorkflowPublish.swift /
  WorkflowRemote.swift / WorkflowSetup.swift / WorkflowTools.swift / WorkflowContext.swift
                  the workflow owner (LKM-100): Publish
                  (merge / PR only), handoff and saved-run PRs, Connect to GitHub, remote
                  fetch/pull/switch, `.trezi/` setup helpers, new projects, Trezi's own
                  update, the in-app feedback issue, curated skill-pack installs (LKM-102)
                  and the diagnosis memory, each a durable record (intent before
                  the effect, receipt after, operation-ID dedupe) reconciled from GitHub
                  and Git instead of repeated. Bun's helpers only propose (PR
                  descriptions, detection, starter files, diagnoses). Bun's client is
                  native/workflow-service.ts behind main/workflow-owner.ts
                  (docs/SWIFT-BACKEND-WORKFLOWS.md)
  PlatformOwner.swift / SimulatorOwner.swift / SimulatorBridge.swift /
  SimulatorTools.swift / PlatformMedia.swift / PlatformTools.swift / PlatformOpen.swift
                  the platform
                  owner (LKM-101): the iOS Simulator preview (bounded, cancellable
                  xcrun/idb runs in a ToolScope, the app's launch command as a journaled
                  group, the loopback MJPEG bridge, idb input and picks), scoped media
                  grants for the source editor (view, identity, size, SHA-256, expiry),
                  pasted attachments from hash-checked chunks, the running-servers
                  recovery, and (PlatformOpen, LKM-102) opening links, files and "Open
                  in editor". Bun's client is native/platform-service.ts behind
                  main/platform-owner.ts (main/simulator.ts wires the Simulator views)
                  (docs/SWIFT-BACKEND-PLATFORM.md)
  ProfilePaths.swift   the profile and session-store rename aliases (LKM-102): the
                  launcher asks `TreziService --resolve-profile`; the session alias is
                  made under the profile lock before Bun starts
                  (docs/SWIFT-BACKEND-RETIREMENT.md)
```

The host side of the connection: `src/native/ServiceClient.swift` owns the versioned XPC
connection (handshake, reattach, bounded outbox) and `src/native/HostService.swift`
integrates the AppKit quit/restart/exit-status lifecycle. See the service Gotcha in
[gotchas.md](gotchas.md).
