import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  branchStatus,
  cachedGithubApi,
  deriveChecks,
  deriveSync
} from '../src/main/branch-status.ts'
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
  ci: 'unknown',
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
// Local Git is real; all provider replies are fixtures, so no account is contacted.
const fixture = mkdtempSync(join(tmpdir(), 'trezi-status-'))
try {
  const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(fixture, 'page.txt'), 'one\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('remote', 'add', 'origin', 'https://github.com/example/site.git')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('checkout', '-qb', 'feature')
  writeFileSync(join(fixture, 'page.txt'), 'two\n')
  git('commit', '-qam', 'feature')
  const feature = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  writeFileSync(join(fixture, 'page.txt'), 'two\n')
  git('commit', '-qam', 'squash')
  const main = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('checkout', '-q', 'feature')
  git('branch', '--set-upstream-to=origin/main')
  const requests = []
  let remoteBaseSha = main
  const reads = {
    run: async (file, args) =>
      file === 'gh' ? JSON.stringify({ nameWithOwner: 'example/site' }) : git(...args),
    api: async (_root, path) => {
      requests.push(path)
      if (path.includes('/branches/main')) return { commit: { sha: remoteBaseSha } }
      if (path.includes('/pulls?'))
        return git('branch', '--show-current') === 'behind'
          ? []
          : [
              {
                number: 126,
                state: 'closed',
                merged_at: 'today',
                head: { sha: feature },
                base: { ref: 'main' },
                html_url: 'https://github.com/example/site/pull/126'
              }
            ]
      if (path.includes('/check-runs?'))
        return { check_runs: [{ name: 'main CI', status: 'in_progress' }] }
      if (path.includes('/deployments/1/statuses'))
        return [{ state: 'failure', target_url: 'https://example.test/failure' }]
      if (path.includes('/deployments?')) return [{ id: 1, sha: main }]
      throw new Error(`Unexpected API: ${path}`)
    }
  }
  const merged = await branchStatus(fixture, reads)
  assert.equal(merged.ahead, 1, 'history divergence remains')
  assert.equal(merged.unpublished, false, 'equivalent files are published')
  assert.equal(merged.pr?.state, 'merged')
  assert.equal(merged.commit, main, 'merged PR checks follow default SHA')
  assert.equal(merged.ci, 'running')
  assert.equal(merged.deployment.state, 'failed')
  assert.equal(merged.unpushed, 1, 'upstream commits are distinct from content')
  writeFileSync(join(fixture, 'page.txt'), 'three\n')
  const changed = await branchStatus(fixture, reads)
  assert.equal(changed.dirty, true)
  assert.equal(changed.unpublished, true)
  assert.equal(changed.pr, undefined, 'old merged PR does not follow new content')
  assert.equal(changed.deployment.state, 'stale', 'old deployment does not follow head')
  assert.equal(changed.ci, 'unknown', 'unpushed local SHA has no remote CI result')
  assert.ok(!requests.some((path) => path.includes(`/commits/${feature}/check-runs?`)))
  writeFileSync(join(fixture, 'page.txt'), 'two\n')
  remoteBaseSha = 'a'.repeat(40)
  const stale = await branchStatus(fixture, reads)
  assert.equal(stale.stale, true, 'outdated fetched default is marked stale')
  assert.equal(stale.commit, remoteBaseSha, 'main checks use the remote SHA')
  git('checkout', '-qb', 'behind', `${feature}~1`)
  git('branch', '--set-upstream-to=origin/main')
  remoteBaseSha = main
  const behind = await branchStatus(fixture, reads)
  assert.equal(behind.ahead, 0)
  assert.equal(behind.behind, 1)
  assert.equal(behind.unpublished, false, 'main-only changes are not unpublished content')
  assert.equal(behind.dirty, false)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
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
