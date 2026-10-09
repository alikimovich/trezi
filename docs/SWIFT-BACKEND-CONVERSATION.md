# Swift conversation coordinator: chat state and orchestration (S11)

> **Since LKM-111 (2026-09-29):** the launch-time rollback (`TREZI_BACKEND_OWNER=legacy`,
> `TreziService --legacy`) and the Bun twins it ran are removed. The Swift owner described
> here is the only one; passages about the rollback, the legacy launch or the TS twins
> are history. Current status: [SWIFT-BACKEND-RETIREMENT.md](SWIFT-BACKEND-RETIREMENT.md).

LKM-97, roadmap row S11 ("Chat/turn/spawn orchestration and transcript state") of the
[canonical plan](SWIFT-BACKEND-PLAN.md) and [roadmap](SWIFT-BACKEND-ROADMAP.md). It
follows [source](SWIFT-BACKEND-SOURCE.md). Under the default launch
(`TREZI_BACKEND_OWNER=swift`) the Swift service decides what a chat is between provider
events. Bun's provider sessions (the Claude and Codex SDK harnesses) remain adapters:
they supply typed events, and Bun performs the effects the owner's answers call for.

- `src/service/ConversationOwner.swift`: requests, validation, checkpoints, drain.
- `src/service/ConversationState.swift`: the per-chat turn state machine, completion
  policy, approvals and spawn admission (pure).
- `src/service/ConversationStore.swift`: session records and History, live
  checkpoints, crash recovery.
- `src/native/conversation-service.ts`: Bun's client. `src/main/conversation-owner.ts`
  is the seam (it throws without the service). The in-process twin
  `conversation-model.ts` was removed in LKM-111;
  `test/fixtures/conversation-owner/parity-golden.json` pins the answers it gave. `src/main/chat-turns.ts` attributes provider events to turns.
  `src/main/agent.ts` asks the owner before every transition.

## The domain, exactly

| Item | Owner (swift launch) | Owner (legacy launch) |
| --- | --- | --- |
| Session records and History, `<profile>/trezi/sessions/<id>.json` (current chat, previous agents, park and spawn records; rename, remove, 50-per-project pruning) | Swift, the only writer (byte-identical format) | Bun (`sessions-store.ts`) |
| Live-chat checkpoints `<profile>/service/conversation/live/`, recovery copies `recovered/` | Swift | untouched |
| Turn state machine: one turn per chat, preparation, cancellation, terminal claim, reconciliation continuation, landing | Swift decides; Bun performs landing through the repository coordinator | TS twin |
| Completion policy: success or failure, whether to name the chat, whether to evaluate memory | Swift | TS twin |
| Titles: user rename wins; a generated name only for an untitled chat | Swift | TS twin |
| Model handoff: refused mid-turn; the next turn carries the history once | Swift decides; Bun builds the prompt | TS twin |
| Permission mode and pending approvals (permission cards, agent questions) | Swift registry and policy; Bun settles the SDK callbacks | TS twin |
| Background spawn admission (3 per project, FIFO queue, cancel) | Swift | TS twin |
| Provider SDK sessions, event streams, prompts, title and memory generation | Bun, under the S10 provider owner's grant ([providers](SWIFT-BACKEND-PROVIDERS.md)) | Bun |
| Composer drafts, attachments and the queued-message list shown in the composer | Bun native chat controller (S12) | Bun |
| Git, worktrees, landing, Undo records | Repository and source owners (S07/S08) | TS Git code |

Reads of `sessions/` stay in Bun (it lists History synchronously); the service writes
every file atomically, and Bun keeps a write it has not seen acknowledged in an overlay
so a read right after it sees it.

## Rules

- **Turns.** `begin {chat, turn}` admits one turn per chat (else `busy`). `send` records
  the user entry when the provider is about to get it (refused `cancelled` after Stop).
  `abort` returns a turn that never reached the provider to idle. The turn id is the
  composer's submission id, sent as `agent:send`'s fifth argument.
- **Attribution.** Every provider honours "one `done` per `send`", in order. Bun's
  `TurnTracker` keeps each session's sends in order and tags every event with the turn
  it belongs to (`AgentEvent.turn`). An `error` is attributed to the oldest unfinished
  send without ending it, and its `done` ends it.
- **Terminal claims.** The owner claims at most one terminal per run of a turn. A second
  one (`error` then `done`) is `duplicate`. One for another turn or run is `stale`, as
  is a `done` no send accounts for (`AgentEvent.stale`). Neither changes anything, and
  the chat controller ignores a terminal tagged with a turn other than the one it is
  running. So a late event cannot complete the wrong turn.
- **Completion.** A claimed `done` without Stop is a success. It lands, and names the
  chat if it is untitled and both sides have spoken (never twice at once). It also
  evaluates memory. Anything else lands as failed. `continue` admits exactly one
  reconciliation run (`run + 1`), never after Stop. `landed` returns the chat to idle
  and stamps `completedAt` once.
- **Records.** Each call that carries a chat's record carries a per-chat sequence
  number, and an older record is refused. A title the owner decided is never taken back
  by a record from Bun.
- **Handoff.** `handoff {reason:"model"}` is refused while a turn is in flight.
  `reason:"restart"` (after a force-stop) abandons the dead session's turn. Either way,
  the next `send` answers `handoff: true` once, and Bun prefixes the recorded conversation.
- **Approvals.** Each request is registered with its chat and tool. An answer settles
  it once; a late or repeated answer finds nothing. `mode` records the permission mode
  and answers which open prompts it no longer asks: all for `bypassPermissions`, edit
  tools for `acceptEdits`. `close` and `release` return the approvals Bun must deny.
- **Spawns.** `spawn` admits now or queues FIFO behind the project's 3 running.
  `spawnDone` frees a slot and admits the next ones in order. `spawnCancel` removes a
  queued spawn; a running one is interrupted by Bun.
- **Checkpoints and crash recovery.** Every transition rewrites the chat's checkpoint
  (record, active flag, phase) before it is answered. Bun also checkpoints a streaming
  turn at tool boundaries, at most once a second. A clean close saves the record and
  deletes the checkpoint. At launch, each leftover checkpoint of an engaged chat is
  saved: a turn cut off mid-way gets a status line saying so, and the project's active
  chat becomes its current record again. An older current record is moved to History,
  never deleted. A record already on disk with a later `endedAt` is newer work, so it
  is kept and the checkpoint is copied under `recovered/`. A damaged checkpoint is
  moved there unread. `status` lists what happened; Bun shows it in the Activity log.

## Protocol

Private pipe, S01 frames, no revision, empty scope:
`{"service":"conversation","id":n,"request":{…,"service":"conversation","method",…}}`.
Unknown or missing fields, a revision, a scope, an unsafe record id and malformed
transcript entries are refused before anything changes.

| Method | Body | Result |
| --- | --- | --- |
| `save` / `remove` / `rename` | `{record, current?}` / `{id}` / `{id, title}` | `{}` / `{}` / `{ok, title?, error?}` |
| `open` | `{chat, project, root, record, options, active, sequence}` | `{}` |
| `activate` / `configure` | `{chat}` / `{chat, options}` | `{}` |
| `checkpoint` | `{chat, record, sequence}` | `{accepted}` |
| `close` | `{chat, persist: current\|history\|none, record, sequence}` | `{saved, release}` |
| `handoff` | `{chat, options, record, sequence, reason: model\|restart}` | `{}` |
| `begin` / `send` / `abort` / `cancel` | `{chat, turn}` / `{chat, turn, entry}` / `{chat, turn}` / `{chat}` | `{}` / `{handoff}` / `{aborted}` / `{phase, turn}` |
| `terminal` | `{chat, turn, run, kind: done\|error, record, sequence}` | `{claimed, outcome?, title?, memory?, reason?}` |
| `continue` / `landed` | `{chat, turn, run}` / `{chat, turn, at}` | `{continued}` / `{landed, completedAt?}` |
| `title` | `{chat, title, source: user\|generated}` | `{ok, title?, error?}` |
| `register` / `resolve` / `mode` / `release` | `{chat, id, kind, tool}` / `{id, kind}` / `{chat, mode}` / `{chat}` | `{}` / `{chat}` / `{allow}` / `{release}` |
| `spawn` / `spawnDone` / `spawnCancel` | `{id, project}` / `{id}` / `{id}` | `{start}` / `{start: [ids]}` / `{queued}` |
| `snapshot` / `status` (read) | `{}` | `{chats, spawns}` / `{recovered}` |

## Rollback (tightened to this domain)

- **Launch-time switch only.** Quit, relaunch with `TREZI_BACKEND_OWNER=legacy`; the
  profile lock admits one owner and no conversation writer is hot-switched.
- **Drain before switching.** At quit Bun closes every chat through the owner (its
  record saved, checkpoint dropped). The entry point waits up to 3 s, then the service
  refuses new requests and lets a decision already underway finish (bounded, 2 s). A
  chat the quit cuts short keeps its checkpoint for the next Swift launch.
- **What is preserved.** Session records are the unchanged files, so the legacy owner
  lists, restores and continues them (tested). Checkpoints and recovery copies under
  `<profile>/service/conversation/` are never read or written by the legacy owner.
  They are still there when Swift returns, and recovery never replaces a record the
  legacy owner wrote later (tested). Turn state, approvals and the spawn queue live for
  the owning process in both launches, as before.
- **Reverting the code.** A pre-LKM-97 build ignores `service/conversation/`; a
  checkpoint is a JSON file whose `record` is an ordinary session record.

## Verification

`test/conversation-owner.mjs` (unit tier) compiles the real owner, with the repository
and source owners, into a fixture (`test/fixtures/conversation-owner/main.swift`;
`CONVERSATION_FAULT=<point>` and `CONVERSATION_FAULT_COUNT=n` SIGKILL inside a write):
- **parity:** one scripted owner session gives identical answers, and identical session
  files, on the legacy and Swift owners. It covers concurrent chats, busy, duplicate
  and late terminals, a continuation and its stale run, cancellation before and after
  send, titles, handoff and restart, approvals and modes, spawn admission, History and
  pruning;
- **agent:** deterministic streaming through `agent.ts` and the native chat controller
  on both owners, with identical outcomes. Cases: two concurrent chats; a queued turn
  order; an error→done race whose late `done` cannot complete the next turn; a stray
  `done`; approvals answered once; Stop; generated and user titles; model handoff once;
  a reattached controller mid-turn; close and restore. In the Swift run, landing and
  Undo go through the Swift repository and source owners (frames counted, commit
  checked);
- **crash:** SIGKILL mid-turn, inside a checkpoint write and inside a History write;
  newer records kept, damaged checkpoints moved aside;
- **rollback**, **schema**, **drain**, the `comment-agents` suite re-run with the Swift
  owners installed (since LKM-111 `test/helpers/with-service-owners.mjs`), and the adapter
  boundary (no backend knows the owner).
