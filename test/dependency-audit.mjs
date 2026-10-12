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
console.log('DEPENDENCY-AUDIT PASS')
