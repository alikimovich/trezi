// S13 workflow owner: the real Swift WorkflowOwner (compiled into a fixture process with
// the repository coordinator) driven through Bun's real client, against scratch
// repositories, bare "GitHub" remotes and a scripted `gh` / package manager. No
// network, no GitHub, no real user repository.
// - scenarios: publish (merge, PR only, reuse, conflict, nothing), handoff, a saved
//   run's PR, Connect, remote status/pull/switch, instrumentation helpers, a new project,
//   the Trezi update, the diagnosis memory, skill packs and feedback, with the Git and
//   GitHub state each leaves (the TS twin these once matched was removed in LKM-111);
// - durability (run by test/workflow-durability.mjs): a reply lost after a remote
//   effect, a crash after the PR, the merge, the repository or the pull, GitHub failing
//   after acting, install/build failures and their resumption, cancellation, busy,
//   restart listing and dismissal, drain, a relaunch, redaction and schema.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signatureFor } from '../src/main/diag-cache.ts'
import { starterFiles } from '../src/main/scaffold.ts'
import { detect, helperFiles } from '../src/main/setup.ts'
import {
  compileWorkflowFixture,
  installFakes,
  startWorkflowFixture
} from './helpers/workflow-fixture.mjs'

// Bun resolves a spawned command with the PATH it started with, so the scripted `gh`,
// `bun` and `npm` must be on PATH before this process starts: re-run under them, with
// Bun's auto-install off. The real tools are never reached (no GitHub, no registry).
if (!process.env.TREZI_WORKFLOW_FAKES) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-workflow-fakes-')))
  installFakes(bin)
  const child = spawnSync(
    process.execPath,
    ['--no-install', new URL(import.meta.url).pathname, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, TREZI_WORKFLOW_FAKES: bin, PATH: `${bin}:${process.env.PATH}` }
    }
  )
  rmSync(bin, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
assert.equal(
  execFileSync('gh', ['--version'], { encoding: 'utf8' }).trim(),
  'gh version 2.99.0 (fake)'
)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-workflow-owner-')))
const compiling = Date.now()
const binary = compileWorkflowFixture()
const fakes = {
  gh: join(process.env.TREZI_WORKFLOW_FAKES, 'gh'),
  bun: join(process.env.TREZI_WORKFLOW_FAKES, 'bun')
}
const began = Date.now()
const log = (...args) => console.log(`[${((Date.now() - began) / 1000).toFixed(1)}s]`, ...args)
// A cold cache waits for a swiftc slot and compiles here, inside the test's budget (LKM-209).
log(`fixture ready after ${((began - compiling) / 1000).toFixed(1)}s (swiftc lane)`)
const fixtures = []
// Git may only use local (file) transports here and in the fixtures: no network (LKM-209).
const offline = { GIT_ALLOW_PROTOCOL: 'file' }
const env = {
  ...offline,
  GIT_AUTHOR_NAME: 'Tester',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Tester',
  GIT_COMMITTER_EMAIL: 't@example.com'
}
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
const gitAs = (cwd, identity, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
const write = (cwd, file, content) => writeFileSync(join(cwd, file), content)
const commit = (cwd, file, content) => {
  write(cwd, file, content)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', `change ${file}`)
}
const describe = async (base) => ({
  title: 'Update the greeting',
  body: `Changes against ${base}.`
})
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** A project with an origin (bare) remote, pushed main, on trezi/main. */
function world(name, { remote = true } = {}) {
  const base = join(scratch, name)
  mkdirSync(base, { recursive: true })
  const w = {
    base,
    origin: join(base, 'origin.git'),
    local: join(base, 'project'),
    profile: join(base, 'profile'),
    ghState: join(base, 'gh.json'),
    pmState: join(base, 'pm.json')
  }
  mkdirSync(w.profile)
  git(base, 'init', '-q', '--initial-branch=main', w.local)
  for (const [key, value] of [
    ['user.name', 'Tester'],
    ['user.email', 't@example.com']
  ])
    git(w.local, 'config', key, value)
  commit(w.local, 'a.txt', 'one\n')
  if (remote) {
    git(base, 'init', '-q', '--bare', '--initial-branch=main', w.origin)
    git(w.local, 'remote', 'add', 'origin', w.origin)
    git(w.local, 'push', '-q', '-u', 'origin', 'main')
    git(w.local, 'remote', 'set-head', 'origin', 'main')
  }
  git(w.local, 'checkout', '-q', '-b', 'trezi/main')
  writeFileSync(w.ghState, '{}')
  writeFileSync(w.pmState, '{}')
  w.gh = () => json(w.ghState)
  w.pm = () => json(w.pmState)
  /** Another clone of the remote (a collaborator). */
  w.peer = () => {
    const peer = join(base, `peer-${Math.random().toString(36).slice(2, 7)}`)
    git(base, 'clone', '-q', w.origin, peer)
    for (const [key, value] of [
      ['user.name', 'Peer'],
      ['user.email', 'p@example.com']
    ])
      git(peer, 'config', key, value)
    return peer
  }
  return w
}

/** Git and GitHub state after a scenario, paths and volatile names normalized. */
function snapshot(w) {
  const out = {
    branch: git(w.local, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status: git(w.local, 'status', '--porcelain'),
    files: readdirSync(w.local)
      .filter((f) => f !== '.git')
      .sort()
  }
  if (existsSync(w.origin)) {
    out.remote = git(w.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
      .split('\n')
      .filter(Boolean)
      .sort()
    out.mainLog = git(w.origin, 'log', '--format=%s', 'main').split('\n')
  }
  const gh = w.gh()
  out.gh = {
    counts: gh.counts ?? {},
    prs: (gh.prs ?? []).map(({ number, head, base, title, state, mergeSubject }) => ({
      number,
      head,
      base,
      title,
      state,
      mergeSubject
    }))
  }
  return out
}

const normalize = (value, w) =>
  JSON.parse(
    JSON.stringify(value ?? null)
      .replaceAll(w.base, '<world>')
      .replace(/trezi\/handoff-[a-z0-9]+/g, 'trezi/handoff-X')
      .replace(
        /refs\/trezi\/recovery\/([^"]+?)\/\d+-\d+-(local|remote)/g,
        'refs/trezi/recovery/$1/X-$2'
      )
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, 'T')
  )

async function start(w, extra = {}) {
  const fixture = await startWorkflowFixture(binary, w.profile, {
    ...offline,
    FAKE_GH_STATE: w.ghState,
    FAKE_PM_STATE: w.pmState,
    WORKFLOW_BUN: fakes.bun,
    ...extra
  })
  fixtures.push(fixture)
  return fixture
}

/** Runs `scenario` on a fresh world with the Swift owner; answers are normalized. */
async function owned(name, scenario, options) {
  const w = world(`owned-${name}`, options)
  const fixture = await start(w)
  const result = normalize(await scenario(fixture.workflows(), w), w)
  await fixture.stop()
  log(`owned ${name}`)
  return result
}

// The tool and durability checks are their own unit test, test/workflow-durability.mjs,
// so the two halves run side by side (LKM-167).
const durabilityPart = process.env.TREZI_WORKFLOW_PART === 'durability'
try {
  if (!durabilityPart) {
    // ───────────── scenarios ─────────────
    const merged = await owned('publish-merge', async (owner, w) => {
      write(w.local, 'a.txt', 'two\n')
      return { result: await owner.publish(w.local, 'merge', describe), state: snapshot(w) }
    })
    assert.equal(merged.result.ok, true)
    assert.deepEqual(merged.state.remote, ['main'])
    assert.equal(merged.state.mainLog[0], 'Update the greeting (#1)')
    assert.equal(merged.state.branch, 'trezi/main')

    const reused = await owned('publish-pr-reuse', async (owner, w) => {
      write(w.local, 'a.txt', 'two\n')
      const first = await owner.publish(w.local, 'pr', describe)
      write(w.local, 'b.txt', 'more\n')
      const second = await owner.publish(w.local, 'pr', describe)
      return { first, second, state: snapshot(w) }
    })
    assert.equal(reused.second.url, reused.first.url)
    assert.equal(reused.state.gh.counts.prCreate, 1)

    const automated = await owned('publish-attribution', async (owner, w) => {
      const internal = { name: 'Trezi', email: 'trezi@local' }
      write(w.local, 'a.txt', 'automated\n')
      git(w.local, 'add', '-A')
      gitAs(w.local, internal, 'commit', '-qm', 'Internal landing')
      const parent = git(w.local, 'rev-parse', 'HEAD')
      const tree = git(w.local, 'rev-parse', 'HEAD^{tree}')
      const first = await owner.publish(w.local, 'pr', describe)
      const head = git(w.local, 'rev-parse', 'HEAD')
      const repeated = await owner.publish(w.local, 'pr', describe)
      return {
        first,
        repeated,
        parent,
        tree,
        head,
        after: git(w.local, 'rev-parse', 'HEAD'),
        author: git(w.local, 'show', '-s', '--format=%an <%ae> | %cn <%ce>', 'HEAD'),
        parentAfter: git(w.local, 'rev-parse', 'HEAD^'),
        treeAfter: git(w.local, 'rev-parse', 'HEAD^{tree}'),
        message: git(w.local, 'show', '-s', '--format=%s', 'HEAD')
      }
    })
    assert.equal(automated.first.ok, true)
    assert.equal(automated.repeated.ok, true)
    assert.equal(automated.head, automated.after, 'repeated Publish adds no second commit')
    assert.equal(automated.parent, automated.parentAfter)
    assert.equal(automated.tree, automated.treeAfter)
    assert.equal(automated.author, 'Tester <t@example.com> | Tester <t@example.com>')
    assert.equal(automated.message, 'Publish project changes')

    const human = await owned('publish-human-tip', async (owner, w) => {
      commit(w.local, 'a.txt', 'human\n')
      const before = git(w.local, 'rev-parse', 'HEAD')
      const result = await owner.publish(w.local, 'pr', describe)
      return { result, before, after: git(w.local, 'rev-parse', 'HEAD') }
    })
    assert.equal(human.result.ok, true)
    assert.equal(human.before, human.after)

    const remoteAutomated = await owned('publish-remote-automated', async (owner, w) => {
      const peer = w.peer()
      git(peer, 'checkout', '-q', '-b', 'trezi/main')
      write(peer, 'a.txt', 'remote automated\n')
      git(peer, 'add', '-A')
      gitAs(peer, { name: 'Trezi', email: 'trezi@local' }, 'commit', '-qm', 'Remote landing')
      const remoteHead = git(peer, 'rev-parse', 'HEAD')
      git(peer, 'push', '-q', 'origin', 'trezi/main')
      const result = await owner.publish(w.local, 'pr', describe)
      return {
        result,
        remoteHead,
        parent: git(w.local, 'rev-parse', 'HEAD^'),
        author: git(w.local, 'show', '-s', '--format=%ae', 'HEAD')
      }
    })
    assert.equal(remoteAutomated.result.ok, true)
    assert.equal(remoteAutomated.parent, remoteAutomated.remoteHead)
    assert.equal(remoteAutomated.author, 't@example.com')

    const remoteHuman = await owned('publish-remote-human', async (owner, w) => {
      const peer = w.peer()
      git(peer, 'checkout', '-q', '-b', 'trezi/main')
      commit(peer, 'a.txt', 'remote human\n')
      const remoteHead = git(peer, 'rev-parse', 'HEAD')
      git(peer, 'push', '-q', 'origin', 'trezi/main')
      const result = await owner.publish(w.local, 'pr', describe)
      return { result, remoteHead, localHead: git(w.local, 'rev-parse', 'HEAD') }
    })
    assert.equal(remoteHuman.result.ok, true)
    assert.equal(remoteHuman.localHead, remoteHuman.remoteHead)

    const missingIdentity = await owned('publish-missing-identity', async (owner, w) => {
      write(w.local, 'a.txt', 'automated\n')
      git(w.local, 'add', '-A')
      gitAs(w.local, { name: 'Trezi', email: 'trezi@local' }, 'commit', '-qm', 'Internal landing')
      git(w.local, 'config', 'user.name', '')
      git(w.local, 'config', 'user.email', '')
      const before = git(w.local, 'rev-parse', 'HEAD')
      const result = await owner.publish(w.local, 'pr', describe)
      return { result, before, after: git(w.local, 'rev-parse', 'HEAD') }
    })
    assert.match(missingIdentity.result.error, /git config user.name and git config user.email/)
    assert.match(missingIdentity.result.error, /cannot verify that linkage/)
    assert.equal(missingIdentity.before, missingIdentity.after)

    const pushFailure = await owned('publish-push-retry', async (owner, w) => {
      write(w.local, 'a.txt', 'automated\n')
      git(w.local, 'add', '-A')
      gitAs(w.local, { name: 'Trezi', email: 'trezi@local' }, 'commit', '-qm', 'Internal landing')
      const hook = join(w.origin, 'hooks', 'pre-receive')
      writeFileSync(hook, '#!/bin/sh\nexit 1\n')
      chmodSync(hook, 0o755)
      const failed = await owner.publish(w.local, 'pr', describe)
      const afterFailure = git(w.local, 'rev-parse', 'HEAD')
      rmSync(hook)
      const resumed = await owner.publish(w.local, 'pr', describe)
      return {
        failed,
        resumed,
        afterFailure,
        afterResume: git(w.local, 'rev-parse', 'HEAD'),
        author: git(w.local, 'show', '-s', '--format=%ae', 'HEAD')
      }
    })
    assert.equal(pushFailure.failed.ok, false)
    assert.equal(pushFailure.resumed.ok, true)
    assert.equal(pushFailure.afterFailure, pushFailure.afterResume)
    assert.equal(pushFailure.author, 't@example.com')

    const conflicted = await owned('publish-conflict', async (owner, w) => {
      const peer = w.peer()
      git(peer, 'checkout', '-q', '-b', 'trezi/main')
      commit(peer, 'a.txt', 'peer\n')
      git(peer, 'push', '-q', 'origin', 'trezi/main')
      write(w.local, 'a.txt', 'local\n')
      return { result: await owner.publish(w.local, 'merge', describe), state: snapshot(w) }
    })
    assert.deepEqual(conflicted.result.conflictFiles, ['a.txt'])
    assert.equal(conflicted.result.recoveryRefs.length, 2)
    // LKM-187: the failure names the step it stopped at, for the failure sheet.
    assert.equal(conflicted.result.step, 'sync')

    // LKM-194: both sides bumped package.json's version. The reconcile leaves no markers
    // in the live checkout (the next chat turn would sync them and fail to install):
    // the merge is aborted, both tips stay on recovery refs, the versions are reported.
    const bumped = await owned('publish-version-conflict', async (owner, w) => {
      const pkg = (version) => `{\n  "name": "shop",\n  "version": "${version}"\n}\n`
      commit(w.local, 'package.json', pkg('0.2.6'))
      git(w.local, 'push', '-q', 'origin', 'trezi/main')
      const peer = w.peer()
      git(peer, 'checkout', '-q', 'trezi/main')
      commit(peer, 'package.json', pkg('0.2.7'))
      git(peer, 'push', '-q', 'origin', 'trezi/main')
      write(w.local, 'package.json', pkg('0.2.8'))
      const head = git(w.local, 'rev-parse', 'HEAD')
      const result = await owner.publish(w.local, 'merge', describe)
      return {
        result,
        live: readFileSync(join(w.local, 'package.json'), 'utf8'),
        status: git(w.local, 'status', '--porcelain'),
        merging: existsSync(join(w.local, '.git', 'MERGE_HEAD')),
        moved: git(w.local, 'rev-parse', 'HEAD') !== head,
        refs: git(w.local, 'for-each-ref', '--format=%(refname)', 'refs/trezi/recovery/')
      }
    })
    assert.deepEqual(bumped.result.conflictFiles, ['package.json'])
    assert.deepEqual(bumped.result.versionConflict, { local: '0.2.8', remote: '0.2.7' })
    assert.equal(bumped.result.branch, 'trezi/main')
    assert.equal(bumped.result.recoveryRefs.length, 2)
    assert.match(bumped.result.error, /left unchanged/)
    assert.doesNotMatch(
      bumped.live,
      /^(<<<<<<<|=======|>>>>>>>)/m,
      'no markers in the live checkout'
    )
    assert.match(bumped.live, /"version": "0\.2\.8"/)
    assert.equal(bumped.status, '', 'the live checkout is clean')
    assert.equal(bumped.merging, false, 'no merge left in progress')
    assert.equal(bumped.moved, true, 'the local bump stays committed')
    assert.equal(bumped.refs.split('\n').filter(Boolean).length, 2)

    const nothing = await owned('publish-nothing', async (owner, w) => ({
      result: await owner.publish(w.local, 'merge', describe),
      state: snapshot(w)
    }))
    assert.equal(nothing.result.error, 'Nothing to publish — no changes since main.')

    const squashEquivalent = await owned('publish-squash-equivalent', async (owner, w) => {
      commit(w.local, 'a.txt', 'same content\n')
      const peer = w.peer()
      commit(peer, 'a.txt', 'same content\n')
      git(peer, 'push', '-q', 'origin', 'main')
      const before = git(w.local, 'rev-parse', 'HEAD')
      const result = await owner.publish(w.local, 'merge', describe)
      return { result, before, after: git(w.local, 'rev-parse', 'HEAD') }
    })
    assert.equal(squashEquivalent.result.error, 'Nothing to publish — no changes since main.')
    assert.equal(
      squashEquivalent.before,
      squashEquivalent.after,
      'equivalent branch is not rewritten'
    )

    const behindOnly = await owned('publish-behind-only', async (owner, w) => {
      const peer = w.peer()
      commit(peer, 'a.txt', 'main moved forward\n')
      git(peer, 'push', '-q', 'origin', 'main')
      const before = git(w.local, 'rev-parse', 'HEAD')
      const result = await owner.publish(w.local, 'merge', describe)
      return { result, before, after: git(w.local, 'rev-parse', 'HEAD'), remote: w.gh().counts }
    })
    assert.equal(behindOnly.result.error, 'Nothing to publish — no changes since main.')
    assert.equal(behindOnly.before, behindOnly.after)
    assert.equal(behindOnly.remote?.prCreate ?? 0, 0, 'no PR was created')

    const handoff = await owned('handoff', async (owner, w) => {
      write(w.local, 'a.txt', 'handoff\n')
      mkdirSync(join(w.local, '.trezi'))
      write(w.local, '.trezi/annotations.json', '[{"id":"n1","text":"Tighten the header"}]\n')
      return {
        result: await owner.handoff(w.local, 'Design handoff', 1, describe),
        state: snapshot(w)
      }
    })

    assert.equal(handoff.result.ok, true)
    assert.equal(handoff.state.branch, 'trezi/handoff-X')

    const branchPr = await owned('branch-pr', async (owner, w) => {
      git(w.local, 'checkout', '-q', '-b', 'trezi/chat-1')
      commit(w.local, 'c.txt', 'chat\n')
      git(w.local, 'checkout', '-q', 'trezi/main')
      const result = await owner.branchPr(w.local, 'trezi/chat-1', describe)
      const missing = await owner.branchPr(w.local, 'trezi/chat-9', describe)
      return { result, missing, state: snapshot(w) }
    })

    assert.equal(branchPr.result.prUrl, 'https://github.com/fake/repo/pull/1')
    assert.equal(branchPr.missing.error, 'That branch no longer exists.')

    const branchPrAutomated = await owned('branch-pr-attribution', async (owner, w) => {
      git(w.local, 'checkout', '-q', '-b', 'trezi/chat-1')
      write(w.local, 'c.txt', 'chat\n')
      git(w.local, 'add', '-A')
      gitAs(w.local, { name: 'Trezi', email: 'trezi@local' }, 'commit', '-qm', 'Internal chat')
      const previous = git(w.local, 'rev-parse', 'HEAD')
      git(w.local, 'checkout', '-q', 'trezi/main')
      const checkout = git(w.local, 'rev-parse', 'HEAD')
      const result = await owner.branchPr(w.local, 'trezi/chat-1', describe)
      return {
        result,
        previous,
        checkout,
        current: git(w.local, 'rev-parse', 'HEAD'),
        parent: git(w.local, 'rev-parse', 'trezi/chat-1^'),
        author: git(w.local, 'show', '-s', '--format=%ae', 'trezi/chat-1')
      }
    })
    assert.equal(branchPrAutomated.result.ok, true)
    assert.equal(branchPrAutomated.current, branchPrAutomated.checkout)
    assert.equal(branchPrAutomated.parent, branchPrAutomated.previous)
    assert.equal(branchPrAutomated.author, 't@example.com')

    const connected = await owned(
      'connect',
      async (owner, w) => {
        const result = await owner.connect(w.local, {
          name: 'demo-app',
          owner: 'octo',
          private: true
        })
        const again = await owner.connect(w.local, {
          name: 'demo-app',
          owner: 'octo',
          private: true
        })
        const bare = join(w.base, 'repos', 'octo', 'demo-app.git')
        return {
          result,
          again,
          remote: git(w.local, 'remote', 'get-url', 'origin'),
          branches: git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'),
          head: git(bare, 'symbolic-ref', 'HEAD'),
          state: snapshot(w)
        }
      },
      { remote: false }
    )
    assert.equal(connected.result.ok, true)
    assert.equal(connected.branches, 'main\ntrezi/main')

    const remote = await owned('remote', async (owner, w) => {
      const peer = w.peer()
      git(peer, 'checkout', '-q', '-b', 'feature/design')
      commit(peer, 'feature.txt', 'remote feature\n')
      git(peer, 'push', '-q', 'origin', 'feature/design')
      git(peer, 'checkout', '-q', 'main')
      commit(peer, 'main.txt', 'remote main\n')
      git(peer, 'push', '-q', 'origin', 'main')
      const cached = await owner.remoteStatus(w.local, false)
      const fetched = await owner.remoteStatus(w.local, true)
      const busy = await owner.remoteUpdate(
        w.local,
        { action: 'pull', ref: 'refs/remotes/origin/main', expectedBranch: 'trezi/main' },
        true
      )
      const stale = await owner.remoteUpdate(
        w.local,
        { action: 'pull', ref: 'refs/remotes/origin/main', expectedBranch: 'other' },
        false
      )
      const pulled = await owner.remoteUpdate(
        w.local,
        { action: 'pull', ref: 'refs/remotes/origin/main', expectedBranch: 'trezi/main' },
        false
      )
      const switched = await owner.remoteUpdate(
        w.local,
        {
          action: 'checkout',
          ref: 'refs/remotes/origin/feature/design',
          expectedBranch: 'trezi/main'
        },
        false
      )
      // A reviewed scope includes staged and new files, but leaves runtime secrets alone.
      write(w.local, 'main.txt', 'local tracked change\n')
      git(w.local, 'add', 'main.txt')
      write(w.local, 'local-note.txt', 'new local note\n')
      write(w.local, '.env', 'TEST_SECRET=never-commit\n')
      const reviewed = await owner.remoteStatus(w.local, false)
      assert.deepEqual(reviewed.changes.map((change) => change.path).sort(), [
        'local-note.txt',
        'main.txt'
      ])
      const beforeCommit = git(w.local, 'rev-parse', 'HEAD')
      const drifted = await owner.remoteUpdate(
        w.local,
        {
          action: 'pull',
          ref: 'refs/remotes/origin/feature/design',
          expectedBranch: 'feature/design',
          commit: { message: 'Keep local work', changeToken: 'stale token' }
        },
        false
      )
      assert.equal(drifted.ok, false)
      assert.equal(git(w.local, 'rev-parse', 'HEAD'), beforeCommit)
      const hook = join(w.local, '.git', 'hooks', 'pre-commit')
      writeFileSync(hook, '#!/bin/sh\nexit 1\n')
      chmodSync(hook, 0o755)
      const rejected = await owner.remoteUpdate(
        w.local,
        {
          action: 'pull',
          ref: 'refs/remotes/origin/feature/design',
          expectedBranch: 'feature/design',
          commit: { message: 'Keep local work', changeToken: reviewed.changeToken }
        },
        false
      )
      assert.equal(rejected.ok, false)
      assert.equal(git(w.local, 'rev-parse', 'HEAD'), beforeCommit)
      rmSync(hook)
      const fresh = await owner.remoteStatus(w.local, false)
      const recovered = await owner.remoteUpdate(
        w.local,
        {
          action: 'pull',
          ref: 'refs/remotes/origin/feature/design',
          expectedBranch: 'feature/design',
          commit: { message: 'Keep local work', changeToken: fresh.changeToken }
        },
        false
      )
      assert.equal(recovered.ok, true, recovered.message)
      assert.equal(git(w.local, 'log', '-1', '--format=%s'), 'Keep local work')
      assert.equal(
        git(w.local, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'),
        'local-note.txt\nmain.txt'
      )
      assert.equal(readFileSync(join(w.local, '.env'), 'utf8'), 'TEST_SECRET=never-commit\n')
      assert.equal(git(w.local, 'rev-list', '--count', `${beforeCommit}..HEAD`), '1')
      const update = await owner.updateCheck(w.local)
      let outside
      try {
        await owner.remoteStatus(join(w.local, '..'), false)
      } catch (error) {
        outside = error.message
      }
      return { cached, fetched, update, busy, stale, pulled, switched, outside, state: snapshot(w) }
    })

    assert.equal(remote.pulled.ok, true)
    assert.equal(remote.switched.branch, 'feature/design')
    assert.equal(remote.busy.ok, false)
    assert.match(remote.outside, /top-level folder/)
    assert.deepEqual(remote.update, { status: 'idle', behind: 0 }) // the fixture branch is not behind its own upstream

    const setup = await owned('setup', async (owner, w) => {
      write(
        w.local,
        'package.json',
        JSON.stringify({
          dependencies: { react: '^19.0.0', next: '^15.0.0' },
          scripts: { dev: 'next dev' }
        })
      )
      mkdirSync(join(w.local, 'node_modules/next'), { recursive: true })
      write(
        w.local,
        'node_modules/next/package.json',
        JSON.stringify({ name: 'next', version: '15.2.0' })
      )
      const files = helperFiles(await detect(w.local))
      const first = await owner.writeHelpers(w.local, files)
      write(w.local, '.trezi/trezi-next.cjs', '// edited by hand\n')
      const second = await owner.writeHelpers(w.local, files)
      const kept = readFileSync(join(w.local, '.trezi/trezi-next.cjs'), 'utf8')
      mkdirSync(join(w.local, '.dsgn'))
      write(w.local, '.dsgn/dsgn-source.cjs', 'old')
      const removed = await owner.removeHelpers(w.local)
      return { first, second, kept, removed, left: readdirSync(join(w.local, '.trezi')) }
    })

    assert.equal(setup.first.written, true)
    assert.equal(setup.second.written, false)
    assert.equal(setup.first.helpers.length, 4)
    assert.equal(setup.kept, '// edited by hand\n')
    assert.equal(setup.removed.files.length, 5)

    // LKM-153: React on Vite 8 gets the Vite plugin beside the Babel visitor; the owner
    // accepts it, hashes it for the setup prompt and removes it on uninstall.
    const viteSetup = await owned('setup-vite', async (owner, w) => {
      write(
        w.local,
        'package.json',
        JSON.stringify({
          dependencies: { react: '^19.2.0' },
          devDependencies: { vite: '^8.0.0', '@vitejs/plugin-react': '^6.0.0' }
        })
      )
      const files = helperFiles(await detect(w.local))
      const wrote = await owner.writeHelpers(w.local, files)
      const plugin = readFileSync(join(w.local, '.trezi/trezi-vite.mjs'), 'utf8')
      const removed = await owner.removeHelpers(w.local)
      return {
        files,
        wrote,
        plugin,
        removed,
        left: existsSync(join(w.local, '.trezi/trezi-vite.mjs'))
      }
    })
    assert.equal(viteSetup.wrote.ok, true, viteSetup.wrote.error)
    assert.deepEqual(
      viteSetup.wrote.helpers.map((h) => h.path),
      ['.trezi/trezi-source.cjs', '.trezi/trezi-vite.mjs']
    )
    assert.equal(viteSetup.plugin, viteSetup.files[1].content)
    assert.ok(viteSetup.removed.files.includes('.trezi/trezi-vite.mjs'))
    assert.equal(viteSetup.left, false)

    const created = await owned('create-project', async (owner, w) => {
      const root = join(w.base, 'New App')
      const result = await owner.createProject(root, starterFiles(root, 'react'), 'bun')
      const again = await owner.createProject(root, starterFiles(root, 'react'), 'bun')
      return {
        result,
        again,
        files: readdirSync(root).sort(),
        log: git(root, 'log', '--format=%s'),
        pm: w.pm().calls
      }
    })

    assert.equal(created.result.ok, true)
    assert.match(created.again.error, /isn't empty/)
    assert.deepEqual(created.pm, ['bun install'])

    const updated = await owned('update', async (owner, w) => {
      git(w.local, 'checkout', '-q', 'main')
      const peer = w.peer()
      commit(peer, 'release.txt', 'new release\n')
      git(peer, 'push', '-q', 'origin', 'main')
      const progress = []
      const result = await owner.update(w.local, (text) => progress.push(text))
      return {
        result,
        head: git(w.local, 'rev-parse', 'HEAD') === git(w.origin, 'rev-parse', 'main'),
        pm: w.pm().calls,
        state: snapshot(w)
      }
    })

    assert.deepEqual(updated.result, { ok: true })
    assert.equal(updated.head, true)
    assert.deepEqual(updated.pm, ['bun install --frozen-lockfile', 'bun run build:native'])

    const diagnosed = await owned('diagnostics', async (owner, w) => {
      const error = "Cannot find module '@ai-sdk/xai' imported from /Users/x/chat.ts"
      const signature = signatureFor(error)
      const none = await owner.recallDiagnosis(w.local, signature)
      await owner.rememberDiagnosis(w.local, {
        signature,
        summary: 'Missing dependency',
        detail: 'Install it.',
        steps: [
          { text: 'Install @ai-sdk/xai', command: 'bun add @ai-sdk/xai', scope: 'repo' },
          { text: 'Restart', scope: 'host' }
        ],
        seenBefore: false,
        status: 'proposed'
      })
      await owner.rememberDiagnosis('/other/project', {
        signature: '1234',
        summary: 'Numeric key',
        steps: [],
        seenBefore: false
      })
      const recalled = await owner.recallDiagnosis(w.local, signature)
      await owner.diagnosisStatus(w.local, signature, 'applied')
      await owner.diagnosisStatus(w.local, 'ffff', 'dismissed')
      return {
        none,
        recalled,
        after: await owner.recallDiagnosis(w.local, signature),
        file: readFileSync(join(w.profile, 'diagnostics.json'), 'utf8')
      }
    })

    assert.equal(diagnosed.after.status, 'applied')
    assert.equal(diagnosed.recalled.seenBefore, true)

    const skills = await owned('skills', async (owner, w) => {
      const input = { packId: 'anthropic-frontend-design', scope: 'project', liveRoot: w.local }
      const ok = await owner.installSkills(input)
      writeFileSync(w.pmState, JSON.stringify({ calls: w.pm().calls, fail: { skills: 1 } }))
      const failed = await owner.installSkills(input)
      const refused = await owner.installSkills({ ...input, packId: 'not-a-pack' })
      return { ok, failed, refused, calls: w.pm().calls }
    })

    assert.equal(skills.ok.ok, true)
    assert.deepEqual(skills.ok.installed, ['frontend-design'])
    assert.equal(skills.failed.ok, false)
    assert.match(skills.refused.message, /not in the curated skill-pack allowlist/)
    assert.equal(skills.calls.length, 2)

    const feedback = await owned('feedback', async (owner, w) => {
      const title = 'Sidebar focus'
      const body = 'Steps to reproduce…'
      const result = await owner.feedback(w.local, title, body)
      const issue = w.gh().issues[0]
      return {
        result,
        issue: issue ? { title: issue.title, body: issue.body } : null,
        create: w.gh().counts?.issueCreate
      }
    })
    assert.equal(feedback.result.ok, true)
    assert.deepEqual(feedback.issue, { title: 'Sidebar focus', body: 'Steps to reproduce…' })
    assert.equal(feedback.create, 1)
    console.log('WORKFLOW OWNER OK — scenarios (durability: test/workflow-durability.mjs)')
  } else {
    // ───────────── durability (Swift owner) ─────────────
    await import('./helpers/workflow-tools-checks.mjs').then((module) =>
      module.toolChecks({ world, start, log })
    )
    await import('./helpers/workflow-durability.mjs').then((module) =>
      module.durability({ world, start, snapshot, git, write, commit, describe, log, fakes })
    )
    console.log(
      'WORKFLOW DURABILITY OK — tools, lost replies, crashes, failures, cancellation, restart, relaunch, drain, redaction, schema'
    )
  }
} finally {
  for (const fixture of fixtures) await fixture.stop().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
