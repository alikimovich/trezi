// LKM-226: the build badge. The one state a build gets (On main, Behind main by N, Not
// on main, Local changes, Unknown), the comparison with origin main against disposable
// Git repositories (a local bare "origin", no network), the stamp `buildInfo` writes,
// and the controller's schedule rules: offline or switched off never compares. LKM-301:
// the badge text (identity, branch off main, state in words), no Git, incomplete stamps,
// detached HEAD, clean/dirty, two revisions and a fresh build time per build.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appInfoPlist } from '../scripts/service-info.mjs'
import { buildInfo } from '../scripts/version.mjs'
import {
  compareWithMain,
  currentBuildLine,
  hasNetwork,
  setCurrentBuildStatus
} from '../src/main/build-status.ts'
import {
  BUILD_CHECK_KEY,
  NativeBuildStatusController
} from '../src/native/build-status-controller.ts'
import { withBuildCheckSetting } from '../src/native/settings-build-check.ts'
import {
  buildDetails,
  buildStatusLine,
  deriveBuildStatus,
  fromGitHubCompare,
  githubRepo,
  parseBuildStamp,
  remoteMain
} from '../src/shared/build-status.ts'
import { useRunnerEnv } from './helpers/runner-env.mjs'

const MAIN = 'a'.repeat(40)
const stamp = (over = {}) => ({
  version: '0.1.0',
  build: '712',
  commit: 'bbbbbbb',
  sha: 'b'.repeat(40),
  branch: 'main',
  dirty: false,
  tag: '',
  git: true,
  builtAt: '2026-10-22T06:18:07.000Z',
  ...over
})
const input = (over = {}) => ({
  enabled: true,
  online: true,
  comparison: null,
  checkedAt: 1_760_000_000_000,
  ...over
})

// --- Derivation: exactly one state per case ---
const equal = deriveBuildStatus(
  stamp({ sha: MAIN, commit: MAIN.slice(0, 7) }),
  input({
    comparison: { main: MAIN, contained: true, behind: 0 }
  })
)
assert.equal(equal.state, 'on-main')
assert.equal(equal.tone, 'green')
// LKM-301: the identity (version, build, commit), no branch on main, and no checkmark.
assert.equal(equal.text, '0.1.0 (712, aaaaaaa)')
assert.deepEqual([equal.identity, equal.context], ['0.1.0 (712, aaaaaaa)', ''])
assert.equal(
  equal.spoken,
  'Version 0.1.0, build 712, commit aaaaaaa, branch main, clean. On main: this is the published code'
)
assert.equal(equal.main, 'aaaaaaa')
// Two revisions with the same package version read differently.
const nextRevision = deriveBuildStatus(
  stamp({ build: '713', commit: 'ccccccc', sha: 'c'.repeat(40) }),
  input({ comparison: { main: 'c'.repeat(40), contained: true, behind: 0 } })
)
assert.equal(nextRevision.version, equal.version)
assert.equal(nextRevision.text, '0.1.0 (713, ccccccc)')
assert.notEqual(nextRevision.text, equal.text)
// A short stamped sha still matches main's full sha.
assert.equal(
  deriveBuildStatus(
    stamp({ sha: '', commit: MAIN.slice(0, 7) }),
    input({
      comparison: { main: MAIN, contained: null, behind: null }
    })
  ).state,
  'on-main'
)

const behind = deriveBuildStatus(
  stamp(),
  input({ comparison: { main: MAIN, contained: true, behind: 3 } })
)
assert.equal(behind.state, 'behind')
assert.equal(behind.tone, 'yellow')
assert.equal(behind.behind, 3)
assert.equal(behind.text, '0.1.0 (712, bbbbbbb) · 3 behind')
assert.match(behind.label, /^Behind main by 3 commits/)
const behindOne = deriveBuildStatus(
  stamp(),
  input({ comparison: { main: MAIN, contained: true, behind: 1 } })
)
assert.match(behindOne.label, /by 1 commit:/)
const behindUncounted = deriveBuildStatus(
  stamp(),
  input({
    comparison: { main: MAIN, contained: true, behind: null }
  })
)
assert.equal(behindUncounted.state, 'behind')
assert.equal(behindUncounted.text, '0.1.0 (712, bbbbbbb) · behind')

const outside = deriveBuildStatus(
  stamp(),
  input({ comparison: { main: MAIN, contained: false, behind: null } })
)
assert.equal(outside.state, 'not-on-main')
assert.equal(outside.tone, 'orange')
assert.equal(outside.text, '0.1.0 (712, bbbbbbb) · not on main')

// Off main the branch stays: it names the build next to its identity.
const candidate = deriveBuildStatus(stamp({ branch: 'candidate' }), input())
assert.equal(candidate.state, 'not-on-main')
assert.equal(candidate.text, '0.1.0 (712, bbbbbbb) · candidate')
assert.equal(candidate.context, 'candidate')
assert.match(candidate.spoken, /branch candidate, clean\. Not on main: built from the candidate/)

const dirty = deriveBuildStatus(
  stamp({ dirty: true, branch: 'candidate' }),
  input({ online: false })
)
assert.equal(dirty.state, 'local-changes', 'a dirty build is Local changes on any branch')
assert.equal(dirty.text, '0.1.0 (712, bbbbbbb) · candidate · modified')
assert.match(dirty.spoken, /branch candidate, uncommitted changes\. Local changes/)
const dirtyMain = deriveBuildStatus(stamp({ dirty: true }), input())
assert.equal(dirtyMain.text, '0.1.0 (712, bbbbbbb) · modified', 'main is never named')

const offline = deriveBuildStatus(stamp(), input({ online: false, checkedAt: null }))
assert.equal(offline.state, 'unknown')
assert.equal(offline.reason, 'offline')
assert.equal(offline.text, '0.1.0 (712, bbbbbbb) · offline')
const off = deriveBuildStatus(stamp(), input({ enabled: false }))
assert.deepEqual([off.reason, off.text], ['off', '0.1.0 (712, bbbbbbb)'])
assert.equal(deriveBuildStatus(stamp(), input({ checkedAt: null })).reason, 'pending')
const unreachable = deriveBuildStatus(stamp(), input())
assert.deepEqual(
  [unreachable.reason, unreachable.text],
  ['unreachable', '0.1.0 (712, bbbbbbb) · unknown']
)
assert.equal(
  deriveBuildStatus(stamp(), input({ comparison: { main: MAIN, contained: null, behind: null } }))
    .state,
  'unknown'
)
const unbuilt = deriveBuildStatus(null, input())
assert.deepEqual(
  [unbuilt.state, unbuilt.reason, unbuilt.text, unbuilt.spoken],
  ['unknown', 'unbuilt', 'dev · unbuilt', 'Unbuilt development source. Unbuilt development source']
)

// Detached builds (CI) are judged by their commit alone, and say they are detached.
const detached = deriveBuildStatus(
  stamp({ branch: '' }),
  input({ comparison: { main: MAIN, contained: true, behind: 2 } })
)
assert.equal(detached.state, 'behind')
assert.equal(detached.text, '0.1.0 (712, bbbbbbb) · detached · 2 behind')
assert.match(detached.spoken, /commit bbbbbbb, detached HEAD, clean\./)

// LKM-301: no Git and an incomplete stamp are Unknown, never another state.
const noGit = deriveBuildStatus(
  stamp({ git: false, build: '0', commit: 'unknown', sha: '', branch: '' }),
  input({ comparison: { main: MAIN, contained: true, behind: 0 } })
)
assert.deepEqual(
  [noGit.state, noGit.reason, noGit.tone, noGit.text],
  ['unknown', 'no-git', 'gray', '0.1.0 · no Git']
)
assert.match(
  noGit.spoken,
  /^Version 0\.1\.0, not built from a Git checkout\. Unknown: built outside/
)
assert.deepEqual([noGit.build, noGit.commit], ['', ''], 'no placeholder build or commit to copy')
for (const missing of [{ dirty: null }, { build: '0' }, { commit: 'unknown' }]) {
  const status = deriveBuildStatus(
    stamp(missing),
    input({ comparison: { main: 'b'.repeat(40), contained: true, behind: 0 } })
  )
  assert.deepEqual(
    [status.state, status.reason, status.text],
    ['unknown', 'metadata', '0.1.0 · no build info'],
    JSON.stringify(missing)
  )
}

// --- Texts: tooltip/About details, the log line ---
const details = buildDetails({ ...behind, tag: 'v0.1.0' })
for (const line of [
  'Version: 0.1.0',
  'Build: 712',
  'Commit: bbbbbbb',
  'Branch: main',
  'Tree: clean',
  'Release tag: v0.1.0',
  'Main: aaaaaaa'
])
  assert.ok(details.includes(line), `details carry ${line}: ${details.join(' | ')}`)
assert.ok(details.some((line) => line.startsWith('Checked: ') && !line.includes('not checked')))
assert.ok(
  details.some((line) => /^Built: Oct 2[12], 2026/.test(line)),
  details.join(' | ')
)
assert.ok(buildDetails(offline).includes('Checked: not checked yet'))
assert.ok(buildDetails(dirty).includes('Tree: uncommitted changes'))
assert.ok(buildDetails(detached).includes('Branch: detached HEAD'))
assert.ok(buildDetails(noGit).includes('Branch: no Git'))
assert.ok(
  buildDetails(deriveBuildStatus(stamp({ builtAt: '' }), input())).includes('Built: unknown')
)
assert.match(
  buildStatusLine(behind),
  /^Build: Behind main by 3 commits.*commit bbbbbbb, branch main, tag none, dirty false, main aaaaaaa, checked 2025-.*, git true, built 2026-10-22T06:18:07\.000Z\)$/
)

// --- Parsers ---
assert.equal(remoteMain(`${MAIN}\trefs/heads/main\n`), MAIN)
assert.equal(remoteMain(`${MAIN}\trefs/heads/main-old\n`), null)
assert.equal(remoteMain(''), null)
for (const url of [
  'https://github.com/alikimovich/trezi.git',
  'https://github.com/alikimovich/trezi',
  'git@github.com:alikimovich/trezi.git',
  'ssh://git@github.com/alikimovich/trezi.git'
])
  assert.equal(githubRepo(url), 'alikimovich/trezi', url)
assert.equal(githubRepo('https://gitlab.com/a/b.git'), null)
assert.equal(githubRepo('/tmp/origin.git'), null)
assert.deepEqual(fromGitHubCompare(MAIN, { status: 'identical' }), {
  main: MAIN,
  contained: true,
  behind: 0
})
assert.deepEqual(fromGitHubCompare(MAIN, { status: 'behind', behind_by: 4 }), {
  main: MAIN,
  contained: true,
  behind: 4
})
assert.deepEqual(fromGitHubCompare(MAIN, { status: 'diverged' }), {
  main: MAIN,
  contained: false,
  behind: null
})
assert.equal(fromGitHubCompare(MAIN, { message: 'Not Found' }), null)
assert.equal(parseBuildStamp('not json'), null)
assert.deepEqual(parseBuildStamp(JSON.stringify(stamp({ dirty: 'yes' }))), stamp({ dirty: null }))
// An older stamp (no git, builtAt): a Git build of unknown time.
const { git: _git, builtAt: _builtAt, ...older } = stamp()
assert.deepEqual(parseBuildStamp(JSON.stringify(older)), stamp({ builtAt: '' }))
assert.equal(parseBuildStamp(JSON.stringify(stamp({ git: false }))).git, false)

// --- Offline: no usable interface ---
assert.equal(hasNetwork({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), false)
assert.equal(
  hasNetwork({
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '169.254.3.4', family: 'IPv4', internal: false }
    ]
  }),
  false
)
assert.equal(
  hasNetwork({ en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }] }),
  true
)

// --- compareWithMain and buildInfo against disposable repositories ---
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-build-status-')))
// biome-ignore lint/correctness/useHookAtTopLevel: not a React hook, it sets the process env
useRunnerEnv(scratch)
process.env.GIT_CEILING_DIRECTORIES = scratch
try {
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const config = (dir) => {
    for (const [key, value] of [
      ['user.name', 'Trezi Test'],
      ['user.email', 'test@trezi.invalid'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false']
    ])
      git(dir, 'config', key, value)
  }
  const commit = (dir, name) => {
    writeFileSync(join(dir, name), name)
    git(dir, 'add', name)
    git(dir, 'commit', '-q', '-m', name)
    return git(dir, 'rev-parse', 'HEAD')
  }
  const origin = join(scratch, 'origin.git')
  git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
  const publisher = join(scratch, 'publisher')
  git(scratch, 'clone', '-q', origin, publisher)
  config(publisher)
  writeFileSync(join(publisher, 'package.json'), '{ "version": "0.1.0" }\n')
  git(publisher, 'add', 'package.json')
  git(publisher, 'commit', '-q', '-m', 'base')
  git(publisher, 'push', '-q', 'origin', 'HEAD:main')
  const app = join(scratch, 'app')
  git(scratch, 'clone', '-q', origin, app)
  config(app)
  const built = git(app, 'rev-parse', 'HEAD')

  // Same commit as main.
  assert.deepEqual(await compareWithMain(app, built), { main: built, contained: true, behind: 0 })
  assert.deepEqual(await compareWithMain(app, built.slice(0, 7)), {
    main: built,
    contained: true,
    behind: 0
  })

  // Main moved on by 2 and the app fetched it: Behind main by 2.
  commit(publisher, 'one')
  const tip = commit(publisher, 'two')
  git(publisher, 'push', '-q', 'origin', 'HEAD:main')
  // Not fetched yet and origin is no GitHub repo: contained (its origin/main has it), count unknown.
  assert.deepEqual(await compareWithMain(app, built), { main: tip, contained: true, behind: null })
  git(app, 'fetch', '-q', 'origin')
  assert.deepEqual(await compareWithMain(app, built), { main: tip, contained: true, behind: 2 })

  // A local commit main does not contain.
  const local = commit(app, 'local')
  assert.deepEqual(await compareWithMain(app, local), { main: tip, contained: false, behind: null })

  // No remote at all: null (Unknown), never a throw.
  const lonely = join(scratch, 'lonely')
  mkdirSync(lonely)
  git(lonely, 'init', '-q', '-b', 'main')
  config(lonely)
  const alone = commit(lonely, 'only')
  assert.equal(await compareWithMain(lonely, alone), null)

  // Main's commit not fetched, a GitHub origin: the compare API gives the count.
  const fakeRun = async (_command, args) => {
    const sub = args[2]
    if (sub === 'ls-remote') return { code: 0, stdout: `${MAIN}\trefs/heads/main\n` }
    if (sub === 'cat-file') return { code: 1, stdout: '' }
    if (sub === 'remote') return { code: 0, stdout: 'git@github.com:alikimovich/trezi.git\n' }
    return { code: 1, stdout: '' }
  }
  const urls = []
  const fakeFetch = async (url) => {
    urls.push(url)
    return { ok: true, status: 200, json: async () => ({ status: 'behind', behind_by: 5 }) }
  }
  assert.deepEqual(await compareWithMain(app, 'b'.repeat(40), { run: fakeRun, fetch: fakeFetch }), {
    main: MAIN,
    contained: true,
    behind: 5
  })
  assert.deepEqual(urls, [
    `https://api.github.com/repos/alikimovich/trezi/compare/${MAIN}...${'b'.repeat(40)}`
  ])
  // A failing API (offline, private, rate limited) falls back without throwing.
  const failing = async () => {
    throw new Error('offline')
  }
  assert.deepEqual(await compareWithMain(app, 'b'.repeat(40), { run: fakeRun, fetch: failing }), {
    main: MAIN,
    contained: null,
    behind: null
  })

  // buildInfo: branch, dirty flag, exact release tag.
  let info = buildInfo(publisher)
  assert.deepEqual([info.branch, info.dirty, info.tag, info.sha], ['main', false, '', tip])
  assert.equal(info.git, true)
  const derived = (built) =>
    deriveBuildStatus(parseBuildStamp(JSON.stringify(built)), input({ checkedAt: null }))
  const revisionA = derived(info).identity
  // LKM-301: each build stamps its own time; the same tree built twice tells apart.
  const first = buildInfo(publisher, new Date('2026-10-22T06:00:00Z'))
  const again = buildInfo(publisher, new Date('2026-10-22T06:05:00Z'))
  assert.deepEqual(
    [first.builtAt, again.builtAt],
    ['2026-10-22T06:00:00.000Z', '2026-10-22T06:05:00.000Z']
  )
  git(publisher, 'tag', 'v0.1.0')
  assert.equal(buildInfo(publisher).tag, 'v0.1.0')
  writeFileSync(join(publisher, 'two'), 'edited')
  assert.equal(buildInfo(publisher).dirty, true)
  assert.match(derived(buildInfo(publisher)).text, / · modified$/)
  git(publisher, 'checkout', '-q', '.')
  assert.doesNotMatch(derived(buildInfo(publisher)).text, /modified/, 'clean again')
  git(publisher, 'checkout', '-q', '-b', 'candidate')
  commit(publisher, 'three')
  info = buildInfo(publisher)
  assert.deepEqual([info.branch, info.tag], ['candidate', ''])
  // A new commit: same package version, another build number and commit.
  const revisionB = derived(info)
  assert.equal(info.version, '0.1.0')
  assert.notEqual(revisionB.identity, revisionA)
  assert.equal(revisionB.text, `0.1.0 (${info.build}, ${info.commit}) · candidate`)
  git(publisher, 'checkout', '-q', '--detach')
  assert.equal(buildInfo(publisher).branch, '')
  assert.match(derived(buildInfo(publisher)).text, / · detached$/)
  // Outside Git: build 0, no commit, `git` false; the badge says so.
  const loose = join(scratch, 'loose')
  mkdirSync(loose)
  writeFileSync(join(loose, 'package.json'), '{ "version": "0.1.0" }\n')
  const outsideGit = buildInfo(loose)
  assert.deepEqual(
    [outsideGit.git, outsideGit.build, outsideGit.commit, outsideGit.sha, outsideGit.dirty],
    [false, '0', 'unknown', '', false]
  )
  assert.equal(derived(outsideGit).text, '0.1.0 · no Git')
  // The Info.plist carries them.
  const plist = appInfoPlist({ ...info, branch: 'feature/<x>', dirty: true, tag: 'v0.1.0' })
  assert.match(plist, /<key>TreziBranch<\/key><string>feature\/&lt;x&gt;<\/string>/)
  assert.match(plist, /<key>TreziDirty<\/key><true\/>/)
  assert.match(plist, /<key>TreziTag<\/key><string>v0\.1\.0<\/string>/)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// --- Controller: local states and offline never compare; the setting turns it off ---
const prefs = (values = {}) => ({ get: (key) => values[key] ?? null })
const harness = (over = {}, values = {}) => {
  const sent = []
  const compared = []
  const controller = new NativeBuildStatusController(
    { send: (method, data) => sent.push([method, data]) },
    prefs(values),
    { present() {}, current: null },
    '/nowhere',
    () => {},
    {
      stamp: stamp(),
      online: () => true,
      now: () => 1_760_000_000_000,
      compare: async (root, sha) => {
        compared.push([root, sha])
        return { main: MAIN, contained: true, behind: 3 }
      },
      ...over
    }
  )
  return { controller, sent, compared }
}
{
  const { controller, sent, compared } = harness()
  const status = await controller.check()
  assert.equal(status.state, 'behind')
  assert.deepEqual(compared, [['/nowhere', 'b'.repeat(40)]])
  const [method, data] = sent.at(-1)
  assert.equal(method, 'buildStatus')
  assert.equal(data.text, '0.1.0 (712, bbbbbbb) · 3 behind')
  assert.deepEqual([data.identity, data.context], ['0.1.0 (712, bbbbbbb)', '3 behind'])
  assert.match(
    data.spoken,
    /^Version 0\.1\.0, build 712, commit bbbbbbb, branch main, clean\. Behind/
  )
  assert.ok(data.details.includes('Commit: bbbbbbb'))
  assert.match(currentBuildLine(), /^Build: Behind main by 3 commits/)
}
{
  const { controller, compared } = harness({ online: () => false })
  assert.equal((await controller.check()).reason, 'offline')
  assert.equal(compared.length, 0, 'offline makes no network call')
}
{
  const { controller, compared } = harness({}, { [BUILD_CHECK_KEY]: 'off' })
  assert.equal((await controller.check()).reason, 'off')
  assert.equal(compared.length, 0, 'switched off makes no network call')
}
for (const local of [{ dirty: true }, { branch: 'candidate' }]) {
  const { controller, compared } = harness({ stamp: stamp(local) })
  const status = await controller.check()
  assert.ok(['local-changes', 'not-on-main'].includes(status.state))
  assert.equal(status.checkedAt, 1_760_000_000_000)
  assert.equal(compared.length, 0, `${JSON.stringify(local)} needs no network`)
}
{
  // A failing comparison is Unknown, never a throw; concurrent checks share one run.
  const { controller, compared } = harness({
    compare: async () => {
      compared.push(1)
      throw new Error('boom')
    }
  })
  const [a, b] = await Promise.all([controller.check(), controller.check()])
  assert.equal(a, b)
  assert.equal(a.reason, 'unreachable')
  assert.equal(compared.length, 1)
}
{
  // The badge's click: details with the update steps and an Update button when behind.
  const presented = []
  const { controller } = harness()
  controller.sheets.present = (state, handle) => presented.push({ state, handle })
  await controller.check()
  controller.open()
  const { state } = presented[0]
  assert.equal(state.title, 'A newer Trezi is on main')
  assert.match(state.detail, /git pull\n {2}bun run build/)
  assert.deepEqual(
    state.actions.map((a) => a.id),
    ['cancel', 'copy-commit', 'check', 'update']
  )
  assert.equal(state.actions[1].copy, 'bbbbbbb')
}
{
  // Settings → General → "Check whether this build is on main": after Version, saved as 'off'.
  const values = {}
  const handled = []
  let changed = 0
  const sheets = { current: null, refresh() {} }
  const settings = {
    sheets,
    async open() {
      sheets.current = {
        state: { title: 'Settings', fields: [{ id: 'version' }, { id: 'projectUi' }] },
        handle: async (action) => handled.push(action.action)
      }
    }
  }
  const preferences = {
    get: (key) => values[key] ?? null,
    set: async (key, value) => {
      values[key] = value
    }
  }
  withBuildCheckSetting(settings, preferences, () => changed++)
  await settings.open()
  await settings.open()
  const ids = sheets.current.state.fields.map((f) => f.id)
  assert.deepEqual(ids, ['version', 'buildCheck', 'projectUi'], 'one field, after Version')
  assert.equal(sheets.current.state.fields[1].value, 'on')
  await sheets.current.handle({ action: 'save', values: { buildCheck: 'off' } })
  assert.equal(values[BUILD_CHECK_KEY], 'off')
  assert.equal(changed, 1)
  await sheets.current.handle({ action: 'save', values: { buildCheck: 'off' } })
  assert.equal(changed, 1, 'an unchanged value does not re-check')
  await sheets.current.handle({ action: 'save', values: { buildCheck: 'on' } })
  assert.equal(values[BUILD_CHECK_KEY], null)
  assert.equal(changed, 2)
  await assert.rejects(sheets.current.handle({ action: 'save', values: { buildCheck: 'x' } }))
  assert.deepEqual(handled, ['save', 'save', 'save'])
}
setCurrentBuildStatus(offline)
assert.match(currentBuildLine(), /^Build: Unknown: offline/)
console.log(
  'BUILD STATUS OK — five states derived, origin main compared in disposable repos, stamp carries branch/dirty/tag/git/build time, badge shows the build identity'
)
