# Swift-owned project memory; annotation storage split (S05)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-93, roadmap row S05 ("memory, annotations and attachments; Swift state
services") of the [canonical plan](SWIFT-BACKEND-PLAN.md) and
[roadmap](SWIFT-BACKEND-ROADMAP.md). This is the third writer transfer, after
[preferences](SWIFT-BACKEND-PREFERENCES.md) and [workspace](SWIFT-BACKEND-WORKSPACE.md).
Under the default launch (`TREZI_BACKEND_OWNER=swift`), the Swift service is the
only writer of project memory. It owns memory reads and writes, revisions, and the
ordering of manual saves against generated proposals, and it writes through the
[operation ledger](SWIFT-BACKEND-LEDGER.md). Model evaluation stays in Bun as a
bounded helper that can only *propose*. Annotation storage is split from
publication, but its writer stays in Bun. That sub-boundary is blocked on S07 (see
below). Attachments are not part of this task.

- `src/service/MemoryFile.swift`: the record, file identity, normalization and
  validity rules, and the session-store directory guard.
- `src/service/MemoryOwner.swift`: the owner actor (per-project domains,
  adoption, reconciliation, `read`/`save`/`propose`) and its reply frames.
- `src/main/project-memory.ts`: the same format and rules in TypeScript. It also
  holds the `ProjectMemoryStore` interface, the legacy Bun writer (now only the
  rollback owner), the per-project evaluation queue and the injection bookkeeping.
  Both owners must produce the same bytes.
- `src/native/project-memory-service.ts`: Bun's client for the Swift owner.
- `src/main/annotation-store.ts`: annotation storage (list/add/remove), separate
  from publication (`src/main/annotations.ts`, S13).

## The domain, exactly

| Item | Location | Owner (swift launch) | Owner (legacy launch) |
| --- | --- | --- | --- |
| Memory record `{"content","updatedAt"}` | `<profile>/trezi/project-memories/<sha256(projectKey(root))>.json` | Swift service | Bun (`createProjectMemoryStore`) |
| Temp file | `<id>.json.tmp` (Swift, 0600) / `<id>.json.<pid>.tmp` (Bun) | Swift service | Bun |
| Intent, receipts, revision, checkpoint | `<profile>/service/ledger/`, one domain `memory/<id>` per project; checkpoint `{digest, format: "trezi-project-memory-v1"}` | Swift service | never opened |
| Evaluation (model call, prompt, parse) | Bun provider backends (`src/main/backends/memory.ts`) | Bun helper: proposes only | Bun |
| Per-session "memory version already in context" | Bun memory (`createProjectMemoryInjection`) | Bun chat state (S11), keyed by the owner's digest | Bun |
| Editor draft (autosave) | Bun memory (`SheetAutosave`) | Bun, untouched by this domain | Bun |
| Annotations `.trezi/annotations.json` | inside the user's repository | **Swift** editing owner since S15 (hash-bound sidecar commit; `annotation-store.ts` renders), see [retirement](SWIFT-BACKEND-RETIREMENT.md) | Bun |

`<profile>/trezi` is the session store. It may be Bun's alias of an older
pre-rename store (`nativeSessionPath`). The service never creates `trezi`
beside one of those, so it cannot split the store in two. Bun resolves the alias
before its first memory request. The file format is unchanged and no store is
migrated. The checkpoint holds only a SHA-256 of the file's bytes (or `absent`).

## Rules (identical in both owners)

- **Identity.** The file ID is the hex SHA-256 of `projectKey(root)`, as before.
  Roots must be absolute, at most 4,096 UTF-16 units, with no lone surrogates.
- **Valid file.** Absent means empty (`content: ""`, `updatedAt: 0`, digest
  `absent`). A valid file is an object with a string `content` and a number
  `updatedAt`. Content is bounded to 16,000 UTF-16 units on read. A repeated key
  takes its last value.
- **Damaged file.** Anything else is damaged: invalid JSON, a BOM, trailing text,
  a wrong shape or wrong types. It is never read as empty and never replaced. That
  project answers `recoveryRequired`, and every other project keeps working. The
  pre-S05 reader read it as empty, so the next editor save or evaluation replaced
  it. Once the file is repaired or removed, it is adopted.
- **Stored value.** JS `trim()`, then `.slice(0, 16000)`, written as
  `JSON.stringify({content, updatedAt})`. `updatedAt` is the owner's `Date.now()`.
  A save whose normalized content equals the stored content writes nothing. The
  pre-S05 writer rewrote the timestamp, which re-injected unchanged memory.
- **Manual versus generated.** `save` is the editor's manual save, the user's
  final override. It may clear memory. `propose` is an evaluation result. It must
  be non-empty and can never erase memory. Both commit only on the revision named
  in `expectedRevision`. In the legacy owner, `propose` commits only on the digest
  it was evaluated against. As a result:
  - A proposal evaluated before a manual save, an adopted external edit or another
    proposal is refused (`conflict`). The Bun queue re-evaluates once against the
    newer memory, and a failed or malformed evaluation is a no-op.
  - A manual save that loses a race is an intent: Bun's client retries it on the
    newer revision, at most twice. The user's text wins.
  - Of two operations sent on the same revision, exactly one commits, whichever
    arrives first. Whatever the order, the manual text is never lost.
- **Injection.** Memory is part of a new session's instructions. The session
  records the digest it carries. If a later turn finds a different digest, the new
  memory (or "memory is now empty") is injected once. Memory that cannot be read is
  treated as no memory. It never fails a chat or a turn, and the session records
  no digest, so memory is injected once it can be read.

## Protocol

Bun uses the private pipe (lines beginning `{"service":"memory"`, never relayed to
the host). The S01 request is wrapped as for workspace:

`{"service":"memory","id":n,"request":{connection, requestID, operationID, scope:{}, mode, expectedRevision?, service:"memory", method, body}}`

- `read {root}` (`read`) → `{revision, digest, content, updatedAt}`. It registers
  the project's domain on first use, reconciles a cut-off write and adopts an
  external edit first.
- `save {root, content}` and `propose {root, content}` (`mutation`, required
  `expectedRevision`) → `{revision, digest, updatedAt, changed}`. A mutation reply
  also carries the committed record as `snapshot`, failures included when readable.
- Refused before anything is recorded: unknown or missing fields, a scoped request
  (`unauthorized`), a wrong method/mode pairing, the internal `adopt`, a relative or
  oversized root, content over 64,000 units, and an empty proposal
  (`invalidRequest`).
- Identity is the operation ID; the intent digest covers the exact body. The same
  ID with the same body returns the recorded receipt. The same ID with a different
  body is `idempotencyMismatch`.
- Bun's client reads fresh on every call; there is no cache that could hide an
  external edit. Requests go one at a time. A reply that does not arrive within
  30 s rejects, and Bun never writes the file itself. The editor then keeps its
  draft and says so. There are no events.

## Commit protocol, adoption and recovery

These follow the workspace protocol, in each project's own FIFO lane:

1. Re-read the file. If its digest is not the checkpoint's, it was edited
   externally: the operation fails `conflict` and the file is adopted as a new
   revision. A damaged file fails `recoveryRequired` and stays untouched.
2. If nothing changes, commit without writing.
3. Otherwise make sure `project-memories/` exists, then write the 0600 temp file
   and `F_FULLFSYNC` it. Call `beginEffect`; the pending record journals the target
   digest and the answer.
4. `rename`, sync the directory, record the receipt.

A failure before the rename is `ioFailure` (retryable): the temp file is removed
and no revision is consumed. After a crash, an `intent` is abandoned. An `effect`
without a receipt is reconciled against the file, never replayed. The target
digest means it committed, and the journaled answer is returned. The prior
checkpoint means it did not happen. Anything else means it was superseded by
another owner's write, which is adopted as-is.

## Annotations: storage split from publication; writer blocked on S07

Reviewer notes live in `<repo>/.trezi/annotations.json`, inside the user's
repository and working tree. The roadmap keeps annotation sidecars legacy-owned
until S07's repository lane can serialize sidecar writes with Git. Publication
runs `checkout`/`add -- .trezi`/`commit` on the same tree. Moving the writer to
Swift before that would create a second, unserialized repository writer. This
task therefore does not move the writer. It does the S05 part that needs no
repository lane:

- **Split.** `annotation-store.ts` owns list/add/remove and imports no Git or
  publication code. `annotations.ts` keeps publication and only reads the notes.
  Publication stops before any Git mutation if the notes file is damaged.
- **CRUD parity.** Same file, pretty JSON with a trailing newline, the same
  fields, 2,000-character notes, empty notes ignored. Operations are now serialized
  per project, reads included. Entries the store does not understand are kept on
  write. Removing an unknown ID writes nothing.
- **Damaged file.** Anything but a JSON array is refused and left untouched. The
  pre-S05 reader read it as empty, and the next note overwrote every earlier one.
- **Stale responses.** The native context controller numbers its note reads per
  project and applies only the newest. A list that finishes late (from activation,
  or an earlier add/remove) can no longer replace a newer list or its preview pins.

(Done in S15, LKM-102: the editing owner commits the notes hash-bound in the repository
lane; see [retirement](SWIFT-BACKEND-RETIREMENT.md).) The remaining S05 annotation work — the Swift writer through the S07 repository
lane — is recorded in `docs/TASKS.md` and must land before S15.

## Rollback (tightened to this domain)

- **Launch-time switch only.** Quit Trezi, then relaunch with
  `TREZI_BACKEND_OWNER=legacy`. The service's `--legacy` owner never opens the
  ledger. Bun's `createProjectMemoryStore` reads the current files as they are.
  The exclusive profile lock admits one owner, so there is no hot switch.
- **Stop and drain.** On quit the service lets Bun finish, then stops accepting
  memory requests. Accepted requests may finish (bounded to 2 s), and only then are
  the ledger and the profile lock released. A request refused while stopping
  answers `unavailable` and writes nothing; the editor keeps its draft. One cut off
  at exit is recovered from the ledger as above.
- **What is preserved.** Each file always holds the newest committed memory in the
  pre-S05 format, so the rollback owner, or a pre-LKM-93 build, reads the newest
  Swift write exactly. The ledger directory stays in place and the legacy owner
  does not touch it. Drafts and injection state live in Bun memory. This domain
  touches no worktree, repository, `.trezi/` sidecar, session record or receipt of
  another domain.
- **Returning to Swift.** The next Swift read adopts whatever the legacy owner
  wrote as a new revision, without rewriting it. An old version is never restored
  over a newer file.
- **Reverting the code.** A pre-LKM-93 build reads the same files and ignores the
  ledger's `memory/…` domains. It reads a damaged file as empty and would replace
  it on the next save, as it always did. Nothing it cannot read is written.

## Verification

`test/memory-owner.mjs` (unit tier) compiles the real Swift sources into a fixture
process and checks them against the legacy Bun writer on real files:
- **Parity.** File IDs (trailing slashes, backslashes, whitespace, non-ASCII),
  stored bytes (Unicode, lone surrogates, control characters, over-long and
  padded content) and reader verdicts for 14 valid, bounded and damaged files.
- **Owner behavior.** Import without writing, legacy bytes, receipts,
  `idempotencyMismatch`, stale revision with the current snapshot, a no-op that
  writes nothing, isolated projects, and no temp files left.
- **Ordering.** A stale proposal is refused and the manual save is kept. A current
  proposal commits. An empty proposal is refused, while a manual save may clear
  memory. A proposal and a save raced on one revision, in both orders: exactly one
  commits.
- **Strict frames**, **damaged and external files** (refused and untouched, repair
  adopted, an external edit or removal adopted and never overwritten), and the
  **session-store guard** (refused beside a legacy store, written through its
  alias, created on a fresh profile).
- **Interrupted persistence.** Injected failures at temp create, write, flush and
  rename change nothing, and the retry succeeds. A directory-sync failure keeps
  the visible commit. SIGKILL after the intent, the effect record, the rename and
  the receipt is each reconciled from the file and answered from the receipt,
  never replayed. A crash after the rename followed by a legacy write keeps the
  legacy write.
- **Restart and rollback.** A service restart keeps content, revision and
  receipts. The legacy owner reads the newest Swift file. Swift adopts a newer
  legacy write without rewriting it and never restores an old version.
- **Bun's client, the queue and the editor against the real owner.** A manual
  save during an evaluation forces one re-evaluation that merges on top of it. A
  stale proposal resolves `null`. A failed evaluation is a no-op. A manual save
  after an external edit wins. A timeout writes nothing locally. A failed autosave
  keeps the draft, says so, and saves it when the sheet is closed. A damaged file
  refuses to open in the editor and survives evaluation.

`test/project-memory.mjs` covers the legacy writer (format, bounds, stale
proposals, damaged files kept, nothing written into a project) and injection:
once per change, per session, and never failing a chat. `test/annotation-store.mjs`
covers note CRUD parity, serialized writes, kept unknown entries and damaged files
kept. It also checks for no Git side effect: no commit, branch, staged change or
stash, and only the sidecar changes. `test/native-context.mjs` checks that
out-of-order note responses keep the newest list and pins. `test/service-process.mjs`
builds the real service executable with the memory owner.
