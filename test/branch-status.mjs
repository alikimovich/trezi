import assert from 'node:assert/strict'
import { cachedGithubApi, deriveChecks, deriveSync } from '../src/main/branch-status.ts'
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
  deriveChecks([{ name: 'build', status: 'completed', conclusion: 'startup_failure' }]),
  { ci: 'failed', failing: ['build'] }
)
assert.deepEqual(deriveChecks([{ name: 'build', status: 'completed', conclusion: 'cancelled' }]), {
  ci: 'none',
  failing: []
})
assert.deepEqual(
  deriveChecks([
    { id: 1, name: 'build', status: 'completed', conclusion: 'failure' },
    { id: 2, name: 'build', status: 'completed', conclusion: 'success' }
  ]),
  { ci: 'passed', failing: [] }
)
let requests = 0
const api = cachedGithubApi(async () => {
  requests++
  if (requests === 1) return 'HTTP/2.0 200 OK\r\netag: "one"\r\n\r\n{"ok":true}'
  throw Object.assign(new Error('304'), { stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n' })
})
assert.deepEqual(await api('/repo', 'path'), { ok: true })
assert.deepEqual(await api('/repo', 'path'), { ok: true })
assert.deepEqual(
  prepublishCommands(
    ['run: bun run lint\nrun: npm run typecheck\nrun: pnpm test\nrun: make build'],
    '## Pitfalls\n- Run `bun run missing` before publishing.',
    { lint: 'biome', typecheck: 'tsc' }
  ),
  {
    run: ['lint', 'typecheck'],
    warn: [
      'CI step pnpm test needs a local check',
      'CI step make build needs a local check',
      'CI step bun run missing needs a local check'
    ]
  }
)
