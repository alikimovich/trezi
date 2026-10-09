# Swift-owned managed project runtime (S06)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-94, roadmap row S06 ("managed servers/dependencies/static serving; Swift
process supervisor") of the [canonical plan](SWIFT-BACKEND-PLAN.md) and
[roadmap](SWIFT-BACKEND-ROADMAP.md). It follows [preferences](SWIFT-BACKEND-PREFERENCES.md),
[workspace](SWIFT-BACKEND-WORKSPACE.md) and [memory](SWIFT-BACKEND-MEMORY.md).
Under the default launch (`TREZI_BACKEND_OWNER=swift`), the Swift service is the
only owner of the processes and sockets that serve a user's project: runtime
detection, dependency installs, dev-server process groups, port allocation,
readiness, the static site with its watcher and live-reload stream, and shutdown
and crash recovery. They move as one unit. Bun still decides *what* to run (the
detected command or the user's custom command) and still holds the repository write
lease around an install until S07.

- `src/service/RuntimeOwner.swift`: the owner (requests, starts, stops, installs,
  readiness, drain, the stamping helper) and its reply and event frames.
- `src/service/RuntimeServer.swift`: one project's server, its readiness and its
  output lines.
- `src/service/ManagedProcess.swift`: one process group (spawn, output, exit,
  stop), `ProcessGroup` signalling and `RuntimeJournal`.
- `src/service/ProcessGuardian.swift`: `runGroupWatchdog`, the per-group crash
  backstop (`TreziService --watch-group <pgid>`).
- `src/service/RuntimeDetect.swift`: detection, launch commands and failure
  messages, identical to `src/main/project-detect.ts`.
- `src/service/RuntimeNet.swift`: port allocation, readiness probes and printed-URL
  parsing, identical to `src/main/devserver-net.ts`.
- `src/service/StaticSite.swift` / `src/service/StaticServer.swift`: the static
  site (files, traversal rules, live reload, FSEvents watcher) and its HTTP layer.
- `src/native/runtime-service.ts`: Bun's client. `src/main/devserver-service.ts`
  serves the unchanged `devserver:*` routes on it; `src/main/devserver.ts` registers
  them. The rollback owner (`devserver-processes.ts`, `managed-child.ts`,
  `static-server.ts`) was removed in LKM-111.

## The domain, exactly

| Item | Owner (swift launch) | Owner (legacy launch) |
| --- | --- | --- |
| Detection: framework, package manager, dev command, static entry, setup-required | Swift (`RuntimeDetect`) | Bun (`project-detect.ts`) |
| Dev-server process groups, output, exit status, stop | Swift (`ManagedProcess`) | Bun (`devserver.ts` via the guardian) |
| Preview ports (allocation, reservation, release) | Swift | Bun |
| Readiness (assigned-port probe, printed-URL fallback, 90 s timeout) | Swift | Bun |
| Dependency install processes (`<manager> install`, 300 s) | Swift | Bun (`execFile`) |
| Static site: HTTP, traversal, MIME, live-reload SSE, FSEvents watcher | Swift | Bun (`static-server.ts`) |
| Crash backstops: per-group watchdog, `<profile>/service/runtime/processes.json` | Swift | the `--legacy` launcher sweeps the journal, then never touches it |
| Which command to run; custom commands; restart and warm eviction policy | Bun (workspace controller, S12) | Bun |
| Repository write lease around an install | Bun (`enqueueRepoWrite`, until S07) | Bun |
| HTML stamping (`data-trezi-source`, parse5) | Bun JS helper, asked by the static site | Bun |
| Legacy → `.trezi/` sidecar migration before detection | Bun (repository sidecar, S07) | Bun |
| Preview-evidence URL mirror for agent tools | Bun (from replies and `exit` events) | Bun |
| Persisted `url`, `launchSpec`, `dependenciesPending`, `environmentRevision` in `workspace.json` | Bun's workspace controller, through the S04 `update` adapter | Bun |
| iOS Simulator and Metro | Bun through the guardian (S14) | Bun |
| "Servers" recovery sheet (stop a foreign listener the user picked) | Bun (`preview-processes.ts`), not moved | Bun |

The domain holds no user data. The only file it writes is the journal, which is
service-private and lists groups this service launched and has not yet seen end.
The persisted server fields in `workspace.json` stay on the typed S04 adapter: they
are the controller's decisions (what to relaunch on restore), not process state, and
move with the workspace controller. The recovery sheet owns no process: it signals a
listener the user picked, only after re-checking its identity, and never force-kills.
Both are recorded in `docs/TASKS.md`.

## Rules

- **Selected runtime.** The package manager comes from the project: an explicit
  `packageManager` field, else `bun.lock`/`bun.lockb`, `pnpm-lock.yaml`,
  `yarn.lock`, else npm. Commands run through `/bin/sh -c` with the launch
  environment Bun was given, so the user's `PATH` picks their Bun, Node, pnpm or
  Yarn, as before. Installs run `<manager> install`, looked up on that `PATH`.
- **Command origins.** A dev command is a detection literal (`<pm> run dev|start`,
  `npx expo start`) or the user's custom command. It is never built from project
  file contents or agent output. Port flags are appended per framework as before.
- **Ports.** Loopback IPv4 from 7777, skipping fetch-blocked ports and ports this
  owner already reserved. A port is free only if `127.0.0.1` binds and neither the
  dual-stack `::` nor the IPv4 `0.0.0.0` wildcard reports `EADDRINUSE` (the IPv4
  wildcard probe is new), so a squatter on a wildcard is never handed out and then
  mistaken for the project's server.
- **Readiness.** The assigned URL is probed (1.5 s probes, 500 ms apart). If the
  server prints its own loopback URL, that URL's host variants are probed too. The
  first answer wins. An exit before readiness fails with the previous messages,
  and a port conflict or lock message becomes `conflict`. Ninety seconds without
  an answer fails `deadlineExceeded`, answered only after the group is gone.
- **Stop and restart.** `stop` answers once the group has ended: TERM, a one-second
  grace, then KILL. Repeated and concurrent stops join the first. A newer start or
  stop cancels a pending start (`cancelled`, "Preview start was cancelled."). A
  restart waits for the previous group to end before it takes a port or launches.
  A stop does not interrupt a running install; Bun discards the start that was
  waiting on it. Quit stops installs too.
- **Health (LKM-146).** A ready server is probed every 10 s (10 s timeout, since a
  cold page compile can be slow). Three unanswered probes in a row stop its group
  as unresponsive. Any HTTP status counts as an answer, so a 500 from a broken page
  is not a hang. Bun's preview supervisor restarts it with backoff.
- **Descendants.** Each server or install is the leader of its own process group.
  When the leader exits on its own, the rest of its group is stopped before the
  leader is reaped, so descendants never outlive it and the group ID cannot be
  reused while anything could still signal it.
- **Static site.** Same routes, MIME types, 404 page, 405 with `Allow`, directory
  index, no-cache headers, stamping and live-reload snippet as before. New:
  responses are `Connection: close`; a request head over 16 KiB is refused (431)
  and a malformed request line gets 400; and a file whose real path leaves the
  project (a symlink out of it) is refused (403). Before, only the lexical path was
  checked, so a repository could serve any file on the machine to its own preview
  page. Stamping asks Bun's JS helper and falls back to unstamped HTML after 5 s,
  on a helper error, or for pages over 4 MiB.
- **Watcher and live reload.** FSEvents on the project's real path, ignoring
  `.git` and `node_modules`, bumps the version at once and broadcasts after 80 ms.
  Pages carry the version they were served at, so a change made while no stream
  was open still reloads. A watcher that cannot start is logged and the site
  still serves. Stopping the site stops the watcher and ends every stream.
- **Logs.** Output is split into lines on bytes (a character split across reads
  survives), ANSI is stripped, blank lines are skipped, and each line reaches the
  Activity log as before. Install output is now logged too.

## Protocol

Bun uses the private pipe. Requests are S01 frames without a revision:
`{"service":"runtime","id":n,"request":{connection, requestID, operationID, scope:{}, mode, service:"runtime", method, body}}`.

| Method | Mode | Body | Result |
| --- | --- | --- | --- |
| `detect` | read | `{root}` | `DetectedProject` |
| `info` | read | `{root}` | `{running, server?}` (`server` once ready) |
| `start` | mutation | `{root, command, framework?}` | `RunningDevServer` `{url, pid, attached:false}` |
| `stop` | mutation | `{root}` | `{stopped}` after the group ended |
| `install` | mutation | `{root}` | `{installed}` (false without `package.json`) |
| `stopAll` | mutation | `{}` | `{}` after every group and site ended |

Unknown or missing fields, non-string values, a scope, a revision, a relative or
oversized root, NUL or lone surrogates are refused (`invalidRequest`) before
anything runs. A second install for the same project while one runs is `busy`.
Runtime operations are supersession, not revisioned state: the newest start or
stop for a project wins, as the legacy generation counter did. Bun's client
timeouts are bounded (start 150 s, install 330 s); a timeout rejects, and Bun never
spawns a server itself under the Swift owner.

Events: `{"event":"service-event","service":"runtime","kind":"log","root","line"}`,
`kind:"exit"` with `{root, url, reason}` when a ready server ends on its own or the
health check stopped it (`reason`: the exit code and output tail, or "The dev
server stopped responding."), and
`kind:"stamp"` with `{id, path, html}`, answered by Bun with
`{"service":"runtime-helper","id":n,"html":string|null}`.

## Process groups, crash recovery and no adoption

1. Launch: the leader gets a new process group, stdin `/dev/null`, one output
   pipe and no other inherited descriptor (`POSIX_SPAWN_CLOEXEC_DEFAULT`). A
   watchdog (`--watch-group <pgid>`) holds the read end of a lifetime pipe whose
   only writer is the service. The group and its leader's kernel start time are
   recorded in the journal.
2. Service death: the lifetime pipe closes, and the watchdog stops the group (TERM,
   0.5 s, KILL). A group whose watchdog was also killed is stopped by the journal
   sweep at the next launch, Swift or legacy, before Bun starts.
3. The sweep stops a recorded group only if its leader still has the recorded
   start time, or if the leader is gone while members remain. A recorded pid now
   held by an unrelated process is left alone. Nothing is ever adopted: a new
   service never takes over a running server. It starts a fresh one, and Trezi
   still never attaches to a server the user runs themselves.

## Rollback (tightened to this domain)

- **Launch-time switch only.** Quit Trezi, then relaunch with
  `TREZI_BACKEND_OWNER=legacy`. The profile lock admits one owner.
- **Drain before switching.** At quit the service waits for Bun to exit, then
  refuses new runtime requests and stops every group, install and site it owns
  (bounded to 5 s) before it releases the ledger and the profile lock. Bun also
  asks for `stopAll` during its own cleanup. The `--legacy` launcher sweeps the
  journal under the lock before it starts Bun, so a legacy runtime never overlaps
  a group the Swift owner started, even after a crash.
- **What is preserved.** This domain has no user data, drafts, receipts or
  worktrees. Project files, `node_modules` and `.trezi/` are untouched by the
  switch. `workspace.json` server fields are written by the same S04 adapter in
  both launches. The journal stays in place; the legacy owner only empties it.
- **Returning to Swift.** A fresh Swift launch sweeps the journal (empty after a
  clean quit) and starts servers on demand. Nothing is restored from an old state.
- **Reverting the code.** A pre-LKM-94 build ignores `service/runtime/` and runs
  its own servers through the guardian as before.

## Verification

`test/runtime-owner.mjs` (unit tier) compiles the real owner into a fixture process
that is also its own watchdog, and drives it through Bun's real client:
- **Parity.** Twenty detection cases (lockfiles, `packageManager`, RN/Expo, static,
  setup-required, invalid and non-object manifests, overridden dependencies,
  duplicate keys, a missing root), launch commands, failure messages, and URL
  matching, ANSI stripping, normalization, host variants and JS `trim()`.
- **Process lifecycle.** Early exit, port conflict, descendants of an exited
  shell, failed readiness (group gone before the answer), three concurrent stops
  of a TERM-ignoring group (KILL after the grace), restart without overlap, strict
  frames that run nothing.
- **Installs.** npm, a Bun lockfile running `bun install`, a missing manager, a
  failing install with its output, descendants cleaned, no manifest, `busy`, the
  300 s bound (shortened in the fixture) and Bun's queue wrapper.
- **Routes.** `devserver:*` on the owner: a stop during a start's install
  discards that start.
- **Crash recovery.** SIGKILL of the service stops the group through the watchdog.
  Without a watchdog, the next launch's sweep stops the orphan. A recorded pid
  with another start time is left alone; the exact identity is stopped.
- **Drain.** Close stops two servers (one ignoring TERM) and an install, empties
  the journal and refuses later requests.
- **Static HTTP** over a socketpair: stamping and snippet, HEAD, MIME, 404, ten
  traversal and encoding cases, symlinks out (403) and in (200), 405, 431, 400,
  and the live-reload stream (version, broadcast, stale reconnect, close).
- **Watcher**: changes bump the version, `.git`/`node_modules` do not, and a closed
  watcher reports nothing. **Stamping helper**: stamped, and unstamped after a
  helper error, an oversized answer or no answer.
- **Sockets** (a real listener): the static site, a real Bun server on its port,
  restart, the printed-URL fallback, a listener on `127.0.0.1`, `0.0.0.0` or `::`
  marking its port occupied, a child that hits `EADDRINUSE` on a port held at its
  exact address reported as `conflict` within seconds (not on the readiness timeout),
  and `stopAll`. The section runs with a 12 s readiness timeout, so a start that never
  becomes reachable fails fast instead of waiting 90 s.

The fixture is a 16-file `swiftc` build. The test caches the binary under
`$TMPDIR/trezi-runtime-owner-cache`, keyed by every source's bytes and the compiler
version (built privately, renamed into place), so a cold run beside other
Swift-compiling tests stays inside the 120 s runner cap and a warm run takes about 9 s.

The watcher needs FSEvents and the socket section needs local port binding. Where
the environment forbids either, those sections are reported and the test ends in
SKIP, never PASS. `test/service-process.mjs` builds the real service with the
owner and checks that the legacy launcher sweeps the journal without signalling an
unrelated pid. The native smoke's fixture project is a static site, so
`bun run test:native` exercises the Swift static site end to end.
