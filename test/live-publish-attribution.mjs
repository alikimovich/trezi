// scripts/live-publish-attribution.mjs (LKM-255) against a local bare "origin" and the
// scripted `gh`: nothing leaves the machine. The script makes the throwaway trezi@local
// commit itself, the real service Publish creates the remote branch and appends the
// user-identity publication commit, and the default branch on origin is untouched.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFakes } from './helpers/workflow-fixture.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-live-publish-test-')))
const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
installFakes(join(scratch, 'fakes'))
const branch = 'trezi-lkm255-attribution-test'

function world(name) {
  const base = join(scratch, name)
  mkdirSync(join(base, 'alikimovich'), { recursive: true })
  const origin = join(base, 'alikimovich', 'lkmv.ch.git')
  const clone = join(base, 'clone')
  writeFileSync(join(base, 'gh.json'), '{}')
  git(base, 'init', '-q', '--bare', '--initial-branch=main', origin)
  git(base, 'init', '-q', '--initial-branch=main', clone)
  git(clone, 'config', 'user.name', 'Site Owner')
  git(clone, 'config', 'user.email', 'owner@example.com')
  writeFileSync(join(clone, 'index.html'), 'site\n')
  git(clone, 'add', '-A')
  git(clone, 'commit', '-qm', 'init')
  git(clone, 'remote', 'add', 'origin', origin)
  git(clone, 'push', '-q', '-u', 'origin', 'main')
  git(clone, 'remote', 'set-head', 'origin', 'main')
  git(clone, 'checkout', '-q', '--no-track', '-b', branch, 'origin/main')
  return { base, origin, clone, gh: join(base, 'gh.json') }
}

function run(w, ...extra) {
  const child = spawnSync(
    process.execPath,
    [
      join(repo, 'scripts/live-publish-attribution.mjs'),
      w.clone,
      '--origin',
      'alikimovich/lkmv.ch',
      '--confirm',
      branch,
      ...extra
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { ...env, PATH: `${join(scratch, 'fakes')}:${process.env.PATH}`, FAKE_GH_STATE: w.gh }
    }
  )
  return child
}

try {
  // No remote branch: the script's trezi@local commit gives Publish a real change.
  const w = world('publish')
  const mainBefore = git(w.origin, 'rev-parse', 'refs/heads/main')
  const ok = run(w)
  assert.equal(ok.status, 0, ok.stderr + ok.stdout)
  const report = JSON.parse(ok.stdout)
  assert.equal(report.result.ok, true)
  assert.equal(report.finalRemote, report.finalLocal)
  assert.equal(report.remoteBase, mainBefore)
  assert.equal(git(w.origin, 'rev-parse', 'refs/heads/main'), mainBefore)
  assert.equal(git(w.origin, 'rev-parse', `refs/heads/${branch}`), report.finalLocal)
  assert.equal(report.final[1], 'Site Owner <owner@example.com>')
  assert.equal(report.final[2], 'Site Owner <owner@example.com>')
  assert.equal(report.parent[1], 'Trezi <trezi@local>')
  assert.equal(report.parent[2], 'Trezi <trezi@local>')
  assert.equal(git(w.clone, 'rev-parse', `${report.finalLocal}^^`), mainBefore)
  assert.equal(
    git(w.clone, 'diff', '--name-only', mainBefore, report.finalLocal),
    '.trezi-publish-verify.txt'
  )
  assert.match(readFileSync(join(w.clone, '.trezi-publish-verify.txt'), 'utf8'), /LKM-255/)
  const calls = JSON.parse(readFileSync(w.gh, 'utf8')).calls
  assert.deepEqual(
    calls.filter((call) => call !== '--version'),
    ['pr view', 'pr create']
  )

  // Guards: the default branch, a wrong origin, an internal identity and a seeded branch.
  const guarded = world('guards')
  git(guarded.clone, 'checkout', '-q', 'main')
  assert.match(run(guarded).stderr, /refusing to publish from main/)
  git(guarded.clone, 'checkout', '-q', branch)
  git(guarded.clone, 'remote', 'set-url', 'origin', join(scratch, 'guards', 'elsewhere.git'))
  assert.match(run(guarded).stderr, /is not alikimovich\/lkmv\.ch/)
  git(guarded.clone, 'remote', 'set-url', 'origin', guarded.origin)
  git(guarded.clone, 'config', 'user.email', 'trezi@local')
  assert.match(run(guarded).stderr, /set the user Git identity first/)
  git(guarded.clone, 'config', 'user.email', 'owner@example.com')
  git(guarded.clone, 'push', '-q', 'origin', `${branch}:refs/heads/${branch}`)
  assert.match(run(guarded).stderr, /origin already has/)
  assert.equal(JSON.parse(readFileSync(guarded.gh, 'utf8')).calls?.length ?? 0, 0)
  console.log('live-publish-attribution: ok')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
