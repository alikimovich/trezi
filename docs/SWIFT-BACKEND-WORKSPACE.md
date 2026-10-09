# Swift-owned workspace identity and persistence (S04)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-92, roadmap row S04 ("basic projects/workspaces; Swift workspace coordinator")
of the [canonical plan](SWIFT-BACKEND-PLAN.md) and [roadmap](SWIFT-BACKEND-ROADMAP.md).
This is the second writer transfer, after [preferences](SWIFT-BACKEND-PREFERENCES.md).
Under the default launch (`TREZI_BACKEND_OWNER=swift`), the Swift service is the only
writer of `workspace.json`. It owns project identity, membership, order, the
selected project and recents, and it writes through the [operation ledger](SWIFT-BACKEND-LEDGER.md).
Sessions, servers and Git stay with their legacy Bun owners until their own slices.

- `src/service/WorkspaceFile.swift`: the document, identity (`projectKey`, real-path
  aliases), validation and every operation. `JSValue` (in `PreferencesFile.swift`)
  now writes numbers and integer-like keys exactly as `JSON.stringify` does.
- `src/service/WorkspaceOwner.swift`: the owner actor (import, reconcile, adopt,
  operations) and its reply frames.
- `src/service/DomainChannel.swift`: the ordered pipe inbox and bounded drain
  shared by both Swift-owned domains, and the strict request frame.
- `src/native/workspace-model.ts`: the same document and operations in TypeScript.
  Both owners must produce the same bytes.
- `src/native/workspace.ts`: the `WorkspaceStore` interface and the legacy Bun
  writer, which is now only the rollback owner. `src/native/workspace-service.ts`:
  Bun's client for the Swift owner.
- `src/native/workspace-controller.ts`: still orchestrates sessions, servers and
  previews, but reads identity, order and selection from the store.

## The domain, exactly

| Item | Location | Owner (swift launch) | Owner (legacy launch) |
| --- | --- | --- | --- |
| Membership, order, `root`, `key`, `touchedAt` | `<profile>/workspace.json` `projects[]` | Swift service | Bun (`legacyWorkspace`) |
| Selected project | `activeKey` | Swift service | Bun |
| Recents | `recents[]` (10, newest first) | Swift service | Bun |
| Per-project metadata: `name`, `url`, `previewKind`, `branch`, `launchSpec`, `viewport`, `chatsCollapsed`, `environmentRevision`, `dependenciesPending`, `sessionKeys`, `activeSessionKey`, `chatSettings` | same entries | Decided by Bun's controllers, persisted by Swift through the typed `update` adapter | Bun |
| Temp file | `<profile>/workspace.json.tmp` (0600), same name for both owners | Swift service | Bun |
| Intent, receipts, revision, checkpoint | `<profile>/service/ledger/`, domain `workspace`; checkpoint `{digest, format: "trezi-workspace-v1"}` | Swift service | never opened |
| Display state: status, history, errors, render revision | Bun memory (`NativeWorkspaceSnapshot`) | Bun, never stored | Bun, never stored |
| Drafts (composer text, sheet autosave) | Bun memory (chat/sheet controllers) | Bun, untouched by this domain | Bun |

The file format is unchanged: `{"projects":[entry…],"activeKey":key|null,"recents":[…]}`.
The file stays the single copy of the state and the rollback artifact; the
checkpoint holds only a SHA-256 of its bytes (or `absent`). No store is migrated.

The metadata row is how "keep provider/session ownership in legacy" is met
without two writers. Bun's session, server and Git code decide those values, as
before. The workspace controller sends the differences through `update`, which
is typed: each field has one validation rule, applied by both owners. `root`,
`key` and `touchedAt` are refused there. Swift persists these values but does not
interpret them. Each moves to Swift with its own slice: sessions with S11,
servers with S06, branches with S07. (S06, LKM-94, moved the server processes but
left these persisted fields on this adapter: they are the workspace controller's
relaunch decisions, and move with that controller.) Checkout (worktree) identity also stays with
S07. Warm-project suspension (the controller's `evictWarm`: stop the server and
close the agent project beyond the three most recent) is unchanged in Bun. It is
ordered by `touchedAt`, which is now stamped by Swift on `open` and `select`.

## Identity and format rules (identical in both owners)

- A **project** is a valid entry: an object whose `root` is a string starting
  with `/` and whose `key` equals `projectKey(root)` (JS `trim`, `\` → `/`,
  trailing slashes removed). Only the first valid entry per key counts. This is
  exactly the set the pre-S04 restore accepted.
- **Canonical root.** `open` returns an existing project when its key matches, or
  when the requested root and a stored root resolve (`realpath`) to the same
  folder. A symlink or `/tmp` vs `/private/tmp` path never creates a second
  project. Keys never change: the key stays the string form, so session stores and
  agent maps keyed on it are unaffected. The root is stored as opened.
- **Nothing is dropped.** Unknown top-level and entry fields, invalid entries,
  invalid recents and duplicate entries stay where they are. Snapshots expose
  only projects and valid recents. `activeKey` reads as null unless it names a
  project. The controller then applies the pre-S04 rule (restore the last project).
- An old entry missing `sessionKeys`/`activeSessionKey`/`url`/… is given the
  pre-S04 defaults by the controller when read. The file is only corrected by the
  next metadata update.
- A file that is not an object with an array `projects` is refused, as are a BOM
  and trailing text. Serialization follows `JSON.stringify` exactly: integer-like
  keys come first, number formatting matches JS, and lone surrogates are escaped.
  A repeated key keeps its first position and takes its last value.
- An operation that changes nothing writes nothing: a duplicate `open`, an
  unchanged reorder, an update equal to what is stored, or one naming a project
  closed in the meantime.
- Limits: 1,000 projects, 256 patches per update, root/key 4,096 UTF-16 units,
  names 1,024, other text 8,192, 1–1,000 session keys. Roots with lone
  surrogates are refused.

Deliberate changes from the pre-S04 Bun writer, which both owners now share:
- Invalid entries, unknown fields and old recents are kept, where the old
  writer silently dropped them on its next save.
- `close` removes every valid copy of the identity, so a duplicate cannot
  resurrect the project.
- The attach-time `legacy` raw-workspace import parameter is gone. No caller
  passed it, and a client can no longer hand the owner a whole document.

## Callers (inventory at implementation time)

| Caller | Operation | Before any dependent command |
| --- | --- | --- |
| `NativeWorkspaceController.open` (menu, recents, `--project`, smoke) | `open(root, chatSettings)` → canonical key | Yes: awaited before select, agent session or server |
| `NativeWorkspaceController.select` (sidebar, restore, after close) | `select(key)` (sets `touchedAt`, `activeKey`) | Yes: awaited before Git, `agent:open-project`, detection, server start or activation. If it fails, the error is shown and nothing starts |
| `NativeWorkspaceController.close` | `close(key)` | Yes: persisted before servers stop and sessions close |
| `reorderProject` (sidebar drag, `project-reorder`) | `reorder(key, before)` | No dependent commands |
| `select` after detection | `recent(root, name)` | Failure is reported and the switch continues |
| `restore` (live agent projects not in the file) | `open(root)` | Yes |
| `changed()`: workspace, Git (`branch`), shell (`viewport`), chat settings effect, environment refresh | `update(patches)`, differences only | Fire-and-forget. A failure is reported, and the fields are re-sent with the next change |

The host (AppKit) still receives projections from Bun. It has no workspace
capability over XPC, and neither does the preview. Picking a folder stays with
AppKit.

## Protocol

Bun is a child of the service, so it uses the private pipe (lines beginning
`{"service":"workspace"`, never relayed to the host), with the S01 request
wrapped as for preferences:

`{"service":"workspace","id":n,"request":{connection, requestID, operationID, scope:{}, mode, expectedRevision?, service:"workspace", method, body}}`

- `snapshot` (`read`, empty body) → `{revision, digest, projects, activeKey, recents}`.
- `open {root, chatSettings?}` → `{revision, digest, key, created}`; `select {key}`,
  `close {key}`, `reorder {key, before|null}`, `update {projects:[{key, fields}]}`,
  `recent {root, name}` → `{revision, digest}`. All are `mutation`s with a
  required `expectedRevision`. Every reply carries the current snapshot, failures
  included.
- Refused before anything is recorded: unknown or missing fields, a scoped
  request (`unauthorized`; the workspace is global), a wrong method/mode pairing,
  `adopt` (internal only), and any invalid value (`invalidRequest`). `notFound`
  and `busy` (too many projects) are recorded failures that consume no revision.
- Identity is the operation ID. The intent digest covers the exact body. The same
  ID with the same body returns the recorded receipt, including an `open`'s key.
  The same ID with a different body is `idempotencyMismatch`.
- Bun's client sends one operation at a time, each against the last committed
  revision. Operations are intents (open this root, select this key). A
  `conflict` caused by an adopted external edit is therefore retried as a new
  operation on the newer revision, at most twice. A reply that does not arrive
  within 30 s rejects the operation. Bun never writes the file itself; a late
  reply still moves its snapshot forward.
- `workspace.changed` events are sent only for adopted external edits. The
  controller then takes identity, order and selection from the event and re-sends
  its own metadata where it differs.

## Commit protocol, adoption and recovery

These are the preferences protocol applied to `workspace.json`, inside the
ledger's FIFO lane for `workspace`:

1. Re-read the file. If its digest is not the checkpoint's, the file was edited
   externally: the operation fails `conflict` and the file is adopted as a new
   revision.
2. Apply the operation. If nothing changed, commit without writing.
3. Otherwise write the 0600 temp file and `F_FULLFSYNC` it, then call `beginEffect`.
   The pending record journals the target digest and the answer (key, created).
4. `rename`, then sync the directory, install the result and record the receipt.

A write failure before the rename is `ioFailure` (retryable), removes the temp
file and consumes no revision. After a crash, an `intent` is abandoned. An
`effect` without a receipt is reconciled against the file, never replayed. If the
file holds the target digest, the operation committed and its journaled answer is
returned. If it holds the prior checkpoint, the operation did not happen. Anything
else was superseded by an external edit: the operation fails `conflict` and the
file is adopted. A file that does not parse is never replaced. The domain answers
`recoveryRequired`, Bun's startup fails with that message, and the file is left
untouched until it is fixed or removed.

## Rollback (tightened to this domain)

- **Launch-time switch only.** Quit Trezi, then relaunch with
  `TREZI_BACKEND_OWNER=legacy`. The service's `--legacy` owner never opens the
  ledger, and Bun's `legacyWorkspace` reads the current `workspace.json` as it is.
  The exclusive profile lock admits one owner, so there is no hot switch.
- **Stop and drain.** On quit the service lets Bun finish; its final updates
  still reach the owner. The service then stops accepting workspace requests,
  lets accepted ones finish (bounded to 2 s), and only then releases the ledger
  and the profile lock. A request refused while stopping answers `unavailable`
  and writes nothing. One cut off at exit is recovered from the ledger as above.
- **What is preserved.** The file always holds the newest committed state, in
  the pre-S04 format, so the rollback owner reads the newest Swift write exactly.
  A pre-LKM-92 build reads it too, since the format and validity rules are
  unchanged. The ledger directory stays in place and the legacy owner does not
  touch it. Drafts and display state live in Bun memory and are unaffected by
  the owner. This domain touches no worktree, session store or receipt of
  another domain.
- **Returning to Swift.** The next Swift launch adopts whatever the legacy owner
  wrote as a new revision, without rewriting it. An old backup is never
  restored over the file.
- **Reverting the code.** A pre-LKM-92 build reads the same file and ignores the
  ledger's `workspace` domain. Such a build drops invalid entries and unknown
  fields on its next save, as it always did. Nothing it cannot read is written.

## Verification

`test/workspace-owner.mjs` (unit tier) compiles the real Swift sources into a
fixture process and checks, against the legacy Bun writer on real files:
- **Profile fixtures.** Current (pre-S04 controller output), old (no recents,
  selection or sessions), odd (unknown and integer-like keys, `__proto__`,
  exotic numbers, lone surrogates, invalid and duplicate entries, invalid
  selection and recents) and empty. Each is read identically, re-encoded
  identically, and gives identical results and bytes after 18 operations,
  including real-path aliases. The legacy writer run on the same file ends
  byte-identical. The refused files are refused by both owners.
- **Owner behavior.** Import without writing; canonical-root identity (trailing
  slash, symlink); receipts, `idempotencyMismatch`, `conflict` with the current
  snapshot; two concurrent operations on one revision, of which exactly one
  commits; strict frames; no write for a no-op; service restart keeps projects,
  order, selection, revision and receipts; a closed owner refuses.
- **External edits and damage.** An external edit conflicts and is adopted. An
  invalid external file is left untouched (`recoveryRequired`), an unreadable
  file blocks the domain, and a second owner cannot open the ledger.
- **Interrupted persistence.** Injected failures at temp create, write, flush and
  rename change nothing, and the retry succeeds. A directory-sync failure keeps
  the visible commit. SIGKILL after the intent, after the effect record, after
  the rename and after the receipt: each is reconciled from the file, never
  replayed. A crash after the rename followed by a legacy-owner write keeps the
  legacy write.
- **Rollback.** The legacy writer reads the newest Swift file. Swift adopts newer
  legacy writes without rewriting them and never restores an old backup.
- **Bun's client and controller against the real owner.** Serialized intents,
  canonical identity, an adoption retried as an intent, a timeout with no local
  write, a late reply, and startup refusal for an invalid file. The controller
  runs on the Swift owner: after a service restart and a UI reattach, projects,
  order and selection are the same.

`test/native-workspace-controller.mjs` checks that identity and selection are
persisted before sessions, servers and Git start, and that a refused selection
starts nothing. It also checks that restart and reattach preserve projects,
order and selection without writes, that display state is never stored, and
that old records get defaults while invalid entries and unknown fields survive.
`test/workspace-owner.mjs` pins the removed legacy writer's answers
(`test/fixtures/workspace-owner/golden.json`, LKM-111).
`test/service-process.mjs` (full, unsandboxed) opens and selects a project from
the supervised backend through the real XPC service's pipe. It checks that the
legacy workspace is imported, the same format is written, and no service frame
reaches the host.
