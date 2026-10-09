> **Retired:** Browser and Tailscale modes were removed with Electron. This document
> records the previous architecture; these commands are no longer available.

# Browser and hosted Trezi

Status: mode 1 local-browser foundation implemented, 2026-09-03. A secure,
single-client mode 2 slice shipped 2026-09-04; multi-client controls and a user
service remain follow-up work. Hosted modes remain deferred.

**Product decision (2026-09-03):** prioritize modes 1 and 2—local browser and
remote browser controlling a local workstation. Hosted Railway and multi-user cloud
workspaces are deliberately deferred. Build the common boundaries so hosting remains
possible later, but do not incur hosted persistence, orchestration, or billing scope
during the local-browser work.

## Running mode 1 today

```text
trezi serve /absolute/path/to/repo
```

Trezi builds when needed, starts its workspace engine without a desktop window,
opens the default browser, and keeps running until the terminal process is stopped.
Use `--port=4173` to choose the control port or `--no-open` to print the URL without
opening it. Omitting the repository uses the current directory.

The first usable slice supports the existing project-open flow, dev-server lifecycle,
Git/GitHub status, provider/session setup, chat commands and streamed agent events,
the embedded project preview, and click-to-select source metadata. The Electron app
continues to work unchanged. Browser-only fallbacks for native features such as the
file picker, pop-out editor, screenshots, iOS Simulator, and the full props/styles/
layers toolchain remain follow-up work; unsupported actions fail closed rather than
receiving broad shell or filesystem access.

Mode 1 binds only to IPv4 loopback. Its printed launch secret is single-use and is
exchanged for an `HttpOnly`, `SameSite=Strict` cookie before the clean URL loads.
The server validates `Host` and exact RPC/WebSocket `Origin` values, and every
repository-scoped command is pinned to the CLI-selected real path. The project
preview is served from a separate random loopback origin in a sandboxed iframe. Its
selection bridge uses both that exact origin and a per-run capability token.

## Running mode 2 today

Install Tailscale on both machines, sign them into the same tailnet, then run this
on the workstation that owns the repository:

```text
trezi serve /absolute/path/to/repo --remote
```

Trezi checks that Tailscale is connected and that Serve is enabled. The first run
may print a Tailscale activation link; open it once, enable Serve for the workstation,
and rerun the command. Copy the printed `Open once:` URL to the other machine. Remote
mode deliberately does not open that URL on the workstation, because doing so would
consume the single-use pairing secret before the other browser receives it.

The control UI and untrusted project preview remain on separate origins. By default,
Trezi listens only on local ports 4173 and 4174 and asks Tailscale Serve to publish
them as tailnet-only HTTPS ports 8443 and 8444. Use `--port`, `--preview-port`, or
`--remote-port` to resolve a conflict; the preview's remote port is always one above
`--remote-port`. The session cookie is `Secure`, and HTTP RPC plus WebSocket upgrades
still require the exact public origin. A reconnect cursor replays events missed while
the remote browser sleeps or changes network.

Stopping Trezi normally removes both Tailscale Serve routes and revokes the browser
session. If the process is force-killed, clean up its two default routes without
resetting unrelated Serve configuration:

```text
tailscale serve --yes --https=8443 off
tailscale serve --yes --https=8444 off
```

This first mode 2 slice pairs one browser profile for one Trezi process. A connected-
client list, selective revocation, multi-client writer arbitration, and launchd/systemd
packaging are intentionally still pending.

Trezi should be able to present the same browser UI while running its workspace
engine in three places:

1. **Local browser:** the browser and workspace engine run on the same machine.
2. **Remote browser, local workspace:** Trezi and the repository run on one
   workstation; an authorized browser on another machine controls them.
3. **Hosted workspace:** the UI and workspace engine run on remote infrastructure
   such as Railway; the repository is cloned into an isolated server workspace.

The first two modes preserve Trezi's current local-repo and subscription-login
model. The third is a cloud IDE and has a materially different trust, persistence,
and credential model.

## Product shape

```text
                          HTTPS + WebSocket
 Browser renderer  <------------------------------>  Trezi control API
      |                                                        |
      | postMessage                                            | typed commands/events
      v                                                        v
 Preview iframe  <---- preview bridge ---->  Workspace engine / agent / Git / dev server
```

The React renderer remains one client. The location of the workspace engine is a
deployment choice, not a separate UI implementation.

### Keep the current contract

`src/shared/api.ts#TreziApi` remains the source-level client contract. Add a
serializable, schema-validated command/event protocol underneath it:

- Electron adapter: `TreziApi` -> the existing `ipcRenderer` transport.
- Browser adapter: `TreziApi` -> HTTP for commands/uploads and WebSocket for
  agent/dev-server/preview events.
- A browser bootstrap installs the selected adapter as `window.api`, allowing the
  renderer to migrate without rewriting every call site at once.

Do not expose arbitrary shell, filesystem, or Git RPC methods. Preserve the current
task-shaped API (`source.write`, `git.checkout`, `agent.send`, etc.) and validate
payloads at the server boundary.

### Extract the workspace engine from Electron

Many modules contain ordinary Node/Bun business logic but register `ipcMain`
handlers directly. Split each area into:

1. a runtime-neutral service accepting a request plus an authenticated workspace
   context;
2. an Electron registration adapter;
3. an HTTP/WebSocket registration adapter.

Start with project detection, dev-server lifecycle, source reads/writes, Git, and
one agent session. Then migrate props/styles/tokens, history, background worktrees,
publishing, and diagnostics. Keep filesystem root validation and the live-checkout
writer queue in the shared service layer so the transports cannot drift on safety.

## Preview in a normal browser

Electron currently injects `src/preview/preload.ts` into a `WebContentsView`. A
normal parent page cannot inspect a cross-origin preview iframe. Replace the
Electron-only edge without duplicating the DOM behavior:

1. Extract selection, layers, computed-style reads, annotations, and inline text
   editing into a transport-neutral preview runtime.
2. Keep a tiny Electron transport using `ipcRenderer`.
3. Add a browser transport running inside the preview and communicating with its
   parent through a versioned `postMessage` protocol.
4. Extend the existing dev-only React/Svelte instrumentation so it can load that
   browser bridge. For unsupported frameworks, let the preview gateway inject the
   bridge into development HTML when safe, with selection falling back gracefully
   when injection is impossible.
5. Validate both `event.origin` and an unguessable per-preview channel token.

Serve preview content from an origin separate from the Trezi control UI. Project
code is untrusted: it must not inherit Trezi cookies, read the control page, or call
workspace APIs directly. The preview gateway must proxy HTTP and WebSocket traffic
to the project's private dev-server port, including HMR upgrades and redirects.

## Mode 1: local browser

The shipped command is:

```text
trezi serve /absolute/path/to/repo
```

It starts the control API, browser assets, workspace engine, and project dev server,
then prints/opens a local URL. Default behavior:

- bind only to `127.0.0.1`;
- generate a launch secret, exchange it for an `HttpOnly`, `Secure` when applicable,
  `SameSite=Strict` session cookie, and remove it from the visible URL;
- enforce exact `Host`/`Origin` allowlists to prevent DNS-rebinding and cross-site
  WebSocket attacks;
- select repositories on the server side (CLI path, recents, or a native helper),
  because a web file picker cannot grant shell/Git access to an existing path;
- keep provider credentials and filesystem paths out of browser state.

Electron can remain a supported shell over the same extracted engine. Native menu,
window, keychain, trash, editor-launch, and screenshot behavior become optional
platform capabilities with browser fallbacks.

## Mode 2: remote browser controlling a local workstation

This is the recommended remote mode when the repository should remain on the machine
running Trezi. The server still binds to loopback; an authenticated private tunnel
publishes only the Trezi HTTPS endpoint.

The first integration is **Tailscale Serve**, limited to devices/users in the same
tailnet. It reverse-proxies two local HTTP services and provisions HTTPS, while
tailnet policy controls which devices can reach them. Trezi also requires a
single-use, per-process browser pairing as defense in depth.

```text
Workstation                       Other computer/tablet
repo + Trezi :4173               browser
       ^                             |
       +------ private HTTPS --------+
              Tailscale Serve
```

Avoid binding an unauthenticated Trezi server to `0.0.0.0` or exposing it by raw
router port-forwarding. Possession of this UI can lead to source changes and agent
tool execution. Tailscale Funnel is public-internet exposure and is not the default;
if public sharing is ever supported, place a strong identity-aware access proxy in
front and issue short-lived, revocable sessions.

Current remote-mode guarantees:

- explicit opt-in (`--remote`), never automatic exposure;
- Tailscale device authorization plus single-use Trezi pairing and exact-origin
  CSRF protection;
- WebSocket reconnect and replay from a monotonic event cursor;
- loopback-only control/preview services with separate tailnet HTTPS origins;
- a visible “remote access active” indicator and route cleanup on graceful shutdown.

Remaining multi-client/daemon requirements:

- a visible connected-client list and **Revoke** control;
- single-writer coordination when two browsers operate the same chat/workspace;
- terminal shutdown must not kill the daemon when installed as a user service;
- suspend/lock controls.

Official operational references:

- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)

## Mode 3: fully hosted Trezi on Railway

### Personal/single-user deployment

A useful first hosted release can run as one authenticated Railway service:

- build a Linux Docker image containing Node 22, Bun, Git, `gh`, Trezi's browser
  bundle, control API, and workspace supervisor;
- listen on `0.0.0.0:$PORT` and provide `/health`;
- attach one volume at `/data` for cloned repositories, `.git` worktrees, sessions,
  project memory, and attachments;
- start target dev servers only on loopback/private ports and expose them solely
  through the authenticated preview gateway;
- use a WebSocket for bidirectional commands and agent streaming; persist enough
  event state for reconnects;
- disable Railway Serverless sleeping while interactive agents/workspaces are open;
- checkpoint edits as Git commits frequently so a restart never relies only on
  process memory.

This is suitable for one trusted owner or a small trusted team. It is not sufficient
isolation for arbitrary users because repository dependencies and agent tools execute
code inside the same container as the control service.

### Multi-user hosted product

Split the deployment into a stateless control plane and isolated workspace workers:

```text
Public Railway service
  web assets + auth + API + WebSocket gateway
          |
          +---- Postgres: users, projects, ACLs, session/event metadata
          +---- object storage: uploads, screenshots, exported artifacts
          +---- private job queue / workspace registry
                          |
                          v
              one isolated worker per active workspace
              repo + dev server + Git + agent tools
```

The control plane may hold durable application credentials; workspace code must not.
Use short-lived capability tokens for each worker and broker model/Git access where
practical. A worker can read/write only its assigned repository and artifact prefix.
Apply CPU, memory, process, disk, network-egress, runtime, and agent-turn limits.

Railway can host the control plane and can provision services programmatically via
its public API. A service-per-workspace beta is possible, but Railway volumes impose
important constraints: one volume per service, no replicas with volumes, a finite
per-project volume count, and brief redeploy downtime. Therefore:

- **small beta:** one Railway worker service and volume per persistent workspace;
- **larger product:** keep Railway for the control plane and use ephemeral isolated
  workspace compute, treating Git/object storage as the durable source of truth; or
  create separate Railway projects/services within explicit quota and lifecycle
  limits;
- never place several mutually untrusted workspaces in one long-lived worker merely
  to avoid provisioning overhead.

Railway private networking should carry control-plane/worker/database traffic. Only
the web gateway is public. WebSockets are appropriate because Railway exempts them
from ordinary HTTP duration and idle limits; SSE agent streams require heartbeat and
are still bounded by HTTP request duration.

Official operational references:

- [Railway public networking limits](https://docs.railway.com/networking/public-networking/specs-and-limits)
- [Railway private networking](https://docs.railway.com/networking/private-networking)
- [Railway volumes and caveats](https://docs.railway.com/volumes/reference)
- [Railway health checks](https://docs.railway.com/deployments/healthchecks)
- [Railway service API](https://docs.railway.com/integrations/api/manage-services)
- [Railway Claude Agent SDK guide](https://docs.railway.com/guides/claude-agent-sdk-app)

### Hosted authentication and provider credentials

Use application authentication (initially GitHub OAuth or a passkey-capable identity
provider) before any project metadata or WebSocket is reachable. Authorize every
command against `{user, workspace, projectRoot}` on the server; a guessed workspace
ID must convey nothing.

For Git, prefer a GitHub App installation or user OAuth token with repository-scoped,
short-lived credentials. Do not ask users to paste a broad personal access token if a
narrow installation token can do the job.

For models, a personal hosted deployment may accept a BYO API key encrypted at rest.
A multi-user product should use provider APIs or an explicit per-user gateway. Do not
copy a workstation's Codex/Claude subscription login directory into a shared server.
If a CLI subscription login is supported for personal self-hosting, isolate it on the
owner's volume, document that it is single-user, and verify provider terms and SDK
behavior before shipping it.

### Preview routing in hosted mode

The public gateway owns one stable origin and maps an opaque workspace/preview ID to
the worker's private dev-server address. Prefer a separate preview origin/domain from
the control application. The gateway must:

- authorize the top-level preview navigation without exposing the control cookie to
  project JavaScript;
- proxy HTML/assets/range requests and WebSocket HMR upgrades;
- rewrite only what is necessary for base paths and redirects;
- set a restrictive control-plane CSP while allowing each preview to run its own
  development policy in isolation;
- terminate routes immediately when a workspace stops;
- prevent workers from selecting arbitrary private-network destinations (SSRF).

## Delivery sequence

### Phase 0 — contract and threat model

- [ ] Inventory all `TreziApi` calls/events and classify them as core, native-only,
      preview-only, or hosted-disabled.
- [ ] Define versioned command/event schemas and an authenticated workspace context.
- [ ] Write the threat model: malicious website, malicious repository/dependency,
      stolen browser session, cross-workspace access, SSRF, and runaway agent.

### Phase 1 — local browser proof of concept

- [x] Extract project detection, dev-server, Git, and one agent path from
      `ipcMain` registration.
- [x] Serve the renderer and implement the browser `window.api` adapter.
- [x] Open one CLI-selected repo and stream one agent turn.
- [x] Render the app in an iframe through the preview gateway.

### Phase 2 — browser editing parity

- [ ] Extract the preview DOM runtime and add the authenticated `postMessage` bridge.
- [ ] Port selection, styles, layers, props, text, annotations, and screenshots.
- [ ] Port worktree isolation, history/recovery, attachments, publish, and provider
      management.
- [ ] Add capability-driven fallbacks for native menu/window/editor/trash/update and
      disable iOS controls when the workspace host cannot provide them.

### Phase 3 — remote-local access

- [x] Add single-use pairing, process-lifetime revocation, and reconnect/replay.
- [ ] Add multi-client presence, selective revocation, and single-writer coordination.
- [x] Document/test Tailscale Serve with a loopback-bound Trezi process.
- [ ] Package the daemon as a launchd/systemd user service.

### Phase 4 — Railway personal alpha

- [ ] Add a production Dockerfile, `$PORT` binding, `/health`, graceful `SIGTERM`,
      `/data` layout, and restart recovery.
- [ ] Add application login, GitHub repository connection, encrypted BYO model keys,
      and quotas.
- [ ] Exercise clone -> start -> select -> edit -> reconnect -> publish across a real
      Railway redeploy.

### Phase 5 — multi-user isolation

- [ ] Split stateless control plane from workspace workers and add Postgres/object
      storage/queue persistence.
- [ ] Provision one sandbox per active workspace with capability tokens and hard
      resource/network limits.
- [ ] Add audit events, abuse controls, secret rotation, backups, deletion/export,
      billing limits, and disaster recovery.

## Definition of done

The browser architecture is not complete until the same end-to-end story works after
a browser refresh and workspace-process restart: authenticate, open/clone a repo,
start its dev server, inspect a stamped element, apply a direct edit, run an agent
edit, observe HMR, undo/recover, and publish—without exposing a raw filesystem or
shell API to the browser.
