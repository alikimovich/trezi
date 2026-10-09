# Agent guide — Git, worktrees and commits

Moved from the old `CLAUDE.md` ("Gotchas", "Conventions") and `AGENTS.md`
("Conventions"). Linked from [AGENTS.md](../../AGENTS.md). Lifecycle details live in
`docs/WORKTREES.md`; the Swift repository owner in `docs/SWIFT-BACKEND-REPOSITORY.md`.

## Committing in this repository

- Commit in small, focused commits with the Co-Authored-By trailer. Commits are
  pre-authorized; do not ask again before staging/committing in-scope work.
- If your change contradicts `AGENTS.md`, a doc under `docs/agent-guide/` or
  `README.md`, fix that doc in the same commit.
- Keep `docs/WORKTREES.md` and `docs/PROVIDERS.md` current for lifecycle/provider
  changes.

## How Trezi uses Git in the user's repository

- Every Trezi Git effect (worktrees, landings, live commits, branch switches,
  recovery) is performed and serialized by the Swift repository owner — one FIFO lane
  per repository common directory; the TS Git code (`git.ts`, `worktrees.ts`,
  `chat-worktrees.ts`, `chat-isolation.ts`, `repo-write-queue.ts`) dispatches to it
  and throws without the service (there is no Bun fallback since LKM-111). Recovery refs are `refs/trezi/recovery/*`.
- Work branches are `trezi/*`; `git.ts` also recognizes the legacy work-branch
  prefixes (a deliberate shim — see [legacy names](legacy-names.md)).
- **Chats run in per-chat worktrees (trezi/chat-<id>), auto-merged back to the
  live tree on each turn's done/error.** The preview ALWAYS serves the live
  checkout, never a worktree. Non-repo-root projects (subdirs, non-git) run on
  the live tree as today (`isRepoRoot` gate in git.ts). Resumed sessions get a
  fresh worktree; the model picker (agent:restart-chat) reuses the existing one.
  Drift from concurrent live edits syncs at turn start; conflicts park on the
  branch for review. One worktree per open chat costs little disk: its
  node_modules is an APFS copy-on-write clone of the live one, never a symlink,
  so a chat's install cannot touch the live dependencies (LKM-146,
  `docs/WORKTREES.md`); worktree directories live under `<userData>/trezi/worktrees`.
- **A worktree's node_modules and symlinked .env must be excluded by NAME, never via
  the target's `.gitignore`.** Every worktree has them so it can build (node_modules
  as its own folder since LKM-146; older worktrees had a symlink, which is removed at
  the next sync). A `.gitignore` pattern with a trailing slash (`node_modules/`, the
  Next.js/CRA/Vite default) is *directory-only* and git never treats a symlink as
  a directory — so it fails to match the symlink. Left to `.gitignore`, the
  symlink is staged by `git add -A`, the turn-end auto-merge chokes reading it
  (`EISDIR` → the whole batch is refused), and EVERY turn parks with `node_modules`
  in the conflict card (this shipped, user-reported 2026-08-08). `worktrees.ts`
  exports `RUNTIME_DEPS` and unstages it in `captureBase`/`commitWorktree`;
  `chat-worktrees.ts` spares it from `git clean` with `-e` (`cleanArgs`). Never
  re-route these through `.gitignore`, and keep any scaffolded `.gitignore`
  slash-free. `.env` (rule has no slash) hides the bug — it DOES match the symlink,
  so only `node_modules` leaks; don't let that asymmetry mislead the diagnosis.
- **The merge onto the live tree is also COMMITTED there — one commit per turn**
  (`live-commit.ts`, called from `chat-isolation.ts` + the comment-spawn
  finalizer). Only the files that turn changed are staged, and it's a pathspec
  (partial) commit, so a user's unrelated dirty/staged work is never swept in.
  Consequence for anything that asks "what did this session change?": a diff vs
  `HEAD` now returns nothing — compare against the merge base with the default
  branch instead (`src/main/publish-scope.ts` does, for the publish paths).
- **A tool callback's `root` is the chat's WORKTREE, not the live tree** — persist app
  state under `SpawnContext.liveRoot` (details in [gotchas.md](gotchas.md)).
