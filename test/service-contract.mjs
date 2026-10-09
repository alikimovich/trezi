import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import { skipUnlessSwift } from './helpers/darwin.mjs'
import { swiftBuild } from './helpers/swift-build.mjs'

skipUnlessSwift('the Swift half of the contract parity check')
const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'trezi-contract-'))
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024
  })
  assert.equal(
    result.status,
    0,
    `${command}: ${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`
  )
  return result.stdout
}
try {
  const bundle = join(scratch, 'codec.mjs')
  try {
    await build({
      entryPoints: [join(root, 'src/shared/service-contract/codec.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent'
    })
  } finally {
    // Own the bundler's lifetime even on failure; do not leave its unref'd service
    // for the suite runner's process-group cleanup after this test exits.
    await stop()
  }
  const { decodeEnvelope, encodeEnvelope, operationDisposition } = await import(bundle)
  const goldenPath = join(root, 'test/fixtures/service-contract/golden.json')
  const fixtures = JSON.parse(readFileSync(goldenPath, 'utf8'))
  // These values cannot be represented by JSON goldens: stringify would erase
  // the defect by coercing them to null before the encoder sees them.
  const numericBodies = [
    (amount) => ({ amount }),
    (amount) => ({ nested: { amount } }),
    (amount) => ({ nested: [0, { amounts: [amount] }] })
  ]
  for (const amount of [NaN, Infinity, -Infinity]) {
    for (const [index, body] of numericBodies.entries()) {
      const value = structuredClone(fixtures[0].value)
      value.payload.body = body(amount)
      assert.throws(
        () => encodeEnvelope(value),
        { code: 'invalidRequest' },
        `encoder rejects ${amount} in numeric payload shape ${index}`
      )
    }
  }
  for (const amount of [null, 0, 0.125, -0.125, Number.MAX_SAFE_INTEGER]) {
    for (const body of numericBodies) {
      const value = structuredClone(fixtures[0].value)
      value.payload.body = body(amount)
      assert.deepEqual(
        decodeEnvelope(encodeEnvelope(value)),
        value,
        'valid numbers and explicit null retain their intent'
      )
    }
  }
  // Invalid UTF-8 cannot be carried in JSON string fields.
  fixtures.push({
    name: 'invalid-utf8',
    wireBase64: Buffer.from([0xc3, 0x28]).toString('base64'),
    error: 'invalidRequest'
  })
  // Generate bulky size boundaries from the checked-in request; keep goldens reviewable.
  fixtures.push({ name: 'byte-limit', wire: ' '.repeat(65_537), error: 'invalidRequest' })
  for (const pad of ['a', '/'])
    for (const size of [65_536, 65_537]) {
      const value = structuredClone(fixtures[0].value)
      value.payload.body = { pad: '' }
      value.payload.body.pad = pad.repeat(size - Buffer.byteLength(JSON.stringify(value)))
      fixtures.push({
        name: `byte-boundary-${pad === '/' ? 'slash-' : ''}${size}`,
        wire: JSON.stringify(value),
        ...(size === 65_536 ? { value } : { error: 'invalidRequest' })
      })
    }
  const slashHeavy = structuredClone(fixtures[0].value)
  slashHeavy.payload.body = { pad: '/'.repeat(40_000) }
  fixtures.push({ name: 'slash-heavy-40000', wire: JSON.stringify(slashHeavy), value: slashHeavy })
  const multibyte = structuredClone(fixtures[0].value)
  multibyte.payload.body = { pad: '猫'.repeat(22_000) }
  fixtures.push({
    name: 'unicode-byte-limit',
    wire: JSON.stringify(multibyte),
    error: 'invalidRequest'
  })
  const inputPath = join(scratch, 'cases.json')
  writeFileSync(inputPath, JSON.stringify(fixtures))
  const tsResults = fixtures.map((test) => {
    const { name, wire, wireBase64, previous, ...context } = test
    try {
      const decoded = decodeEnvelope(
        wireBase64 ? Buffer.from(wireBase64, 'base64') : Buffer.from(wire),
        context
      )
      const value = JSON.parse(Buffer.from(encodeEnvelope(decoded)).toString('utf8'))
      const result = { name, value }
      if (previous)
        result.disposition = operationDisposition(
          decoded.payload,
          decodeEnvelope(Buffer.from(previous)).payload
        )
      return result
    } catch (error) {
      return { name, error: error.code ?? String(error) }
    }
  })
  const expected = fixtures.map(({ name, value, error, disposition }) =>
    error ? { name, error } : { name, value, ...(disposition ? { disposition } : {}) }
  )
  for (let i = 0; i < fixtures.length; i++)
    assert.deepEqual(tsResults[i], expected[i], `TypeScript: ${fixtures[i].name}`)
  const binary = swiftBuild('service-contract', [
    'src/service/ServiceContract.swift',
    'test/fixtures/service-contract/main.swift'
  ])
  const swiftResults = JSON.parse(
    run(binary, ['src/shared/service-contract/schema.json', inputPath])
  )
  assert.equal(swiftResults.length, expected.length)
  for (let i = 0; i < fixtures.length; i++)
    assert.deepEqual(swiftResults[i], expected[i], `Swift: ${fixtures[i].name}`)
  const encodedByTS = tsResults
    .filter((result) => result.value)
    .map((result) => ({
      name: `ts-encoded-${result.name}`,
      wire: Buffer.from(encodeEnvelope(result.value)).toString('utf8'),
      value: result.value
    }))
  writeFileSync(inputPath, JSON.stringify(encodedByTS))
  const receivedBySwift = JSON.parse(
    run(binary, ['src/shared/service-contract/schema.json', inputPath])
  )
  assert.deepEqual(
    receivedBySwift,
    encodedByTS.map(({ name, value }) => ({ name, value })),
    'Swift receives TypeScript encoding'
  )
  for (const result of swiftResults.filter((result) => result.value)) {
    assert.deepEqual(
      decodeEnvelope(Buffer.from(JSON.stringify(result.value))),
      result.value,
      `TypeScript receives Swift: ${result.name}`
    )
  }
  // A reordered retry has the same semantic operation identity, while array order and null/absence matter.
  const request = tsResults[0].value.payload
  assert.equal(operationDisposition(request), 'fresh')
  assert.equal(
    operationDisposition(
      { ...request, body: Object.fromEntries(Object.entries(request.body).reverse()) },
      request
    ),
    'duplicate'
  )
  assert.equal(
    operationDisposition({ ...request, body: { ...request.body, absent: null } }, request),
    'idempotencyMismatch'
  )
  const roadmap = readFileSync(join(root, 'docs/SWIFT-BACKEND-ROADMAP.md'), 'utf8')
  const tasks = new Set([...roadmap.matchAll(/^\| (S\d{2}) \|/gm)].map((match) => match[1]))
  assert.equal(tasks.size, 15, 'roadmap declares all 15 migration tasks')
  for (const [name, count] of [
    ['MODULES', 146],
    ['ROUTES', 133],
    ['EVENTS', 240]
  ]) {
    const rows = readFileSync(join(root, `docs/SWIFT-BACKEND-${name}.md`), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
    rows.shift() // census header
    assert.equal(rows.length, count, `${name}: every audited row retained`)
    for (const row of rows) {
      const columns = row
        .split('|')
        .map((value) => value.trim())
        .filter(Boolean)
      assert.ok(tasks.has(columns.at(-2)), `${name}: missing task: ${row}`)
      assert.ok(columns.at(-1).length > 3, `${name}: missing future owner`)
    }
  }
  console.log(
    `SERVICE-CONTRACT PASS — ${fixtures.length} golden cases agree in TypeScript and Swift`
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
