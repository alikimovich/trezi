import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  baseline,
  evaluate,
  LABELS,
  MODEL,
  metrics,
  redact,
  requestFor,
  validateDataset,
  validateResponse
} from '../scripts/jev/core.mjs'

const data = validateDataset(
  JSON.parse(readFileSync(new URL('./fixtures/jev/failure-cases.json', import.meta.url)))
)
assert.equal(data.filter((r) => r.split === 'holdout').length, 20)
assert.equal(data.filter((r) => r.split === 'development').length, 10)
for (const label of LABELS)
  assert.equal(data.filter((r) => r.split === 'holdout' && r.label === label).length, 4)
assert.throws(() => validateDataset([...data, data[0]]), /invalid_dataset_entry/)
const request = requestFor({
  evidence: 'timeout only',
  label: 'secret-label',
  rationale: 'answer leakage',
  id: 'private id'
})
assert.deepEqual(Object.keys(request), ['model', 'state', 'questions'])
assert.equal(request.state, 'timeout only')
assert(!JSON.stringify(request).includes('answer leakage'))
const fakeKey = 'FAKE_TEST_CREDENTIAL_DO_NOT_USE'
const sanitized = redact(
  `key=${fakeKey} Authorization: Bearer ${fakeKey}\napi_key="private-value"\nhttps://host.test/path?token=private-query\nperson@example.test /Users/alice/project`,
  [fakeKey]
)
for (const secret of [
  fakeKey,
  'private-value',
  'private-query',
  'person@example.test',
  '/Users/alice'
])
  assert(!sanitized.includes(secret))
assert.equal(
  redact('-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----'),
  '[REDACTED PRIVATE KEY]'
)

const body = {
  model: MODEL,
  answers: {
    cause: {
      type: 'choice',
      choice: 'environment',
      confidence: 0.9,
      probabilities: Object.fromEntries(
        LABELS.map((label) => [label, label === 'environment' ? 1 : 0])
      )
    }
  },
  usage: { input_tokens: 123, output_tokens: 20 }
}
let captured
const result = await evaluate({ evidence: `EPERM ${fakeKey}` }, fakeKey, async (url, options) => {
  captured = { url, options }
  return { ok: true, json: async () => ({ ...body, arbitrary: fakeKey }) }
})
assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone')
assert.equal(captured.options.redirect, 'error')
assert.equal(captured.options.headers.Authorization, `Bearer ${fakeKey}`)
assert(!captured.options.body.includes(fakeKey), 'credential excluded from model state')
assert(!JSON.stringify(result).includes(fakeKey), 'untrusted response fields excluded from reports')
assert.equal(result.choice, 'environment')
await assert.rejects(
  evaluate(data[0], fakeKey, async () => {
    throw new Error(fakeKey)
  }),
  /^Error: provider_network_or_timeout$/
)
await assert.rejects(
  evaluate(data[0], fakeKey, async () => ({ ok: false, status: 401, text: async () => fakeKey })),
  /^Error: provider_http_401$/
)
await assert.rejects(
  evaluate(data[0], fakeKey, async () => ({
    ok: true,
    json: async () => {
      throw new Error(fakeKey)
    }
  })),
  /^Error: invalid_provider_json$/
)
await assert.rejects(
  evaluate(data[0], '', () => {
    throw new Error('must not call')
  }),
  /missing_typesafe_key/
)
for (const mutate of [
  (b) => {
    b.answers.cause.choice = fakeKey
  },
  (b) => {
    b.answers.cause.confidence = NaN
  },
  (b) => {
    b.answers.cause.probabilities.environment = 0.5
  },
  (b) => {
    b.answers.cause.probabilities.extra = 0
  },
  (b) => {
    b.answers.cause.choice = 'unknown'
  },
  (b) => {
    b.usage.input_tokens = -1
  },
  (b) => {
    b.model = fakeKey
  }
]) {
  const invalid = structuredClone(body)
  mutate(invalid)
  assert.throws(() => validateResponse(invalid), /^Error: invalid_provider_response$/)
}
const row = (label, choice, p, latencyMs) => ({
  label,
  choice,
  baseline: 'environment',
  probabilities: Object.fromEntries(LABELS.map((l) => [l, l === choice ? p : (1 - p) / 4])),
  latencyMs,
  inputTokens: 100,
  outputTokens: 0
})
const m = metrics([
  row('environment', 'environment', 1, 100),
  row('timing', 'environment', 1, 300),
  { error: 'provider_http_429' }
])
assert.equal(m.accuracy, 0.5)
assert.equal(m.multiclassBrier, 1)
assert.equal(m.expectedCalibrationError, 0.5)
assert.equal(m.advisoryCoverage, 2 / 3)
assert.equal(m.advisoryAccuracy, 0.5)
assert.equal(m.errors, 1)
assert.equal(m.costIncomplete, true)
assert.equal(m.latencyP95Ms, 300)
assert.equal(m.confusion.timing.environment, 1)
assert.equal(metrics([]).accuracy, null)
assert.equal(metrics([row('unknown', 'unknown', 1, 100)]).advisoryCoverage, 0)
assert.equal(metrics([row('timing', 'timing', 0.6, 100)]).advisoryCoverage, 0)
assert.equal(baseline('HTTP 429 rate limit'), 'provider_limit')
assert.equal(baseline('EPERM binding socket'), 'environment')
console.log(
  'JEV-PILOT OK — dataset integrity, no label leakage, credential redaction, response validation, metrics, safe errors'
)
