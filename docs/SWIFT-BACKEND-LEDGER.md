# Durable operation ledger (S03 substrate)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-90, step S03 of the [canonical plan](SWIFT-BACKEND-PLAN.md) and
[roadmap](SWIFT-BACKEND-ROADMAP.md). This adds the Swift service's persistent
operation intent, request digests and receipts, commit checkpoints, per-domain
revisions, event cursors and recovery queries. It transferred no domain writer itself. The first writer to use it is
preferences (LKM-91, [preferences](SWIFT-BACKEND-PREFERENCES.md)); the second is the
workspace (LKM-92, [workspace](SWIFT-BACKEND-WORKSPACE.md)); the third is project
memory (LKM-93, [memory](SWIFT-BACKEND-MEMORY.md)), with one domain `memory/<id>` per
project, registered on first use. Bun remains the writer of sessions and every
other store.

- `src/service/LedgerStore.swift`: file format, checksums, sync, compaction, damage handling.
- `src/service/OperationLedger.swift`: identity, admission, phases, recovery, events, retention.
- `src/service/LedgerMirror.swift`: consumer ordering rules (future UI/controller side).
- `src/service/ServiceRuntime.swift` opens the ledger once, at the first launch
  hello, after `ProfileExclusion` succeeds and before Bun starts.

## Storage layout

`<profile>/service/ledger/`:

| File | Content |
| --- | --- |
| `LOCK` | `flock` held by the opener. Never unlinked. A second opener gets `busy`. |
| `snapshot.json` | One line: `{format, generation, epoch, state}`. Replaced by temp file → `F_FULLFSYNC` → `rename` → directory `fsync`. |
| `journal.jsonl` | Header line `{kind:"header", format, generation, epoch}`, then records numbered `n = 1…`. Each record is appended and `F_FULLFSYNC`ed before it is acknowledged. |
| `quarantine/` | Byte-exact, synced copies of torn journals, written with `O_EXCL` before any repair. |

Every line is `<sha256 hex of the JSON> <JSON>\n`. `format` is
`trezi-ledger-1`. `state` holds the event head `sequence`, `domains`
(revision, checkpoint, `blockedBy`), `operations`, `expired` IDs and the
retained `events`. Record kinds are `domain`, `intent`, `effect`, `receipt` and
`uncertain`. An `effect` record may carry the owner's reconciliation note
(`checkpoint`, kept as the operation's optional `pending`; LKM-91), which older
readers ignore. Replay and live writes share one transition function
(`OperationLedger.apply`). A record that does not apply is corruption.

Compaction runs every 512 journal records, and at open after pruning. It writes
snapshot generation `G+1`; that rename is the commit point. A new journal with
header `G+1` follows. On open, a journal whose header generation is older than
the snapshot is superseded (every record is already in the snapshot) and is
replaced. A newer generation, a different epoch, or a journal without a
snapshot is corruption.

### Compatibility review

- The directory is new, and nothing reads it except the Swift service. Bun, the
  `--legacy` rollback owner and pre-S03 builds never open it. `service.lock`,
  `native.lock` and every existing store, journal, draft, receipt and worktree
  are unchanged.
- A snapshot or header with another `format` fails with `unsupportedFormat`, and
  its files are left untouched. An older build therefore never downgrades or
  rewrites a newer store.
- Revisions and cursors use the S01 wire DTOs (`ServiceRevision`,
  `ServiceCursor`, `ServiceEvent`, `ServiceSnapshot`, `ServiceFailure`) unchanged.
  No XPC selector, capability or control frame is added. Typed domain dispatch
  arrives with the first writer transfer.

## Semantics

**Identity.** The operation ID is the idempotency key; the request ID is one
attempt. The intent digest is SHA-256 over a canonical encoding of domain, mode,
service, method, scope, expected revision and body. Object keys are ordered by
UTF-8 bytes, strings are never normalized, and `-0 == 0`. Key order doesn't
count. Array order, null versus absence and Unicode spelling do. Connection,
request ID and timeout are excluded.

**Admission** (`perform`), in this order:
1. An operation must be a mutation with an expected revision.
2. Look up the ID. A known ID with the same digest returns its recorded operation.
   This is the stable outcome, including `busy` while it runs. A different digest
   is `idempotencyMismatch`, and an expired ID is `recoveryRequired`.
3. Acquire the domain's FIFO lane, then look up the ID again.
4. A domain blocked by an uncertain operation answers `recoveryRequired`, with
   `recoveryID` naming that operation.
5. A stale revision or epoch is a `conflict`, carrying `currentRevision`.
6. Persist the intent, which reserves counter + 1, then run the effect.

Identity comes before the revision check, so a retry of a successful operation
never conflicts with the revision that operation advanced.

**Serialization.** Swift actors are reentrant. The lane is held from admission
until the receipt, across every suspension inside the effect. Hand-off is direct
(FIFO), so commits in one domain never interleave.

**Phases and crash boundaries.**

| Durable boundary reached before the crash | After restart |
| --- | --- |
| none | Unknown ID; a retry executes normally |
| `intent` | `abandoned` (`unavailable`, retryable as a *new* operation); revision unchanged; never run later |
| `effect` (`beginEffect()` recorded) | `uncertain`; the domain is blocked; a same-ID retry is `recoveryRequired` |
| effect performed, no receipt | same as `effect` |
| `receipt` | the recorded result, whether or not the reply was delivered |

`beginEffect()` separates cancellable preparation from a non-idempotent effect.
An effect whose outcome is only the checkpoint needs no `beginEffect()`: its
checkpoint and receipt are one record. An error thrown after `beginEffect()` is
`uncertain`, unless it is `LedgerEffectError.notApplied`, which the owner uses
when it knows nothing happened. An uncertain operation is resolved only by
`reconcile(id, .applied | .notApplied)`, after the owner inspects the external
world. It is never replayed. If a journal write fails, memory takes the state a
restart would reach and the store refuses further writes until reopened.

**Cancellation.** Before the effect, `cancel` records `cancelled`; the
performer's `beginEffect()` throws and its late result is discarded. After the
effect it returns `tooLate`; for a settled operation, `finished`.

**Revisions.** Each domain has its own epoch (minted at registration) and
counter. `register` never reinitializes an existing domain from a caller's copy.

**Events and cursors.** The ledger epoch persists across restarts, so cursors
survive them. Each commit emits `operation.committed` with the next sequence,
committed revision, scope, result and checkpoint. The last 1,024 are retained.
`events(after:)` returns `snapshotRequired` for another epoch, a cursor ahead of
the head, or a gap older than the window. A snapshot reads revision, checkpoint
and cursor together, without suspending.

**Consumer rules** (`LedgerMirror`). State moves only by a snapshot or the next
event in sequence. A duplicate or late event, or an older snapshot, is `stale`.
A gap or foreign epoch is `snapshotRequired`. A reply never writes state: its
revision is either already reflected (`stale`) or ahead, meaning fetch deltas.
Local drafts are outside the mirror.

**Retention.** The advertised retry horizon is 7 days. Final operations older
than that become `expired` IDs, which answer `recoveryRequired`, never execute.
Beyond 4,096 retained operations the oldest expire earlier. The newest 65,536
expired IDs are remembered; a retry older than that is indistinguishable from a
new operation, so clients must not retry beyond the advertised horizon.
In-flight and uncertain operations are never pruned.

**Damage.**
- An *unterminated* final journal line was never acknowledged. It is copied to
  `quarantine/`, then truncated.
- Any other checksum, numbering, generation or apply failure refuses to open
  (`corrupt`) and leaves every file untouched. No automatic repair or fresh
  store follows, since a fresh store would forget receipts and execute
  duplicates.
- `quarantineLedgerStore(at:)` is the explicit operator/owner action. It moves
  the whole directory aside, and the next open starts a new epoch, so every old
  cursor needs a snapshot.
- In the service, a ledger that fails to open is reported on the diagnostics
  stream. Legacy Bun keeps running. A future ledger-backed domain must answer
  `recoveryRequired` while `ledger` is nil.

## Rollback

The domain affected by this step is `<profile>/service/ledger/` only.
- **Launch-time owner switch.** `TREZI_BACKEND_OWNER=legacy` runs the rollback
  owner. It never opens the ledger (tested) and leaves it in place for the next
  Swift launch.
- **Reverting the code.** A pre-S03 build ignores the directory. No existing
  store was migrated, so nothing needs restoring.
- **Stop/drain.** The ledger needs no drain: every acknowledged transition is
  already synced. The service releases the ledger before the profile lock.

## Adoption gate for the first writer (preferences)

Met by LKM-91 (see [preferences](SWIFT-BACKEND-PREFERENCES.md) for each item):
- Name the exact files (the v1 preferences store and its unknown keys and nulls).
- Import the newest legacy state as the domain's initial checkpoint, under the
  profile lock, with drafts untouched.
- Add typed XPC request/snapshot/event dispatch that uses this ledger.
- Stop and drain Bun's writer before the switch.
- Test legacy restoration from the *newest* Swift-written state, not a backup.
- Prove drain-and-restart restoration.

`TREZI_BACKEND_OWNER=legacy` and Bun's preferences writer remain the rollback
owners.

## Verification

`test/operation-ledger.mjs` (unit tier) compiles the real sources into a
line-driven fixture process and checks:
- Duplicate, mismatch, conflict and `notFound`, with receipts across restart.
- Digest canonicalization.
- SIGKILL injected at `intent`, `effect`, effect-performed and `receipt`, then
  restart, repeated restart, reconciliation and effect counts.
- Unplanned SIGKILLs at arbitrary times, after which the effect exists exactly
  when the ledger says committed.
- FIFO serialization across suspension, with one commit per revision.
- Cancel before the effect and too late, and effect-error classification.
- Event window, gaps, epochs, cursor restart and mirror ordering.
- Horizon expiry, compaction, and a crash between the snapshot rename and the
  journal reset.
- Lock contention, torn-tail repair, corruption refusal with untouched bytes,
  explicit quarantine, and newer-format refusal.

`test/service-process.mjs` additionally checks two things. The legacy owner
never creates the ledger. The real XPC service creates it at launch, and its
epoch survives a second service instance (full, unsandboxed run).
