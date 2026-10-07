import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentGitAccess, rawGitWrite } from '../src/main/agent-git-access.ts'
import { gitAccessHook } from '../src/main/backends/codex-mcp.ts'
import { compileRepositoryFixture, startRepositoryFixture } from './helpers/repository-fixture.mjs'
import { useRunnerEnv } from './helpers/runner-env.mjs'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-agent-git-')))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const version = (path) => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version

function setup(name) {
  const remote = join(root, `${name}.git`)
  mkdirSync(remote)
  git(remote, 'init', '-q', '--bare')
  const live = join(root, name)
  mkdirSync(live)
  git(live, 'init', '-q', '-b', 'main')
  git(live, 'config', 'user.name', 'User')
  git(live, 'config', 'user.email', 'user@local')
  git(live, 'config', 'commit.gpgsign', 'false')
  git(live, 'remote', 'add', 'origin', remote)
  writeFileSync(join(live, 'package.json'), '{"version":"0.2.4"}\n')
  git(live, 'add', 'package.json')
  git(live, 'commit', '-q', '-m', 'initial')
  git(live, 'checkout', '-q', '-b', 'trezi/main')
  writeFileSync(join(live, 'package.json'), '{"version":"0.2.6"}\n')
  git(live, 'commit', '-q', '-am', 'bump to 0.2.6')
  const landed = git(live, 'rev-parse', 'HEAD')
  git(live, 'checkout', '-q', 'main')
  writeFileSync(join(live, 'package.json'), '{"version":"0.2.5"}\n')
  git(live, 'commit', '-q', '-am', 'bump to 0.2.5')
  git(live, 'push', '-q', '-u', 'origin', 'main', 'trezi/main')
  git(live, 'checkout', '-q', 'trezi/main')
  const work = join(root, `${name}-chat`)
  git(live, 'worktree', 'add', '-q', '-b', `trezi/chat-${name}`, work, 'HEAD')
  const wt = { id: name, repoRoot: live, path: work, branch: `trezi/chat-${name}`, baseSha: landed }
  return { live, work, remote, wt, landed }
}

try {
  const binary = compileRepositoryFixture()
  // biome-ignore lint/correctness/useHookAtTopLevel: sets the process environment for this fixture
  useRunnerEnv(root)
  const fixture = await startRepositoryFixture(binary, root, { REPOSITORY_WORKTREES_ROOT: root })
  try {
    const owner = fixture.owner()
    const managed = setup('managed')
    const first = await owner.gitSyncBase(managed.wt, 'origin/main')
    assert.equal(first.merged, false)
    assert.deepEqual(first.conflicted, ['package.json'])
    assert.match(readFileSync(join(managed.work, 'package.json'), 'utf8'), /<<<<<<<|>>>>>>>/)
    writeFileSync(join(managed.work, 'package.json'), '{"version":"0.2.6"}\n')
    const continued = await owner.gitMergeContinue(managed.wt)
    assert.equal(
      git(managed.work, 'rev-list', '--parents', '-n', '1', continued.head).split(' ').length,
      3
    )
    assert.equal(version(managed.work), '0.2.6')
    const landing = await owner.completeTurn(managed.wt, 'Resolve package version', true)
    assert.equal(landing.outcome, 'merged')
    const liveCommit = await owner.commitLive(
      managed.live,
      landing.files,
      'Resolve package version',
      undefined,
      landing.newBase
    )
    assert.equal(liveCommit.committed, true)
    assert.equal(git(managed.live, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3)
    git(managed.live, 'merge-base', '--is-ancestor', managed.landed, 'HEAD')
    git(managed.live, 'merge-base', '--is-ancestor', continued.head, 'HEAD')
    git(managed.live, 'push', '-q', 'origin', 'trezi/main')
    assert.equal(
      git(managed.live, 'rev-parse', 'refs/remotes/origin/trezi/main'),
      git(managed.live, 'rev-parse', 'HEAD')
    )

    const full = setup('full')
    git(full.work, 'fetch', '-q', 'origin', 'main')
    try {
      git(full.work, 'merge', '--no-ff', 'origin/main')
    } catch {}
    writeFileSync(join(full.work, 'package.json'), '{"version":"0.2.6"}\n')
    git(full.work, 'add', 'package.json')
    git(full.work, 'commit', '-q', '-m', 'Resolve raw git merge')
    const rawHead = git(full.work, 'rev-parse', 'HEAD')
    const rawLanding = await owner.completeTurn(full.wt, 'Land raw merge', true, true)
    assert.equal(rawLanding.outcome, 'merged')
    const rawLive = await owner.commitLive(
      full.live,
      rawLanding.files,
      'Land raw merge',
      undefined,
      rawLanding.newBase
    )
    assert.equal(rawLive.committed, true)
    git(full.live, 'merge-base', '--is-ancestor', rawHead, 'HEAD')
    git(full.live, 'merge-base', '--is-ancestor', full.landed, 'HEAD')

    const committed = setup('commit')
    writeFileSync(join(committed.work, 'package.json'), '{"version":"0.2.7"}\n')
    git(committed.work, 'commit', '-q', '-am', 'Agent makes a raw commit')
    const commitHead = git(committed.work, 'rev-parse', 'HEAD')
    const commitLanding = await owner.completeTurn(committed.wt, 'Land raw commit', true, true)
    assert.equal(commitLanding.outcome, 'merged')
    await owner.commitLive(
      committed.live,
      commitLanding.files,
      'Land raw commit',
      undefined,
      commitLanding.newBase
    )
    assert.equal(version(committed.live), '0.2.7')
    git(committed.live, 'merge-base', '--is-ancestor', commitHead, 'HEAD')

    assert.equal(agentGitAccess(undefined), 'managed')
    assert.equal(agentGitAccess('full'), 'full')
    assert.match(
      rawGitWrite('Bash', { command: 'git merge origin/main' }, 'managed'),
      /git_sync_base/
    )
    assert.match(
      rawGitWrite('Bash', { command: 'git push origin trezi/main' }, 'managed'),
      /publish_update/
    )
    assert.equal(rawGitWrite('Bash', { command: 'git merge origin/main' }, 'full'), null)
    const hook = gitAccessHook(root, 'managed', managed.live)
    assert.equal(hook.features.hooks, true)
    assert.equal(hook.hooks.PreToolUse[0].matcher, '^Bash$')
    const blocked = spawnSync('bun', ['bin/trezi-git-guard.mjs', 'managed', managed.live], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git merge origin/main' }
      }),
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8'
    })
    assert.equal(blocked.status, 0)
    assert.match(
      JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecisionReason,
      /git_sync_base/
    )
    const allowed = spawnSync('bun', ['bin/trezi-git-guard.mjs', 'full', managed.live], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git merge origin/main' }
      }),
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8'
    })
    assert.equal(allowed.stdout, '')
  } finally {
    await fixture.stop()
  }
  console.log('AGENT-GIT PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
