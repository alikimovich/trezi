# Swift service, XPC connection and legacy supervision (S02)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-89, step S02 of the [canonical plan](SWIFT-BACKEND-PLAN.md) and
[roadmap](SWIFT-BACKEND-ROADMAP.md). This step moves **process supervision and
profile exclusion** to a separate Swift service. It moved **no domain writer**.
Since LKM-91 the service writes preferences ([preferences](SWIFT-BACKEND-PREFERENCES.md)),
since LKM-92 workspace identity, order and selection ([workspace](SWIFT-BACKEND-WORKSPACE.md)),
and since LKM-93 project memory ([memory](SWIFT-BACKEND-MEMORY.md)); Bun remains the
single writer of sessions, annotations, Git/worktrees, source edits and managed servers.

## Topology

```
open -a Trezi / trezi ── TreziHost (AppKit) ──XPC── TreziService ──pipes── Contents/Helpers/bun Contents/Resources/backend/index.cjs
(bun run dev: scripts/start-native.mjs)                 │                      └─ TreziService --guard … (detached servers)
                                                        ├─ TreziService --guard-backend (holds profile lease)
                                                        └─ provider helpers (bun provider-helper.cjs, one per session)
```

- `src/native/ServiceClient.swift` / `src/native/HostService.swift`: the host's
  connection, handshake, reattach and AppKit quit/restart integration.
- `src/service/ServiceRuntime.swift`: listener, peer checks, launch, legacy relay,
  drain. `src/service/ServiceXPC.swift`: the control frame codec and limits.
- `src/service/BackendSupervisor.swift`: `ProfileExclusion` and the Bun process
  group. `src/service/ProcessGuardian.swift`: lifetime-pipe guardians.
- `src/service/OperationLedger.swift` (S03): opened under the profile lock at the
  first launch hello, before Bun starts. See [the ledger](SWIFT-BACKEND-LEDGER.md).
- `src/service/PreferencesOwner.swift` (S03, LKM-91): the preferences writer. Bun
  lines starting `{"service":"preferences"` go to it, not to the host; see
  [preferences](SWIFT-BACKEND-PREFERENCES.md).
- `src/service/WorkspaceOwner.swift` (S04, LKM-92): the workspace writer, on the
  same pipe (`{"service":"workspace"`); `src/service/DomainChannel.swift` is the
  ordered inbox and bounded drain both domains share. See
  [workspace](SWIFT-BACKEND-WORKSPACE.md).
- `src/service/MemoryOwner.swift` (S05, LKM-93): the project memory writer, on
  the same pipe (`{"service":"memory"`) and the same `DomainChannel`, drained at
  stop like the other two. See [memory](SWIFT-BACKEND-MEMORY.md).
- `src/service/RuntimeOwner.swift` (S06, LKM-94): the managed project runtime,
  on the same pipe (`{"service":"runtime"`, plus `runtime-helper` stamping answers).
  It launches project groups itself, each with a `--watch-group` watchdog and a
  journal entry, and is drained at stop after Bun exits and before the lock is
  released; the service sweeps that journal before Bun starts. See
  [runtime](SWIFT-BACKEND-RUNTIME.md).
- The later owners (repository, source, conversation, providers, editing, workflows,
  platform) ride the same pipe; since LKM-111 Bun spawns no managed process itself
  (`managed-child.ts` was removed with the rollback launch).

The XPC service is bundled at
`Trezi.app/Contents/XPCServices/dev.trezi.service.xpc` and copied to
`out/native/TreziService` for the development launcher's `--resolve-profile`. The build
ad-hoc signs all three.

## Connection contract

One bounded selector, `exchange(Data) -> Data`, plus `receive(Data)` for events.
No filesystem, provider or preview selectors are exported.

- Frames: `ServiceControl` v1.0, kinds `hello | legacy | wait | cancel | shutdown`.
  Unknown fields, a field not allowed for the kind (`resume` outside hello,
  `payload` outside legacy), non-UUID connection/request IDs and an unsupported
  version are rejected. Control frames are capped at 64 KiB; legacy UI frames at
  32 MiB (screenshots/media replies), separately from S01 domain DTO limits.
- Peer identity, both directions: the service requires the host's designated
  signing requirement and the same effective UID; the host requires the
  service's. A different executable in the same bundle is refused.
- Negotiation fails closed: role must be `ui`, versions exactly `[1.0]`, schema
  `trezi-supervision-1`, capabilities exactly `legacy.ui@1` + `supervision@1`.
  The UI role grants no provider, parser or preview capability.
- One active peer process per service instance. The first hello carries the
  launch (absolute Bun, backend and profile paths); later hellos must repeat it
  and name the negotiated epoch in `resume`. A fresh instance (launchd restarts
  a lost service on demand) refuses `resume` with `recoveryRequired` and starts
  no Bun; the host then exits instead of adopting a new epoch.
- Request IDs are unique per connection and never replayed. A send whose
  outcome is uncertain (no reply, failure, disconnect while pending) terminates
  the host fail-closed. Frames produced before the handshake or while
  reconnecting were never submitted and wait in a bounded outbox.
- `wait`/`cancel` prove request-scoped cancellation (30 s bound, 128 per peer).
  Disconnect answers outstanding waits `unavailable`.
- Disconnect leaves Bun running for a 5 s same-process reattach window, then
  drains. Up to three reconnect attempts are made by the host.
- `serviceStopped` is final: the service has drained Bun and released the
  profile, so the client invalidates, never reconnects, and completes shutdown
  locally. (Reconnecting would wait on launchd's ~10 s respawn throttle.)
- Bridge pipes are read with `FileHandle.readAvailable(upTo:)` (POSIX `read`).
  `read(upToCount:)` blocks on a pipe until the full count or EOF, which held
  every short JSON line from Bun indefinitely. Writes to Bun run on their own
  serial queue and Bun's lines are delivered asynchronously, so a full stdin
  pipe can never stop the stdout reader (two-pipe deadlock). Stop waits up to
  2 s for accepted frames to reach Bun before closing its stdin.
- Diagnostics: before the first hello the client passes its stderr
  (`attachDiagnostics`, an XPC file descriptor). It becomes Bun's stderr, since
  an XPC service's own stderr is discarded; Bun's logs and smoke failures reach
  the terminal as they did on the legacy pipe.

## Supervision and termination

- `ProfileExclusion` takes a non-blocking `flock` on `<profile>/service.lock`
  (never unlinked, so no second inode can admit a second owner) and reserves the
  legacy `<profile>/native.lock` with its PID via `O_EXCL`. A live or malformed
  `native.lock` refuses; only an `ESRCH` owner's lock is replaced.
- Bun runs in its own process group under `--guard-backend`, which holds a
  duplicate of the lock descriptor. A service crash therefore keeps the profile
  excluded until the guardian has drained Bun.
- Detached project servers and Metro run under `--guard`: their read end of the
  service's lifetime pipe (fd 3) closes when Bun or the service dies, and the
  guardian TERMs then KILLs its group (0.5 s). Bun's synchronous force-stop sends
  TERM to guarded groups so the guardian can clean descendants.
- Shutdown: TERM the Bun group, at least 1.5 s grace when guarded (Bun's own
  one-second drain fits inside), then group KILL and reap. Concurrent and
  repeated shutdown calls join one cleanup.
- Exit status: the launcher returns the host's status. Bun sends
  `quit {status}`; the service sends `serviceStopped {status}` when Bun exits on
  its own. The host applies a non-zero status in `applicationWillTerminate`,
  because `NSApp.terminate` exits the process itself. Terminal signals to the
  host drain through the service.
- Quit returns `.terminateCancel`, drains, then calls `NSApp.terminate` again.
  `.terminateLater` parks AppKit in a modal-panel run loop that is not
  guaranteed to service the main queue carrying the client's replies and its
  own timeouts, so the drain could hang indefinitely. A 20 s watchdog
  exits 1 if the service never answers.
- In-app restart (updates) asks the host to quit, waits for the service's drain
  acknowledgement, then relaunches `scripts/start-native.mjs`.

## Launch-time owner selection and rollback (history)

LKM-111 removed this: there is one launch (host → XPC service → Bun), `TreziService`
has no `--legacy` mode and nothing reads `TREZI_BACKEND_OWNER`
(`test/retirement-census.mjs` fails if a shipped file names it). What follows is the
S02 record.

`TREZI_BACKEND_OWNER` was read once, at launch, by `scripts/start-native.mjs`:

| Value | Launch |
| --- | --- |
| `swift` (default) | host → XPC service → Bun |
| `legacy` | `TreziService --legacy` → Bun, which spawns the host over stdio pipes (the pre-S02 transport) |

Any other value refuses to launch. Both paths take the same `ProfileExclusion`,
so the owners can never overlap; there is no hot switch. The domain affected by
this step is the profile-owner lock and process lifetime only:

- Files: `service.lock` (new, inert to older builds) and `native.lock` (same
  format as before: the owning PID). No store, journal, receipt, draft or
  worktree format changes, so neither path reads a backup or rewrites data.
- To roll back: quit Trezi (drain completes and releases the lock), relaunch with
  `TREZI_BACKEND_OWNER=legacy`. To revert the code entirely, a pre-S02 build
  sees `native.lock` owned by a dead PID and replaces it as it always did.
- Tested: `test/service-process.mjs` launches the rollback owner, proves a
  contender is refused, writes newer state while it runs, drains and verifies
  the newest data survives; `test/native-service-launch.mjs` pins both specs.

## Verification

`test/service-process.mjs` (unit tier) compiles the real Swift sources and
proves, with real processes: profile lock contention and legacy-lock refusal,
startup failure, child death, repeated/concurrent shutdown, descendant and
detached-server cleanup, service-crash drain under the inherited lease
(profile recovery after a SIGKILLed holder; the rollback launcher it once also
launched is gone since LKM-111), the control codec, signed-peer rejection, closed version /
schema / capability / role negotiation, startup failure over XPC, legacy frame
relay, cancellation, same-epoch reattach, refused stale/duplicate hellos,
reconnect with a queued frame, and backend death → `serviceStopped {status: 1}`
→ prompt local shutdown with no replacement Bun.

The XPC half requires launchd service lookup; a Seatbelt-sandboxed runner gets
`Connection init failed at lookup … Sandbox restriction` and cannot pass it.
`--supervision-only` runs the rest. `bun run test:native` launches the real app
through the service path. Ad-hoc signatures pin the peer by cdhash, so host and
service must come from the same build (the build always produces both).
