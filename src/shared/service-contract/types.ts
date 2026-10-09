/** Transport-independent v1 DTOs. Not registered on the legacy host bridge. */
export type UUID = string
/** Canonical unsigned decimal UInt64, never a JSON number. */
export type Counter = string
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue }
export type JSONObject = { [key: string]: JSONValue }
export interface WireVersion {
  major: 1
  minor: 0
}
export interface Scope {
  project?: UUID
  chat?: UUID
  turn?: UUID
  checkout?: UUID
  document?: UUID
}
export interface Revision {
  epoch: UUID
  counter: Counter
}
export interface Cursor {
  serviceEpoch: UUID
  sequence: Counter
}
export interface Capability {
  name: string
  version: number
}
export type FailureCode =
  | 'invalidRequest'
  | 'unsupportedVersion'
  | 'unsupportedCapability'
  | 'unauthorized'
  | 'notFound'
  | 'conflict'
  | 'busy'
  | 'cancelled'
  | 'deadlineExceeded'
  | 'unavailable'
  | 'ioFailure'
  | 'providerFailure'
  | 'recoveryRequired'
  | 'idempotencyMismatch'
export interface ServiceFailure {
  code: FailureCode
  message: string
  retryable: boolean
  operationID?: UUID
  currentRevision?: Revision
  recoveryID?: UUID
}
export interface RequestPayload {
  connection: UUID
  requestID: UUID
  operationID: UUID
  scope: Scope
  mode: 'read' | 'mutation'
  expectedRevision?: Revision
  timeoutMilliseconds?: number
  service: string
  method: string
  body: JSONObject
}
export interface ReplyPayload {
  connection: UUID
  requestID: UUID
  operationID: UUID
  scope: Scope
  result: { kind: 'succeeded'; payload: JSONValue } | { kind: 'failed'; payload: ServiceFailure }
}
export interface EventPayload {
  serviceEpoch: UUID
  sequence: Counter
  operationID?: UUID
  scope: Scope
  revision?: Revision
  name: string
  value: JSONObject
}
export interface HelloPayload {
  connection: UUID
  role: 'ui' | 'legacy' | 'provider' | 'parser'
  versions: WireVersion[]
  schemaHash: string
  capabilities: Capability[]
}
export interface HelloAckPayload {
  connection: UUID
  version: WireVersion
  serviceEpoch: UUID
  capabilities: Capability[]
  limits: { maxBytes: number; maxDepth: number; maxCollection: number }
  cursor: Cursor
}
export interface CancelPayload {
  connection: UUID
  requestID: UUID
  operationID: UUID
  scope: Scope
  target: UUID
}
export interface SnapshotPayload {
  scope: Scope
  revision: Revision
  cursor: Cursor
  value: JSONObject
}
export interface Payloads {
  request: RequestPayload
  reply: ReplyPayload
  event: EventPayload
  hello: HelloPayload
  helloAck: HelloAckPayload
  cancel: CancelPayload
  snapshot: SnapshotPayload
}
export type Envelope = {
  [K in keyof Payloads]: { version: WireVersion; kind: K; payload: Payloads[K] }
}[keyof Payloads]
/** Separate fields: both identifiers may contain dots. */
export interface ServiceMethod {
  service: string
  method: string
}
export interface ValidationContext {
  /** Supplied by a trusted endpoint binding, never by the caller's payload. */
  expectedScope?: Scope
  currentRevision?: Revision
  allowedMethods?: ServiceMethod[]
}
