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
import { compileWorkflowFixture, installFakes } from './helpers/workflow-fixture.mjs'

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

// LKM-355: the script compiles the workflow fixture, a cold compile of most service
// sources that queues behind other tests' swiftc runs in the 2-wide lane. Build it here
// first, so its time is logged apart from the script's runs, and bound each run: a hung
// run fails with its output instead of reaching the runner's limit with none.
const compileStart = Date.now()
compileWorkflowFixture()
console.log(`live-publish-attribution: workflow fixture ready in ${Date.now() - compileStart} ms`)
const RUN_LIMIT_MS = 120_000

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
      env: { ...env, PATH: `${join(scratch, 'fakes')}:${process.env.PATH}`, FAKE_GH_STATE: w.gh },
      timeout: RUN_LIMIT_MS
    }
  )
  return child
}
const ran = (child) =>
  `status ${child.status}, signal ${child.signal}${child.error ? `, ${child.error.message}` : ''}\nstdout: ${child.stdout}\nstderr: ${child.stderr}`
// Every check names itself; assert adds actual and expected.
const equal = (actual, expected, check) =>
  assert.equal(
    actual,
    expected,
    `${check}: actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
  )
const refused = (w, pattern, check) => {
  const child = run(w)
  assert.ok(
    child.status === 1 && pattern.test(child.stderr),
    `${check}: expected exit 1 and ${pattern}, got ${ran(child)}`
  )
}

try {
  // No remote branch: the script's trezi@local commit gives Publish a real change.
  const w = world('publish')
  const mainBefore = git(w.origin, 'rev-parse', 'refs/heads/main')
  const ok = run(w)
  assert.equal(ok.status, 0, `publish run exits 0: ${ran(ok)}`)
  const report = JSON.parse(ok.stdout)
  equal(report.result.ok, true, 'Publish result ok')
  equal(report.finalRemote, report.finalLocal, 'origin branch is the local tip')
  equal(report.remoteBase, mainBefore, 'reported origin main is unchanged')
  equal(git(w.origin, 'rev-parse', 'refs/heads/main'), mainBefore, 'origin main is unchanged')
  equal(
    git(w.origin, 'rev-parse', `refs/heads/${branch}`),
    report.finalLocal,
    'origin test branch is the final commit'
  )
  equal(report.final[1], 'Site Owner <owner@example.com>', 'publication commit author')
  equal(report.final[2], 'Site Owner <owner@example.com>', 'publication commit committer')
  equal(report.parent[1], 'Trezi <trezi@local>', 'throwaway commit author')
  equal(report.parent[2], 'Trezi <trezi@local>', 'throwaway commit committer')
  equal(
    git(w.clone, 'rev-parse', `${report.finalLocal}^^`),
    mainBefore,
    'the two commits sit on origin main'
  )
  equal(
    git(w.clone, 'diff', '--name-only', mainBefore, report.finalLocal),
    '.trezi-publish-verify.txt',
    'only the throwaway file changed'
  )
  const throwaway = readFileSync(join(w.clone, '.trezi-publish-verify.txt'), 'utf8')
  assert.match(
    throwaway,
    /LKM-255/,
    `throwaway file names LKM-255: actual ${JSON.stringify(throwaway)}`
  )
  const calls = JSON.parse(readFileSync(w.gh, 'utf8')).calls
  assert.deepEqual(
    calls.filter((call) => call !== '--version'),
    ['pr view', 'pr create'],
    `gh calls: actual ${JSON.stringify(calls)}, expected pr view and pr create (and --version)`
  )

  // Guards: the default branch, a wrong origin, an internal identity and a seeded branch.
  const guarded = world('guards')
  git(guarded.clone, 'checkout', '-q', 'main')
  refused(guarded, /refusing to publish from main/, 'refuses the default branch')
  git(guarded.clone, 'checkout', '-q', branch)
  git(guarded.clone, 'remote', 'set-url', 'origin', join(scratch, 'guards', 'elsewhere.git'))
  refused(guarded, /is not alikimovich\/lkmv\.ch/, 'refuses another origin')
  git(guarded.clone, 'remote', 'set-url', 'origin', guarded.origin)
  git(guarded.clone, 'config', 'user.email', 'trezi@local')
  refused(guarded, /set the user Git identity first/, 'refuses the internal identity')
  git(guarded.clone, 'config', 'user.email', 'owner@example.com')
  git(guarded.clone, 'push', '-q', 'origin', `${branch}:refs/heads/${branch}`)
  refused(guarded, /origin already has/, 'refuses a branch already on origin')
  equal(JSON.parse(readFileSync(guarded.gh, 'utf8')).calls?.length ?? 0, 0, 'guards call no gh')
  console.log('live-publish-attribution: ok')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
