import assert from 'node:assert/strict'
import { deriveChecks, deriveSync } from '../src/main/branch-status.ts'
import { prepublishCommands } from '../src/main/prepublish-checks.ts'

assert.deepEqual(deriveSync('0\t0', 'main'), { ahead: 0, behind: 0, sync: 'up to date' })
assert.deepEqual(deriveSync('2\t3', 'main'), {
  ahead: 3,
  behind: 2,
  sync: '3 ahead · 2 behind main'
})
assert.throws(() => deriveSync('bogus', 'main'))
assert.deepEqual(deriveChecks([]), { ci: 'none', failing: [] })
assert.deepEqual(deriveChecks([{ name: 'build', status: 'in_progress' }]), {
  ci: 'running',
  failing: []
})
assert.deepEqual(deriveChecks([{ name: 'build', status: 'completed', conclusion: 'success' }]), {
  ci: 'passed',
  failing: []
})
assert.deepEqual(deriveChecks([{ name: 'build', status: 'completed', conclusion: 'failure' }]), {
  ci: 'failed',
  failing: ['build']
})
assert.deepEqual(
  prepublishCommands(
    ['run: bun run lint\nrun: bun run test:native'],
    '## Pitfalls\n- Run `bun run typecheck` before publishing.'
  ),
  { run: ['lint', 'typecheck'], warn: ['CI step bun run test:native needs a local check'] }
)
