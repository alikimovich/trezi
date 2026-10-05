# Swift-owned preferences (S03, first writer transfer)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-91, the preferences half of S03 in the [canonical plan](SWIFT-BACKEND-PLAN.md)
and [roadmap](SWIFT-BACKEND-ROADMAP.md). It is the first domain whose writer
moves: under the default launch (`TREZI_BACKEND_OWNER=swift`) the Swift service is
the only writer of `preferences.json`, through the [operation ledger](SWIFT-BACKEND-LEDGER.md).
Bun keeps the controllers that decide *what* to save and reads an acknowledged
snapshot. No other domain moves.

- `src/service/PreferencesFile.swift`: the v1 format. Insertion-ordered JSON over
  UTF-16 code units with `JSON.parse`/`JSON.stringify` semantics, validation, the
  temp → flush → rename → directory-sync write steps and their fault seam.
- `src/service/PreferencesOwner.swift`: the owner actor (import, reconcile,
  adopt, batches), the strict request frame and the ordered pipe inbox.
- `src/native/preferences-service.ts`: Bun's client (acknowledged reads, one
  batch at a time, no fallback). `src/native/preferences.ts`: the shared v1
  rules and the legacy Bun writer, which is now only the rollback owner.

## The domain, exactly

| Item | Location | Owner (swift launch) | Owner (legacy launch) |
| --- | --- | --- | --- |
| Values | `<profile>/preferences.json`, v1: `{"version":1,"values":{key: string \| null}}` | Swift service | Bun (`nativePreferences`) |
| Temp file | `<profile>/preferences.json.tmp` (0600), same name both owners use | Swift service | Bun |
| Intent, receipts, revision, checkpoint | `<profile>/service/ledger/`, domain `preferences`; checkpoint `{digest, format: "trezi-preferences-v1"}` | Swift service | never opened |
| Drafts | Settings sheet autosave draft, in Bun memory (`SheetAutosave`) | Bun | Bun |

The checkpoint holds only the SHA-256 of the file's bytes (or `absent`); the file
itself stays the single copy of the values and the rollback artifact. No store is
migrated and the file format does not change.

Format rules, identical in both owners (checked byte-for-byte by the tests):
keys start with `trezi:`/`trezi.` or the legacy prefix and are shorter than 200 UTF-16 code units;
values are `null` or strings of at most 2,000,000 code units. Invalid persisted
entries are dropped, unknown valid keys are kept, `null` is stored (it is not a
deletion), a legacy-prefixed key is kept and copied to its `trezi` name when that
is absent. A repeated JSON key keeps its first position and takes its last value.
Lone surrogates survive. A file that is not `version === 1` with an object
`values` is refused, as are a BOM and trailing garbage. A deliberate divergence:
the Swift reader refuses JSON nested deeper than 512 levels rather than risk its
stack, so such a file fails startup (untouched) where Bun would have accepted it.

## Callers (inventory at implementation time)

Every write is an awaited batch; nothing in Bun writes the file under the Swift
launch.

| Caller | Keys | Behavior |
| --- | --- | --- |
| `src/native/settings-controller.ts` | `preferred-model`, `project-ui:v1`, `project-ui-engine:v1`, `chat-workspace-idle-days:v1`, `activity-auto-open:v1`, `agent-file-access:v1` | One atomic batch, built from the committed state when sent (a newer last-used model is kept). Autosave keeps a failed draft; closing waits for the save. |
| `src/native/workspace-runtime.ts` | `preferred-model` (last used) | Batch computed from the committed state when sent; failure is reported. |
| `src/native/git-controller.ts` | `publish-mode` | Renders after the commit; storage does not change publishing. |
| `src/native/shell-controller.ts` | `chat-hidden` | The toggle is immediate; the save is awaited and a failure reported. |
| `src/native/index.ts` | `native-chat-width`, `native-panel-sizes` | Host layout events; range checks unchanged; failures go to the activity log. |

Reads (`get`/`snapshot`) come from the last acknowledged snapshot. The host still
receives values from Bun (`preferences`, `layoutWidth`, `layoutSizes`) as display
state; it has no preference capability over XPC, and neither does the preview.

## Protocol

Bun is a child of the service, so its requests use the private pipe, not XPC
(the application/service XPC boundary is unchanged). A Bun line beginning
`{"service":"preferences"` is taken by the service's pipe reader and never relayed
to the host. The frame wraps an S01 request:

`{"service":"preferences","id":n,"request":{connection, requestID, operationID, scope:{}, mode, expectedRevision?, service:"preferences", method, body}}`

- `snapshot` (`read`, empty body) → `{revision, digest, entries:[{key, value}]}`.
- `set` (`mutation`, `expectedRevision` required, body `{entries:[{key, value}]}`,
  1–256 entries) → `{revision, digest}`. The reply also carries the current
  snapshot, including on failure, so a conflict hands back what changed.
- Refused before anything is recorded: unknown or missing fields, a non-empty
  scope (`unauthorized`: preferences are global), a wrong method/mode pairing and
  any invalid key or value (`invalidRequest`).
- Identity is the operation ID; the intent digest covers the exact batch
  (UTF-16, order, null versus text). Same ID and batch returns the recorded
  receipt, a different batch is `idempotencyMismatch`.
- `preferences.changed` events are sent only for changes Bun did not make (an
  adopted external edit). Bun's own writes are answered by their replies.
- Requests are handled in the order Bun wrote them. Bun's client sends one batch
  at a time, each against the revision the previous one committed. A reply that
  does not arrive in 30 s rejects the batch; Bun never writes locally, and a late
  reply still moves its snapshot forward.

## Commit protocol

Inside the ledger's FIFO lane for `preferences`:
1. Re-read the file. A digest other than the checkpoint's is an external edit:
   the batch fails with `conflict`, then the file is adopted (below).
2. Build the next values, write the 0600 temp file and `F_FULLFSYNC` it. A
   failure here or at the rename is `ioFailure` (retryable), removes the temp
   file and consumes no revision.
3. `beginEffect(pending: {digest: target})`: the target digest is journaled with
   the effect record.
4. `rename`, then `fsync` the directory. A failed directory sync cannot undo a
   rename that readers already see, so the commit stands; if the rename did not
   persist, the next open adopts whatever the file holds.
5. Install the values, then the receipt carries the new checkpoint.

**Adoption.** At open, and whenever a batch finds an external edit, a file that
differs from the checkpoint and parses as v1 becomes a new revision (an internal
`adopt` operation). A file that does not parse is never replaced: the batch fails
`recoveryRequired` and the file stays untouched until it is fixed or removed.
This is how newer writes from the rollback owner are kept.

**Recovery.** After a crash, an `intent` is abandoned (never run later). An
`effect` without a receipt is reconciled against the file, never replayed: the
target digest means applied (committed at its reserved revision), the prior
checkpoint means not applied, anything else was superseded by an external edit
(failed `conflict`, and the file is adopted).

**Unavailable.** If the ledger cannot be opened (another owner holds it, or it is
damaged) or the file cannot be read as v1, every request answers
`recoveryRequired` and Bun's startup fails with that message. Nothing is written.

## Rollback (tightened to this domain)

- **Launch-time owner switch.** Quit Trezi, then relaunch with
  `TREZI_BACKEND_OWNER=legacy`. The service's `--legacy` owner never opens the
  ledger and Bun's `nativePreferences` reads the current `preferences.json` as
  it is. There is no hot switch: the exclusive profile lock admits one owner.
- **Stop and drain.** On quit the service lets Bun finish (its final events
  still reach the preferences owner), then stops accepting requests, lets
  accepted ones finish (bounded 2 s), and only then releases the ledger and the
  profile lock. A request refused while stopping answers `unavailable` and
  writes nothing; one cut off at exit is recovered from the ledger as above.
- **What is preserved.** The file is always the newest committed state, in the
  legacy format, so the rollback owner reads the newest Swift write exactly. The
  ledger directory stays in place (untouched by the legacy owner). Drafts live in
  Bun's memory and are unaffected by the owner; autosave keeps a failed draft.
  No worktree or other store is involved.
- **Returning to Swift.** The next Swift launch adopts whatever the legacy owner
  wrote as a new revision. An old backup is never restored over the file.
- **Reverting the code.** A pre-LKM-91 build reads the same v1 file as its own and
  ignores the ledger's `preferences` domain. The ledger `pending` field this adds is
  optional, so the pre-LKM-91 ledger code still decodes the journal.

## Verification

`test/preferences-owner.mjs` (unit tier) compiles the real Swift sources into a
fixture process and checks, against the legacy Bun owner on real files:
- Reader/writer parity: unknown keys, `null`, legacy-prefix copies, repeated keys,
  UTF-16 key/value boundaries (astral characters included), lone surrogates,
  invalid UTF-8, and the refused files. Written bytes are identical to Bun's.
- Import without writing, atomic batches, duplicate receipts, `idempotencyMismatch`,
  `conflict` with the current snapshot, two concurrent batches on one revision
  (exactly one commits), strict frame validation, restart and a closed owner.
- External edits conflict and are adopted; an invalid external file is left
  untouched; an unreadable file blocks the domain; a second owner cannot open it.
- Injected failures at temp create, write, flush and rename change nothing and
  the retry succeeds; a directory-sync failure keeps the visible commit.
- SIGKILL after intent, after the effect record, after the rename and after the
  receipt, then restart: reconciled from the file, never replayed. A crash after
  the rename followed by a legacy-owner write keeps the legacy write.
- Rollback: the legacy owner reads the newest Swift file; Swift adopts newer
  legacy writes without rewriting them and never restores an old backup.
- Bun's real client against the real owner: serialized batches, batches built
  from committed state, conflict and adoption notice, timeout with no local
  write, a late reply, and startup refusal for an invalid file.

`test/native-settings.mjs` adds a failed save that keeps its draft and a close
that waits for the retried save. `test/service-process.mjs` (full, unsandboxed)
sends a batch from the supervised backend through the real XPC service's pipe:
the legacy file is imported, the v1 file is written, and no service frame reaches
the host. `bun run test:native` launches the real app through this path.
