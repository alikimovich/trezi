# Legacy names

Trezi was called **dsgn**, then **Praxis**. Code, UI and docs use only Trezi names.
The earlier names survive only in the read-compatibility shims below, and only in
the files listed. `test/legacy-names-audit.mjs` fails when either name appears
anywhere else. Exceptions: tests of these shims under `test/`, the history in
`docs/PROGRESS.md` and `docs/TASKS.md`, and asset names inside `build/Assets.car`.
It also fails when a listed file no longer carries an earlier name. Don't "fix" a
listed string. Removing a shim needs a tested migration.

| Shim (read side only; writes use Trezi names) | Files |
| --- | --- |
| OS identity kept on purpose: bundle ID `dev.praxis.native` (WebKit data, TCC grants, and the identifier in the app's designated requirement). LKM-144 decided against renaming it to `dev.trezi.native`: a rename would reset every grant and the WebKit store, so every prompt would come back | `scripts/build-native.mjs`, `scripts/service-info.mjs` |
| Keychain service `dev.praxis.native.secrets`: the master key is read once, written as `dev.trezi.native.secrets`, then the old item is deleted (LKM-137). The delete may ask once more; a denied delete leaves an unused item (LKM-144). The operator docs name both legacy identifiers in their check and cleanup commands | `src/native/Secrets.swift`, `README.md`, `docs/PROVIDERS.md` |
| `PRAXIS_*` env vars as a fallback for `TREZI_*` (Trezi wins); the installer reuses `PRAXIS_HOME` or an existing `~/.praxis` checkout and removes the retired `praxis` command link it made | `src/shared/rename-compat.ts`, `bin/trezi-agent-mcp.mjs`, `src/service/ProviderData.swift`, `install.sh` |
| Profile alias `Trezi Native → Praxis Native`; the `praxis`/`dsgn` session, memory and provider stores inside a profile | `src/native/profile-path.ts`, `src/service/ProfilePaths.swift`, `src/service/ConversationStore.swift`, `src/service/MemoryFile.swift`, `src/service/ProviderData.swift`, `src/main/provider-data.ts` |
| `praxis:`/`praxis.` preference keys (a Trezi key wins, even when null) | `src/native/preferences.ts`, `src/service/PreferencesFile.swift` |
| `praxis/*` and `dsgn/*` work branches and `praxis/chat-*` recovery branches | `src/main/git.ts`, `src/shared/github.ts`, `src/main/worktrees.ts`, `src/main/chat-park.ts`, `src/service/RepositoryGit.swift`, `src/service/RepositoryLanding.swift`, `src/service/WorkflowRemote.swift` |
| `.praxis/` and `.dsgn/` sidecar folders: agent write-deny, excluded from snapshots and cleaning, detection, sidecar migration, helper sync and setup uninstall | `src/main/backends/tools.ts`, `src/main/provider-policy.ts`, `src/service/ProviderPolicy.swift`, `src/main/chat-island-schema.ts`, `src/main/chat-island-source.ts`, `src/main/worktrees.ts`, `src/main/project-detect.ts`, `src/main/props-svelte.ts`, `src/service/SourcePaths.swift`, `src/service/RepositoryGit.swift`, `src/service/RuntimeDetect.swift`, `src/service/EditingProject.swift`, `src/service/WorkflowSetup.swift` |
| `data-praxis-*` source stamps (Trezi preferred when both exist) and React Native `praxis:` test IDs | `src/preview/source-stamp.ts`, `src/main/setup.ts`, `src/main/setup-react.ts`, `src/main/setup-next.ts`, `src/main/setup-mdx.ts`, `src/main/html-source.ts`, `src/native/smoke-source-stamp.ts`, `src/native/smoke-legacy-project.ts`, `src/service/SimulatorTools.swift` |
| Short display paths: old-name profile folders, worktree stores and `refs/praxis/recovery/*` read as "chat workspace", "Trezi data" or "recovery copy" | `src/shared/display-path.ts`, `src/native/display-paths.ts` |
| Leftover Electron-era `Praxis/praxis` and `dsgn/dsgn` chat worktree folders: pruned into recovery, then removed once migrated or empty | `src/service/RepositoryCleanup.swift`, `src/main/chat-workspaces.ts` |
| `praxis:animation-replay`, dispatched beside the Trezi event for existing project listeners | `src/preview/preload.ts` |
| The one-time project migration (below) | `src/service/EditingLegacyNames.swift` |
| This list | `docs/agent-guide/legacy-names.md`, `test/legacy-names-audit.mjs` |

A path such as `~/Library/Application Support/Praxis Native/praxis/worktrees/<id>`
in tool output (for example a `bun install` error from a chat worktree) is expected
on a profile created before the rename. It does not mean a stale build. The profile
alias row above keeps that directory in place. `Trezi Native` and `trezi` are aliases
to it, and Git and package managers print the resolved path (checked in LKM-194).

## Retired

These have no read path:

- the `praxis` command;
- the old XPC service ID (the build leaves only `dev.trezi.service.xpc` in the app);
- the `praxis` MCP server and plugin namespace;
- the old preview IPC prefix.

Provider sessions started before the rename lose their old tool names. They get
the Trezi tools on the next turn.

## Project migration

`src/service/EditingLegacyNames.swift` runs when a project is detected. It renames
the old setup files: `.praxis/praxis-*` helpers become `.trezi/trezi-*`. It then
rewrites the references to them in configs and `.gitignore`, the `data-praxis-*`
stamps and `praxis:animation-replay` listeners. It runs automatically only when the
Git tree has no meaningful uncommitted change; otherwise the user confirms in a
sheet (`src/native/legacy-names.ts`). A dirty tree is never rewritten silently
(`test/legacy-names-migrate.mjs`), and nothing is committed. A legacy helper that
differs from the current one is kept under `.trezi/legacy/praxis/`. Binary files,
ignored files, links and the metadata folders are never rewritten.
