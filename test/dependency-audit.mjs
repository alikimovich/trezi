import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyFindings } from '../scripts/dependency-audit.mjs'

const existing = { name: 'transitive-a', id: 'GHSA-old', severity: 'high' }
const newHigh = { name: 'transitive-b', id: 'GHSA-new', severity: 'high' }
const newLow = { name: 'transitive-c', id: 'GHSA-low', severity: 'low' }
const current = [existing, newHigh, newLow]

// A main push has no PR base: print the whole baseline, but introduce no gate.
assert.deepEqual(classifyFindings(current, undefined).added, [])
assert.deepEqual(classifyFindings(current, undefined).blocking, [])

// A PR gates only new high/critical package-advisory pairs.
const compared = classifyFindings(current, [existing])
assert.deepEqual(compared.added, [newHigh, newLow])
assert.deepEqual(compared.blocking, [newHigh])

// CI shape: only superseded PR runs are cancelled, the app build sees full history, and
// the retired candidate branch no longer triggers.
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/)
assert.match(workflow, /app build[\s\S]*?fetch-depth: 0/)
assert.doesNotMatch(workflow, /candidate/)

// The test job runs both typechecks as their own step, before an unfiltered unit tier
// that no longer carries --typecheck (they used to compete with the Swift fixtures).
const testJob = workflow.slice(workflow.indexOf('\n  test:'), workflow.indexOf('\n  app-build:'))
const steps = new Map(
  testJob
    .split(/\n {6}- name: /)
    .slice(1)
    .map((step) => [step.slice(0, step.indexOf('\n')), step])
)
const stepNames = [...steps.keys()]
const stepIndex = (name) => stepNames.indexOf(name)
assert.match(testJob, /timeout-minutes: 45\b/)
assert.ok(stepIndex('Typecheck') >= 0 && stepIndex('Unit tests') > stepIndex('Typecheck'))
const typecheckStep = steps.get('Typecheck')
assert.match(typecheckStep, /^ {10}bun run typecheck$/m, 'the node + preview typecheck runs')
assert.match(typecheckStep, /^ {10}bun run typecheck:native$/m, 'the native typecheck runs')
const unitStep = steps.get('Unit tests')
assert.match(unitStep, /node test\/run\.mjs unit --report --timeout-ms=120000 --log-tail=150\n/)
assert.doesNotMatch(
  unitStep,
  /--(typecheck|filter|serial|jobs)/,
  'every unit test, default workers'
)
assert.equal(
  testJob.match(/node test\/run\.mjs/g)?.length,
  1,
  'one runner call, no second filtered or concurrent run'
)
console.log('DEPENDENCY-AUDIT PASS')
