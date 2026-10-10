# Agent guide — `src/main/` backend map

Moved from the old `CLAUDE.md` architecture tree and `AGENTS.md` ("`src/main/`:
retained backend services"). Linked from [AGENTS.md](../../AGENTS.md).

`src/main/` holds the retained backend services (CJS bundle, Bun; the directory name
is historical): agent/provider sessions, dev servers, Git/worktrees, setup, source
parsers, props/styles/tokens, annotations, diagnostics, media and iOS Simulator. Every
provider session starts through `src/main/provider-sessions.ts` (the provider owner's
grant; see `docs/SWIFT-BACKEND-PROVIDERS.md`); the built-in adapters then run in a
provider helper (`src/main/backends/provider-helper-entry.ts`). Where the Swift service
owns a domain, the TS module listed here is its client: there is no Bun fallback since
LKM-111 — see [service-owners.md](service-owners.md).

```
src/main/
  preview-ipc.ts  every ipcMain handler that talks to (or about) that preview:
                  bounds/load/reset/capture, the select + comment relays, the
                  prop-panel island's plumbing, Styles reads, Layers. Owns no
                  view — native/index.ts hands it a `PreviewIpcHost` (accessors +
                  the shared `PreviewState`, which native/index.ts's load
                  re-arm reads). The sandboxed preload can only be READ by a
                  request/reply round trip; `requestReply` is that pattern
                  once, shared by styles:read and layers:read
  devserver.ts    registers the devserver:* routes, served by the runtime owner
                  through devserver-service.ts
  provider-sign-in.ts  starts user-initiated Claude Code or Codex app-server browser
                  login; provider CLIs own credential storage and the resulting
                  readiness is refreshed through providers:check-login
  project-detect.ts detect framework/PM + launch commands (pure; Swift mirror
                  in service/RuntimeDetect.swift)
  file-tree.ts    list a project's files (git ls-files / fs-walk) for the
                  native source editor's file tree (source:tree IPC)
  project-icon.ts the project's own favicon, kept as project metadata (project:icon)
                  — a declared <link rel="icon"> first, else the conventional
                  paths; inlined as a data: URL, mtime-revalidated. Reads the
                  FILES, not the running page, so an un-run project has one too.
                  No longer drawn in sidebar rows: every project row uses the
                  shared native folder symbol (src/native/SidebarIcon.swift)
  file-ops.ts     the same sidebar's file MANAGER — create/rename/delete
                  (source:create-file/rename-file/delete-file). Pure; every
                  renderer-supplied path is re-validated (no traversal, no
                  .git/.trezi/legacy sidecars/node_modules), delete goes to the OS trash
  media.ts / media-types.ts   the editor's media viewer: opening a .png/.mp4 must
                  SHOW it, not decode its bytes as utf8. media-types is the pure
                  half (ext→kind/MIME, binary sniff); the platform owner issues the
                  opaque `trezi-media://f/<token>` grants that only trusted native
                  code turns back into a path (AppKit shows the file). No WebKit view
                  serves the scheme (the Electron-era stream is retired)
  agent.ts        persistent multi-turn agent session (streams over agent:* IPC);
                  asks the conversation owner before every chat transition
  backends/       provider seam: claude.ts, codex.ts, gemini.ts behind pickProvider
                  (gemini currently has NO SDK dep — treat as experimental). A set
                  AgentOptions.connectionId routes to codex.ts whatever `provider` says.
                  codex-retry.ts is codex.ts's pure half (the CLI emits all five of its
                  retry attempts as separate `error` events; this collapses them into
                  one line that keeps the actual cause). interrupt.ts is the shared
                  "Stop must always work" helper — ask the backend nicely, then kill
                  (see the Gotcha on the SDK's untimed interrupt). helper-host.ts runs a
                  provider inside a supervised helper; helper-session.ts is Bun's view of
                  such a session. Since LKM-111 every built-in session runs there
                  (provider-helper-entry.ts is the helper's entrypoint; see
                  docs/SWIFT-BACKEND-PROVIDERS.md)
  session-tools.ts  Trezi's session tools for Codex's MCP bridge and helper sessions,
                  each authorized by the provider owner first (`authorizedTool`)
  codex-usage.ts  live token counts for a Codex turn: the SDK's event stream
                  reports usage only at `turn.completed`, so this tails the
                  CLI's own session rollout (`$CODEX_HOME/sessions/…jsonl`) for
                  its `token_count` records. Every reading is a running THREAD
                  total, so codex.ts DIFFS them (`usageDelta`), never sums
  providers-store.ts / providers.ts   v10 "connections" — user-added OpenAI-compatible
                  endpoints (AI Gateway, Groq, custom) so open models like Kimi/DeepSeek
                  can drive a chat. providers-store.ts only reads the store; the service's
                  provider owner writes it (keys through `TreziSecrets --crypto`) via
                  src/service/ProviderData.swift behind main/provider-data.ts.
                  providers.ts owns the providers:* IPC, the /models catalog probe, the
                  picker's ModelChoice list, and resolveConnection() — the seam
                  backends/codex.ts aims the Codex SDK at. These sessions stay in Bun
  model-catalog.ts what the two BUILT-IN seats offer, discovered instead of
                  curated: the parsers + a TTL cache with injected clock/baseDir over
                  the file the provider owner persists (it runs `codex debug models` on
                  the SDK's OWN vendored binary, not PATH). Claude needs a live session (Query.supportedModels()),
                  so backends/claude.ts hands its answer back via recordClaudeModels;
                  providers.ts only schedules the refresh, never on the render path
                  (src/service/ProviderData.swift via main/provider-data.ts)
  simulator.ts    iOS Simulator preview views and routes; the platform owner runs
                  xcrun/idb and the MJPEG bridge (src/service/SimulatorOwner.swift)
  props.ts / props-svelte.ts   prop editing engines (React via react-docgen /
                  Svelte 5); they mirror each other's splice/apply contract
  styles.ts / styles-svelte.ts  CSS editing for the island's Styles tab: one
                  edit → Tailwind class rewrite, else merge into an EXISTING
                  inline style, else hand to the agent; tw-styles.ts +
                  inline-style.ts are the pure mapping/splicing halves
  style-tokens.ts re-resolves a design-token pick from the island (name+group
                  only) against the project's own tokens and decides what to
                  write — a `var(--name)` reference or a Tailwind token class
  move-node.ts / move-node-svelte.ts / move-node-html.ts   the Layers panel's
                  drag-to-reorder engines (React/Svelte/static HTML): same-
                  parent sibling reorder writes real source; anything
                  ambiguous (shared stamp, cross-file, templated by a
                  .map()/{#each}) → needsAgent. move-node-splice.ts is the
                  shared, dependency-free rebuild-from-scratch splice all
                  three call; ast-walk.ts is the shared parent/ancestor walk
                  (React + Svelte; static HTML uses its own, to dodge parse5's
                  parentNode back-references)
  control-manifest.ts / control-panels.ts   AI-surfaced control panels:
                  validate + anchor-lex + render literals (pure) and the
                  .trezi/control-panels.json store (rendered here, committed
                  hash-bound by the editing owner) + controls:* IPC
  tokens.ts       design-token detection/scaffold   annotations.ts  comments → PR
  publish.ts      Publication's one Bun step (a checkout on its base branch moves to a
                  work branch) and the PR description helper; the workflow owner
                  (service/WorkflowPublish.swift) publishes through workflow-owner.ts
  annotation-store.ts  the notes sidecar's storage (list/add/remove; no Git), split
                  from publication in annotations.ts; it renders only, the editing
                  owner commits the sidecar (since LKM-102)
  spring.ts       pure spring→CSS linear() engine (vendored from ~/dev/spring2css);
                  powers the spring_to_css agent tool in backends/claude.ts
  apca.ts         APCA (Lc) contrast checker + accessible-color suggester
                  (adapted from ~/dev/apca-cli; apca-w3 + colorparsley loaded via
                  dynamic import — ESM-only); powers the check_contrast agent tool
  fluid.ts / oklch.ts / shadows.ts   pure design-system calculators powering the
                  fluid_clamp (Utopia clamp() math), color_scale (OKLCH tonal ramp
                  + gamut map) and layered_shadow (multi-layer box-shadow) agent tools
  type-metrics.ts pure line-height + letter-spacing recommender (size-aware,
                  WCAG-floored leading; Material-3 tracking); powers the line_height agent tool
  skill-packs.ts / skills-install.ts   curated allowlist catalog of external "taste"
                  skills + the `npx skills add --copy` runner; power the
                  list_recommended_skills (pure) and install_skills (side-effecting) agent tools
  git.ts, worktrees.ts, chat-worktrees.ts, chat-isolation.ts
                  git/worktree primitives; worktrees: per-chat isolation + sync/merge/recovery;
                  chat-worktrees: turn-scoped ops (sync, commit, apply); chat-isolation: lifecycle,
                  with chat-state (per-chat state, chain), chat-park (park records, clearPark,
                  crash recovery), chat-landing (landTurn), parked-chat (Apply/Discard/Resolve,
                  the stopped-turn hold), chat-status (read-only views: snapshot, send
                  refusal, the agent's workspace_state) and chat-helpers (setup helper sync).
  chat-watchdog.ts  LandingGuard (bounded landing wait, Stop ends it) and TurnWatchdog (silent
                  turn detector) behind "already running is never a dead end" (LKM-165)
  backends/claude-resume.ts  canonical cwd, resume-failure detection and the chat summary that
                  seeds a recovered Claude session (LKM-165)
  feedback.ts, feedback-diagnostics.ts
                  in-app feedback issue; the opt-in, redacted diagnostics bundle (LKM-165)
                  Their mutating functions dispatch to the Swift repository owner
                  (repository-owner.ts; without the service they throw);
                  repo-write-queue.ts likewise
  live-commit.ts  one commit per turn on the LIVE checkout (pure): stages only the
                  files that turn changed, partial-commits so the user's own staged
                  work is untouched, skips non-repo-root projects, never throws
  publish-scope.ts  what a session changed / is there anything to publish (pure) —
                  measured against the default branch, since committed turns leave
                  nothing to see in a HEAD-relative diff. Used by annotations.ts
  setup.ts, scaffold.ts
  diagnose.ts, diag-cache.ts, diag-rules.ts         sessions-store.ts, edit-history.ts
  project-ui*.ts  Experimental Gen UI (see architecture.md and docs/PROJECT_UI.md)
```
