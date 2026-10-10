import assert from 'node:assert/strict'
import { cachedGithubApi, deriveChecks, deriveSync } from '../src/main/branch-status.ts'
import { prepublishCommands, prepublishRunWarning } from '../src/main/prepublish-checks.ts'

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

// A run killed by the 10 s timeout is "did not finish", never a false "failed"; a real
// non-zero exit still reports "failed".
const timedOut = prepublishRunWarning(
  'typecheck',
  Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })
)
assert.match(timedOut, /did not finish locally within 10 s; CI will run it/)
assert.doesNotMatch(timedOut, /failed/)
const exited = prepublishRunWarning(
  'check',
  Object.assign(new Error('Command failed: bun run check'), {
    code: 1,
    killed: false,
    signal: null
  })
)
assert.match(exited, /^Pre-publish check bun run check failed: /)
assert.doesNotMatch(exited, /did not finish/)
