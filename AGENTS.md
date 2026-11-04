# AGENTS.md — working guide for Trezi

Coding agent guide. `CLAUDE.md` imports this file; linked agent-guide pages bind.

## What Trezi is

A native macOS app: AI chat (Swift/AppKit/SwiftUI) edits a repo beside its dev
server preview (system WebKit). Swift XPC owns the profile lock, ledger and
domain writers; Bun runs retained JS and supervised provider helpers.
Distribute from source (`bun install`, `bun run build`); start with `open -a Trezi`
or `trezi` (`bun run dev` for development). Users bring provider credentials.
Electron, React rendering and browser/Tailscale mode are retired (`docs/NATIVE.md`).

Trezi had earlier names. Their remaining strings are deliberate read-compatibility
shims, all listed in [legacy names](#legacy-names): don't "fix" them.

## Start here every session

1. Read only the top of `docs/PROGRESS.md` (newest-first log with the *why* behind
   decisions), e.g. `head -80 docs/PROGRESS.md`, and find your task in
   `docs/TASKS.md` with `grep -n '<ISSUE-ID or keyword>' docs/TASKS.md`. Both files
   are very large: use head/grep (or a ranged read), never read either in full.
2. After a chunk, add a dated entry atop `docs/PROGRESS.md` and tick
   `docs/TASKS.md`. Never rewrite history.
3. If your change contradicts this file, a `docs/agent-guide/` page or `README.md`,
   fix that doc in the same commit. `test/docs-links.mjs` fails CI when an anchored
   path (`src/…`, `docs/…`) referenced in them no longer exists.

## Commands

Use **Bun**, not npm/yarn. Native builds need macOS 13.3+ and the macOS 26 SDK. Full table:
[verification](docs/agent-guide/verification.md).

| Command | What |
| --- | --- |
| `bun run dev` | Build and launch the native app |
| `bun run build` | Build to `out/native/` |
| `bun run typecheck` | Native/backend/shared + preview. Run after every change |
| `bun run check:feedback --base=origin/main` | Proportionate local feedback: lint first, applicable typechecks, audited selected unit tests; FULL selection gets static checks and a partial-evidence receipt |
| `bun run typecheck:native` | Native/backend/shared only |
| `node test/run.mjs unit` | Unit tier, no desktop |
| `bun run test:<name>` | One test (aliases in package.json) |
| `bun run test:native` | Native desktop integration (disposable profile) |
| `bun run test` | Unit + native |
| `bun run verify` | All tiers incl. real provider calls (needs authorization) |
| `bun run lint` | Biome over `src` + `test` |
| `bun run release <major\|minor\|patch>` | Maintainers only: bump, changelog, commit, tag on main ([versioning](#versioning-and-changelog)) |

## Verify your own work without asking the user

- After coherent edits, use `bun run check:feedback --base=origin/main` for
  proportionate local feedback. Its receipt is partial evidence, never merge
  acceptance. Required CI, independent review and the exact-head gate still apply.
  Native acceptance and native-failure pre-merge verification remain required.
  Agent OS schedules desktop checks under its shared lock and runs nightly native
  checks. Full local commands remain available.
- Keep `bun run lint` at exit 0; the feedback command runs it before tests.
- Real provider calls (`test:native-live`, `verify`) require authorization.
- Tiers: `unit`, `native`, `live`, `all`. Native/live run serially. SKIP is not
  PASS. `--only=core,chat,…` limits smoke groups (`src/native/smoke-groups.ts`);
  acceptance needs every group. Details: `docs/TESTING.md`.
- Check UI PNGs. Offscreen captures cannot paint Liquid Glass.
  `TREZI_NATIVE_BACKGROUND_TEST=1` is reduced coverage; report it.

### Evidence budget

- A foreground capture plus fixture JSON geometry/state is enough evidence.
- Do not add OCR, synthetic CGEvent/input-routing tests or system preference
  changes unless the ticket requires them.
- Tests never change system settings.

## Architecture map

- `src/native/` — Swift host UI (`src/native/Host.swift`, `src/native/Shell.swift`,
  `src/native/Chat.swift`, `src/native/WorkspaceLayout.swift`, …) and the Bun
  controllers behind it; `src/native/index.ts` is the Bun entrypoint.
- `src/service/` — the Swift XPC service: profile lock, ledger and the domain owners
  (preferences, workspace, memory, runtime, repository, source, conversation,
  providers, editing, workflows, platform); the only writers, with no Bun fallback.
  Built-in provider adapters run in helpers it supervises.
  [service-owners](docs/agent-guide/service-owners.md)
- `src/main/` — retained Bun backend: provider adapters and sessions, parsers,
  props/styles/tokens, Git/worktree orchestration and reads.
  [backend-map](docs/agent-guide/backend-map.md)
- `src/preview/` — isolated WKContentWorld instrumentation of the page, the
  only WebKit view. `src/shared/api.ts` — every cross-process type.
- Product log: processes write redacted lifecycle lines to `~/Library/Logs/Trezi`.
  Never log prompts, file contents or secrets. [logs](docs/agent-guide/logs.md)
- Tree, lifecycle, trust boundaries, design rationale:
  [architecture](docs/agent-guide/architecture.md). Per-domain docs: the
  `SWIFT-BACKEND-*` files in `docs/`.

Trezi **owns** the target's dev-server lifecycle: never run the target's `dev`
yourself. Preview messages are untrusted; keep the view-identity allowlist.

## Git and worktrees

- Commit small, focused changes with a Co-Authored-By trailer. Commits are
  pre-authorized; do not ask again before staging/committing in-scope work.
- In user repos, the Swift repository owner performs every Trezi Git effect. Chats
  run in per-chat worktrees (`trezi/chat-<id>`), landed live only once a host check
  passed on that source; the preview serves the live checkout.
- Exclude worktree `node_modules` (each worktree's own clone, never a link to the
  live one) and the `.env` symlink by name, never via `.gitignore`.
- "What did this session change?" compares against the merge base with the default
  branch, not `HEAD`.
- Tool callbacks get the worktree as `root`; persist state under
  `SpawnContext.liveRoot`.
- Details and the reasons: [git-worktrees](docs/agent-guide/git-worktrees.md),
  `docs/WORKTREES.md`.

## Versioning and changelog

- `package.json` `version` is the one version source (SemVer; before 1.0, minor =
  features or breaking changes, patch = fixes). The build stamps it, the commit count
  of HEAD as the build number and the short sha into `Trezi.app`, its XPC service and
  the backend/provider-helper bundles (`scripts/version.mjs`). Never hand-edit it.
- **Every ticket that changes user-visible behaviour adds one line under
  `## [Unreleased]` in `CHANGELOG.md`** (Keep a Changelog: Added / Changed / Fixed /
  Removed). Internal-only changes add none. The file union-merges like the logs.
- Releases are cut by a maintainer on a clean main with `bun run release
  <major|minor|patch>`: it bumps, moves Unreleased into a dated section, commits
  `Release vX.Y.Z` and tags `vX.Y.Z`, and never pushes. Agents do not run it.
- CI fails on a non-SemVer version or a missing Unreleased section
  (`scripts/check-version.mjs`).

## Conventions (summary)

Full list: [conventions](docs/agent-guide/conventions.md). Hard-won traps:
[gotchas](docs/agent-guide/gotchas.md) — read before debugging Stop/interrupt,
XPC/quit, shortcuts, Styles, control panels or model lists.

- Keep files under ~500 lines. SDKs are ESM-only: dynamic `import()`.
- New `.mjs` test → register it in its tier in `test/tiers.mjs`.
- Never commit secrets; a connection's API key never leaves main (UI sees `hasKey`).
- Agents cannot write a target's `.trezi/` (or the [legacy](docs/agent-guide/legacy-names.md) sidecar folders).
- Keep `docs/WORKTREES.md`, `docs/PROVIDERS.md` and `docs/MEMORY.md` current.

## Legacy names

Trezi had earlier names. They survive only as read-compatibility shims. Every shim
and every file that carries one is listed in one place:
[legacy names](docs/agent-guide/legacy-names.md). `test/legacy-names-audit.mjs`
enforces that list. Projects that still use the old setup names are migrated once
on open: automatically on a clean Git tree, otherwise only after the user confirms.
The migration never commits.
