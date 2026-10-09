# First Swift backend slice and ordered follow-ups

LKM-84 review proposal, 2026-09-27. This is an implementation breakdown, not new
tickets or authorization to execute migration work in this documentation issue.
See the [audit](SWIFT-BACKEND-AUDIT.md) and [contracts](SWIFT-BACKEND-CONTRACTS.md).

## LKM-88 implementation reconciliation (2026-09-28)

The [15-step roadmap](SWIFT-BACKEND-ROADMAP.md) now assigns every audited module,
route and event to an implementation task and future owner. Its foundation-first
order supersedes the alternative breakdown below. The contract ownership section
has been reconciled to the canonical separate-service/XPC boundary. The remaining
experiment text is historical review material, not instructions for implementation
or permission to skip durable intent. S01 transfers no domain writer.

## Relationship to the canonical migration plan

The [canonical migration plan](SWIFT-BACKEND-PLAN.md) remains authoritative.
It specifies a separate Swift service process, XPC, Swift supervision
of the legacy Bun service, and persisted operation intent/recovery checkpoints.
This audit-specific document preserves the bounded-slice analysis and alternatives
for review; it does not replace that plan or mark a migration phase complete.

Preferences is the recommended first **state domain** after the canonical service,
supervision and correctness foundations. The host-local service, retained Bun
launcher, and in-memory-only operation ledger described below are an alternative
staging experiment, not approved exceptions to those foundations. Under the
canonical sequence, expose the same preference protocol from the Swift service
via XPC, use its supervisor/profile ownership, and persist operation intent and
recovery checkpoints before transferring the writer. Keep the existing v1
preference payload compatible; any separate ledger format requires its own review.
The no-ledger restart checks below describe the experiment's limitations, not
acceptance evidence for canonical crash recovery.

The ordered breakdown below is an audit dependency analysis. Its preference-first
and deferred-ledger/launcher ordering is retained as a review alternative only;
implementation follows the canonical foundation-first order unless that plan is
explicitly revised. All domain acceptance checks and rollback protections remain
applicable. No implementation or product-policy change is made here.

## Reading the preserved audit and contract snapshots

The candidate's [ownership audit](SWIFT-BACKEND-AUDIT.md) and
[contract proposal](SWIFT-BACKEND-CONTRACTS.md) retain their audit/design material alongside
[the canonical plan](SWIFT-BACKEND-PLAN.md). Read this companion for the detailed
first-slice analysis and compatibility qualifications: the audit's existing
“first slice and follow-ups” link leads to the canonical phase plan, while the
detailed candidate comparison, failure injection and rollback live below.
The audit and its alternatives remain review material; no migration, storage
change, automatic merge or worktree removal is authorized by these documents.

The contracts' “Ownership and transport” section now adopts the canonical
separate Swift service/XPC boundary; the host-local/direct-call/pipe-first
experiment below is superseded for implementation. Typed service interfaces,
scope, errors, revisions and operation semantics apply to either transport.
With XPC, put these interfaces behind an explicit connection endpoint, validate
decoded DTOs and peer identity, and handle connection invalidation using the
contracts' snapshot/operation recovery rules. Swift supervises legacy Bun and
narrow helpers; private pipes may still serve those helper boundaries.

The first slice's reduced guarantees below refer only to the
staging experiment in this companion. It does not relax the canonical plan's
persisted intent, recovery checkpoints or single-writer requirements. The
canonical prerequisites and the alternative's deferred supervision/durable ledger
are distinguished above; no alternative is approved by retaining it for review.

## Compare dependency closure before choosing

| Candidate | Required closure | Validation value / reason for order |
| --- | --- | --- |
| Native preferences | `nativePreferences`, index startup/layout handlers, settings/shell/Git/workspace preference callers, Swift bridge and preference consumers | Small durable state domain with real UI callers, no SDK/Git/source writes; proves single writer, validation, optimistic concurrency and bridge failure. Recommended first. |
| Project memory | Store + automatic evaluation queue + provider context injection + native autosave + session revision tracking | Attractive bounded store, but manual-vs-model ordering and in-flight evaluations cross agent/SDK boundaries. Follow preferences after contract/cancellation foundation. |
| Source read/file tree | Filesystem/path/media and editor-controller | Useful trust-boundary test, but reads alone do not prove durable ownership; source save/Undo greatly expands closure into parsers, transactions and drafts. |
| Annotations | Note store, preview pins/context and annotation module's publish functions | Small CRUD surface but currently colocated with remote/Git publication. Separation prerequisite; does not justify pulling publication into first slice. |
| Managed dev server | Runtime detection, selected package manager, readiness, shell/process groups, static server/watch/SSE, shutdown, workspace recovery | Excellent lifecycle proof, but broad failure surface and runtime fixtures. Second major infrastructure slice after small state ownership succeeds. |
| Chat/worktree landing | Providers, controllers, transcripts, repository queue, recovery, Undo, tools, preview, dependency refresh | Highest product value and risk. First extracting it would combine reentrancy, non-atomic filesystem/Git changes and provider behavior; defer until explicit policy and recovery prerequisites pass. |

Preferences proves a representative durable transition, not transactional Git,
provider parity, crash-safe streaming or complete helper isolation. Success must
not be used to infer those later properties.

## Bounded first target: Swift-owned native preferences

Current implementation is only 31 lines:
[preferences.ts:3](../src/native/preferences.ts#L3) reads version-1
`preferences.json`, accepts legacy-prefixed names shorter than 200 characters,
string values at most 2,000,000 characters or null, and writes mode-0600 temp file
then renames. Unknown valid keys are retained; invalid persisted entries are
filtered; malformed/version-mismatched files throw. Preserve those behaviors and
UTF-16-compatible length checks for JS parity. Null and absent keys must remain
distinct in storage despite `get` returning null for both.

Scope includes all preference writes, not just layout. Known callers:

- [index.ts:238](../src/native/index.ts#L238): layout width/panel sizes;
  startup snapshot feeds Swift preferences/layout and controller preferred model.
- [settings-controller.ts:30](../src/native/settings-controller.ts#L30): preferred
  model, project-UI opt-in and composition engine, through SheetAutosave.
- [workspace-runtime.ts:36](../src/native/workspace-runtime.ts#L36): last-used model.
- [git-controller.ts:15](../src/native/git-controller.ts#L15): publish-mode value.
- [shell-controller.ts:43](../src/native/shell-controller.ts#L43): chat-hidden state.

Changing where publish-mode is stored does not authorize or alter publishing.
No workspace/history/provider/memory/source storage transfers in this slice.

### Prerequisites and touched components

1. Introduce shared versioned preference DTO/schema and golden JSON fixtures,
   a typed Swift service protocol/actor and Bun compatibility adapter. A dedicated
   Swift file keeps persistence off MainActor and below the repository size limit.
2. Extend `bridge.ts`/Host dispatch with typed request/reply and preference
   snapshot/change handling in both directions. Swift currently sends events and
   Bun initiates numbered requests; do not assume a symmetric RPC exists.
3. Retain Bun's existing profile lock/launcher and pass the selected profile path
   through a trusted startup argument, never through preview or provider inputs.
   Explicitly choose `bun` or `swift` ownership before writable initialization.
   Unsupported handshake fails startup; it must not silently activate two writers.
4. Inventory every `nativePreferences` consumer again at implementation time.
   Convert mutations to awaited adapter calls; acknowledged snapshot supplies
   synchronous read-only getters. Avoid optimistic success before disk commit.
   Move width/panel validation into Swift while preserving existing bounds.
5. Settings sends one atomic preference batch, with SheetAutosave still retaining
   failed drafts. Close/navigation waits for the latest acknowledgement. Preserve
   last-used/fixed model semantics in shared model-choice logic.
6. Build/test wiring in `scripts/build-native.mjs`, `test/run.mjs` and focused
   native tests; add fixtures only to deterministic tiers, no paid provider calls.

### Ownership and commit protocol

Only the selected owner opens `preferences.json` writable. Swift reads legacy v1
in place, preserves valid unknown entries and writes the same format. Bun's
adapter cannot fall back to local writes after a timeout. Before acknowledging,
Swift validates the batch/revision, writes a same-directory temporary file with
0600 mode, flushes it, replaces the destination, and publishes the new snapshot.
Design the filesystem error seam so each step can be injected in tests. Do not
claim power-loss durability beyond what the chosen platform flush/rename sequence
and tests establish.

Use a service-epoch counter revision for in-process ordering plus a digest of the
canonical file content in snapshots. The actor retains operation ID/request digest
and result for its lifetime; duplicate IDs return the same result. No separate
persistent ledger or new file schema in this first slice. After service restart,
all clients must resnapshot before writing: expected epoch mismatch prevents
blind replay. For an uncertain old write, compare the snapshot with the intended
values, report applied/current/conflicting state, and only submit a new explicit
revision-checked set if still needed. Setting a value is naturally idempotent;
that does not prove exactly-once durable request execution across restarts.

An external file change detected against the loaded digest yields conflict and a
new read, preserving the draft. The profile lock remains the supported writer
exclusion mechanism; arbitrary external writes cannot be made transactionally
safe by a hash check alone. A future general operation ledger is a separate slice.
The preference actor commits without suspension between revision validation and
ordered file replacement, or uses an explicit internal write queue if asynchronous
I/O is chosen. Actor isolation alone is insufficient across an await.

### Acceptance and failure injection

| Check | Required observable result |
| --- | --- |
| Existing v1 file, absent file, explicit null, unknown valid key, invalid key/value, Unicode length boundary | Swift and existing Bun fixture readers agree; no profile migration or silent corrupt-file replacement. |
| Layout, hide/show, model preference, composition settings, publish-mode across relaunch | Values round-trip unchanged; no real publish, provider turn or project server needed. |
| Two concurrent batches with same revision; repeated operation with identical/different payload | One accepted revision; conflict for stale batch; stable duplicate receipt; mismatched ID payload rejected. |
| Inject failure before temp creation, during write/flush, before rename | Prior committed file remains valid; no success event; original draft remains and retry is available. |
| Kill after rename before acknowledgement | Restart snapshot reveals actual committed values; uncertain request is not blindly replayed. |
| Reorder/duplicate/drop events; timeout; old epoch response | Consumer uses revision/snapshot, retains newer draft and never enables Bun fallback writer. |
| Close Settings during pending save; disk-full or read-only profile | Close awaits latest result; failed draft remains visible/retryable. No empty-value substitution. |
| Bun/Swift restart and profile-lock contention | Exactly one selected owner; no second app opens writable profile; failed negotiation explains failure. |
| Forged preview request, oversized payload, invalid profile/path field | Reject before write; preview has no preference capability. |
| Roll back to Bun owner on same fixture profile | Legacy file reads exactly; all current preferences preserved; no conversion required. |

Run full and native typechecks, fixture unit checks, docs links, focused native
preferences/settings/shell/workspace tests and `bun run test:native`. Inspect
native screenshots for affected settings/layout behavior. Deterministic checks
must distinguish SKIP from PASS; report pointer/older-OS limits explicitly.

### Rollback

A launch-only developer switch chooses the owner; do not hot-switch during writes.
Stop accepting preference mutations, drain or report uncertain operations, close
the process, then restart the prior build/Bun owner under the profile lock. The
unchanged v1 file is the rollback artifact; keep a pre-slice fixture copy for
comparison but never overwrite newer user preferences with it automatically.
If Swift cannot decode existing data, abort takeover with the original file
untouched. Do not silently create defaults, discard drafts, or write from both
implementations. Revert implementation code without resetting project worktrees.

## Ordered follow-up breakdown

Each item needs its own reviewed implementation scope and deterministic exit
checks; no tickets are created here.

1. **Contract fixtures and preferences slice.** Implement the above ownership
   transfer, symmetric adapter and revision/error behavior. Exit: fixture parity,
   single-writer and injected-failure/rollback checks pass.
2. **General operations/snapshot substrate.** Add durable operation ledger and
   consistent cursor snapshots for domains that need restart recovery. Decide and
   review storage layout/migration separately. Test kill at every commit phase,
   duplicate/late/cancelled requests and snapshot gaps before adopting it broadly.
3. **Memory and annotation state.** Swift owns manual/automatic memory revisions,
   injection and proposal acceptance; isolate annotations from publishing. Keep
   model evaluation helper-only. Exit: concurrent manual save wins, corrupt stores
   preserved, no Git leakage, explicit note CRUD and autosave retry parity.
4. **Managed runtime lifecycle.** Swift supervises project-selected commands,
   dependency installs, static HTTP/watch and process groups; transfers shutdown
   ownership as one unit. Exit: descendant survives shell exit then is killed,
   repeated signals, port conflict, failed readiness/restart, static traversal and
   cleanup checks. No manual target dev process or unowned server adoption.
5. **Source service and parser helper seam.** Transfer canonical paths, baselines,
   source transaction/Undo and drafts first; parser workers return proposals only.
   Exit: external edit/symlink/schema failure, grouped Undo, cancelled parse,
   out-of-order result and partial multi-file write recovery; no draft loss.
6. **Repository policy and recovery prerequisite.** Review explicit intent for
   landing/reconciliation/cleanup before porting current automatic paths. Specify
   journal, common-directory serialization, private index, recovery refs and
   explicit removal policy. Exit: competing chats, external Git/index mutations,
   process death and uncertain state retain recoverable work; no auto merge/removal.
7. **Conversation and provider helpers.** Move turn/spawn queues, permissions,
   terminal deduplication, transcripts/model handoff, titles and completion policy
   to Swift; SDK adapters retain harness details. Prove enforced helper privileges,
   cancellation escalation, image transport and tool scope before claiming isolation.
   Real-provider validation is separately authorized, never implied by unit fixtures.
8. **Controls/content/composition and preview orchestration.** Transfer manifests,
   revisions/gestures, pending activation and deferred navigation onto Source and
   Conversation; retain isolated DOM JS and bounded recipe/compiler helpers.
   Exit: next-turn/later-revision isolation, HMR, draft preservation, grouped
   Undo/replay, stale document/turn rejection and unavailable-helper recovery.
9. **Publishing, Git remote actions, setup, diagnostics and updates.** Move policy
   and journals to Swift; gate network/mutation intent; preserve partial failure
   receipts and existing project runtimes. Exit: simulated remote side-effect then
   lost reply, install/build failure and recoverable conflict; no automatic retry
   that duplicates a PR/merge or discards work.
10. **Simulator, media and launcher consolidation.** Complete platform process
    ownership, scoped media transport, build/install packaging and Swift lifecycle
    parentage; remove Bun orchestration only after all route/event/lifecycle census
    rows have an owner and evidence. Verify simulator and supported macOS versions
    separately. Keep Node/JS SDK/compiler helpers and preview instrumentation.

## Validation for this documentation issue

Baseline: local candidate HEAD `94b6dd6`; line references describe that source.
No source/runtime files changed. The route/module/event appendices are static
snapshots and must be regenerated/reconciled as implementation changes.

- Configured full/native typechecks and native-runtime command: passed, including
  native build and direct-host-launch guard. The command emitted no smoke-completion
  marker and produced no native PNG artifacts in this sandbox; full desktop smoke
  coverage is therefore unconfirmed despite exit 0. No visual parity claim.
- Documentation link check passed. Source-link/line bounds and census counts were
  independently checked. Focused preference/sheet/workspace/shell unit results are
  recorded in the worker report.
- Additional `bun test/native-boundary.mjs` failed on the pre-existing undeclared
  `@modelcontextprotocol/sdk/client/index.js` runtime dependency, also reported in
  the 2026-09-25 progress entry; no dependency/runtime edits are in this issue.
- No real provider, publishing, update-pull or migration parity validation.
