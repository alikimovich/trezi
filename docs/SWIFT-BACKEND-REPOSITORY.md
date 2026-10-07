# Swift repository coordinator: Git, worktrees and recovery (S07)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-95, roadmap row S07 ("Git/worktrees/isolation policy and recovery; per-repository
Swift coordinator") of the [canonical plan](SWIFT-BACKEND-PLAN.md) and
[roadmap](SWIFT-BACKEND-ROADMAP.md). It follows [runtime](SWIFT-BACKEND-RUNTIME.md).
Under the default launch (`TREZI_BACKEND_OWNER=swift`), the Swift service performs
every Git effect Trezi makes in a user's repository and is the serialization
authority for everything else that writes there. Bun keeps the decisions that belong
to later slices: chat state, park records, Undo history, setup helpers.

- `src/service/RepositoryOwner.swift`: requests, the method table with required
  intents, lanes and leases, journal bracketing, drain.
- `src/service/RepositoryEffects.swift`: worktree lifecycle, turn commits and
  landings (twins of `worktrees.ts`/`chat-worktrees.ts`).
- `src/service/RepositoryLanding.swift`: explicit apply, reconciliation staging,
  discard, live commits, branch switching, orphan and branch recovery (twins of
  `applyToWorkingTree`, `stageResolve`, `commitLiveTurn`, `git.ts`, `pruneOrphans`).
- `src/service/RepositoryCleanup.swift`: idle chat workspace cleanup
  (`reclaimWorktree`) and the old-name worktree folders orphan recovery may empty,
  removed by `removeLegacyFolder` once nothing but a `.DS_Store` is left (LKM-136,
  `docs/WORKTREES.md`).
- `src/service/RepositoryMerge.swift`: the file-by-file three-way merge an apply falls
  back to when `git apply --3way` refuses a patch that is really a conflict (LKM-130).
- `src/service/RepositoryJournal.swift`: the operation journal, recovery refs and
  the per-common-directory lanes.
- `src/service/RepositoryGit.swift`: the git runner, private-index snapshots and path
  rules.
- `src/service/GitMessages.swift`: every read of Git's stderr (LKM-150): `git apply`
  errors as reason, file and line, the same on any Git version and without the
  scratch patch path, and the push-rejection check. Decisions that the index or a ref
  can answer (a three-way conflict = unmerged entries) do not read Git's text at all.
  `test/git-messages.mjs` pins recorded output of several Git versions.
- `src/native/repository-service.ts`: Bun's client. `src/main/repository-owner.ts` is
  the seam: the mutating functions in `worktrees.ts`, `chat-worktrees.ts`,
  `live-commit.ts`, `git.ts` and `repo-write-queue.ts` dispatch to it when it is
  installed and are the rollback owner when it is not.

## The domain, exactly

| Item | Owner (swift launch) | Owner (legacy launch) |
| --- | --- | --- |
| Serialization of repository writes (`enqueueRepoWrite`) | Swift lane per common directory, leases held by Bun | Bun promise queue per project key |
| Chat/spawn worktrees: create, sync, attach/retire branch, commit, remove | Swift | Bun |
| Landing a turn on the live checkout (`completeTurn`, `autoApply`) | Swift (edits returned for Undo) | Bun |
| Explicit apply of a parked chat or spawn branch; reconciliation staging; discard | Swift | Bun |
| One commit per turn on the live checkout (`commitLiveTurn`) | Swift | Bun |
| Branch ensure/switch/checkout on the live checkout | Swift | Bun |
| Startup recovery: orphan checkouts, integrated chat branches | Swift | Bun |
| Operation journal `<profile>/service/repository/journal.json` | Swift | untouched |
| Recovery refs `refs/trezi/recovery/*` in each repository | Swift | untouched |
| Chat isolation state (parked, turn numbers), park records in the session store | Bun (S11) | Bun |
| Undo history for landed edits (`recordEdit`) | Swift source service (S08, LKM-96) | Bun |
| Setup helpers into worktrees, Next dependency provisioning | Bun JS helpers inside the lease | Bun |
| Git reads (branch lists, status, patches, marker scans, publish scope) | Bun (reads only) | Bun |
| Remote fetch/pull/checkout (`git-remote.ts`), publishing, annotation sidecar | Bun, inside the Swift lease | Bun |
| Prop, text, style, move, island, content and control source writes, file-tree operations | Swift source service in this lane (S08, LKM-96) | Bun |

The last row is deliberate. Those writers are other slices (S13 publishing and remote
actions, S05's annotation writer, S08 source transactions); they now take the Swift
lane, so they are ordered with every Git effect, but they still run their own
commands. Each is recorded in `docs/TASKS.md`.

## Rules

- **Lanes.** The lane key is the resolved `git rev-parse --git-common-dir`, so the
  live checkout and every linked worktree share one FIFO; a folder outside Git is
  keyed by its resolved path. Frames enter lanes in pipe order. Unrelated
  repositories run concurrently. Before, branch switches, orphan recovery, branch
  pruning and spawn-branch apply ran outside the queue, and the queue was keyed by
  project path, so a worktree and its live checkout did not serialize.
- **Leases.** `acquire {root}` answers when the lane is granted; `release {lease}`
  frees it after every operation already queued inside it. Bun tracks held leases per
  async call chain (`AsyncLocalStorage`): effects inside a lease run in it, and a
  nested acquire on the same lane is re-entrant instead of a deadlock. An acquire
  never times out (a late grant would hold the lane forever); a stopping service
  releases every lease.
- **Explicit intent.** Landing (`completeTurn` `land`, `autoApply`, `applyParked`,
  `applyBranch`), reconciliation (`stageResolve`), `discardParked`, `removeWorktree`
  (`landed`, `release`, `abandon`), `reclaimWorktree` (`idle`), `removeLegacyFolder` (`legacy`), `deleteBranch` (`discard`, `integrated`), orphan
  recovery and branch pruning each require their intent in the body, or are refused
  (`invalidRequest`) before anything runs.
- **Scope.** Every worktree operation checks that the path resolves under the profile
  and is a *linked* worktree of the request's repository. The user's main checkout, a
  worktree the user made elsewhere and an arbitrary folder are refused
  (`unauthorized`). Branch names must pass `check-ref-format`; deletions and
  `trezi/`-switches only touch work branches (`trezi/` and the legacy prefixes).
- **Private index.** Snapshots (a worktree's fork point, the live tree before a
  three-way apply, recovery snapshots) are built in a private index under
  `<profile>/service/repository/scratch`; the user's index is never read or written
  for them. Git runs with the repository-redirecting variables (`GIT_DIR`,
  `GIT_INDEX_FILE`, …) removed and `GIT_OPTIONAL_LOCKS=0`.
- **Recovery refs.** Before anything could make work unreachable, the owner names a
  ref in the journal, then points `refs/trezi/recovery/<UTC>-<kind>-<op>-<label>` at it:
  dirty or unlanded worktree state before a sync reset, removal or discard; the parked
  tip before reconciliation resets the worktree; a branch tip `checkout -B` or a
  deletion would orphan; the target commit before a landing writes files; the live
  pre-image before a three-way apply can write conflict markers; a detached orphan's
  recovery commit. Refs guarding an effect that completed with the work still
  reachable (a clean landing, a clean apply) are deleted; the rest are kept, and
  the owner never prunes them (refs are the only handle on moved-out work; list or
  delete them from Activity › Recovery Refs…, or with
  `git for-each-ref refs/trezi/recovery/` by hand, once inspected). Each ref name carries a random suffix so refs of one kind and label
  within one operation never overwrite each other.
- **Landing.** Unchanged policy (write only where the live file equals the fork point
  or already the target; refuse the whole batch otherwise), with these changes: files
  are compared as bytes; a symlink or a path resolving outside the checkout is refused;
  missing parent directories are created; a failed write restores the files already
  written; a batch over 16 MiB parks instead of crossing the pipe. A turn's file list
  names both sides of a rename (`--no-renames`), so a renamed file's old name is a
  deletion the landing refuses (parks) instead of a file left behind on live.
- **Conflicts, not errors (LKM-130).** `git apply --3way` refuses a whole patch, writing
  nothing, for add/add, modify/delete, delete/modify and a rename whose source is gone.
  Explicit apply (`applyParked`, `applyBranch`) and Resolve (`stageResolve`) then merge
  file by file from the commits the patch came from (`RepositoryMerge.swift`: `diff-tree
  -M`, `git merge-file`). Every conflict ends as markers in the file; a deleted side is an
  empty side labelled `live (deleted)` or `chat (deleted)`; the chat's rename wins and
  a live rename is followed. A binary file or symlink changed on both sides keeps the
  chat's version under Resolve and the project's under an explicit apply (reported as a
  conflict). A patch Git cannot read, a submodule, or a folder in the way stays an
  error: the message is bounded (600 characters) and names the path and Git's reason
  (`<path>: corrupt patch at line N`), and Git's full output goes to the service log.
  Not handled: rename/rename to two different names (the chat's name wins, content merged).
- **Live commits.** The same pathspec commit (`add -- paths`, `commit --no-verify --
  paths`), so the user's staged work elsewhere stays staged. A foreign index lock or a
  concurrent Git process makes it fail with the files left landed and uncommitted, as
  before.
- **Branches.** `checkout` only accepts an existing local branch and runs
  `git checkout <branch> --`. Before, a name that was not a ref could be read by Git as
  a path and discard that file's changes.
- **Paths.** Git path output is read with `-z`, so non-ASCII names are exact rather
  than C-quoted.
- **Startup recovery.** A dirty orphan's work is made durable before its checkout is
  touched: recovery refs on its HEAD and on a private-index snapshot of the dirty
  state, then the recovery commit on its branch (folded into a parked chat's squash,
  with the branch put back as found if the commit fails). A checkout whose commit
  failed (signing that cannot run in the background service, a Git error) is moved
  aside, never force-removed; a ref that could not be made leaves the orphan exactly
  as found. The recovery commit leaves excluded paths out. An orphan of *another* repository is left for that repository's own
  lane (before, it was reclaimed from whichever project opened first). A folder that
  is no longer a worktree is moved aside to `.recovered-<name>-<time>` instead of
  deleted; Trezi's own `.`-prefixed scratch is removed.
- **Snapshots.** A clean checkout's fork point is now HEAD itself rather than a new
  commit with HEAD's tree (what the legacy comment already described).

## Journal and recovery

An entry `{operationID, kind, intent, lane, root, worktree?, branch?, refs, started}`
is written and synced before the first effect and removed when the operation settles.
A failure after a recovery ref was made moves the entry to `interrupted`. When a new
service opens the journal, every still-active entry was interrupted by a crash and
moves there too. Nothing is replayed, reset or deleted for it: the worktree, its
branch and the refs keep the work, and chat recovery's existing orphan handling
surfaces unlanded branches as recovery records. `status` (read) returns them;
`acknowledge {operationID, intent:"acknowledge"}` forgets one and keeps its refs. A
damaged journal is left exactly as found; mutations are then refused
`recoveryRequired` (leases still work, so Bun's own writes are not blocked).

**Reported once (LKM-134).** Journal version 2 gives an interrupted entry a
`resolved` time. When the service opens the journal it resolves every open entry and
syncs that before anything reads it, so `status.recovered` lists each entry at
exactly one launch however often Trezi restarts (a crash before Bun shows that
report loses only the line; the refs stay). Each recovered entry carries `missing`,
the journaled refs not in its repository (a crash between naming a ref and creating
it, before the effect it guards, or the user deleted it), and `unreadable` when the
repository is gone. A version 1 journal reported its open entries at every launch,
so those are resolved without a new report and only counted in `closedEarlier`;
`recoveryNotices` (`src/native/repository-recovery.ts`) turns that into one summary
line. Saved work is reported at info level, a missing or unreadable ref as a
warning; only a damaged journal is an error. Activity › Recovery Refs… lists every
kept ref of the open projects and the journal's repositories (`recoveryRefs`, read)
and deletes only refs the user selects and then confirms (`deleteRecoveryRefs`,
`intent:"discard"`), each with `update-ref -d <ref> <sha>` so a ref that moved since
it was listed is kept. Nothing deletes recovery refs automatically.

## Protocol

Bun uses the private pipe with S01 frames, no revision and an empty scope:
`{"service":"repository","id":n,"request":{…,"service":"repository","method",…}}`.
Mutations take an optional `leases` array (the leases the calling chain holds).

| Method | Body | Result |
| --- | --- | --- |
| `acquire` / `release` | `{root, held?}` / `{lease}` | `{lease, reentrant}` / `{}` |
| `status` (read) / `acknowledge` | `{}` / `{operationID, intent}` | `{active, interrupted, recovered, closedEarlier, journal?}` / `{}` |
| `recoveryRefs` (read) / `deleteRecoveryRefs` | `{roots?}` / `{root, refs, shas, intent:"discard"}` | `[{root, refs:[{ref, sha, date, subject}]}]` / `{deleted, kept}` |
| `createWorktree` | `{root, worktreesDir, id, branch, linkNodeModules}` | `Worktree` |
| `syncWorktree` / `attachBranch` / `retireBranch` | `{root, worktree}` | `{synced, baseSha}` / `{}` |
| `commitWorktree` | `{root, worktree, message}` | `{committed, files}` |
| `autoApply` | `{root, worktree, files, intent:"land"}` | `{applied, edits}` |
| `completeTurn` | `{root, worktree, message, intent:"land"\|"park"}` | `{outcome, files, edits, newBase?}` |
| `applyParked` / `applyBranch` | `{root, worktree\|branch, intent:"land"}` | `{ok, conflict, files?, newBase?, empty?, error?}` |
| `stageResolve` | `{root, worktree, intent:"reconcile"}` | `{conflicted, files, clean, baseSha}` |
| `discardParked` | `{root, worktree, intent:"discard"}` | `{}` |
| `removeWorktree` | `{root, worktree, keepBranch, intent}` | `{}` |
| `reclaimWorktree` | `{root, worktree, intent:"idle"}` | `{removed, dirty, ref}` |
| `deleteBranch` | `{root, branch, intent}` | `{deleted}` |
| `pruneOrphans` | `{root, worktreesDir, skip, parked, intent:"recover"}` | `[{id, dirty, branch, repoRoot}]` |
| `pruneBranches` | `{root, protected, intent:"integrated"}` | `{deleted, preserved}` |
| `removeLegacyFolder` | `{root: <old-name worktrees folder>, intent:"legacy"}` | `{removed}` |
| `commitLive` | `{root, files, title, body?}` | `{committed, sha?, files}` |
| `checkout` / `switchBranch` | `{root, branch}` | `BranchResult` |
| `strandedLandings` (read) | `{root}` | `{current, branches:[{branch, tip, count}]}` |
| `restoreLandings` | `{root, branch, tip, intent:"restore"}` | `{merged, files, conflictFiles, recoveryRefs}` |

`switchBranch` (automatic: `git:ensure`, publish heal) never moves the live checkout
onto an existing branch that lacks its commits (LKM-185, `RepositoryBranches.swift`):
a branch behind HEAD fast-forwards first (old tip at a recovery ref), a diverged one is
refused. The branch rules are in `docs/WORKTREES.md` (Publishing a shared work branch).

Unknown or missing fields, wrong types, oversized or relative paths, NUL and lone
surrogates are refused before anything is journaled.

## Rollback (tightened to this domain)

- **Launch-time switch only.** Quit Trezi, relaunch with `TREZI_BACKEND_OWNER=legacy`.
  The profile lock admits one owner; no Git effect is hot-switched.
- **Drain before switching.** At quit, after Bun has exited, the service refuses new
  requests, releases Bun's leases and lets running Git effects finish (bounded to
  5 s). One cut short stays in the journal and is reported at the next Swift launch.
- **What is preserved.** Worktrees, their branches (`trezi/chat-*`,
  `trezi/comment-*`) and `<profile>/trezi/worktrees` are ordinary Git state in the
  same places and names, so the legacy owner continues on worktrees the Swift owner
  made (tested). The journal and every recovery ref stay; the legacy owner never
  reads or writes them. Park records, Undo history and drafts are Bun's in both
  launches. No backup is restored and nothing newer is overwritten.
- **Returning to Swift.** The journal opens as it was left; refs are unchanged.
- **Reverting the code.** A pre-LKM-95 build ignores `service/repository/` and
  `refs/trezi/recovery/*` (they can be listed with
  `git for-each-ref refs/trezi/recovery/` and deleted by hand once inspected). A
  pre-LKM-134 build reads a version 2 journal but ignores `resolved`, so it reports
  the closed entries again at each launch; nothing else changes.

## Verification

`test/repository-owner.mjs` (unit tier) compiles the real owner into a fixture
(`test/fixtures/repository-owner/main.swift`, `REPOSITORY_FAULT=<point>` SIGKILLs
inside an effect) and drives it through Bun's client and the unchanged TS entry points:
- **Parity.** The legacy suites `chat-worktrees`, `worktrees`, `live-commit`, `git`,
  `chat-recovery`, `auto-reconciliation` and `setup-next` run unchanged with the Swift
  owner preloaded (`test/helpers/repository-owner-preload.mjs`, which since LKM-111
  starts the editing fixture so the conversation, source and editing owners are real
  too) and must send it frames.
  `chat-islands` is left out: it assumes a lease is granted within one timer tick.
- **Lanes.** A worktree root waits for its live checkout's lease; an effect outside a
  lease waits; another repository runs concurrently; nested leases and effects inside
  a lease do not deadlock; two chats landing at once both land and commit.
- **External changes.** A foreign `index.lock` refuses the live commit with the files
  kept, then it commits; an external commit between turns is synced and built on; the
  user's staged file stays staged throughout.
- **Intent and scope.** Missing or wrong intents, unknown fields, a revision, a scope,
  a non-work branch, the main checkout, a user worktree outside the profile and a
  path-like checkout name are refused with nothing changed. Discard and dirty removal
  keep their content at recovery refs.
- **Crash.** SIGKILL after the first file of a landing, after reconciliation's reset,
  and after a removal preserved dirty work: the next process reports each as
  interrupted, its refs hold the target/parked/dirty content, nothing is reset, and
  `acknowledge` needs its intent and keeps the ref.
- **Orphans.** Two dirty orphans (one parked) with a recovery commit that cannot be
  made (signing required, failing program): both checkouts stay on disk, the parked
  branch tip is unchanged, each has its own `orphan-head`/`orphan-dirty` ref; with
  signing working the work is committed on its branch and the checkout removed.
- **Rollback and drain.** The legacy owner lands a turn on a Swift-made worktree with
  journal bytes and refs unchanged; a damaged journal is refused untouched while
  leases work; close refuses a request queued behind a lease and later requests.

`test/service-process.mjs` builds the real service with the owner.
