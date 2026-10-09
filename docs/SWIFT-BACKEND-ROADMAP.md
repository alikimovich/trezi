# Swift backend implementation roadmap

> **History note (LKM-111, 2026-09-29):** this document predates LKM-111, which removed
> the Bun rollback launch (`TREZI_BACKEND_OWNER=legacy`, `TreziService --legacy`), its
> twins and several modules named here. The current census is in
> [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-88, 2026-09-28. This expands the eight phases of the
[canonical plan](SWIFT-BACKEND-PLAN.md) into 15 implementation boundaries.
S01 is LKM-88; S02–S15 are stable local task IDs, not assertions about external
issue identifiers or assignments to people. The manager owns scheduling, commits,
verification and review. Future owners below name architectural responsibility.

S01 is accepted (candidate 51fb928). S02 (LKM-89) adds the separate XPC service,
Swift supervision of legacy Bun, Swift-owned profile exclusion and the
launch-time owner switch; it is implemented for review and transfers no domain
writer; see [service and rollback](SWIFT-BACKEND-SERVICE.md). S03's durable
operation ledger (LKM-90) is implemented for review in the Swift service and
also transfers no writer ([ledger](SWIFT-BACKEND-LEDGER.md)). The preferences
writer transfer (LKM-91) is implemented for review: the service owns
`preferences.json` in the unchanged v1 format, and Bun's writer remains the
launch-time rollback owner ([preferences](SWIFT-BACKEND-PREFERENCES.md)).
The workspace transfer (LKM-92, row S04) is implemented for review: the service
owns project identity, order, selection and recents in the unchanged
`workspace.json`, legacy slices report their per-project fields through a typed
adapter, and Bun's writer is the rollback owner ([workspace](SWIFT-BACKEND-WORKSPACE.md)).
The memory transfer (LKM-93, row S05) is implemented for review: the service owns
project memory files and orders manual saves ahead of stale generated proposals;
annotation storage is split from publication but stays legacy-owned until S07, and
attachments moved later with S14 ([memory](SWIFT-BACKEND-MEMORY.md)).
The runtime transfer (LKM-94, row S06) is implemented for review: the service owns
detection, installs, dev-server process groups, ports, readiness and the static
site with its watcher, with a per-group watchdog and journal for crash recovery;
Bun keeps command choice and the install's repository lease, and its runner is the
rollback owner ([runtime](SWIFT-BACKEND-RUNTIME.md)).
The repository transfer (LKM-95, row S07) is implemented for review: the service is
the per-repository serialization authority (common-directory lanes and leases) and
performs every Trezi Git effect with journaled intent, recovery refs and explicit
intents for landing, reconciliation, discard and removal; the TS Git code is the
rollback owner ([repository](SWIFT-BACKEND-REPOSITORY.md)).
The source transfer (LKM-96, rows S08 and S09) is implemented for review: parsers
only propose hash-bound edits; the service authorizes paths, commits journaled
multi-file transactions in the repository's lanes, owns grouped Undo, file-tree
operations, editor reads/saves and persisted drafts, and rolls back interrupted
transactions without overwriting newer work; the TS writers are the rollback owner
([source](SWIFT-BACKEND-SOURCE.md)).
The conversation transfer (LKM-97, row S11) is implemented for review: the service owns
session records and History, live-chat checkpoints and crash recovery, turn transitions
with terminal deduplication and stale-event refusal, completion policy, titles, model
handoff, approvals and spawn admission; Bun's provider sessions are adapters and the TS
twin is the rollback owner ([conversation](SWIFT-BACKEND-CONVERSATION.md)).
The provider transfer (LKM-98, row S10) is implemented for review: the service holds
every provider session's grant, answers its permission requests and tool authorizations,
owns Stop's deadline and persists resume ids, and supervises provider helpers against
their grant (environment, descriptors, process group, validated frames). The SDK
adapters stay in-process in Bun until an authorized live parity run moves them into
helpers; the TS twin is the rollback owner ([providers](SWIFT-BACKEND-PROVIDERS.md)).
The editing transfer (LKM-99, row S12) is implemented for review: the service owns chat
island histories and their state machine (activation bound to the defining turn, which
the conversation owner decides; command admission, batch revision chains, per-island
Undo), commits the controls sidecars hash-bound in the repository lane, persists
content-editor drafts and holds deferred preview navigation until its turn lands. Bun
keeps the JS helpers, the isolated DOM instrumentation and the inspector views; the TS
twin is the rollback owner ([editing](SWIFT-BACKEND-EDITING.md)).
The workflow transfer (LKM-100, row S13) is implemented for review: the service performs
publication (Publish, handoff and saved-run PRs), Connect to GitHub, remote fetch/pull/switch,
the instrumentation helpers, new projects, Trezi's own update and the diagnosis memory as
journaled workflows with operation IDs and receipts, reconciling uncertain steps from GitHub
and Git instead of repeating them; Bun keeps the proposing helpers and the sheets, and the
original TS code is the rollback owner ([workflows](SWIFT-BACKEND-WORKFLOWS.md)).
The platform transfer (LKM-101, row S14) is implemented for review: the service runs the
Simulator preview (bounded, cancellable xcrun/idb runs, the launch command as a journaled
group, the loopback bridge), issues scoped media grants to the source editor, writes pasted
attachments from hash-checked chunks and performs the running-servers recovery; the TS code
is the rollback owner ([platform](SWIFT-BACKEND-PLATFORM.md)).

| Task | Canonical phase | Scope and future owner | Required exit evidence |
| --- | --- | --- | --- |
| S01 | 1 | Contracts and executable correctness fixtures (LKM-88); shared Swift/TypeScript protocol | Golden parity, malformed/version/limit/scope/revision rejection, request versus operation identity, complete census mapping. Accepted; merged as 51fb928. |
| S02 | 2 | Separate Swift service, XPC and supervision; Swift supervisor owns legacy Bun and helper lifetimes | Peer validation, launch negotiation, invalidation/reconnect, bounded shutdown, exclusive profile lock and launch-time owner selection. No domain takeover by transport alone. Implemented for review (LKM-89): `test/service-process.mjs`. |
| S03 | 3 | Durable intent/checkpoint/snapshot substrate and preferences; Swift persistence service | Persist intent before effects, recover after each injected crash phase, deduplicate across restart, preserve v1 preferences/unknown keys/null and unsaved drafts; drain-and-restart restoration. Ledger substrate implemented for review (LKM-90): `test/operation-ledger.mjs`. Preferences transfer implemented for review (LKM-91): `test/preferences-owner.mjs`. |
| S04 | 3 | Basic projects/workspaces; Swift workspace coordinator | Stable root/checkout identity, restore/open/close/reorder/suspend parity, revisioned snapshots and preservation of newer workspace state on rollback. AppKit retains picking and presentation. Implemented for review (LKM-92): `test/workspace-owner.mjs`. Root identity moved; checkout (worktree) identity stays with S07, and warm-project suspension keeps running in Bun on the Swift-owned `touchedAt` until S06/S11. |
| S05 | 3 | Memory, annotations and attachments; Swift state services | Manual save beats stale evaluation, annotation publishing split, scratch/blob bounds, original data retained on corruption/failure and restart. Repository lane gates project sidecar changes. Memory implemented for review (LKM-93): `test/memory-owner.mjs`. Annotation storage split and hardened in Bun (`test/annotation-store.mjs`); its Swift writer is blocked on S07. Attachments (scratch/blob bounds) not started. |
| S06 | 4 | Managed servers/dependencies/static serving; Swift process supervisor | Selected runtime preserved; process groups, descendants, watchers and logs stop on shutdown; readiness/port/restart failures and rollback tested without orphan adoption. Implemented for review (LKM-94): `test/runtime-owner.mjs`. Persisted server fields stay on the S04 adapter with the workspace controller (S12); the user-driven "Servers" recovery sheet (foreign listeners) and the Simulator (S14) stay in Bun. |
| S07 | 5 | Git/worktrees/isolation policy and recovery; per-repository Swift coordinator | Explicit mutation intent, common-directory FIFO lease, private index, recovery refs and interrupted landing; preserve user index/worktrees and never blind-reset newer changes. Implemented for review (LKM-95): `test/repository-owner.mjs` (legacy suites re-run on the owner, lanes, external changes, intent, crash, rollback). Remote actions, publishing, the annotation sidecar and source writers run inside the Swift lease but keep their own writers until S13/S05/S08. |
| S08 | 5 | Source transactions, file tree, media reads, drafts and Undo; Swift source service | Expected hashes, root/symlink checks, multi-file interrupted commit recovery, grouped Undo, blob scopes and newer external edits preserved; Repository remains serialization authority. Implemented for review (LKM-96): `test/source-owner.mjs`. File-tree listing, media (`trezi-media://`) and component resolution stay Bun read-only; sidecar stores stay Bun inside the lease; setup/scaffold writers move with S13. |
| S09 | 5 | Parser/source-edit helper extraction; read-only JS parsers under Swift source authority | Hash-bound patches/diagnostics, React/Svelte/HTML parity, unavailable/schema/ambiguous cases, cancelled/stale proposals; helpers cannot commit source. Implemented for review (LKM-96) with S08: parsers stay in the Bun process (no separate helper process yet) but commit only through `proposeEdit`; a static check keeps file writes and Undo state out of the engines. |
| S10 | 6 | Provider adapters, authentication, catalogs and tools; Swift provider service plus supervised SDK/math helpers | Capability negotiation, secret/reference boundary, image semantics, helper privileges and deterministic failure/cancel fixtures. Paid/live provider checks require separate authorization. Implemented for review (LKM-98): `test/provider-owner.mjs`. The SDK adapters (and title/memory generation) stay in-process under the owner until a live parity run; catalogs stay in Bun; pure calculators stay with the adapter. |
| S11 | 6 | Chat/turn/spawn orchestration and transcript state; Swift conversation coordinator | Queues, approvals, terminal deduplication, model handoff, cancellation, checkpointed transcripts and reconnect without draft loss; repository effects delegated to S07. Implemented for review (LKM-97): `test/conversation-owner.mjs`. The composer's queued-message list and drafts stay in the Bun chat controller (S12); provider sessions stay Bun adapters (S10). |
| S12 | 7 | Editing/controls/content/composition/preview controllers; Swift coordinators, AppKit and isolated DOM JS | Originating chat/turn/document/revision checks, pending activation, saved-source Undo through S08, preserved drafts and DOM allowlist; test hooks never become helper capabilities. Implemented for review (LKM-99): `test/editing-owner.mjs`. Inspector/layers/style controllers stay Bun view controllers (no workflow state beyond their generation checks); the composer queue, drafts and attachments, the workspace controller's server fields and the preview DOM instrumentation stay where they are (TASKS). |
| S13 | 7 | Publishing/remote actions/setup/diagnostics/support and shared sheet routing; Swift application services | Explicit side-effect intent, durable local/remote receipts, uncertain-result reconciliation, redacted logs and failure-preserving autosave; commits delegated to Repository/Source. Implemented for review (LKM-100): `test/workflow-owner.mjs`. Feedback issues (`feedback:submit`), sheet routing and autosave, `github:status`/`setup:detect`/update check (reads) and the tokens sidecar stay in Bun (TASKS). |
| S14 | 7 | Simulator and platform process integration; Swift simulator coordinator | Supervised xcrun/bridge lifecycle, failed preflight/build/boot/install and teardown recovery; platform/device verification recorded separately. Implemented for review (LKM-101): `test/platform-owner.mjs`. Also moved: media grants (S08 media reads), attachments (S05 remainder), the running-servers sheet (S06 remainder). A real Xcode/simulator run is unverified; the remaining Bun OS effects are listed in TASKS for S15. |
| S15 | 8 | Installation updates, launcher/distribution and legacy retirement; Swift lifecycle service | Reconcile every census row, no remaining Bun domain writers, retained narrow JS helpers, supported-macOS/package checks and restoration from current data without old-backup overwrite. Partially implemented for review (LKM-102): notes and starter tokens moved to the editing owner, executable effect census (`test/retirement-census.mjs`), one platform source (`test/distribution.mjs`). Gate blocked by 13 Bun-owned rows and the in-process provider adapters; legacy owners retained ([retirement](SWIFT-BACKEND-RETIREMENT.md)). |

Each task depends on the foundation in preceding canonical phases. The numeric
order is the default schedule, not permission for temporary dual ownership.
S05 annotation sidecars must remain legacy-owned until S07's repository lane is
available; S04 scaffolding and other source-changing paths likewise defer their
writer transfer until S07/S08. Record those blocked sub-boundaries explicitly,
then complete them before S15. A row's task is accountable for integrating it;
shared mutation mechanisms remain owned by S07/S08. Splitting a file does not
split the authoritative writer. Source parsing and provider math may remain JS.

## Exhaustive census mapping

Every data row now has explicit `Migration task` and `Future owner` columns:

- [Modules](SWIFT-BACKEND-MODULES.md): 146 production module rows.
- [Routes](SWIFT-BACKEND-ROUTES.md): 133 registration rows, including the dynamic
  preview reply factory. Repeated names are separate registration sites.
- [Events](SWIFT-BACKEND-EVENTS.md): 240 dispatch/emission/subscription rows,
  including duplicate producers, UI commands, test hooks and dynamic envelopes.

The inventory source locations are the preserved LKM-84 snapshot; mapping does
not claim those historical line numbers remain current. A generic event bus row
maps to the boundary/controller that must dispatch it; concrete domain rows name
the eventual effect owner. AppKit remains the UI broker and never gains workflow
or persistence authority from receiving snapshots. Inspection/Perform/capture
rows remain test or UI broker capabilities, never provider/parser capabilities.

Mixed routes follow their actual effect: `styles:apply` and `layers:move` go to
source editing; DOM style/layer reads, previews and replies stay in S12. Picking,
source popouts and native edit commands retain their AppKit broker. Annotation
publication belongs to S13, with S07 authorizing repository effects; S05 owns only
annotation storage. Provider session tools not registered as RPCs are covered by
S10's tool modules, with chat, memory, source, controls, composition and preview
operations dispatched to their explicit domain owners. Media scheme registration
belongs to S08. Project build plugins and preview instrumentation remain JS.

## Canonical architecture and rollback boundary

The accepted boundary is a **separate Swift service over versioned XPC**, with
Swift supervising legacy Bun and helpers. Private helper pipes may carry bounded
DTO bytes, but cannot replace the application/service XPC boundary. Durable
intent and recovery checkpoints are prerequisites for the first transferred
writer. Host-local actors, a Bun-owned future launcher and an in-memory-only
ledger were audit staging alternatives and are not accepted migration steps.

S01 has no production owner switch because it transfers no writer. Reverting
these inert contract files requires no data restoration. S02 adds launch-time
owner selection (`TREZI_BACKEND_OWNER=swift|legacy`) under one Swift profile lock
before S03 opens any writable domain; its rollback domain is only the lock files
and process lifetime. Every transfer must first
name its exact files, journals, receipts, drafts and worktrees; test stopping new
mutations, draining or recording uncertain operations, closing the current owner
and restoring the legacy owner under the same exclusive profile lock. Retain
current stores and journals. Legacy restore must read/reconcile the newest state,
including work completed after any backup, or refuse safely with recovery status.
Never replace current state with an old backup, discard drafts/receipts/worktrees,
hot-switch a writer, or fall back to Bun writes after a timeout. Domain-specific
restoration tests are prerequisites for takeover, not claims established by S01.
