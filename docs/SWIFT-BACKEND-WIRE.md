# Executable service contract v1.0

LKM-88 / S01. The [canonical plan](SWIFT-BACKEND-PLAN.md) controls architecture;
this contract is transport-independent data for its separate Swift service/XPC
boundary and subordinate helpers. Nothing registers these messages on the legacy
bridge or transfers a writer. The [roadmap](SWIFT-BACKEND-ROADMAP.md) assigns every
audited module, route and event to a later owner.

## Sources and executable evidence

- [JSON Schema](../src/shared/service-contract/schema.json) defines closed envelope
  shapes; [TypeScript DTOs](../src/shared/service-contract/types.ts) and
  [codec](../src/shared/service-contract/codec.ts) implement them.
- [Swift DTOs and codec](../src/service/ServiceContract.swift) use Foundation Codable
  with explicit discriminators and an independently implemented schema validator.
  The codec takes the bundled, trusted schema; peers must never supply or select it.
- [Golden fixtures](../test/fixtures/service-contract/golden.json) contain expected
  decoded values or exact rejection codes. `bun test/service-contract.mjs` builds
  the real TypeScript codec, compiles the Foundation-only Swift executable, checks
  both against those expectations and checks exhaustive roadmap assignments.
  A missing Swift compiler fails the check; it does not count as parity or SKIP.

These are foundations, not all domain method schemas. `body`, snapshot `value`,
event `value` and successful reply payloads carry JSON; subsequent tasks must add
method-specific DTOs and validation before registering their dispatchers. The
preference-shaped request is an inert representative mutation. No ledger, XPC
endpoint, service executable, credentials, OS capability enforcement or store is
introduced here. Codec validation does not prove crash recovery or exactly-once
execution.

## Wire rules

Every message is `{version: {major: 1, minor: 0}, kind, payload}`. Kinds are
`hello`, `helloAck`, `request`, `reply`, `event`, `cancel`, `snapshot`. Replies use
an explicit `result: {kind: "succeeded" | "failed", payload}`. The failed payload
has a typed failure code, safe display message, retryability and optional operation,
revision and recovery identity. Optional metadata is absent, never null. Domain
JSON retains explicit null, absence, empty strings/objects/arrays, Unicode spelling
and finite fractional values separately. Swift enum synthesis is not the wire API.

UUIDs are lowercase canonical strings. Project/chat/turn/checkout/document IDs
identify authoritative mappings, not paths or UI selection. Chat, checkout and
document require a project; turn requires chat. A future endpoint must resolve
those mappings and bind its trusted `expectedScope`; the codec rejects mismatches.
A caller's own scope declaration grants no authority. Source/preview scopes need
further path, document-generation and origin validation in their owning task.

Counters and sequence numbers are canonical decimal strings in `[0, UInt64.max]`,
including values above JavaScript's safe integer range. Numeric JSON values must
be finite with absolute value at most `Number.MAX_SAFE_INTEGER`. TypeScript validates
the original value graph before serialization, rejecting NaN and either infinity
instead of allowing JSON.stringify to turn them into null. No timestamp,
byte/blob or path codec is implied by arbitrary body JSON; owners must define
those schemas before using them. Frames use strict UTF-8, at most 65,536 bytes,
24 simultaneously open containers and 256 members per object/array. These maxima
apply before acceptance; bytes and nesting are checked before object decoding.
Duplicate object keys, including escaped duplicates and Unicode canonically
equivalent spellings, are rejected before decoding to prevent Swift dictionary
collisions. A single decomposed Unicode key/value is preserved without normalization.
Lone UTF-16 surrogates are rejected. Error messages allow 1,024 Unicode scalars.
Both encoders leave forward slashes unescaped so slash-heavy frames retain the
same byte budget; fixtures cover 40,000 slashes and the exact/over-limit boundary.

JSON Schema expresses shapes and basic scalar constraints. The codecs additionally
validate UInt64 range, frame/depth/collection limits, scope hierarchy, mutation
revisions, cursor epochs, capability-name uniqueness and duplicate keys. A generic
schema validator alone is insufficient. Unsupported envelope/negotiated versions
fail with `unsupportedVersion`; malformed shapes fail with `invalidRequest`.
Only v1.0 is supported today, including Hello version proposals. Future negotiation
must explicitly extend this set with fixtures; unknown optional events and minor
versions are not silently accepted by this initial strict codec.

Hello advertises role, build/schema hash and versioned capability names; HelloAck
returns selected version, service epoch, capabilities, resource limits and cursor.
Its cursor epoch must match the service epoch. This defines the exchange, not a
capability grant algorithm. A dispatcher supplies trusted `allowedMethods` as
`{service, method}` pairs, compared field by field; joining with a dot is ambiguous
because either identifier may contain dots. An empty list denies all methods;
omission performs no method allowlist check. The codec rejects unsupported commands
with `unsupportedCapability`; provider/model names
never confer capabilities. Role/peer authorization remains an S02 requirement.

## Operations, revisions and recovery

`requestID` identifies one transport attempt; `operationID` identifies durable
intent across attempts/connections. The pure `operationDisposition` comparison
returns fresh for a different operation ID, duplicate for the same operation and
same intent, and idempotencyMismatch for changed intent. Intent includes mode,
service, method, scope, expected revision and body; connection, request ID and
timeout do not change it. Object field order is irrelevant; array order, null
versus absence and Unicode value spelling are significant. This is an executable
identity rule, not an in-memory substitute for the required durable ledger.
S03 adds that ledger in the Swift service ([ledger](SWIFT-BACKEND-LEDGER.md)):
its persisted intent digest follows the same identity rule.

Mutations require `expectedRevision`. A trusted current revision rejects a stale
counter or epoch with `conflict`. Future dispatch must validate syntax/scope,
consult durable operation identity/receipt **before** checking a fresh operation's
revision, then reserve revision and persist intent before effects. Otherwise a
successful retry would incorrectly conflict with the revision it advanced. No
mutation is executed here. A timeout/connection loss never means rollback.

Cancel has its own request and operation IDs plus `target` operation ID. It is
acknowledged through a reply, not treated as a transport request-ID cancellation.
Representative reply fixtures retain `cancelled` versus `tooLate`/`committing`;
domain tasks must implement cooperative cancellation, commit-point handling and
persistent final status. Snapshot DTOs bind state, revision and stream cursor;
events carry epoch and sequence. Later services must take snapshots consistently,
reconcile gaps/old epochs and retain local drafts independently. DTO parity alone
does not establish replay retention, consistent snapshots or restored operations.

## Rollback in this step

All runtime writers and launch behavior remain legacy-owned. Removing these inert
files requires no data rollback. S02 adds a launch-time owner switch; S03 and later
takeovers must stop/drain mutations, retain stores/journals/receipts/drafts/worktrees,
and test restoring the legacy owner against the newest state. Never overwrite
new work from an older backup. See the roadmap's domain-specific takeover gates.
