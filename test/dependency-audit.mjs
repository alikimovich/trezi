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

// LKM-327: both typechecks run once in their own Linux job; the unit tier runs in macOS
// shards (3 on a pull request, 1 whole run on a push to main) with no --typecheck; one
// `typecheck + unit tests` gate needs both. The unit tier is unfiltered on a push to
// main; a pull request adds only --changed=<base SHA>.
const job = (id) => {
  const start = workflow.indexOf(`\n  ${id}:\n`)
  assert.ok(start >= 0, `job ${id}`)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/)
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}
const stepsOf = (text) =>
  new Map(
    text
      .split(/\n {6}- name: /)
      .slice(1)
      .map((step) => [step.slice(0, step.indexOf('\n')), step])
  )
const typecheckJob = job('typecheck')
assert.match(typecheckJob, /runs-on: ubuntu-latest/)
const typecheckStep = stepsOf(typecheckJob).get('Typecheck')
assert.match(typecheckStep, /^ {10}bun run typecheck$/m, 'the node + preview typecheck runs')
assert.match(typecheckStep, /^ {10}bun run typecheck:native$/m, 'the native typecheck runs')
assert.match(typecheckJob, /bun scripts\/check-version\.mjs/)

const unitJob = job('unit')
assert.match(unitJob, /runs-on: macos-26/)
assert.match(unitJob, /timeout-minutes: 45\b/)
assert.match(unitJob, /fail-fast: false/)
assert.match(
  unitJob,
  /shard: \$\{\{ fromJSON\(github\.event_name == 'pull_request' && '\[1, 2, 3\]' \|\| '\[1\]'\) \}\}/,
  'a push to main runs the whole tier in one shard'
)
const unitSteps = stepsOf(unitJob)
assert.ok(!unitSteps.has('Typecheck'), 'the shards do not typecheck')
const unitStep = unitSteps.get('Unit tests')
assert.match(
  unitStep,
  /^ {10}node test\/run\.mjs unit --report --timeout-ms=120000 --log-tail=150 --shard="\$TREZI_TEST_SHARD" "\$@"\n/m
)
assert.match(
  unitStep,
  /TREZI_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/
)
// The only extra argument is the PR's own base SHA, and it is empty off pull requests.
assert.match(
  unitStep,
  /TREZI_TEST_BASE: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| '' \}\}/
)
assert.deepEqual(unitStep.match(/set -- .*/g), ['set -- --changed="$TREZI_TEST_BASE"; fi'])
assert.match(unitStep, /if \[ -n "\$TREZI_TEST_BASE" \]; then set -- /)
assert.doesNotMatch(
  unitStep,
  /--(typecheck|filter|serial|jobs)/,
  'every unit test, default workers'
)
assert.equal(
  workflow.replace(/^\s*#.*$/gm, '').match(/node test\/run\.mjs/g)?.length,
  1,
  'one runner call, no second filtered or concurrent run'
)
// Each shard keys its own Swift cache and logs what it restored.
assert.match(unitJob, /key: unit-swift-\$\{\{ runner\.os \}\}-\$\{\{ matrix\.shard \}\}of/)
assert.ok(unitSteps.has('Swift test cache result'))
assert.match(unitJob, /name: unit-test-logs-\$\{\{ matrix\.shard \}\}of/)

const gate = job('test')
assert.match(gate, /name: typecheck \+ unit tests\n/)
assert.match(gate, /needs: \[typecheck, unit\]/)
assert.match(gate, /if: always\(\)/, 'a failed or cancelled shard fails the check, never skips it')
assert.match(gate, /test "\$TYPECHECK" = success && test "\$UNIT" = success/)
console.log('DEPENDENCY-AUDIT PASS')
