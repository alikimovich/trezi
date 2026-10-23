# Swift source transactions, file operations, Undo and parser proposals (S08/S09)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-96, roadmap rows S08 ("Source transactions, file tree, media reads, drafts and
Undo") and S09 ("Parser/source-edit helper extraction") of the
[canonical plan](SWIFT-BACKEND-PLAN.md) and [roadmap](SWIFT-BACKEND-ROADMAP.md). It
follows [repository](SWIFT-BACKEND-REPOSITORY.md). Under the default launch
(`TREZI_BACKEND_OWNER=swift`) the Swift service is the only writer of a user's source
files for Trezi's own edits. Bun's parsers compute edits and hand them over as
proposals; they cannot commit files or hold Undo state.

- `src/service/SourceOwner.swift`: requests, validation, deadlines, lanes, drain.
- `src/service/SourceStore.swift`: hash-bound multi-file transactions, Undo/redo/revert
  over them, create/rename/delete.
- `src/service/SourceJournal.swift`: the transaction journal and crash rollback.
- `src/service/SourceHistory.swift`: grouped Undo stacks (twin of `edit-history.ts`).
- `src/service/SourcePaths.swift`: path authorization and atomic byte-exact file I/O.
- `src/service/SourceDrafts.swift`: persisted unsaved editor drafts.
- `src/native/source-service.ts`: Bun's client. `src/main/source-owner.ts` is the
  seam; `src/main/source-commit.ts` (`proposeEdit`) is the only call that commits a
  parser's result. `edit-history.ts` and `file-ops.ts` dispatch to the owner when it is
  installed and are the rollback owner when it is not.

## The domain, exactly

| Item | Owner (swift launch) | Owner (legacy launch) |
| --- | --- | --- |
| Prop, text, style, move, island, content and control edits (`commitEdit`/`proposeEdit`) | Swift commits Bun's proposal | Bun writes |
| Code editor saves (`source:write`) | Swift, bound to the hash issued with the read | Bun, compared to the baseline |
| Source reads for the editor (`source:read` text) | Swift (authorized path, hash) | Bun |
| File tree create/rename/delete | Swift | Bun (`file-ops.ts`) |
| Undo/redo/revert history, landed chat turns recorded into it | Swift (service lifetime) | Bun (process lifetime) |
| Unsaved editor drafts | Swift, `<profile>/service/source/drafts/` | Bun memory only (as before) |
| Transaction journal, recovery reports `<profile>/service/source/{journal,recovered}` | Swift | untouched |
| Parsing, schemas, Tailwind/token mapping, splice computation | Bun JS helpers (read-only) | Bun |
| File tree listing, media (`trezi-media://`), component resolution, open in editor | Bun, read-only | Bun |
| Sidecar stores (`.trezi/control-panels.json`, `content-controls.json`, `tokens.json`, annotations) | Bun, inside the repository lease | Bun |
| Setup/scaffold instrumentation writers (`setup.ts`, `scaffold.ts`) | Bun, inside the repository lease (S13) | Bun |

## Rules

- **Proposals.** A proposal is `{path, expectedHash, content}`: the SHA-256 of the exact
  bytes the parser read, and the new text. The owner commits only if every file still
  holds its expected bytes, so an external edit, a stale or out-of-order parse and a
  second proposal from the same read are refused (`{ok:false, conflict:true, file}`)
  with nothing written. Bun reports that as "The file changed since it was read".
- **Cancellation.** A lane write carries `timeoutMilliseconds` (Bun's own deadline); the
  owner refuses to start one whose deadline passed while it waited (`deadlineExceeded`),
  so a proposal Bun gave up on is never committed later. Bun waits 5 s longer than the
  deadline for that answer.
- **Schema.** Unknown or missing fields, a revision, a scope, a malformed hash, duplicate
  (or aliased) paths in one batch, NUL, lone surrogates and oversized content (16 MiB
  per batch) are refused before anything runs.
- **Paths.** A path is repo-relative or absolute under the project root. It must not
  traverse, and must not lie in `.git`, `.trezi` (or a legacy metadata folder) or `node_modules`.
  After every symlink is resolved the file (and, for a new file, its deepest existing
  folder) must be inside the resolved root. A link to another project file writes that
  file and stays a link; a link out of the project is refused (`unauthorized`).
- **Transactions.** All files are checked before any is written; pre-images and the
  entry are journaled and synced first; each file is replaced atomically (temporary
  file, `fsync`, `rename`, permissions kept). A write failing midway puts back the files
  already written and answers `ioFailure`.
- **Crash recovery.** At launch every leftover entry is rolled back file by file: a file
  that still holds the transaction's bytes gets its pre-image back; one that was never
  written is left; one someone changed since is **kept as it is** and its pre-image is
  copied to `recovered/<operation>/files/`. Nothing newer is overwritten. `status`
  lists the reports (Bun shows them in the Activity log); `acknowledge {operationID,
  intent:"acknowledge"}` forgets a report and keeps the copies. An unreadable entry is
  left as found and commits are refused `recoveryRequired` (file operations still work).
- **Undo.** Same model as `edit-history.ts`: per resolved project root, 500 ms
  coalescing per key (a gesture coalesces until it ends), groups undone as one step,
  addressable revert of a chat turn, all-or-nothing drift refusal. Undo, redo and
  revert are transactions, so an interrupted one is rolled back like any other. A batch
  that wrote one file twice now undoes cleanly (the legacy history refused it). A
  landed turn with a binary file (NUL bytes) is not recorded, so it cannot be reverted;
  the legacy history recorded it as lossy text and a revert corrupted the file.
- **Serialization.** Every write runs in the repository coordinator's lane for the
  file's repository, or inside a lease the calling Bun chain holds, so source writes are
  ordered with every Git effect and with sidecar writers. A proposal made while another
  chain holds the lane (a dependency install) waits for it.
- **Drafts.** A draft is `{path, base (hash), text}`. The editor saves it (debounced)
  while dirty and clears it on save, reload, rename or delete. After a restart it is
  restored; if the file changed meanwhile it opens as a conflict, and saving it is
  refused because it is bound to its own base. A damaged drafts file is refused, never
  overwritten.

## Protocol

Private pipe, S01 frames, no revision, empty scope:
`{"service":"source","id":n,"request":{…,"service":"source","method",…}}`. Lane writes
take an optional `leases` array.

| Method | Mode | Body | Result |
| --- | --- | --- | --- |
| `read` | read | `{root, path}` | `{path, size, binary, hash?, content?}` |
| `commit` | mutation | `{root, edits:[{path, expectedHash, content}], key?, group?, gesture?}` | `{ok, files, hashes}` / `{ok:false, conflict, file}` |
| `record` | mutation | `{root, edits:[{path, before, after}], key?, group?}` | `{recorded}` |
| `undo` / `redo` | mutation | `{root}` | `{ok, empty?, conflict?, file?}` |
| `revert` | mutation | `{root, group, intent:"revert"}` | as `undo` |
| `history` / `canRevert` | read | `{root}` / `{root, group}` | `{undo, redo}` / `{revertable}` |
| `clearHistory` | mutation | `{root}` | `{}` |
| `createFile` / `renameFile` / `deleteFile` | mutation | `{root, path}` / `{root, path, to}` / `{root, path, intent:"trash"}` | `{ok, path?, error?}` |
| `drafts` / `saveDraft` / `clearDraft` | read / mutation | `{root}` / `{root, path, base, text}` / `{root, path}` | `[{path, base, text, current}]` / `{}` |
| `status` / `acknowledge` | read / mutation | `{}` / `{operationID, intent}` | `{interrupted, journal?}` / `{}` |

## Rollback (tightened to this domain)

- **Launch-time switch only.** Quit, relaunch with `TREZI_BACKEND_OWNER=legacy`; the
  profile lock admits one owner and no source writer is hot-switched.
- **Drain before switching.** At quit, after Bun has exited, the service refuses new
  source requests, then closes the repository coordinator (a source write queued
  behind a released lease answers "stopping" instead of starting), then waits
  (bounded, 5 s) for a write already running. One cut short is rolled back from its
  journal at the next Swift launch.
- **What is preserved.** Source files are ordinary files in place; the legacy owner
  continues on whatever the Swift owner wrote (tested). The journal, recovery reports
  and drafts under `<profile>/service/source/` are never read or written by the legacy
  owner, and are still there when Swift returns (tested). Undo history lives for the
  owning process in both launches, as before.
- **Reverting the code.** A pre-LKM-96 build ignores `service/source/`; saved drafts can
  be read there as JSON and recovered pre-images under `recovered/`.

## Verification

`test/source-owner.mjs` (unit tier) compiles the real owners into a fixture
(`test/fixtures/source-owner/main.swift`, `SOURCE_FAULT=<point>` SIGKILLs inside a
transaction) and drives them through Bun's clients and the unchanged TS engines:
- **parity:** the real `propedit-app` (React props, text, inline style), `svelte-app`
  (props, text), `editable-app` (HTML text) and `layers-app` (move) fixtures are edited,
  undone and redone by the legacy owner and the Swift owner with identical results and
  identical bytes after every step; `shadow-controls` (islands, Styles, Undo) re-runs
  unchanged with the Swift owner installed (since LKM-111
  `test/helpers/with-service-owners.mjs`, the only owner; the legacy side is history);
- **proposals:** out-of-order parses, an external edit, a deadline-expired proposal
  behind a held lease and invalid schemas write nothing;
- **paths:** traversal, protected folders, symlinked file and folder escapes; a link
  inside the project;
- **transactions:** a stale file refuses the batch; a write failing midway (read-only
  folder) puts back the files already written;
- **crash:** SIGKILL midway through a commit and a grouped Undo, with and without a
  later user edit: rolled back where safe, newer work kept and its pre-image preserved;
  a damaged journal refused untouched;
- **history, files, drafts** (restart, stale base, damaged file), **lanes** (waits for
  another chain's lease, runs inside its own), **rollback**, **drain**, and **helpers**
  (parser modules contain no file-writing call and no Undo state).
