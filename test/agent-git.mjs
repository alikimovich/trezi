import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentGitAccess, rawGitWrite } from '../src/main/agent-git-access.ts'
import { setAgentMergeSource } from '../src/main/agent-merge-setting.ts'
import { gitAccessHook } from '../src/main/backends/codex-mcp.ts'
import { agentGitTool, PUBLISH_WORKFLOW_BUDGET_MS } from '../src/main/chat-agent-git.ts'
import { states } from '../src/main/chat-state.ts'
import { runTreziTool } from '../src/main/session-tools.ts'
import { setWorkflowOwner } from '../src/main/workflow-owner.ts'
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
    const fakeBin = join(root, 'bin')
    mkdirSync(fakeBin)
    const fakeGh = join(fakeBin, 'gh')
    writeFileSync(
      fakeGh,
      '#!/bin/sh\nif [ "$1 $2 $3 $4" = "pr view 6 --json" ] && [ "$5" = "state,mergeCommit" ]; then printf \'%s\\n\' \'{"state":"MERGED","mergeCommit":{"oid":"abcdef1234"}}\'; elif [ "$1 $2" = "run list" ]; then printf \'%s\\n\' \'[{"name":"Publish release","status":"completed","conclusion":"success","url":"https://example.test/run/1"}]\'; else printf \'%s\\n\' \'{"number":6,"url":"https://example.test/pr/6","mergeable":"CONFLICTING","baseRefName":"main","headRefName":"trezi/main","statusCheckRollup":[]}\'; fi\n'
    )
    chmodSync(fakeGh, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${originalPath}`
    const statusRepo = setup('status')
    const statusScope = {
      root: statusRepo.work,
      liveRoot: statusRepo.live,
      emitKey: 'status-agent',
      background: false,
      notify() {}
    }
    const scope = {
      root: managed.work,
      liveRoot: managed.live,
      emitKey: 'managed-agent',
      background: false,
      notify() {}
    }
    states.set(statusScope.emitKey, {
      wt: statusRepo.wt,
      liveRoot: statusRepo.live,
      reclaimed: false
    })
    states.set(scope.emitKey, { wt: managed.wt, liveRoot: managed.live, reclaimed: false })
    try {
      const status = await runTreziTool('pr_status', { number: 6 }, statusScope)
      assert.equal(status.mergeable, 'CONFLICTING')
      assert.deepEqual(status.conflictingFiles, ['package.json'])
      const pushes = []
      setWorkflowOwner({
        publish: async (live, mode) => {
          pushes.push([live, mode, ['origin', 'trezi/main']])
          git(live, 'push', 'origin', 'trezi/main')
          return { ok: true, url: 'https://example.test/pr/6' }
        }
      })
      const published = await agentGitTool(
        scope.emitKey,
        scope.root,
        scope.liveRoot,
        'publish_update',
        {}
      )
      assert.equal(published.pushed, true)
      assert.deepEqual(pushes, [[managed.live, 'pr', ['origin', 'trezi/main']]])
      const merged = await agentGitTool(
        scope.emitKey,
        scope.root,
        scope.liveRoot,
        'publish_merge',
        {}
      )
      assert.equal(merged.merged, true)
      assert.equal(merged.mergeCommit, 'abcdef1234')
      assert.equal(merged.workflow.conclusion, 'success')
      // LKM-203: the workflow is polled from the call's start, not forever: past the budget
      // a running workflow is reported as in_progress with its url, never a tool timeout.
      const runningBin = join(root, 'running-bin')
      mkdirSync(runningBin)
      const runningGh = join(runningBin, 'gh')
      writeFileSync(
        runningGh,
        readFileSync(fakeGh, 'utf8').replace(
          '"status":"completed","conclusion":"success"',
          '"status":"in_progress"'
        )
      )
      chmodSync(runningGh, 0o755)
      process.env.PATH = `${runningBin}:${fakeBin}:${originalPath}`
      const started = Date.now()
      const pending = await agentGitTool(
        scope.emitKey,
        scope.root,
        scope.liveRoot,
        'publish_merge',
        {},
        Date.now() - PUBLISH_WORKFLOW_BUDGET_MS - 1
      )
      assert.equal(pending.merged, true)
      assert.equal(pending.workflow.state, 'in_progress')
      assert.equal(pending.workflow.url, 'https://example.test/run/1')
      assert.ok(Date.now() - started < 20_000, 'an exhausted budget does not keep polling')
      process.env.PATH = `${fakeBin}:${originalPath}`
      setAgentMergeSource(() => 'false')
      const refused = await agentGitTool(
        scope.emitKey,
        scope.root,
        scope.liveRoot,
        'publish_merge',
        {}
      )
      assert.match(refused.error, /Agent PR merging is off/)
    } finally {
      states.delete(statusScope.emitKey)
      states.delete(scope.emitKey)
      setWorkflowOwner(null)
      setAgentMergeSource(() => null)
      process.env.PATH = originalPath
    }
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
    for (const command of [
      'git branch',
      'git branch --show-current',
      'git stash list',
      'git tag -l',
      'git worktree list'
    ])
      assert.equal(rawGitWrite('Bash', { command }, 'managed'), null, command)
    for (const command of [
      'git push origin trezi/main',
      'git push --force origin trezi/main',
      'git update-ref refs/heads/trezi/main HEAD',
      'git branch -f trezi/main HEAD',
      `git -C ${managed.live} reset --hard HEAD`
    ])
      assert.match(
        rawGitWrite('Bash', { command }, 'full', managed.live, managed.work),
        /refused/,
        command
      )
    assert.match(
      rawGitWrite(
        'Bash',
        { command: 'git branch --show-current && git push origin trezi/main' },
        'managed'
      ),
      /publish_update/
    )
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
    const blockedFull = spawnSync(
      'bun',
      ['bin/trezi-git-guard.mjs', 'full', managed.live, managed.work],
      {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'git update-ref refs/heads/trezi/main HEAD' }
        }),
        cwd: new URL('..', import.meta.url).pathname,
        encoding: 'utf8'
      }
    )
    assert.match(
      JSON.parse(blockedFull.stdout).hookSpecificOutput.permissionDecisionReason,
      /refused/
    )
  } finally {
    await fixture.stop()
  }
  console.log('AGENT-GIT PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
