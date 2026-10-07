# Worktrees and concurrent chats

Trezi gives every interactive chat on a Git repository root its own linked worktree.
Models edit there; the preview and the user's editor remain on the live checkout. The
isolation boundary is the worktree, while convergence is owned by one repository-scoped
landing queue.

S02 changes process supervision, not this writer: Bun still owns repository queues,
worktree creation and recovery. Swift's profile lease spans backend crash cleanup.
Launch-time rollback reads current stores/worktrees in place; it never restores an
old backup or removes a recovery branch. See [service rollback](SWIFT-BACKEND-SERVICE.md).

Copy-on-write creation measurements and integration tradeoffs are recorded in
[COW-INVESTIGATION.md](COW-INVESTIGATION.md). The experiment leaves this lifecycle
unchanged; CoW file duplication alone does not provide landing or recovery.

All chats are peers in the rail and in the isolation model: each crosses the same
landing queue. Chat identity and worktree identity are independent; closing a
conversation does not justify retaining a stale branch.

## State model

```text
idle (detached worktree, no chat branch)
  → turn starts: attach trezi/chat-<id>
  → model edits privately
  → repository landing queue
      → success: validate, write + commit live, detach, delete chat branch
      → failure/interruption: commit partial work only on chat branch, park
      → text drift: three-way merge privately; land clean edits automatically
      → text overlap: one automatic AI reconciliation, then land or park
      → other conflicts: keep cumulative work on chat branch, park

parked
  → Resolve (UI or agent tool): rebase both sides into the worktree; AI resolves markers
      (add/add, modify/delete and rename conflicts are markers too, a deleted side
       labelled "(deleted)"; only an unreadable patch is an error — LKM-130)
  → Retry: land the held work again once the live change is gone (LKM-165)
  → Discard: reset worktree, detach, delete chat branch
  → successful resolution: land once, detach, delete chat branch

landing threw (index lock, unreadable tree, owner error — LKM-165)
  → parked with reason failed and the error on the card; the chat never stays
      "isolated" with nothing landed
  → Retry / Resolve / Discard as for any park

parked, reason interrupted (Stop or a failed turn; not a conflict — LKM-151)
  → Revert this turn's changes: hidden at once (live never changed); Undo re-holds it;
      the next turn start or chat close discards it (recovery ref kept)
  → Keep changes: land the held work as one turn with its own Revert group
  → Ask agent to finish / next message / Send now: continue on top of it; success lands all
```

The branch is a recovery reference, not the session's permanent identity. It exists
only while a turn can lose work or while a conflict awaits a decision. An idle chat
retains its worktree/session cwd but no branch, preventing stale `trezi/chat-*` refs
from growing with every chat.

## Invariants

- One live checkout has one writer. Every snapshot, landing, apply, resolve, discard,
  and teardown crosses the repository queue.
- Only a successful provider terminal outcome may auto-land. Failed or interrupted
  work stays parked and recoverable.
- A provider's duplicate terminal events finalize a turn once. In particular, Codex's
  `error` followed by `done` is one failed turn.
- A batch is validated before live writes. Complete Git conflict-marker triplets never
  cross into the live checkout.
- Three-way resolution uses a temporary index seeded from the working tree. The user's
  real staged state is not a resolver input and is never mutated.
- `.env` and non-template `.env.*`, `node_modules`, `*.tsbuildinfo`, `.trezi/`, and
  the [legacy](agent-guide/legacy-names.md) sidecar folders are excluded from snapshots, worktree commits, and live commits.
- Parked work keeps a durable branch. Successfully landed or discarded work does not.
- Comment-created and automatic visual-edit background agents are attributed to their
  exact parent chat in the rail, but still count against the repository-wide concurrency
  cap and land through the same repository writer. Closing a parent chat does not stop
  its agent, so an agent left without a live parent re-parents onto the project's first
  chat rather than disappearing from the rail with its cancel control. Automatic edit
  completion is recorded in the activity log, not the chat transcript. The legacy
  `text-edit` event origin now covers committed props, styles, custom controls,
  and layer moves as well as text. Failed/interrupted children keep partial work
  recoverable without auto-applying it.

## What “conflict” means in Trezi

A park does not necessarily mean Git found overlapping `<<<<<<<` markers. It means the
chat's result could not be proven safe to land as one batch. Typical causes are another
chat or the user changing the same file during the turn, deletion/binary changes that
need the explicit resolver, or a failed/interrupted provider turn with partial edits.

Successful interactive turns first try a three-way reconciliation for existing regular
text files. Non-overlapping edits land without another model turn or a warning card.
Overlapping edits start one reconciliation turn in the same chat/provider, including
background chats. Markers remain private; the live checkout changes only after the
normal marker check and landing validation pass. The prompt asks the model to preserve
both intents, verify the result, and leave genuinely incompatible choices unresolved.
The provider retains its configured permissions. The busy gate stays held through
landing, so queued messages cannot race reconciliation; Stop cancels the continuation.
A failed/stopped reconciliation or further drift falls back to the existing card with
no automatic retry loop. Failed original turns, binary files, additions, deletions,
and symlinks retain the explicit review path. Already-parked chats retain Resolve.

The conflict card must therefore reflect the harness's authoritative landing state—not
the model's opinion about whether its private worktree is clean. A clean worktree can
still be parked because publication to the live checkout failed.

Codex/gateway chats can query that same authority with the session-scoped
`workspace_state` MCP tool. When it reports `parked`, `prepare_conflict_resolution`
invokes the same queued resolver as the conflict card, leaving marker-bearing files in
the chat's current worktree for the model to reconcile. The tool is idempotent after
staging, refuses to reset a worktree already edited in the current turn, and exposes no
raw Git/reset/discard escape hatch.

### Parked chats always have a way out (LKM-165)

Issue #230: after failed Codex turns, a switch to Claude never landed. The failed turns
held their work and the live base moved on, so the next successful turn drift-parked.
From then on `agent:send` refused every turn on the chat, including the Resolve card's
own resolution turn (native always names the chat), so nothing could land and the
agent kept reporting the edits as pending. Separately, a landing that threw was
swallowed: the chat stayed isolated with nothing landed and no card. The symlinked
project path was not a cause (the Swift owner works on real paths).

- The send guard (`sendRefusal` in `src/main/chat-status.ts`) refuses only an
  unresolved drift park; once Resolve has staged markers, the resolution turn sends.
- A landing exception parks the chat with `reason: 'failed'` and the error, shown on the
  card. The card offers Discard, Retry (`agent:retry-landing`, which re-runs the landing
  against the current live tree) and Resolve.
- Landing, park and worktree state are per chat, not per provider: a provider switch
  keeps the same worktree and cumulative batch, and the next successful turn lands every
  held file (`test/chat-landing-recovery.mjs`).
- A landing or turn that makes no progress cannot wedge the chat (`src/main/chat-watchdog.ts`).
  `afterTurn` bounds the chat's wait on a landing with `LandingGuard` (3 minutes); a
  timeout or Stop ends the wait and shows the work as `failed` with Retry. The batch
  behind it cannot be cancelled, so the repository lease and the chat's chain stay held
  until it settles: a Retry meanwhile is refused ("still finishing"), the next landing
  waits behind it, and whatever the batch ends as (merged, parked or a real error) is
  the state, so it never merges twice or after the card says otherwise. A batch that
  never settles holds its project's lease, as the Swift owner call under it would
  anyway. `TurnWatchdog` ends a turn
  silent for 10 minutes. `agent:send` and `agent:interrupt` settle a service phase that
  Bun no longer runs, so the chat never answers "This chat is already running." for a
  turn nothing is running. A send that still meets a real turn is queued by the native
  composer (LKM-151), and the activity row names the step: landing, holding changes,
  combining with project edits or finishing the previous step.
- `workspace_state` reports `lastLanding` (merged, parked, unchanged or failed, with the
  files and time) and guidance that never says "pending"; Codex has the Trezi tools
  pre-approved so it can call it (`docs/PROVIDERS.md`).

## Stopped turns and broken previews (LKM-151)

Stop never leaves a half-made edit in the live checkout. An interrupted or failed turn
parks with `reason: 'interrupted'` (`src/main/stopped-turn.ts`), so the chat shows a
post-Stop card instead of the conflict card. The card offers Revert this turn's changes,
Keep changes, and Ask agent to finish. Revert is byte-exact because the held work never
touched the live checkout. It is undoable until the next turn starts. The stopped
message's hover Revert does the same thing. Keep lands the work like a successful turn:
one commit, plus an edit-history group that the message's Revert and "Revert last turn"
restore byte for byte. A drift park stays a conflict even when a later turn on top of
it is stopped. The chat can still send while held: the next message continues the held
work.

The original incident landed live because the selection prompt carried the
element's absolute live path. A bypass-permission background agent edited that path
directly. The prompt now gives project-relative sources. A Claude `PreToolUse` hook
(`src/main/live-write-guard.ts`) denies Edit/Write/MultiEdit/NotebookEdit aimed inside
the live checkout from a worktree chat, and names the worktree path to use instead.
Shell commands and Codex are covered too (LKM-156, below).

### Bash and Codex writes to the live checkout (LKM-156)

- **Claude Bash.** The same `PreToolUse` hook denies any `Bash` command that names the
  live root while the chat runs in a worktree (`liveCheckoutCommand`). The denial names
  the worktree path of the first live path in the command. The guard matches the root
  as given, resolved (`/private/var/…`), shell-escaped and as `~/`, `$HOME/` or
  `${HOME}/`; siblings such as `app-other` and the worktree's own paths do not match.
- **Reads are denied too.** A shell command cannot be classified as a read or a write
  reliably: `sed -i`, redirections, `tee`, `cp`/`mv` targets, `find -exec`, `xargs`,
  formatters, `git -C` and `cd … &&` all write through ordinary-looking commands. The
  worktree holds the same files, so the agent loses nothing by using it. A command
  that reaches the live tree without spelling it (a relative `../..` walk, a variable
  built at runtime) is not caught; the prompt and the worktree cwd are the defense there.
- **Codex and Responses connections.** Both run on the Codex harness, which has no
  pre-tool hook, so the sandbox keeps them out (`src/main/backends/codex-sandbox.ts`):
  `workspace-write` with the worktree as the working directory and `approvalPolicy:
  'never'`, so a `require_escalated` request is refused. `test/live-write-guard.mjs`
  drives the real CLI against a local fake Responses endpoint (no provider call) and
  shows that `>`, `>>`, `sed -i`, `cp`, `mv`, `tee`, a write into the live `.git` and
  an escalation all fail while the worktree stays writable. It prints SKIP where no
  local port or nested sandbox is available.
- **What the sandbox otherwise allows.** `workspace-write` also keeps `/tmp`, `$TMPDIR`
  and the `writable_roots` of the user's `~/.codex/config.toml` writable. A worktree
  session therefore overrides `writable_roots` to none and excludes `/tmp` or `$TMPDIR`
  when it overlaps the live tree (only a project kept in a temp folder). Without the
  override a live tree under `/tmp` was writable in the probe; the test's own
  `config.toml` lists the live root as a writable root, and it stays read-only.
- **Non-Git projects** run in the live tree itself: no hook denial, no sandbox override.

The Codex sandbox above applies only with Agent file access set to Project only (LKM-163, below).

### Agent file access and symlinked paths (LKM-163)

- **Setting.** Settings → General → Agent file access (`trezi:agent-file-access:v1`,
  preferences owner). Main reads it whenever a provider helper session opens and passes
  it as `AgentOptions.agentFileAccess`, so a change applies to new chats.
  - **Full access** (default; unset or unknown values read as this): the agent reads
    and writes anywhere the user can and has network access. Codex runs with
    `sandboxMode: 'danger-full-access'` and no sandbox config. Claude gets no extra path limits.
  - **Project only**: the LKM-156 behaviour above (Codex `workspace-write` in the worktree).
- **Isolation stays in both modes.** The agent still works in its chat worktree, and
  Trezi lands the result in the live checkout. The Claude `PreToolUse` hook is the same
  in both modes. It is a correctness rule, not a security sandbox: it blocks only the
  live checkout, and its denial names the worktree path to edit instead.
- **Codex in Full access.** Codex has no pre-tool hook. So the adapter snapshots the live
  tree (its HEAD, and its uncommitted files from `git --no-optional-locks status` plus
  each file's size and mtime) before and after each turn
  (`src/main/backends/live-tree-watch.ts`). One chat note names every file that became
  dirty or changed again, every file that was uncommitted before and is clean after
  (`git checkout -- f`, `restore`, `stash` or `reset --hard` discarded the user's work),
  and, when HEAD moved, a commit made in the live checkout (with the files from
  `git diff --name-only before..after`). Trezi did not track any of it, and Revert cannot
  undo it. A file the user or another chat's landing changed during the turn is named
  too, so the note says the live project changed, not that Codex changed it. Landing
  runs after `done`, so the chat's own landing is never in the comparison.
- **Symlinked paths.** Every chat worktree sits under the profile's symlink aliases on an
  upgraded Mac (`Trezi Native` and `trezi` link to the folders of an earlier name,
  `src/service/ProfilePaths.swift`), and a project may sit under a symlinked folder.
  Codex's Seatbelt profile refuses a writable root with any symlink component other
  than the top-level `/tmp`/`/var` aliases ("symlinked writable roots are not
  supported"). That stopped every Codex chat before its first command. Codex now gets
  the worktree's real path (`realPath` in `src/main/agent-file-access.ts`) as its working
  directory in both modes. The Claude guard compares targets and both roots as given
  and resolved.
- **No permission dialogs.** Trezi adds no paths, entitlements or approvals. Codex keeps
  `approvalPolicy: 'never'` in both modes and never asks. Full access drops Codex's own
  Seatbelt profile, which never prompts. A macOS privacy prompt can still appear when the
  agent itself opens a protected folder (Desktop, Documents), as it could already for reads.
- **Tests.** `test/live-write-guard.mjs` covers both modes, the symlinked worktree and
  project, and the real CLI. That includes a project-only run from a worktree behind a
  symlink alias, which fails instead of skipping if Codex refuses the symlink, and a
  Full-access run that writes outside the project and is detected in the live tree.
  `test/agent-file-access.mjs` drives the real adapter with a stand-in CLI: the setting
  reaches every helper session, Full access passes `--sandbox danger-full-access`, `--cd`
  is the real worktree path, and a live write gives one note.

`src/shared/dev-error.ts` reads the dev server's log lines and spots Vite
(esbuild/Babel/Rolldown `PARSE_ERROR`), Next.js and tsc-style errors. If the error
names a file that the chat's last landed turn touched, a card in Trezi's own chat UI
offers Revert last turn and Fix with agent. The card clears when the dev server
rebuilds that file. Detection is a heuristic over log output; errors that appear only
in the browser are not read.

Regression coverage: `test/stop-recovery.mjs` (Git, through the Swift owners) and
`test/stop-recovery-ui.mjs` (guard, reader, controller cards and queue).

## Recovery and limits

On restart, dirty or unmerged orphan worktrees are folded into recovery records; work
already present live is removed. Trezi also sweeps branch-only `trezi/chat-*`
leftovers whose checkout was removed by an older or interrupted teardown. Because a
landed turn is usually a different commit on the live branch, cleanup accepts either
commit ancestry or patch equivalence against live `HEAD`; it never deletes a checked-
out branch, a persisted park, or a tip carrying a unique patch. Other namespaces such
as `backup/*`, normal work branches, and comment-agent branches are outside this sweep.

The preview currently serves the live checkout, so mid-turn worktree edits are not
visible there until landing. Isolation currently applies only when the opened folder is
the Git repository root; non-Git folders and Git subdirectories use the live path and do
not receive this concurrency guarantee.

Implementation: `src/main/repo-write-queue.ts`, `src/main/chat-isolation.ts` (with
`src/main/chat-state.ts`, `src/main/chat-park.ts`, `src/main/chat-landing.ts`,
`src/main/parked-chat.ts`, `src/main/stopped-turn.ts`),
`src/main/chat-worktrees.ts`, `src/main/worktrees.ts`, `src/main/live-commit.ts`.
Regression coverage: `test/chat-worktrees.mjs`, `test/live-commit.mjs`,
`test/chat-isolation.mjs`, `test/turn-terminal.mjs`.

### Landing commit messages (LKM-189)

A landing's commit message describes the change, never the user's prompt. Before the
chat branch is squashed, `src/main/chat-commit.ts` reads the worktree's diff against
`baseSha` (file list, diff stat and an excerpt of at most 8,000 characters, new files
included; `src/main/commit-message.ts`) and gives it, with the agent's final reply, to
the chat's provider as a tool-less one-shot on its background model (Haiku for Claude,
`gpt-6-sol` low effort for Codex, the connection's own model otherwise —
`describeAgentOptions`). The prompt never contains the user's message.

- The answer must be an imperative subject of at most 72 characters plus 3–6 bullets.
  An echo of the prompt, "[Attached files]", chatter or an error is rejected.
- The model has 3 s. On timeout, refusal or no provider the message is built from the
  files: "Update key-tile.tsx, home.tsx and bottom-bar.tsx" (Add/Remove when every file
  was added/deleted), one bullet per file and a "Changed areas" line.
- If at least 3 of the last 20 non-merge subjects (and 60%) use Conventional Commits,
  the subject does too (`chore:` when the model gave no type).
- The same message is used for the chat branch's squash commit and the live commit.
  Parked turns never advance `baseSha`, so a re-squash describes the combined diff.
- `Trezi-Turn` and `Trezi-Chat` (the chat branch) are Git trailers at the end of the
  body, never in the subject.
- Publish's PR title and body summarise the branch's commit subjects, checked against
  the diff; legacy prompt-subject commits (body "Trezi turn N …") are left out of that list.

Coverage: `test/commit-message.mjs` (mocked model, timeout, refusals, conventions,
combined diff, trailers), `test/live-commit.mjs` (re-squash after a park),
`test/chat-landing.mjs`, `test/publish-description.mjs`.

## Chat workspace cleanup

Each open chat's checkout lives in the profile's `worktrees/` folder (LKM-136). They
are removed in four ways, under the same rules: a parked or resolving chat, and a
chat with a turn running or being prepared, is never touched; a checkout with
uncommitted work is never removed. Its work goes to an `idle-<id>` recovery ref
(once per distinct content) and the checkout stays.

- **Close (archive).** Closing a chat lands its last turn and removes its checkout
  (`releaseChat`). Deleting the chat from History afterwards has no checkout left.
- **Idle.** Every hour, a chat with no turn for the period set in Settings → General
  (1, 3, 7, 14 or 30 days, or Never; default 7) loses its checkout and retired branch
  (`reclaimWorktree`). Its next turn recreates the checkout at the same path from the
  live tree, then syncs and lands as usual. A running Claude session keeps its process
  open across this; its tools resolve the path again, which works because the path is
  the same.
- **Clean up now.** Settings → General shows the disk use of all chat workspaces and
  runs the idle cleanup with no idle period.
- **Old-name folders.** Once, a minute after launch (and on Clean up now), the worktree
  folders of the earlier app profiles beside this one (`<support>/<old app>/<old
  name>/worktrees`, see `docs/agent-guide/legacy-names.md`) go through orphan recovery.
  The repository service (`removeLegacyFolder`) then removes each folder, and its
  old-name parent, only when it is empty (a `.DS_Store` aside). A folder
  that still holds anything else (a checkout of a repository that no longer exists, a
  moved-aside copy) stays. The profile's own store, even when it is physically an
  old-name folder, is never one of them.

Implementation: `src/main/chat-workspaces.ts`, `src/main/chat-isolation.ts`
(`reclaimIdleWorkspace`, the recreate in `beforeTurn`; `recreateWorkspace` in `src/main/chat-state.ts`),
`src/service/RepositoryCleanup.swift`. Coverage: `test/chat-workspace-cleanup.mjs`
(through the Swift owner) and `test/native-settings.mjs` (the Settings rows).

## New chat: pending chats and the spare worktree (LKM-182)

New chat never waits for Git, dependencies or the provider. `agent:new-chat` registers
a **pending chat** (`src/main/chat-pending.ts`) and returns its session key at once;
`agent:workspace-snapshot` lists it with an empty record, so the native controllers
show it and focus the composer (`New chat composer ready` in the product log, about
3 ms). The chat is then prepared in the background (`prepareChat` in
`src/main/agent.ts`): its checkout (`isolatedCwd`), the provider session, then
registration. Closing a pending chat cancels it; whatever was made is released.

- **First send.** `agent:send` waits for a pending chat (one retry if its preparation
  failed). After 300 ms the chat shows "Preparing workspace…" as its progress line;
  Stop cancels the wait and nothing is sent. Restart, rename and permission-mode
  changes wait for it too.
- **Spare.** Each open repository project keeps one prewarmed **spare** checkout
  (`src/main/chat-spare.ts`): a detached chat worktree with no branch, created through
  the repository write queue after the project opens (when it has chats) and after each
  new chat is ready. `isolatedCwd` takes it and syncs it from the live tree (uncommitted
  and untracked work included) before use; a spare that fails to sync is removed and a
  fresh checkout is made. Without a ready spare the chat creates its own in the
  background as before. Orphan recovery treats the spare as live
  (`liveChatWorktreeIds`). Closing the project removes the unused spare (abandon intent,
  no recovery ref, after any background install in it); quit drops the record and the
  next launch's orphan recovery removes the clean checkout.
- **Dependencies.** On the new-chat path the copy-on-write clone of the live
  `node_modules` still happens; a needed install (changed manifests) runs in the
  background (`provisionDependencies(..., { background: true })`) and is never started
  twice. A chat's later sync (`syncFromLive`) during a running install neither waits
  for it nor redoes it: it skips re-provisioning and the install carries on. Only a
  non-chat foreground `provisionDependencies` (e.g. a spawn's `createWorktree`) waits
  for a running install. While it runs, the turn's prompt tells the agent to read and
  edit but not run commands that need `node_modules`. Removing the checkout (closing
  the chat or project, `releaseChat`, `releaseSpare`, or a spare whose sync failed)
  first waits for the install to settle, so nothing writes into a deleted folder.

Measured with a stub provider and the Swift repository owner (`isolatedCwd` timings
are what New chat used to wait for; see `docs/PROGRESS.md`): small project 195–216 ms
before, composer ready in 2–3 ms after with the spare take at 146–156 ms in the
background; 6,000 files plus 8,000 in `node_modules`, 0.9–1.3 s before, 2–3 ms after
with the take at 0.31–0.44 s. Coverage: `test/chat-new-instant.mjs` (unit; 3 s
worktree creation, first send, spare reuse, pending close, project close) and
`test/chat-spare.mjs` (Git suite through the Swift owner).

## Publishing a shared work branch

Publish is a second repository-wide landing boundary after chat work reaches the live
checkout. The entire commit → reconcile → push → PR → merge → cleanup sequence holds a
per-repository publish lock. Before pushing an existing `trezi/*` branch, Trezi
fetches/prunes origin and records both tips below `refs/trezi/recovery/`.

The reconciliation is ancestry-driven: a remote ancestor needs only a normal push; a
local ancestor fast-forwards; true divergence gets an explicit merge commit. A push
rejected because the remote moved repeats fetch/reconciliation, with three total
attempts. Content conflicts remain in the live checkout with both recovery refs and
are surfaced as an exact file list. Publish never force-pushes, rebases, resets, or
chooses ours/theirs across the repository.

Implementation: the workflow owner, `src/service/WorkflowPublish.swift` (since LKM-111
the only one; the Bun twin `publish-reconcile.ts` was removed). Regression coverage:
`test/workflow-owner.mjs`.

### Branch rules (LKM-185)

- **One branch.** Landings always go to the branch the live checkout has checked out,
  the preview serves that checkout, and the toolbar shows that branch. Only an explicit
  user action (the branch menu, Git updates → Switch) switches, deletes or recreates it.
- **Merge without `--delete-branch`.** `gh pr merge --delete-branch`, run in the live
  checkout, checks out the base and force-deletes the work branch locally, including any
  landing that arrived while the PR description was written. Trezi merges without it
  and then deletes the remote branch itself, with a lease on the pushed head.
- **Cleanup keeps the work branch.** After the merge, Trezi fetches with `--prune` (no
  stale `origin/<branch>` is left behind to recreate the branch from) and fast-forwards
  the local base only when that is a fast-forward. The work branch fast-forwards to the
  merged base when that contains it, or else merges it (a squash merge never contains
  it). Both tips are recorded below `refs/trezi/recovery/` first. If the merge does not
  apply cleanly, it is aborted and the branch stays as it was. The result then carries
  a `notice` that offers Git updates → Pull. Nothing checks out, deletes or recreates a
  branch, so the old `recoverShip` fallback, which re-checked-out the branch by name, is
  gone. Git's DWIM checkout of a deleted branch creates it from the stale
  remote-tracking ref (reflog `branch: Created from refs/remotes/origin/…`), which is
  how earlier landings became unreachable.
- **Ensure never hides landings.** The open-time `git:ensure` and publish's heal call
  `switchBranch` onto `trezi/<base>`. If that branch already exists and lacks the
  checkout's commits, the repository owner either fast-forwards it to HEAD (old tip at
  a recovery ref) or, when it diverged, refuses and stays put
  (`joinBranch`, `src/service/RepositoryBranches.swift`).
- **Recovery on open.** Once per project per launch, `strandedLandings` lists other
  local branches holding landed chat commits (committer `trezi@local`, `trezi/chat-*`
  and `trezi/comment-*` excluded) whose changes the checkout lacks. A squash or
  cherry-pick already in the checkout is skipped through `git merge-tree`. One notice
  reads "N earlier chat changes are on branch main, not on trezi/main" and offers
  **Bring them back** and **Ignore**. Bring them back runs `restoreLandings`: recovery
  refs for both tips, then a `--no-ff` merge. A conflict stays in the checkout for
  per-file resolution. Ignore is remembered per branch tip
  (`trezi:stranded-landings-ignored`). UI: `src/native/stranded-landings.ts`. Coverage:
  `test/branch-safety.mjs` reproduces the reported sequence, and it fails on the old
  cleanup.

Model/provider changes keep the selected chat's worktree and require confirmation
when the chat contains messages. The replacement session receives a one-time
recorded conversation handoff on its next turn; sibling chats are untouched.

## Environment changes and preview startup

The native workspace controller refreshes a managed web preview after authoritative `isolation:merged`
or applied `spawn-finished` events containing manifests, lockfiles, or framework
config changes. A provider's earlier `done` and parked/failed outcomes do not
trigger this refresh. Background projects retain pending refreshes until activated.
An empty project can open its chat before it has a dev server or application files.

For dependency changes (LKM-146), the workspace controller stops the server, shows
"Installing dependencies…" in the preview while `devserver:install` runs the
project's package manager in the live checkout (in its repository write queue),
then starts the server and reloads the preview. Git does not transfer a
worktree-local `node_modules` directory. Auto-detected commands/frameworks are
resolved again; explicit custom launch commands retain their override. Preview
startup failures leave chat available for repair and expose a retry command.
This refresh covers landed Git-root work; external file edits and non-isolated
turns still depend on the framework's own reload behavior or a manual restart.

A ready server that exits, or that the runtime owner stops after three unanswered
health probes, is not left dead. The preview shows the reason and a Restart button,
and `src/native/preview-supervisor.ts` restarts it after 1, 2, 4, 8 and 16 s. After
the last attempt it leaves Restart to the user. A manual Restart, a landing or
another project cancels the pending attempt.

## Setup helpers and Next.js validation

Git snapshots continue to exclude `.trezi/`. Before creating an agent session and
before every clean chat turn, Trezi copies only the setup helper allowlist into
the private checkout, verifies the copies, and records paths/SHA-256 hashes in
`.trezi/setup-helpers.json`. This also handles setup started after a chat's
worktree already exists. Annotations and other sidecar data are not shared.

A parked chat (held work after a stop, failure or drift) gets the same copy at the
start of every turn (LKM-153). Before, `beforeTurn` skipped parked chats entirely,
so a Connect to Trezi started in a chat with a stopped turn reached the agent without
`.trezi/trezi-source.cjs` and the setup stopped. The copy is safe while parked
because `.trezi/` never enters a snapshot, landing or clean. Set up also copies the
helpers itself before the setup turn (`syncChatHelpers` in
`src/main/chat-helpers.ts`, on the chat's repository queue, recreating an
idle-removed worktree first) and checks every hash against the live write. A
mismatch fails setup with that reason instead of reaching the agent. We chose this
over pointing the agent at the live `.trezi/` by absolute path, because the config's
relative `./.trezi/…` import and the agent's own checks (hashes, typecheck, a test
run) resolve in its checkout. We also chose it over relaxing the "agents never write
`.trezi/`" rule. The agent only edits config, and the dev server keeps loading the
live copies.

Every worktree has its own `node_modules`; none links to the live one (LKM-146).
Before, ordinary projects got a symlink, so an agent's `npm install`/`bun add`/
`pnpm remove` in a chat wrote straight into the folder the running dev server
reads. The live dependencies changed mid-turn, before anything landed, and could
disagree with the live `package.json`. `provisionDependencies`
(`src/main/worktree-dependencies.ts`, Swift `EditingProject.dependencyState`) runs
at worktree creation and every turn sync:

- It removes a link left by an older Trezi.
- When the live `node_modules` is ignored by Git and the worktree's manifests and
  lockfile match the live ones, it clones the live folder with APFS `clonefile`.
  This is one copy-on-write call: about 0.4 s for 12.6k files, against 1.6 s for a
  file-by-file copy. The clone is marked at once.
- Otherwise (manifests differ, another volume, or a changed fingerprint since the
  marker) it runs the worktree's own install with the project's package manager,
  then marks it.

The marker is `.trezi/dependencies.sha256`, a fingerprint of `package.json` and
the lockfiles. A `node_modules` that Git does not ignore is never copied in.

Isolation was chosen over blocking installs in chats: an agent must be able to add
a dependency and build or test with it in its own checkout. Detaching only when an
install starts cannot be enforced, because Trezi does not see the agent's shell
commands before they run. No adapter widens Turbopack's root.

`workspace_state` exposes the live checkout/revision/dirty state, worktree base,
preview URL, and latest stamp observation. `servedRevision: null` and
`revisionVerified: false` deliberately distinguish those observations from proof
that a particular commit finished compiling. Exact compiler revision attribution
remains a separate requirement.

## Pulling remote updates and switching branches

The branch menu's **Git updates…** panel fetches configured remotes, pulls a
selected remote-tracking branch into the current branch, or opens a remote branch
locally. Pull explicitly uses a merge, preserving local commits; it does not
rebase, force-reset, push, or silently stash. A conflicting merge is aborted back
to the clean starting tree. New local branches track the selected remote branch;
existing local branches are switched to without resetting or repointing them.
Pull afterward to update an existing local branch.

These operations run through the repository write queue and reject active project
agents, uncommitted project files, in-progress Git operations, and stale current-
branch selections. Untracked runtime sidecars do not block updates; Git retains
its own protection against overwriting untracked incoming paths. Fetch is safe
while agents work and does not alter the checkout. Remote references are refreshed
and validated before mutations. Browser mode enforces the same opened-root scope.

Successful pull/checkout results update branch metadata and request a preview
restart, installing dependencies when manifests/lockfiles changed. The next chat
turn uses the existing live-to-worktree synchronization to pick up the new tree.

Ordinary local-branch switches also restart the managed preview, re-detect the
framework, and install dependencies when branch-tip manifests or lockfiles differ.
Attached external servers get a page reload and a manual-restart message.

## Composer message queue

Enter or Queue message during a running turn captures the text, attachments, and
selected objects for that chat. Each chat drains in FIFO order, including while
another chat is active. Sends carry an explicit session key; attachment saving
and the previous turn's landing cannot redirect them to a newly active project.
The next send waits for the existing landing chain. A conflict pauses dispatch;
Stop and agent errors pause remaining messages until Send now. The paused row says
whether they will send: after Stop, "not sent" (Send now continues the held work), and
during a conflict, waiting with Send now disabled. Pending items can be removed. Queues are in memory, cleared on chat close or app reload.

Provider completion keeps the chat busy until landing finishes. Automatic
reconciliation shows a short progress status instead of the conflict card.

Clean merges add no chat notice. Their Revert action attaches to the completed
assistant response, even if a queued response has already started. Conflicts and
failures still surface normally.

## Chat-island source edits

Chat islands validate literal bindings against the creating agent's source tree,
but persist their spec/turn association in the native profile. They wait for a
successful terminal/landing event before enabling live edits; failed or parked
turns leave them unavailable. Closing or stopping the chat cancels composition.

A committed control gesture checks the loaded file revision inside the repository
write queue and writes its entire single-file batch as one undo group. Stale source
or a changed/closed island rejects the write. Controls never follow current DOM
selection. The next chat turn picks up committed live values through normal
worktree synchronization and a compact provider-only context summary. Full runtime
scrubbing and multi-file island transactions are not supported by the first slice.

## Comment completion feedback

Native comment cards display the latest provider tool status. Their final messages
distinguish applied, no-change, cancelled, failed and review outcomes; applied
comments expose their grouped Undo action. Finalizer errors retire the running card
and retain the recovery checkout. Late start responses cannot revive completed
cards. The repository busy slot stays occupied through landing and cleanup, and
comment snapshots and finalization use the shared repository writer.

## Managed preview shutdown

Preview processes belong to the app, independently of chat worktrees. Terminal
interrupts and app quit await termination of each owned process group, escalating
to SIGKILL after one second. Shell exit does not release ownership while descendants
survive. Shutdown does not land or discard worktree edits or target unrelated servers.

Legacy profile/worktree paths and the identities kept on purpose are listed in
[legacy names](agent-guide/legacy-names.md).

## Attachments and the chat worktree (LKM-166)

A chat's attachments are not copied into its worktree: a picked file is referenced by its
own path, and a pasted image is saved by the service in the profile's
`trezi/attachments` folder (pruned after 7 days), outside every repository. That is why no
`.trezi-attachments` folder exists and the worktree exclusion list (`excludedWorktreePath`
in `src/main/worktrees.ts`, `RepositoryPaths.excluded` in `src/service/RepositoryGit.swift`)
is unchanged: an attachment can never be committed or merged into the live tree. See
`docs/PROVIDERS.md` for how the agent is told about them.
