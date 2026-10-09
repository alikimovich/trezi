import schema from './schema.json'
import type { Envelope, FailureCode, JSONValue, RequestPayload, ValidationContext } from './types'

export * from './types'

export const LIMITS = { maxBytes: 65_536, maxDepth: 24, maxCollection: 256 } as const
export class ContractError extends Error {
  constructor(public readonly code: FailureCode) {
    super(code)
  }
}
function fail(code: FailureCode = 'invalidRequest'): never {
  throw new ContractError(code)
}
type Rule = {
  $ref?: string
  oneOf?: Rule[]
  const?: unknown
  enum?: unknown[]
  type?: string
  properties?: Record<string, Rule>
  required?: string[]
  additionalProperties?: boolean
  items?: Rule
  minItems?: number
  minimum?: number
  maximum?: number
  pattern?: string
  maxLength?: number
}
const definitions = schema.$defs as Record<string, Rule>
function matches(value: unknown, rule: Rule): boolean {
  if (rule.$ref) return matches(value, definitions[rule.$ref.slice('#/$defs/'.length)])
  if (rule.oneOf) return rule.oneOf.filter((r) => matches(value, r)).length === 1
  if ('const' in rule && value !== rule.const) return false
  if (rule.enum && !rule.enum.includes(value)) return false
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const object = value as Record<string, unknown>
    if (rule.required?.some((k) => !Object.hasOwn(object, k))) return false
    if (
      rule.additionalProperties === false &&
      Object.keys(object).some((k) => !Object.hasOwn(rule.properties!, k))
    )
      return false
    return Object.entries(rule.properties ?? {}).every(
      ([k, r]) => !Object.hasOwn(object, k) || matches(object[k], r)
    )
  }
  if (rule.type === 'array')
    return (
      Array.isArray(value) &&
      value.length >= (rule.minItems ?? 0) &&
      value.every((v) => matches(v, rule.items!))
    )
  if (rule.type === 'string')
    return (
      typeof value === 'string' &&
      (!rule.pattern || new RegExp(rule.pattern).exec(value)?.[0] === value) &&
      (rule.maxLength === undefined || [...value].length <= rule.maxLength)
    )
  if (rule.type === 'boolean') return typeof value === 'boolean'
  if (rule.type === 'integer')
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= (rule.minimum ?? -Infinity) &&
      value <= (rule.maximum ?? Infinity)
    )
  return true
}
/** Bound nesting before JSON.parse. Braces inside strings do not count. */
function checkDepth(text: string) {
  const stack: (Set<string> | null)[] = []
  let quoted = false,
    escaped = false,
    start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        quoted = false
        let next = i + 1
        while (/\s/.test(text[next] ?? '') && next < text.length) next++
        if (text[next] === ':') {
          const key: string = JSON.parse(text.slice(start, i + 1))
          const keys = stack.at(-1)
          if (!keys || keys.has(key.normalize('NFC'))) fail()
          keys.add(key.normalize('NFC'))
        }
      }
    } else if (char === '"') {
      quoted = true
      start = i
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? new Set() : null)
      if (stack.length > LIMITS.maxDepth) fail()
    } else if (char === '}' || char === ']') stack.pop()
  }
}
function bounded(value: unknown): void {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  )
    fail()
  // Reject lone surrogates: Foundation cannot represent them; preserve composed/decomposed Unicode unchanged.
  if (
    typeof value === 'string' &&
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  )
    fail()
  if (value && typeof value === 'object') {
    if (Object.keys(value).length > LIMITS.maxCollection) fail()
    for (const [key, child] of Object.entries(value)) {
      bounded(key)
      bounded(child)
    }
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function checkVersion(value: unknown) {
  if (!matches(value, definitions.version)) fail('unsupportedVersion')
}
export function decodeEnvelope(bytes: Uint8Array, context: ValidationContext = {}): Envelope {
  if (bytes.byteLength > LIMITS.maxBytes) fail()
  let value: unknown
  try {
    const wire = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    checkDepth(wire)
    value = JSON.parse(wire)
  } catch {
    fail()
  }
  bounded(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  checkVersion((value as Record<string, unknown>).version)
  const raw = value as Record<string, unknown>
  const payload = raw.payload as Record<string, unknown> | undefined
  if (raw.kind === 'hello' && Array.isArray(payload?.versions))
    for (const v of payload.versions) checkVersion(v)
  if (raw.kind === 'helloAck') checkVersion(payload?.version)
  if (!matches(value, schema as Rule)) fail()
  const envelope = value as Envelope
  const p = envelope.payload
  if ('scope' in p) {
    const scope = p.scope
    if (
      ((scope.chat || scope.checkout || scope.document) && !scope.project) ||
      (scope.turn && !scope.chat)
    )
      fail()
    if (context.expectedScope && canonical(scope) !== canonical(context.expectedScope))
      fail('unauthorized')
  }
  // Counters are strings so all UInt64 values survive both runtimes exactly.
  const counters: string[] = []
  if ('revision' in p && p.revision) counters.push(p.revision.counter)
  if ('expectedRevision' in p && p.expectedRevision) counters.push(p.expectedRevision.counter)
  if ('cursor' in p) counters.push(p.cursor.sequence)
  if ('sequence' in p) counters.push(p.sequence)
  if (envelope.kind === 'reply' && envelope.payload.result.kind === 'failed') {
    const r = envelope.payload.result.payload.currentRevision
    if (r) counters.push(r.counter)
  }
  if (counters.some((c) => BigInt(c) > 18_446_744_073_709_551_615n)) fail()
  if (envelope.kind === 'request') {
    const request = envelope.payload
    if (request.mode === 'mutation' && !request.expectedRevision) fail()
    if (
      request.mode === 'mutation' &&
      context.currentRevision &&
      canonical(request.expectedRevision) !== canonical(context.currentRevision)
    )
      fail('conflict')
    if (
      context.allowedMethods &&
      !context.allowedMethods.some(
        (allowed) => allowed.service === request.service && allowed.method === request.method
      )
    )
      fail('unsupportedCapability')
  }
  if (envelope.kind === 'hello' || envelope.kind === 'helloAck') {
    const caps = envelope.payload.capabilities
    if (new Set(caps.map((c) => c.name)).size !== caps.length) fail()
    if (envelope.kind === 'hello') for (const v of envelope.payload.versions) checkVersion(v)
    else {
      checkVersion(envelope.payload.version)
      if (envelope.payload.cursor.serviceEpoch !== envelope.payload.serviceEpoch) fail()
    }
  }
  return envelope
}
export function encodeEnvelope(value: Envelope): Uint8Array {
  // JSON.stringify coerces non-finite numbers to null. Validate the original
  // graph first so serialization cannot silently change operation intent.
  bounded(value)
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  decodeEnvelope(bytes)
  return bytes
}
/** Pure comparison only. A future durable ledger must persist this identity before effects. */
export function operationDisposition(
  current: RequestPayload,
  previous?: RequestPayload
): 'fresh' | 'duplicate' | 'idempotencyMismatch' {
  if (!previous || previous.operationID !== current.operationID) return 'fresh'
  const intent = (r: RequestPayload): JSONValue => ({
    mode: r.mode,
    service: r.service,
    method: r.method,
    scope: { ...r.scope },
    expectedRevision: r.expectedRevision ? { ...r.expectedRevision } : null,
    body: r.body
  })
  return canonical(intent(current)) === canonical(intent(previous))
    ? 'duplicate'
    : 'idempotencyMismatch'
}
