# Swift Backend Migration Plan

Goal: replace the Bun-hosted application backend with a Swift-owned service
architecture. Swift owns workspace/chat coordination, persistence, provider
lifecycle, Git/worktrees, source transactions, managed servers, and recovery.
JavaScript remains narrowly scoped to provider SDK adapters and web-language
parsing helpers.

## Status

Initiated 2026-09-27. This is the canonical plan document; update it as
phases complete.

**Current (2026-09-29, LKM-111):** the built-in Claude, Codex and Gemini adapters run by
default in provider helpers the Swift service supervises (v10 connections stay in Bun).
The launch-time rollback (`TREZI_BACKEND_OWNER=legacy`, `TreziService --legacy`) and
every Bun twin it ran are removed; their recorded answers became goldens, and each Bun
seam throws without the service. The retirement gate is open (0 Bun-owned rows, no
rollback switch in a shipped file, both checked by `test/retirement-census.mjs`). The
retained JS and a Bun binary ship inside `Trezi.app`, so no installed Bun is needed to
run it, and `open -a Trezi` or the thin `trezi` command is the one start path. The bounded
live Claude + Codex parity check (`test/provider-live-parity.mjs`) passed for Claude on
both hosts in the operator's run; Codex hit its usage limit and is deferred to LKM-113
(numbers in the retirement evidence). Passages below that name the rollback are history.
See [retirement](SWIFT-BACKEND-RETIREMENT.md).

**Earlier (2026-09-29, LKM-102, reduced acceptance):** the scope was reduced (a
recorded decision): the SDK adapter move, the live provider parity run and the removal
of the legacy launch path and old Bun copies are LKM-111. The last seven Bun-owned
census rows moved to Swift, each with a rollback twin and parity tests: the connections
store, model catalog and Codex probe (`ProviderData.swift`), opening links, files and the
editor (`PlatformOpen.swift`), the profile and session-store aliases
(`ProfilePaths.swift`), and the profile lock, which Bun no longer writes (it refuses to
start without the service's). **The census has 0 Bun-owned rows**; the removal gate stays
closed on LKM-111. Provider adapters remain in Bun by default; helper routing is an
explicit opt-in (`TREZI_PROVIDER_HELPERS=1`), and v10 connections stay in-process even
with it. See [retirement](SWIFT-BACKEND-RETIREMENT.md).

**Earlier (2026-09-29, LKM-102, first pass):** S15 (roadmap row) reconciles the census and gates the
legacy retirement. The last S05 sidecar writer (reviewer notes) and the starter tokens
scaffold moved to the editing owner's hash-bound sidecar commit, and the supported
platform (macOS 13.3+, macOS 26 SDK to build, Bun 1.3+) has one source enforced by the
build, launcher, CLI and installer. Every Bun module that writes files, runs processes or
sends signals is classified in [retirement](SWIFT-BACKEND-RETIREMENT.md) and checked by
`test/retirement-census.mjs`. The retirement gate was then blocked (by Bun-owned rows,
since moved; the provider adapters still run in Bun pending LKM-111), so no legacy
owner, rollback twin or `TREZI_BACKEND_OWNER=legacy` was removed and Bun still hosts the
application controllers. Implemented for review on the LKM-101 candidate.

**Earlier (2026-09-29, LKM-101):** S14 (roadmap row) moves the remaining OS services Bun
ran itself into the Swift service's platform owner. The iOS Simulator preview (preflight,
boot, idb, the app's launch command as a journaled process group, the loopback bridge and
its frame capture, input and element picks) is a Swift coordinator: every tool run is
bounded and cancellable, so a stop or a newer start reaches a boot or build still waiting,
and a restart never overlaps. The native source editor's media access is a scoped grant
(view, file identity, size, SHA-256, expiry) instead of a Bun path registry; pasted images
are uploaded in hash-checked chunks and written by the service; the running-servers sheet's
inspection and SIGTERM re-check identity in Swift. The unreachable `trezi-media` scheme route
is retired. A census of the Bun-owned OS effects that remain is recorded in TASKS for S15.
`TREZI_BACKEND_OWNER=legacy` keeps the original TS code as the rollback owner. See
[platform](SWIFT-BACKEND-PLATFORM.md). Implemented for review on the LKM-100 candidate;
manager verification and acceptance are pending, and a real Xcode/simulator run is
unverified (scripted tools only).

**Earlier (2026-09-29, LKM-100):** S13 (roadmap row) moves Trezi's side-effecting
workflows outside a chat turn into the Swift service's workflow owner: Publish (merge or
PR only), the handoff and saved-run PRs, Connect to GitHub, remote fetch/pull/switch, the
`.trezi/` instrumentation helpers, new projects (files, first commit, install), Trezi's own
update and the diagnosis memory. Each run is a durable record: every step's intent is on
disk before its effect and its receipt after, requests carry an operation ID, and a request
re-sent after a lost reply is answered from its receipt. An uncertain step is reconciled
from GitHub and Git (an open PR adopted, a merge checked on the journal's PR number, a
repository this run created adopted, a pull skipped by receipt), so no PR, merge or update
is repeated. Bun keeps the helpers that only propose (PR descriptions, detection and helper
sources, starter files, diagnoses) and the sheets. `TREZI_BACKEND_OWNER=legacy` keeps the
original TS code as the rollback owner. See [workflows](SWIFT-BACKEND-WORKFLOWS.md).
Implemented for review on the LKM-99 candidate; manager verification and acceptance are
pending, and real GitHub/installs are unverified (scripted `gh` and package manager only).

**Earlier (2026-09-29, LKM-99):** S12 (roadmap row) moves the editing workflows' state
into the Swift service. It is the only writer of chat island histories and decides every
island step: a definition is bound to the turn the conversation owner says is in flight,
only that turn's landing activates it (a late or another turn's terminal activates
nothing), commands are admitted for the current revision one at a time, a queued
batch's source revision advances only through its own writes, and each island's Undo
group reverts through the source owner. It commits the controls sidecars
(`.trezi/control-panels.json`, `content-controls.json`) only against the bytes Bun read,
in the repository lane; persists content-editor drafts across restarts (a stale one is
refused on save); and holds an agent's `open_preview` until its turn lands (the native
app had lost this deferral). Bun keeps the JS helpers, the isolated WebKit
instrumentation and the inspector views. `TREZI_BACKEND_OWNER=legacy` keeps the TS twin
as the rollback owner. See [editing](SWIFT-BACKEND-EDITING.md). Implemented for review
on the LKM-98 candidate; manager verification and acceptance are pending.

**Earlier (2026-09-29, LKM-98):** S10 (roadmap row) puts provider sessions under the
Swift service. Every session is opened there first and gets a grant fixed from its
provider, background flag and roots. The service answers its permission requests
(Claude's `canUseTool` no longer decides) and authorizes its Trezi tools (Claude's
in-process tools, Codex's MCP bridge). It holds Stop's deadline, escalating to the
adapter's kill switch once, and persists provider thread ids for resume. It also
supervises provider helpers: stdio only, an allowlisted environment, its own process
group, and bounded frames each checked against the grant, with violations stopping the
helper. This answers the open question on the provider boundary: SDK adapters, one
supervised helper per session in the end state. The helper runtime is verified with a
scripted fake provider. The real adapters still run in-process in Bun until an
authorized live parity run moves them. `TREZI_BACKEND_OWNER=legacy` keeps the TS twin as
the rollback owner. See [providers](SWIFT-BACKEND-PROVIDERS.md). Implemented for review
on the LKM-97 candidate; manager verification and acceptance are pending, and
real-provider behaviour is unverified.

**Earlier (2026-09-29, LKM-97):** S11 (roadmap row) moves conversation state into the
Swift service. It is the only writer of session records and History (unchanged
`sessions/*.json`), keeps a checkpoint of every live chat, and at launch saves a chat a
crash cut off without replacing newer work. It owns the turn state machine and its
completion policy: one turn per chat, at most one terminal claimed per turn run, and a
late or duplicate terminal refused, so it cannot complete the wrong turn. It also owns
titles (a user rename always wins), model handoff (history carried once), pending
approvals and permission mode, and background-spawn admission. Bun's provider sessions
stay adapters: `TurnTracker` attributes each event to its turn, and Bun performs the
effects the owner's answers call for, landing through the repository coordinator.
`TREZI_BACKEND_OWNER=legacy` keeps the in-process TS twin as the rollback owner. See
[conversation](SWIFT-BACKEND-CONVERSATION.md). Implemented for review on the LKM-96
candidate; manager verification and acceptance are pending.

**Earlier (2026-09-29, LKM-96):** S08 and S09 (roadmap rows) move source
transactions into the Swift service. Bun's parsers (React, Svelte, HTML, Tailwind,
tokens, moves, islands, content, controls) only propose `{path, expectedHash,
content}`; the service commits a proposal only if the file still holds the bytes it
was computed from, in the repository's lane, as a journaled multi-file transaction.
Path authorization (root, protected folders, symlink containment), editor reads and
saves with owner-issued baseline hashes, file-tree create/rename/delete, grouped
Undo/redo/revert and persisted editor drafts are Swift's. A crash midway through a
commit or an Undo is rolled back at the next launch without overwriting anything
changed since (pre-images are kept). A proposal whose deadline passed while it waited
is never started. `TREZI_BACKEND_OWNER=legacy` keeps the TS writers as the rollback
owner. This answers the open question on the parser helper contract and
expected-content hashing. See [source](SWIFT-BACKEND-SOURCE.md). Implemented for review
on the LKM-95 candidate; manager verification and acceptance are pending.

**Earlier (2026-09-29, LKM-95):** S07 (roadmap row) moves repository coordination
into the Swift service: one FIFO lane per repository common directory (the live
checkout and all its worktrees), leases that replace Bun's process-local
`enqueueRepoWrite` queue, and every Trezi Git effect — worktree create/sync/remove,
turn commits and landings, explicit apply, reconciliation staging, discard, live
commits, branch switches and startup recovery. Each mutation's intent is journaled
before its first effect; recovery refs (`refs/trezi/recovery/*`) are made before
anything could become unreachable; removal, discard and landing need their explicit
intent; interrupted operations are reported, never replayed. Snapshots use a private
index. Bun keeps chat state, park records, Undo history and setup helpers, and other
slices' writers (remote actions, publishing, annotations, source writes) run inside
the Swift lease until they move. `TREZI_BACKEND_OWNER=legacy` keeps the TS Git code
as the rollback owner; worktrees, journal and refs survive the switch. See
[repository](SWIFT-BACKEND-REPOSITORY.md). Implemented for review on the LKM-94
candidate; manager verification and acceptance are pending.

**Earlier (2026-09-29, LKM-94):** S06 (roadmap row) moves the managed project
runtime into the Swift service as one unit: runtime detection, dependency installs,
dev-server process groups, ports, readiness, the static site with its FSEvents
watcher and live-reload stream, and shutdown and crash recovery. Bun still chooses
what to run and keeps the repository write lease around installs until S07; HTML
stamping stays a JS helper the static site asks. Each group has a watchdog and a
journal entry, so descendants never outlive a leader, a service crash never leaves
a server running, and nothing unrelated is signalled or adopted. At quit the
service drains every owned group before it releases the profile lock, and the
`--legacy` launcher sweeps the journal first, so `TREZI_BACKEND_OWNER=legacy`
(Bun's runner as the rollback owner) never overlaps a Swift-started server. See
[runtime](SWIFT-BACKEND-RUNTIME.md). Implemented for review on the LKM-93
candidate; manager verification and acceptance are pending.

**Earlier (2026-09-29, LKM-93):** S05 (roadmap row) moves project memory into the
Swift service as the only writer of the unchanged `project-memories/<id>.json`
files, through the ledger (one domain per project). A manual editor `save` always
wins; a generated `propose` commits only on the revision it was evaluated against,
so a stale evaluation can never overwrite it. Evaluation stays a Bun helper with no
write authority. Damaged files are refused untouched instead of read as empty, and
injection uses the owner's digest. Annotation storage is split from publication and
hardened (damaged files kept, per-project serialization, stale responses dropped),
but its writer stays in Bun: the sidecar is inside the user's repository and waits
for S07's repository lane, as this roadmap requires. `TREZI_BACKEND_OWNER=legacy`
keeps the Bun memory writer as the rollback owner. See [memory](SWIFT-BACKEND-MEMORY.md).
Implemented for review on the LKM-92 candidate; manager verification and acceptance
are pending.

**Earlier (2026-09-29, LKM-92):** S04 (roadmap row) moves workspace identity,
membership, order, the selected project and recents into the Swift service as
the only writer of the unchanged `workspace.json`, through the ledger. Keys stay
as they were; an aliased root (symlink, trailing slash) resolves to the existing
project. Mappings are persisted before any dependent session/server command. Session,
server and Git fields stay legacy-owned and reach the file only through a typed
`update` adapter; display state and drafts are never stored. `TREZI_BACKEND_OWNER=legacy`
keeps a byte-identical Bun writer as the rollback owner. See
[workspace](SWIFT-BACKEND-WORKSPACE.md). Implemented for review on the accepted
LKM-91 base; manager verification and acceptance are pending.

**Earlier (2026-09-28, LKM-91):** the preferences writer moves to the Swift
service, through the ledger, behind the adoption gate: v1 `preferences.json` is
kept byte-compatible, Bun's callers send awaited batches over the supervised pipe
and read acknowledged snapshots, and `TREZI_BACKEND_OWNER=legacy` keeps Bun's
writer as the rollback owner. See [preferences](SWIFT-BACKEND-PREFERENCES.md).
Implemented for review; manager verification and acceptance are pending. Every
other domain writer is still Bun.

**Earlier (2026-09-28, LKM-90):** S02 (LKM-89) is merged into this step's base
(5b18354). S03's durable operation ledger — persistent intent, request digests
and receipts, commit checkpoints, per-domain revisions, persisted event cursors
and recovery queries — is implemented for review in the Swift service; see the
[ledger](SWIFT-BACKEND-LEDGER.md) for storage layout, compatibility, rollback and
the preferences adoption gate. No domain writer has moved.

**Earlier (2026-09-28):** S01 (LKM-88) is accepted and merged into the candidate
as 51fb928. S02 (LKM-89) — the separate Swift XPC service, legacy Bun
supervision, Swift-owned profile exclusion and launch-time owner selection — is
implemented for review; see [service and rollback](SWIFT-BACKEND-SERVICE.md).
Manager verification (unsandboxed XPC fixture and native tier) and independent
review are pending for S02. No domain writer has moved; S03 is next. The dated
entries below are history: their "pending" notes refer to S01 before acceptance.

2026-09-28, LKM-88 (step S01): shared contract/fixture implementation and exhaustive
census ownership mapping are implemented for review. The 92-case cross-language
fixture suite, TypeScript/native typechecks and docs-link check pass. Manager
verification, independent review and acceptance remain required. No domain writer has moved. The separate
Swift service/XPC, Swift supervision and durable intent prerequisites remain
mandatory. See the [15-step roadmap](SWIFT-BACKEND-ROADMAP.md) for task boundaries,
future owners and rollback gates, and the [executable wire contract](SWIFT-BACKEND-WIRE.md)
for the implemented subset. Audit host-local/pipe-first/in-memory staging
is superseded for implementation and does not relax this plan.

2026-09-28 verification repair: the fixture now stops its esbuild service after
bundling. The focused unit runner passes all 92 cases and process-group cleanup;
manager's full verification and review remain pending. No ownership boundary changed.

2026-09-28 manager follow-up: all 108 unit checks and typechecks passed; desktop
verification stopped at Shadow Light foreground capture. Its fixture now awaits
bounded main-window readiness before capture, with a passing non-GUI regression.
Manager must rerun desktop verification and inspect the captures; migration
acceptance and all writer transfers remain pending.

2026-09-28 escalation: the latest manager run passes 109 unit checks but loses
foreground during asynchronous capture, after readiness succeeds. The smoke
helper now retries only explicit foreground rejections with fresh activation and
pixels, bounded to three attempts. Non-GUI race regressions pass; unchanged Swift
guards and PNG/OCR checks still require manager desktop verification. S01 remains
for review, with no writer transfer or migration acceptance.

2026-09-28 tracking repair: candidate and S01 task sections are preserved in a
conflict-free three-way TASKS resolution. Implementation is unchanged; manager
desktop verification, independent review and tested candidate integration remain
pending. No candidate merge commit is claimed by this worker.

2026-09-28 independent-review repair: manager reports 109 unit checks and native
integration passed on the prior revision. Fix the two subsequent contract findings:
structured service/method authorization prevents dotted-name collisions, and Swift
encoding leaves slashes unescaped. All 100 cross-language cases and both typecheck
tiers pass. This revision awaits manager verification and independent re-review;
no domain writer has moved and S01 acceptance remains pending.

2026-09-28 encoder review repair: validate original TypeScript values before
serialization so NaN and either infinity cannot silently become null. Nine
encoder rejection cases, fifteen valid numeric/null controls, the 100-case
cross-language suite and both typecheck tiers pass. This revision still requires
manager verification and independent re-review; ownership remains unchanged.

## End-state architecture

| Layer | Responsibility |
|---|---|
| Swift AppKit/SwiftUI app | Presentation, user input, WebKit, native dialogs, OS integrations. Holds display state, not authoritative workflow state. |
| Swift service process | Workspace/chat coordination, persistence, provider sessions, Git/worktrees, source transactions, managed servers, recovery. |
| Provider adapters | Translate provider events/commands into a typed Trezi contract. Native protocols where sufficient; SDK helpers where needed. |
| Source-analysis helpers | Parse framework sources, resolve types/schemas, propose edits. No authority to commit changes or manage app state. |
| Project processes / preview | User project servers and their runtimes; JavaScript instrumentation inside WebKit. |

Transport: versioned, typed local protocol over XPC with explicit requests,
events, cancellation, and reconnection.

## Service owners

- Workspace/session coordinator
- Repository coordinator per Git repository
- Source transaction service
- Process supervisor
- Persistence service

## Migration order

1. Define contracts and correctness criteria
2. Stand up Swift service and supervision (Bun becomes supervised legacy service)
3. Move persistence and basic workspace services
4. Move managed servers
5. Move Git and source transaction ownership
6. Move chat and provider orchestration
7. Move editing and application controllers
8. Remove legacy service and complete distribution

## Correctness rules

- Each state domain has exactly one authoritative writer.
- Transfer whole ownership boundaries; avoid dual writes.
- Every mutation carries operation ID + expected revision.
- Persist operation intent and recovery checkpoints.
- Acceptance exercises interrupted operations and restarts.

## What stays JavaScript

- TypeScript type checking, React prop extraction, Svelte/Babel transforms
- Framework-specific source stamping and build plugins
- Provider SDK integrations via thin Node adapters
- WebKit DOM observation and interaction
- User project dev servers (including Bun when required by project)

## Open questions

- ~~Exact provider integration boundary (native protocol vs SDK helper)~~ (LKM-98: SDK
  adapters, one supervised helper per session in the end state; see [providers](SWIFT-BACKEND-PROVIDERS.md))
- ~~Source parser helper contract and expected-content hashing~~ (LKM-96: proposals
  carry the SHA-256 of the bytes they were computed from; see [source](SWIFT-BACKEND-SOURCE.md))
- Persistence format migration strategy

## Links

- PM conversation: agent-os talk_to_project conversationId d52bdc53-9410-492c-9ecc-7f2e2ae5bad5
