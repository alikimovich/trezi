# Proposed Swift service contracts

Review proposal for LKM-84, 2026-09-27. These are proposed guarantees, not current
runtime behavior. Source baseline and all current routes are in the
[ownership audit](SWIFT-BACKEND-AUDIT.md) and [route map](SWIFT-BACKEND-ROUTES.md).
No protocol or persistence changes are made by this documentation.

LKM-88 implements the transport-independent v1.0 DTO subset and executable golden
fixtures described in the [wire contract](SWIFT-BACKEND-WIRE.md). The illustrative
declarations below remain design context; checked-in codecs define the current
wire shape. No domain writer has moved.

## Ownership and transport

LKM-88 reconciliation, 2026-09-28: the [canonical plan](SWIFT-BACKEND-PLAN.md)
and [15-step roadmap](SWIFT-BACKEND-ROADMAP.md) govern implementation. Service
actors run in a **separate Swift service process**, with a versioned typed XPC
connection to the AppKit/SwiftUI app. Direct actor calls are internal service
implementation details. The previous host-local, Bun-launcher and pipe-first
proposal is retained as historical analysis in the
[audit companion](SWIFT-BACKEND-AUDIT-PROPOSAL.md), not an approved staging path.

UI owns focus, display, ephemeral gestures and draft presentation. Swift services
own validation, workflow choices, durable transitions, operation records and
repository serialization. A UI draft remains intact until an authoritative save
acknowledgement; service snapshots must not replace an unsaved draft. Validate
XPC peer identity, decoded DTOs, scope and capability before dispatch; invalidation
requires snapshot/operation reconciliation, not blind replay.

Swift supervises legacy Bun and narrow provider/parser helpers. Those subordinate
boundaries may use private inherited pipes with bounded UTF-8 JSON frames;
serialize writes and keep logs on stderr. Their transport does not replace XPC
between UI and the separate service. Impose frame/depth/collection limits before
acceptance. Large screenshots, media and sources need scoped blob capabilities
with size, hash and expiry. Retain MCP screenshot image content semantics.

Persist operation intent and recovery checkpoints before transferring the first
writer. An in-memory fixture or actor ledger proves only local contract semantics,
not restart safety. The launch-time owner switch must be selected before writable
initialization, with one writer and explicit stop/drain/recovery before switching.
UI loss is not provider completion; a transport timeout does not undo a write.
S01 introduces inert DTOs and executable fixtures only; no production service,
transport or persistence owner changes in this task.

## Envelope and representative Swift definitions

Use stable UUID-backed project/chat/turn identifiers, independent of UI selection,
path strings, SDK session IDs, branch names and transcript array indexes. Service
resolves `ProjectID` to an authorized canonical root; repository identity includes
the canonical Git common directory so linked worktrees share a writer. Keep a
separate checkout ID to distinguish live and private trees. Persist ID mappings
before accepting dependent durable commands. Legacy IDs stay behind an adapter.

The declarations below remain illustrative domain-design sketches. The S01
executable DTOs and golden fixtures define the initial wire subset; these sketches
are not a second codec or a claim that the domain services exist:

```swift
import Foundation

struct ServiceID<Tag>: Codable, Hashable, Sendable {
    let rawValue: UUID
}
enum ProjectTag {}
enum ChatTag {}
enum TurnTag {}
enum OperationTag {}
typealias ProjectID = ServiceID<ProjectTag>
typealias ChatID = ServiceID<ChatTag>
typealias TurnID = ServiceID<TurnTag>
typealias OperationID = ServiceID<OperationTag>

struct WireVersion: Codable, Sendable {
    let major: UInt16
    let minor: UInt16
}
struct Scope: Codable, Sendable {
    let project: ProjectID?
    let chat: ChatID?
    let turn: TurnID?
    let checkout: UUID?
    let document: UUID?       // new generation after navigation/reload
}
struct Revision: Codable, Equatable, Sendable {
    let epoch: UUID
    let counter: UInt64
}
struct Request<Body: Codable & Sendable>: Codable, Sendable {
    let version: WireVersion
    let connection: UUID
    let requestID: UUID      // one attempt, not an idempotency key
    let operationID: OperationID
    let scope: Scope
    let expectedRevision: Revision?
    let timeoutMilliseconds: UInt32?
    let body: Body
}
enum FailureCode: String, Codable, Sendable {
    case invalidRequest, unsupportedVersion, unsupportedCapability
    case unauthorized, notFound, conflict, busy, cancelled
    case deadlineExceeded, unavailable, ioFailure, providerFailure
    case recoveryRequired, idempotencyMismatch
}
struct ServiceFailure: Error, Codable, Sendable {
    let code: FailureCode
    let message: String      // safe display text, no key/prompt/file dump
    let retryable: Bool
    let operationID: OperationID?
    let currentRevision: Revision?
    let recoveryID: UUID?
}
enum Reply<Value: Codable & Sendable>: Codable, Sendable {
    case succeeded(Value)
    case failed(ServiceFailure)
}
struct Event<Value: Codable & Sendable>: Codable, Sendable {
    let serviceEpoch: UUID
    let sequence: UInt64
    let operationID: OperationID?
    let scope: Scope
    let revision: Revision?
    let value: Value
}

struct PreferenceEntry: Codable, Sendable {
    let key: String
    let value: String?       // preserve current explicit null semantics
}
struct PreferencesSnapshot: Codable, Sendable {
    let revision: Revision
    let entries: [PreferenceEntry]
}
struct SetPreferences: Codable, Sendable {
    let entries: [PreferenceEntry]
}
protocol PreferencesService: Sendable {
    func snapshot() async throws -> PreferencesSnapshot
    func set(_ request: Request<SetPreferences>) async
        -> Reply<PreferencesSnapshot>
}

struct SourceEdit: Codable, Sendable {
    let relativePath: String
    let expectedSHA256: String
    let replacement: String
    let undoGroup: UUID
}
struct SourceReceipt: Codable, Sendable {
    let revision: Revision
    let undoGroup: UUID
    let changedPaths: [String]
}
protocol SourceService: Sendable {
    func apply(_ request: Request<SourceEdit>) async -> Reply<SourceReceipt>
}
enum OperationPhase: String, Codable, Sendable {
    case accepted, running, waitingForUser, committing
    case succeeded, failed, cancelled, recoveryRequired
}
struct OperationStatus: Codable, Sendable {
    let id: OperationID
    let phase: OperationPhase
    let failure: ServiceFailure?
}
struct CancelOperation: Codable, Sendable {
    let target: OperationID
}
```

On the wire, use an explicit `{kind, payload}` discriminator for every enum and a
stable `{service, method}` name; do not freeze Swift synthesized associated-value
encoding as the cross-language standard. Publish JSON Schema and matching TS
unions/Swift codecs with golden fixtures. Decimal strings encode UInt64 counters
and sequence values on JSON wires to avoid JavaScript precision loss; UUIDs use
canonical strings. Bytes, timestamps (UTC epoch milliseconds), paths and null
versus absence must have explicit codecs. Invalid/nonfinite numbers are rejected.

A Hello request supplies supported major/minor ranges, client role, build/schema
hash and requested capabilities. HelloAck chooses version, service epoch,
capabilities with per-capability versions, resource limits and snapshot cursor.
Major mismatch fails before mutations. Minor additions must be optional;
unknown optional events may be ignored, unknown commands fail explicitly.
Capabilities distinguish subscription authentication, custom Responses endpoints,
image understanding, question cards, background edits, islands, preview observation
and project composition. A model name never grants a harness capability. Missing
capabilities disable actions with a reason instead of retrying a different provider.

## Complete domain mapping rules

Every existing route has a proposed domain in the route census. Resolve the two
mixed labels as follows; domain separation must not create multiple source writers:

| Domain | Methods/data carried forward and ownership rule |
| --- | --- |
| Projects | pick/pick-new use UI broker; create/detect/icon are service operations. Workspace restore/open/close/reorder/activate/suspend are direct native-controller actions migrating here, with project/session/runtime snapshots. |
| Conversation | All `agent:*` and `sessions:*` routes: session CRUD/switch/send, history/transcript, permission/question responses, interrupt, spawned children, isolation status. Delegate repository effects of spawn apply/discard and resolve/discard-conflict to Repository; it remains the sole mutation authority. |
| Memory | `project-memory:get/set`, automatic evaluation proposals and next-turn injection. Swift alone compares/commits revisions; helper may evaluate text only. |
| Attachments | `attachments:save`, scratch lifetime/pruning and image validation; scoped blob receipts replace arbitrary absolute paths. Swift owns storage; helper gets a bounded read capability. |
| Providers | `providers:*`, catalogs/auth/usage and SDK capability discovery. Credential references cross boundaries; secret material only reaches the specific authorized helper, never UI snapshot or logs. |
| Repository | `git:*`, isolation preparation/landing/recovery and worktree lifecycle. IDs, intent, expected HEAD/index/source evidence and operation receipt; never generic shell or path-based reset RPC. |
| Publishing | `github:*`, `publish:*`; Swift plans and journals local/remote steps through Repository. Requires explicit publish/merge intent; a helper cannot push, merge or remove worktrees on its own. |
| Annotations | `annotations:*` notes/pins, versioned list; sidecar writes use Repository's mutation lane. Publish does not become an annotation-store concern merely because it shares a file today. |
| Source | `source:*`, `props:*`, `text:*`, `edit:*`, `styles:apply`, `tokens:*`, `layers:move`. Native popout/open-editor is UI broker; all disk changes and saved-source Undo are Source transactions under Repository. Pure parsers return inspections/patch proposals. |
| Controls | `controls:*`, direct island interactions, provider `chat_island`; versioned manifest/value/gesture identities and pending/ready state. Delegates file changes to Source; records attach to original chat/turn. |
| Content | `content-controls:*` and provider recipe tools; draft and authoritative revision separate; Source owns JSON commit/Undo, preserving unknown fields and stable collection IDs. |
| Preview | `preview:*`, `trezi:preview:*`, `styles:read/preview/clear-preview/replay` and read replies; `layers:read/select/hover/set-watch/changed` and replies. DOM-only effects, document-bound read receipts, current location/screenshot evidence. Move request becomes a Source proposal, never a direct page write grant. |
| Runtime | `devserver:*`, dependency refresh/install, static serve/watch, restart/readiness/log streams. Preserve target runtime/command, own child process groups and teardown. |
| Simulator | `simulator:*`, device state and selection/log events. Swift orchestrates; xcrun/bridge tools are supervised resources. |
| Setup | `setup:*`, stamp/helper sync and explicitly requested skill installs. Source/Repository performs application-owned mutations; project build plugins remain JS in the project's runtime. |
| Diagnostics / Support | `diagnose:*`, `feedback:*`, bounded log subscriptions and reports. Provider evaluator cannot apply diagnosis autonomously; capture is a scoped UI broker action. |
| Preferences / Lifecycle | Direct preferences/settings/layout events, startup lock, shutdown and installation update; versioned snapshots. Update has installation-scoped operation, distinct from target project Repository. |
| UI broker | `window:*`, `menu:*`, native picking/trash/open/capture/download/permissions and state presentation methods. UI is the authority for user interaction, never persistence/landing. |

The dynamic reply row maps to Preview. Media scheme maps to Source's read-only
blob capability plus UI playback. Project-UI generation maps to a Composition
helper capability coordinated by Conversation; pure math tools remain helper
capabilities. All native `*State` commands become snapshots/view projections of
these domains. All Host/native events remain listed in the event census; test
inspection routes stay out of the helper protocol.

## State, replay, revisions and cancellation

One writer per domain is mandatory, including during migration. The launch plan
chooses an owner before either implementation opens writable state. Bun adapters
may cache read-only acknowledged snapshots but cannot write around Swift.
Retain current file formats until a separately reviewed storage slice; no implicit
Electron-profile import. Atomic rename of one JSON file is not an atomic commit
with another file, Git, a remote service or a database.

Every mutation carries operation ID, immutable originating scope and expected
revision. An accepted receipt is not completion. Keep a domain operation ledger
for durable effects: same ID + same canonical request digest returns the recorded
status/result; changed payload returns idempotencyMismatch. Never auto-retry an
uncertain non-idempotent remote request. Query/reconcile the external result, or
return recoveryRequired. Bound ledger retention with an explicit advertised
retry horizon; IDs older than that horizon require status/recovery, not execution.
The historical experiment's reduced guarantees are not canonical acceptance;
durable intent/recovery is required before any writer transfer.

Events carry service epoch and monotonically increasing stream sequence. A
snapshot includes a cursor taken consistently with its state; subscribe from that
cursor without a snapshot/event gap. On reconnect, request deltas only within the
advertised retained window; otherwise replace authoritative state with a full
snapshot, retain local drafts and reconcile outstanding operation IDs. Durable
operations survive transport loss through their ledger; high-frequency prose/log
chunks need not all be durable, but transcript checkpoints must identify truncation
or replay gaps. Provider crash cannot resume an SDK conversation unless supported;
snapshot marks it interrupted/recoverable rather than inventing success.

Use per-domain revisions, not one global counter. File hashes remain required
against external editor changes. A UI generation can suppress display updates
but cannot decide whether a committed mutation happened. Late/duplicate events
from old epochs/documents/turns never activate controls or navigate a new chat;
late durable outcomes still update their originating domain and are discoverable
by status query. Permission/question responses bind request ID, provider session
and turn; duplicate or expired answers return an explicit result.

Cancellation is a request with its own acknowledgement: queued operations may
cancel before effects; running helpers receive cooperative cancel then bounded
termination; committing operations report too-late/current status. Swift checks
cancel state again before entering a commit. A cancelled provider turn cannot
trigger landing; private work remains recoverable. Once durable write succeeds,
late cancellation cannot claim that it was rolled back. Closing a UI window only
unsubscribes unless the workflow explicitly requests cancellation. Timeouts produce
an uncertain status to query, not an automatic resend with a new operation ID.

## Actor reentrancy and non-atomic effects

An actor does not serialize an entire operation across `await`. Repository owns
an explicit FIFO mutation lease keyed by canonical common Git directory. Reserve
operation/revision while isolated; mark running before yielding to helper work.
After each await, verify operation generation, cancellation and expected evidence.
Only the lease holder may enter committing. Avoid cyclic actor waits: obtain
repository lease first, then domain commit slot, then filesystem/Git work; callbacks
cannot recursively acquire that lease. Reads may run concurrently against an
identified snapshot, not mutable state assumed stable across suspension.

Future repository transactions journal intent and preimages/recovery refs before
irreversible effects, validate every file before the first live write, apply,
record Git result, then mark durable completion and publish events. If a step
fails or process dies, reconcile observed HEAD/index/file hashes with the journal.
Never overwrite new external edits in a blind rollback. Preserve the real user
index, parked branches, drafts and Undo preimages; uncertain partial state blocks
further mutations until recovery. A database transaction cannot roll back Git or
filesystem changes. Recovery never automatically merges or removes worktrees.
Explicit user-intent policy is a prerequisite to port the existing automatic paths.

## Narrow helper capabilities and privileges

| Helper | Retain in JS/Node/Bun | Allowed resources and constraints |
| --- | --- | --- |
| Provider harness | Claude/Codex SDKs, stream translation, CLI integration; Gemini opt-in; provider retry/auth quirks and MCP image results | Only assigned private checkout, provider-owned resume/cache location, selected endpoint credential and necessary network/process access. No live checkout, app profile, arbitrary keychain queries, landing, publish or worktree removal. Swift owns turn state, approvals, child spawning policy, durable records and cancellation outcome. Legacy non-isolated sessions need an explicit compatibility plan before this boundary is enforced. |
| Parser/compiler | TS checker, Babel, react-docgen, Svelte compiler, parse5, JS config syntax, json-render codegen/recipe validation | Snapshot bytes plus bounded authorized read-only dependency view; return diagnostics, schemas, source spans and patches with input hashes. No source writes/Undo/Git, network, arbitrary project-config execution or application state. Cache keys include parser/version/config/source hashes. Kill/restart failed worker and reject stale results. |
| Composition/evaluation | Jev/json-render selection, provider title/memory/diagnosis evaluations | Bounded input and deadlines, narrowly scoped credential/network access. Return proposal + engine/fallback; Swift validates before committing memory, recipes or islands. No evaluator writes. |
| Pure computation | Existing tested spring/color/contrast/type/shadow math | Values in/out, no filesystem/network, deterministic versioned output. Can port later without forcing parser/SDK replacement. |
| Project toolchain | Next/Vite/Svelte/MDX source stamp plugins, package-manager scripts, Metro and existing project tools | Run in project-selected runtime/checkout under Swift supervision; do not replace with app Bun or rewrite package managers. These are project code, not trusted services. Installation scripts can execute arbitrary code and need their own explicit launch policy. |
| Preview instrumentation | DOM selection, styles/layers, overlays, replay, source stamps | Keep isolated JavaScript in WKContentWorld. Only allowlisted bounded messages; no provider/helper service access. Swift supplies document/viewport evidence and validates origin. |

This is a privilege specification, not a claim that current Node subprocesses are
sandboxed. Before helper extraction, test enforcement against symlinks, path
traversal, forged scopes, token reuse, oversized frames, secret-bearing stderr and
attempted profile/live-tree access. Arbitrary provider shell execution cannot be
contained by an RPC allowlist alone; an OS-enforced policy or reviewed equivalent
is required before claiming that guarantee.
