# Bun ownership audit for the Swift backend migration

> **History note (LKM-111, 2026-09-29):** this document predates LKM-111, which removed
> the Bun rollback launch (`TREZI_BACKEND_OWNER=legacy`, `TreziService --legacy`), its
> twins and several modules named here. The current census is in
> [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

Status: review proposal, 2026-09-27, LKM-84. Documentation only. Current source in
this worktree is authoritative; historical Electron/browser descriptions are not
runtime evidence. No migration, storage change, automatic merge, or worktree removal
is authorized by this document. Validation does not establish Swift backend parity.

Read together:

- [Route census](SWIFT-BACKEND-ROUTES.md): every registration, handler signature,
  source location, literal callers, and proposed service domain.
- [Module census](SWIFT-BACKEND-MODULES.md): all 146 production Bun modules and their
  imports, exports and effect locations, including indirect and route-less services.
- [Event census](SWIFT-BACKEND-EVENTS.md): 240 dispatch/emission/subscription sites,
  including Swift commands, native actions and preview channels.
- [Proposed contracts](SWIFT-BACKEND-CONTRACTS.md) and
  [first slice and follow-ups](SWIFT-BACKEND-PLAN.md).

## Coverage method and limits

Started with AGENTS, README, current PROGRESS/TASKS and NATIVE, WORKTREES,
PROVIDERS, MEMORY, TESTING, NATIVE-MIGRATION; consulted DESIGN, CHAT-ISLANDS,
CONTENT_CONTROLS, PROJECT_UI and UNUSED-HELPERS for domain semantics. Older browser
references in these documents are not evidence of an active application renderer.

Enumerated every TypeScript file recursively below `src/main/` and production
TypeScript below `src/native/` (146, including declarations; excluding smoke
fixtures). Parsed registration calls with the installed TypeScript compiler:
`ipcMain`, injected `ipc` and `router` `.handle`/`.on`; resolved preview constants;
rendered callback input/result signatures with the checker. Found 133 sites:
132 statically named sites and one reply-listener factory instantiated twice.
These are site counts, not unique route counts. Scanned all source literals for
callers, then reconciled dynamic callers below. The module appendix preserves
imports so a reader can follow dependency closure instead of assuming exports are
independent services. Effect searches include writes, processes, timers, watchers,
servers and quit hooks. Event census includes Swift case dispatch and event emits;
repeated branches and test commands are deliberately retained.

Registration root: [index.ts:144](../src/native/index.ts#L144) through line 170;
agent registration indirectly installs provider routes at
[agent.ts:1439](../src/main/agent.ts#L1439). Controller installation begins at
[index.ts:247](../src/native/index.ts#L247). `src/shared/api.ts` is a data-type
catalog, not a complete executable route schema: native actions also use
`src/shared/native-*`, and handlers still accept `any`/`unknown`. Those weaknesses
are retained visibly in the census rather than presented as typed guarantees.

Resolved dynamic paths:

- `requestReply(opts.reply)` registers `styles:read-reply` (500 ms) and
  `layers:read-reply` (800 ms), [preview-ipc.ts:298](../src/main/preview-ipc.ts#L298)
  and [preview-ipc.ts:368](../src/main/preview-ipc.ts#L368). Missing views, missing
  selection and timeouts return null; replies require actual preview sender identity.
- `source:${…}` selects create-file/rename-file/delete-file in
  [editor-controller.ts:92](../src/native/editor-controller.ts#L92).
  `edit:${action}` selects undo/redo in [index.ts:321](../src/native/index.ts#L321).
  Conditional Git set/checkout, preview load/reset and session rename routing are
  visible in their controller rows. `layers:select` is sent through controller
  action dispatch. A missing literal caller is not sufficient evidence of dead code.
- Provider tools are registered per session, not with `ipcMain`. See the tool
  inventory below. Injected router implementations are test seams, not extra
  production transports. `protocol.handle('trezi-media', …)` is a separate route.
- `serviceEvents` emits generic `event` and `command` envelopes in
  [platform.ts:64](../src/native/platform.ts#L64) and line 149. Consumers branch on
  channel and nested payload type. `AgentEvent` variants at
  [api.ts:278](../src/shared/api.ts#L278) are part of the contract, not extra RPCs.
- Host `*Perform`, `*Inspect`, capture and IME methods are present in dispatch;
  some are ephemeral-only, others are not. Do not grant this whole test surface
  to helpers or preview content when deriving production capabilities.

Unresolved gaps: this is static source coverage, not runtime call-frequency or
external SDK internals coverage. Provider-generated tool names, SDK subprocess
behavior, dynamically imported package internals, arbitrary project scripts,
external editors and Xcode tooling need runtime validation during their slices.
The census records registration/signature and textual references, not a whole-
program alias proof. No current general schema validator or universal repository
transaction can be inferred from the presence of TypeScript types or a queue.
No external endpoint, credential store or target project was queried for this audit.

## Current process boundary

Bun launches Swift as a child, owns the profile PID lock and registrations, then
restores controllers on `ready` ([index.ts:52](../src/native/index.ts#L52),
[index.ts:427](../src/native/index.ts#L427)). Swift consumes newline JSON and
schedules UI dispatch on the main queue; [Host.swift:175](../src/native/Host.swift#L175)
begins the command switch. Bun's [bridge.ts:16](../src/native/bridge.ts#L16) matches
numeric replies, defaults to 30-second timeouts and rejects pending requests on
host exit. Timeout does not cancel a Swift command. There is no wire version,
capability handshake, durable request deduplication, event replay or reconnect
protocol. Host closure normally triggers whole-application cleanup.

Swift already owns AppKit/SwiftUI rendering, window geometry, focus/IME, source
text views and local text Undo, native dialogs, file picking/trash, media playback,
WebKit navigation/download permissions, screenshot capture, and Keychain crypto.
These are not Bun services to port. The native controllers still decide most
workflow transitions and construct their snapshots. `NativeView('main')` is a
trusted in-process sender; only `preview` is a WebView. Do not reproduce retired
Electron abstractions as a new Swift browser service.

## Responsibility, state, effects and failure matrix

Each family inherits the exact route inputs/outputs and caller locations from the
route census. Module names below refer to full paths/entry points in the module
census; grouping avoids repeating the same state/failure description per getter.
Unless stated, there is no cancellable operation ID: errors are throws, strings,
nulls or per-route result unions; IPC timeout does not undo effects.

| Domain and current owner | State, persistence, dependencies and effects | Cancellation, recovery and trust |
| --- | --- | --- |
| Projects / Workspace — native workspace/shell controllers, workspace storage; main scaffold, icon | Roots, recents, active project/chat, preview status and LRU suspension in controller; `workspace.json` uses temp+rename. Detect package manager/framework; create repo/template; icons read project files; picker is Swift. Starts/stops agents and servers, ensures work branch. | Controller generations reject stale activation; closed/LRU projects stop sessions. Bad restore/startup is surfaced. Paths are trusted UI inputs but file services validate boundaries. Workspace selection is not a universal permission grant. |
| Conversation — agent, chat-controller/state/actions/snapshot/runtime, backends | Maps of live sessions, opening promises, active/intended keys, preparing/running turns, permission/question resolvers, spawn cap/queue; transcript records under profile `trezi`, SDK resume IDs, titles and run statistics. Composer drafts, queues and attachments are controller memory. Provider calls, private file edits and landing trigger preview/environment refresh. | Stop marks preparing work, interrupts provider with bounded wait; terminal tracker finalizes once; failed/interrupted turns cannot count as successful landing. Model switches preserve text handoff, not image bytes/full tool results. Pending UI requests belong to originating session, not current selection. |
| Isolation / Repository — chat-isolation, chat-worktrees, worktrees, repo-write-queue, live-commit, conflict-resolution, publish-scope/reconcile | Private worktree metadata, branch/base snapshots, park records and Git refs; per-repository promise queue protects coordinated live writes. Git processes, private indexes, filesystem writes, dependency linking/install, branch attach/retire/pruning. | Current successful turns reconcile/land automatically, failures park; duplicate terminal suppression and persisted recovery references. Startup orphan recovery and patch-equivalence checks exist. Non-Git/subdirectory sessions may edit live. Queue is process-local and not a crash transaction. Preserve user index and source Undo; never infer that every independent file writer already holds this queue. |
| Git navigation / Publishing — git, git-remote, github, annotations, publish-description; native git/review controllers | Branch/status/remote fetch, switch/tracking, publish lock, diff scope and recovery refs; Git/gh network subprocesses; publish creates commits, pushes, creates/merges PRs and cleans up. PR description evaluation uses provider helper. | Remote update guards dirty/running projects; publish retry/reconciliation and explicit conflict file reporting. Network failure can occur after remote effect. No universal cancel/rollback. These are existing capabilities, not authorization to invoke them during migration. |
| Memory — project-memory, backends/memory, agent; native sheets/autosave | Per canonical-root hash JSON in profile `trezi/project-memories`, 16,000-character cap, temp+rename; injected revision per session. Automatic tool-free provider evaluation serializes per project. | Manual save during evaluation wins via content/timestamp recheck and bounded retry; evaluation failure is a no-op. UI autosave preserves failed drafts and waits on close. Timestamp is not a protocol revision. Memory is excluded from Git and helper-owned application state. |
| Providers — providers/store, model-catalog, codex-models/usage, jev-credentials, backends/index | Saved connections/catalogs, model cache and custom endpoint resolution; encryption uses Swift helper through stdin, Keychain-backed AES-GCM. Model discovery may spawn Codex or fetch endpoint models. SDKs dynamically imported in Bun. | Bounded refresh/fallback; encrypted secrets never enter UI snapshots. Provider validation/network failures have specific results. Experimental Gemini is gated, not dead code. Capability differences must survive migration. |
| Source — props, props-typescript/svelte, html-source, styles/inline-style/styles-svelte, tokens/style-tokens/tw-*, move-node/splice/html/svelte, file-ops/tree, edit-history | Reads/parses project source, resolves imports/schemas, applies literal patches/removals/text/style/token/move writes, launches external editor or Swift trash. Per-root in-memory before/after Undo stacks with groups; file drafts and baselines in native editor-controller. AST/compiler dependencies include TS, Babel, docgen, Svelte, parse5. | Schema absence is prompt-only; ambiguous edits return agent prompts. Source hashes/text comparisons reject drift, grouped Undo validates expected files. Multi-file filesystem writes are not atomic. Preserve dirty drafts through navigation and treat symlink/root checks as server responsibilities. |
| Controls / Content — control-manifest/panels/selection, content-controls/ipc/tools, chat-islands/schema/source; native inspector/content | Sidecar control manifests and JSON recipes; profile chat-island records keyed to session/turn. Native drafts/generations, pending/ready islands, source revisions, gesture queues and Undo groups. Optional Jev picks validated blocks/sections. Content preserves unrelated JSON fields. | Missing bindings wait/retry; content corruption fails without overwrite; stale revisions preserve draft. Pending islands settle only after landing, are dropped on failure/Stop; background children cannot create islands. User gestures do not call models. Source/recipe mutations need the same repository writer. |
| Project composition — project-ui/catalog/jev, controls-jev | Bounded static React discovery, selected turn opt-in, catalog/spec/candidates → TSX or selected controls. Json-render/core/codegen and Gateway evaluations. Returned project UI source is not itself written. | Explicit Jev composition errors do not silently fallback; control selection has documented missing-key fallback. Cancellation/deadlines and validation; no helper permission to land generated source. |
| Runtime — devserver/net/processes, static-server, project-dependencies/worktree-dependencies; native preview-processes/recovery | Managed root→server records, allocated ports, log tails, readiness polling/retry, process groups, static HTTP/SSE and recursive watcher. Detects selected package manager/custom command; dependencies install in appropriate checkout. | Stop/quit drains groups, TERM then one-second grace/KILL; synchronous exit fallback. Static server path containment, no arbitrary adoption of healthy ports. Process death and restart are distinct from proof that preview serves latest worktree edits. |
| Simulator — simulator, xcode | Device/preflight/build/boot/install state, simctl/xcrun and bridge processes, MJPEG/touch/accessibility transport and logs; simulator hooks route preview selection. | Stop/quit tears down bridge/device work as implemented; preflight returns missing tooling guidance. External platform processes have partial-failure states; deterministic desktop checks do not establish device parity. |
| Preview — preview-ipc/state/tools/observation/evidence, native context/layers and recovery | Selected elements, pins/mode/status/bounds, pending style/layer reads, active URL/document evidence, deferred code/preview navigation after landing. Swift hosts isolated DOM instrumentation; preview JS remains JS. | Actual sender checks plus allowlist; style/layer timeout returns null; navigation/generation changes invalidate evidence. Screenshots observe current live UI, not private edits. Failed WebKit reloads eventually require retry. |
| Media / Attachments — media/types, attachments, native editor/composer | Bounded opaque token→validated file map; ranged media responses, native resolved paths, attachment bytes and MIME/size classification. `attachments:save` writes profile `trezi/attachments`; each save starts best-effort pruning of scratch files older than seven days; 25 MiB backend byte cap. `media` event bridges custom scheme; `mediaReply` returns status/headers/base64. | Attachment save failure returns an empty path, pruning errors are swallowed; unknown media token/path gives missing result; Swift stopped scheme task discards late response, not general Bun cancellation. Native media uses direct trusted path playback. No arbitrary preview file-read capability. |
| Setup / Skills / Rules — setup and react/next/mdx/artifacts, sidecar-migrate, bundled-skills, skills/install/packs, rules, scaffold | Detect source stamps/framework, generate dev plugins/config adapters, synchronize worktree helper files, install skills and legacy sidecar migration. Reads package/version/config and user/project skill paths. | Setup readiness tied to landing/new document; guard production transforms; preserve wrappers/custom commands. Sidecar restrictions apply to agents. Prompt guidance is not an OS sandbox. Legacy strings and explicit skill install behavior must be preserved. |
| Diagnostics / Support — diagnose/diag-rules/cache, feedback; native support/activity | Rule matching, optional provider diagnosis, profile diagnostics cache, proposed/applied/dismissed status; capture screenshot, gh issue submission; bounded activity logs. | Cache/AI failures can yield null; feedback reports errors/fallbacks. No universal cancel and no inferred permission to send feedback. Logs/tool details require redaction before any new transport. |
| Update / Preferences / Lifecycle — main update; native update-controller/preferences/index/shutdown/platform | Installation Git update status; clean-checkout/draft/busy guards; pull/install/build/restart; native preference map version 1 temp+rename; profile lock, bridge and quit hooks. | Rechecks restart guards, surfaces partial update failure; no implicit branch switch/discard. Corrupt preferences fail startup; cleanup is shared/idempotent promise, exit forced-stop fallback. Profile lock is separate from domain transactions. |
| Pure math/tool utilities — apca/vendor declaration, fluid, oklch, shadows, spring, type-metrics, ast-walk, svelte-instance | Deterministic values/AST traversal used by providers/editing; no durable authority. rpc-router and backend types describe seams only. | Calculator validation/errors remain tool-local. Retained wrappers without production callers are listed in UNUSED-HELPERS; do not treat their existence as a missing UI feature. |

## Native workflow ownership that RPC enumeration misses

All controller imports/exports are traced in the module census. Direct Swift events
(`composer-action`, `chat-action`, `island-action`, `source-action`, `content-action`,
`layers-action`, `inspector-action`, `sheet-action`, `shell-action`,
`native-preview-action`, `activity-action`, `menu`, `recent`, layout events) reach
Bun through Host emission and `host.on`, not through a typed UI service interface.

- Chat controller chooses draft/queue submit, pause/resume, model confirmation,
  permission/question responses and presentation snapshots. Chat runtime binds
  islands to records/turns and watches terminal/landing events.
- Workspace controller restores projects/sessions and orchestrates activation,
  shutdown, dependency refresh and preview restarts. Shell controller derives rows,
  icons, branch/URL/device/select state. Context controller captures selection and
  turn context, readiness, pins, background cards and pending navigation.
- Editor controller retains documents/baselines/dirty state across file/popout
  changes. Inspector controller serializes scrubs and schema/source writes.
  Content controller keeps recipe drafts and revision-aware saves. Layers
  controller guards stale reads/moves. These must not become generic UI callbacks
  with permission to write arbitrary paths.
- Sheet runtime, SheetAutosave, settings, support, Git, review and update
  controllers own draft retention, generation checks, confirmation/action flow
  and retry policy; Swift Sheets renders forms. ActivityController buffers logs.
- Preferences and workspace files are separate from provider history and the
  Electron profile. There is no justification for merging those stores.

## Provider-facing and non-IPC routes

[Trezi agent tools:7](../src/main/trezi-agent-tools.ts#L7) declares the complete
socket allowlist. Authenticated `POST /invoke` accepts `{action,args}`, responds
with `{ok,result}` or `{ok:false,error}`; 40 KiB body bound and mode-0600 Unix
socket ([trezi-agent-tools.ts:55](../src/main/trezi-agent-tools.ts#L55)). Session
token selects a registered handler, and dispose revokes it. Socket teardown is
normally process-owned; SDK/CLI tool forwarding is not another UI sender.

| Tool family / proposed domain | Existing tools; producer → handler and result |
| --- | --- |
| Repository | Codex `workspace_state`, `prepare_conflict_resolution` → session closure → chat-isolation authoritative evidence/staging; state/result only, no raw reset interface. |
| Preview / Source | Claude/Codex `preview_location`, `preview_screenshot`, `preview_inspect`, `preview_evaluate`, `preview_console`, `preview_viewport`, `open_preview`, `open_code` → observation/preview/code-tools. Return URL/image content or deferred navigation result; exact file/text validation, originating chat/turn and landing gates. Detached navigation is refused. |
| Controls / Content | `content_controls` catalog/define and `chat_island` catalog/define/read → content-control-tools/chat-islands with validated recipes/literal bindings; actual engine/fallback in results. |
| Composition | `project_ui_catalog`, `compose_project_ui` → project-ui/catalog/jev; opt-in scoped to submitted turn, returned source/spec, no live write. |
| Pure computation | Claude `spring_to_css`, `check_contrast`, `fluid_clamp`, `color_scale`, `layered_shadow`, `line_height` → math helpers; numeric/schema inputs → computed CSS/color/metric results. |
| Skills | Claude `list_recommended_skills`, `install_skills` → skill-packs/skills-install. Catalog/package selection → descriptions or installation result; install is an explicit filesystem/network operation, not pure computation. |

Claude registration is at [claude.ts:565](../src/main/backends/claude.ts#L565),
Codex preflight at [codex-mcp.ts:49](../src/main/backends/codex-mcp.ts#L49).
The executable is [bin/trezi-agent-mcp.mjs:61](../bin/trezi-agent-mcp.mjs#L61); its observation tool loop at line 108 registers location/screenshot dynamically and preserves image blocks. The MCP executable and dependency path come from that module; inventory must be
rechecked when SDKs change. Gemini CLI is environment-gated and does not expose
all these tools. Helper capabilities must describe these differences explicitly.

Background responsibilities without public routes include automatic title and
memory evaluations ([agent.ts:210](../src/main/agent.ts#L210)), spawn pumping and
terminal finalization (lines 404/596), worktree reclamation/recovery, model catalog
refresh at provider registration, server readiness/log parsing/restart, static
watch/SSE disposal, preview pending navigation/read timeout, content binding retry,
island settling, preference/layout persistence and shutdown hooks. Timers and
subprocess locations are indexed in the module census; these are migration work,
not incidental implementation details.

## Security and migration consequences

Preview inputs are untrusted even when syntactically typed. Maintain
[platform.ts:34](../src/native/platform.ts#L34)'s restricted send allowlist,
actual WebView identity stamped in Host, isolated WKContentWorld and origin-bound
navigation/media prompts. Neither page JavaScript nor provider tool arguments may
select a profile path, live checkout or arbitrary Swift method. Revalidate real
paths/symlinks and revision at commit time; source stamps are locators, not grants.

Current SDKs run in Bun with application privileges and inherited environment;
sidecar/tool guards are not a complete sandbox. Splitting processes alone does
not make helpers least-privileged. New helper restrictions require an enforceable
launch/OS policy and negative tests. Preserve project-selected runtimes; the app's
Bun version is not authority to replace npm/pnpm/yarn/Node inside target projects.

The architecture constraint against automatic merging/removal is adopted for
new migration work. Current automatic behavior is recorded above as a compatibility
hazard. The first slice does not touch it. A later repository slice must present
explicit intent gates and policy for review before replacing that code; recovery
must retain uncertain work. This proposal neither silently changes the product
nor treats existing cleanup as permission to perform cleanup now.

## Reproducing the census

Use Bun with the repository's installed `typescript` API: parse
`tsconfig.native.json`, create a Program/TypeChecker, recursively walk source files
and CallExpression nodes, and select property calls on `ipcMain`, `ipc`, `router`
with names `handle` or `on`. Record `getLineAndCharacterOfPosition(getStart())`,
resolve string literals or constants from `preview-channels.ts`, and render the
callback with `getSignatureFromDeclaration`/`signatureToString(NoTruncation)`.
Keep nonliteral expressions as unresolved rows and examine each factory call.
The source inventory takes ImportDeclaration and dynamic `import()` edges, export
entry points and effect-search line leads. A separate line scan takes Swift
`case "…"`/event emissions, `host.on/once`, `sendToMain`, `sendToRenderer`,
`safeSend`, `webContents.send`, `serviceEvents` and preview constants. Search all
source files for literal references to each channel; then inspect template-string
and conditional invokes rather than labeling unmatched rows unused.

The 133-site and 146-module counts are reproducibility assertions for this
baseline, not a future required count. Check additions/removals intentionally.
The event scan is a review index; nested AgentEvent variants are enumerated below
and shared Swift action structures are referenced by the module/dispatch census.

Current `agent:event` payloads, all intersected with optional `projectKey` and
`sessionId` ([api.ts:278](../src/shared/api.ts#L278)):

| Variants | Payload / consumers / proposed ownership |
| --- | --- |
| delta, status, commands | Text or SlashCommandItem list; chat controller consumes; Conversation stream. |
| permission-request, permission-resolved, question-request, question-resolved | Request specification or request ID; chat cards/resolvers; Conversation approval state. |
| usage | Input/output/cached token deltas; chat accumulator; Conversation usage, not independent invoices. |
| done, error | Optional landingPending or message; terminal tracking and chat busy state; Conversation outcome separate from Repository completion. |
| title | Generated title; chat/workspace/sidebar; Conversation metadata. |
| spawn-started, spawn-finished | Branch, origin and optional outcome/summary/files; context/background cards and environment refresh; Conversation child operation with Repository result. |
| reconciliation-started, landing-finished | Lifecycle signal; chat queue/controls activation; Repository operation projected into Conversation. |
| isolation | isolated/merged/parked, branch/files/Undo group/revertability; chat/context/workspace; Repository authority. |

App services also emit channel-specific devserver/simulator log, ready and exit
information, controls/content updates, source reveal and preview-open requests.
Their concrete producer/consumer expressions appear in the event census. They
must acquire operation/scope/revision envelopes during migration; a raw event
name does not presently promise durable ordering.
