# Swift platform owner: Simulator, media, attachments, server recovery (S14)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-101, roadmap row S14 ("Simulator and platform process integration") of the
[canonical plan](SWIFT-BACKEND-PLAN.md) and [roadmap](SWIFT-BACKEND-ROADMAP.md). It follows
[workflows](SWIFT-BACKEND-WORKFLOWS.md). Under the default launch (`TREZI_BACKEND_OWNER=swift`)
the service's platform owner performs the OS services Bun still ran itself: the iOS
Simulator preview, the source editor's media access, pasted composer images and the
"Running servers" recovery sheet. Bun keeps the views, the sheet and one proposing input
(the bridge page's bezel artwork, `src/shared/iphone-frame.ts`, sent with each start).

- `src/service/PlatformOwner.swift`: requests, validation, intents, drain.
- `src/service/SimulatorOwner.swift`: `SimulatorCoordinator` (preflight, device choice, boot,
  the app's launch command as a supervised group, idb, picks, stop, supersede) and `MetroGate`.
- `src/service/SimulatorBridge.swift`: the loopback bridge (page, MJPEG stream, control) and
  `FrameCapture`.
- `src/service/SimulatorTools.swift`: the xcrun/idb parsing (Bun's `xcode.ts` twin was removed in
  LKM-111) and the bridge page.
- `src/service/PlatformMedia.swift`: `MediaScopes` (media grants) and `AttachmentUploads`.
- `src/service/PlatformTools.swift`: `PlatformTool` (bounded tool runs), `ToolScope`
  (cancellation) and `PreviewServers` (the recovery sheet's inspection and stop).
- `src/native/platform-service.ts`: Bun's client; `src/main/platform-owner.ts` is the seam and
  `src/main/simulator.ts` wires the Simulator views. The rollback owner (`media.ts`,
  `attachments.ts`, `preview-processes.ts` and the process half of `simulator.ts`) was
  removed in LKM-111.

## The domain, exactly

| Item | Owner (swift launch) | Owner (legacy launch) |
| --- | --- | --- |
| Simulator preflight, boot, `open -a Simulator`, idb probe/recovery (`pkill -f idb_companion`, `/tmp/idb`) | Swift, every tool run bounded and cancellable | Bun (`simulator.ts`) |
| The app's launch command (`npx expo run:ios` or the user's) | Swift process group, watchdog + runtime journal | Bun (`spawnManagedCommand`) |
| Sim bridge (127.0.0.1 ≥ 7800: page, `/stream`, `/control`), frame capture, idb input, element picks | Swift | Bun (Node `http`) |
| Media for the native source editor (`trezi-media://f/<token>` → path) | Swift grants (view, size, identity, SHA-256, expiry) | Bun registry (`media.ts`) |
| Pasted images `<profile>/trezi/attachments/<stamp>-<stem>.<ext>`, 7-day pruning | Swift (chunked, hash-checked upload) | Bun (`attachments.ts`) |
| Running-servers sheet: list project listeners, SIGTERM one | Swift (`PreviewServers`) | Bun (`preview-processes.ts`) |
| Bezel artwork, sheet and simulator UI, `simulator:log` into Activity | Bun (proposes / displays) | Bun |

Retired, not moved: the `trezi-media` WebKit scheme route (Host `media`/`mediaReply`, Bun's
`protocol.handle`). No WebKit view registered the scheme, so it was unreachable, but it was a
Bun file-read path by token; the native editor shows media by path.

## Rules

- **One simulator preview.** A newer start or a stop supersedes a start still under way: its
  `ToolScope` signals every tool it is waiting on (a 120 s `bootstatus`, a build) and the start
  answers `cancelled`. A restart stops the previous bridge and Metro group before its own
  preflight, so two never overlap. The booted simulator stays booted (as before).
- **Supervised launch command.** The command is the default literal or the user's own
  (never project or page content), run by `/bin/sh -c` as its own process group with the
  runtime owner's watchdog and journal (`<profile>/service/runtime/processes.json`). Failure
  before readiness (a build error, an early exit, no frame within 30 s) stops the group.
- **Bounded tools.** `xcrun`, `idb`, `pkill`, `lsof` and `ps` run without a shell, in their own
  group, with a deadline (TERM, then KILL), separate bounded stdout/stderr, and anything left in
  the group stopped before the leader is reaped.
- **Bridge.** Loopback only; every request must name the bridge's own host (DNS rebinding);
  `/stream` and `/control` need the per-bridge token baked into the page (no CORS headers);
  control bodies ≤ 4 KiB; at most eight viewers; a viewer that cannot take a frame within 2 s is
  dropped. The bezel URI is accepted only as `data:image/(png|svg+xml|webp);base64,…` (≤ 512 KiB).
- **Media grants.** Granted only to the `source` view (the native editor), for a file the source
  service's path rules allow (no traversal, `.git`, sidecars or `node_modules`; a symlink only to
  another project file), a previewable media type and ≤ 256 MiB. A grant is a random token (not a
  path hash) bound to the file's device, inode, size, modification time and SHA-256, and expires
  after 15 minutes without use. Resolving re-authorizes the path and re-checks the identity: a
  different view is refused, an expired, unknown or changed grant is refused and revoked. Bun's
  client then asks for a new grant (the file is authorized and hashed again). At most 500 grants;
  one per file and view. Grants are memory only.
- **Attachments.** `attachmentOpen {mediaType, bytes, sha256}` fixes an image type, a size
  (≤ 25 MiB, the legacy cap) and the hash; 1 MiB chunks must arrive in order; an upload idle for
  60 s is dropped; at most four at once. Only a complete upload whose hash matches is written
  (atomically), into a real `attachments` directory of this user (a link is refused), with the
  legacy name. Each save prunes regular files older than seven days; links are never followed or
  removed. The legacy contract stands: a failure answers `''`.
- **Server recovery.** Only this user's TCP listeners whose working directory is the project
  folder; the service, its parent, supervised Bun and the host are never listed. A server is
  identified by pid, kernel start time (`identity`), command, folder and addresses; all are
  re-checked immediately before SIGTERM, and nothing is force-killed.
- **Intents.** `simulatorStart`, `simulatorStop` and `serverStop` need an explicit intent.

## Protocol

Private pipe, S01 frames, no revision, empty scope: `{"service":"platform","id":n,"request":{…}}`.
Events: `{"event":"service-event","service":"platform","kind":"simulator-log","line"}` and
`kind:"simulator-picked"` `{source|null, tag}`.

| Method | Mode | Body |
| --- | --- | --- |
| `status` | read | `{}` |
| `simulatorPreflight` | read | `{}` → `SimPreflight` |
| `simulatorStart` | mutation | `{root, intent:"start", frame:{uri, inset, aspect}, command?, udid?}` → `RunningSimulator` |
| `simulatorStop` / `simulatorSelect` | mutation | `{intent:"stop"}` / `{active}` |
| `mediaGrant` / `mediaResolve` | mutation / read | `{root, path, view}` / `{token, view}` |
| `attachmentOpen` / `attachmentChunk` / `attachmentCommit` | mutation | `{mediaType, bytes, sha256, name?}` / `{upload, offset, data}` / `{upload}` |
| `servers` / `serverStop` | read / mutation | `{root}` / `{server, intent:"stop"}` |
| `openLink` / `openFile` (LKM-102) | mutation | `{url}` (http(s) only) → `{}` / `{path}` → `{error}` (`""` on success) |
| `openInEditor` (LKM-102) | mutation | `{root, path, line, column?}`: a file inside the project; `code -g`, `cursor -g`, `zed`, `subl`, then `open` → `{ok, error?}` |

`PlatformOpen.swift` replaced Bun's own `open` and editor CLI runs (`native/platform.ts`,
`main/props.ts`). Their rollback twins were removed in LKM-111;
`test/helpers/platform-checks.mjs` (`checkOpen`) checks the owner's argv against
scripted `open`/editor commands.

## Rollback (tightened to this domain)

- **Launch-time switch only.** Quit, relaunch with `TREZI_BACKEND_OWNER=legacy`; the profile
  lock admits one owner.
- **Drain before switching.** At quit, after Bun has exited, the service stops the simulator
  preview, its bridge and the Metro group (bounded, 5 s) together with the runtime owner's
  groups, before the lock is released. A group a crashed service left is in the runtime journal,
  which the next Swift launch and the `--legacy` launcher both sweep first, so the legacy
  simulator never overlaps it.
- **What is preserved.** Attachments keep their folder and names, so both owners read and prune
  the same files (tested both ways). Media grants and uploads are memory only: after a switch the
  legacy registry issues its own URLs, and after a return to Swift an old URL is granted again,
  never trusted. The simulator keeps no state beyond the runtime journal.
- **Reverting the code.** A pre-LKM-101 build has the TS owners and ignores nothing new on disk.

## Verification

`test/platform-owner.mjs` (unit tier) compiles the real owner into a fixture
(`test/fixtures/platform-owner/main.swift`) and drives it through Bun's client, with a scripted
`xcrun`, `idb`, `pkill` and Metro (`fake-*.mjs`); the test re-runs itself with them on PATH so
the legacy preflight is compared on the same tools. Covered: parity of the pure helpers and of
preflight in seven modes (Xcode missing, license, no runtimes, no devices, SDK/runtime mismatch,
a failing list, available); simulator unavailable (nothing booted or launched); a view-only
bridge (page, foreign `Host`, tokens, stream, control, eight-viewer cap, Stop); restart with no
overlap; stale-companion recovery; idb input and element picks; cancel during boot and while
waiting for Metro (the waiting group and its descendants gone); a newer start superseding one
still booting; build failure, early exit and no frames (group stopped, journal empty); drain on
close; a crashed owner's Metro group swept at the next launch; media grants (views,
containment, links, size, types as the legacy table, changed and swapped files, expiry and its
extension, bound, restart); attachments (legacy names, caps, hash and order checks, idle expiry,
concurrency, pruning, a linked folder, legacy pruning of the same folder); server recovery
(project listeners only, legacy inspection agreement, identity re-checks, protected parent,
unrelated server survives); schema and denied capabilities.

Not verified here: a real Xcode, simulator, idb or Expo build (no device work in the fixture;
the tools are scripts), `open -a Simulator` from the XPC service, and the native smoke (it has
no simulator path). Supported platform: macOS only, as the whole service; the non-Mac branch of
the legacy preflight no longer applies under the Swift launch.
