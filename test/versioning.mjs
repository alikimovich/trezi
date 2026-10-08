/**
 * LKM-143 versioning:
 * - version.mjs: SemVer check, bumps, the changelog move and the CI problems;
 * - Info.plists: the app and XPC service plists the build writes carry
 *   CFBundleShortVersionString = package version and CFBundleVersion = commit count
 *   (parsed with plutil), and a present build carries them too;
 * - scripts/check-version.mjs fails on a non-SemVer version or a missing Unreleased;
 * - scripts/release.mjs in a disposable repo: refusals (bad bump, off main, dirty,
 *   untracked, empty Unreleased, existing tag) change nothing; a release bumps,
 *   moves the changelog, commits "Release vX.Y.Z", tags it annotated, and pushes nothing.
 *
 * Run with: bun test/versioning.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appInfoPlist, serviceInfoPlist } from '../scripts/service-info.mjs'
import {
  buildInfo,
  bumpVersion,
  isSemver,
  releaseChangelog,
  setPackageVersion,
  unreleasedBody,
  versioningProblems,
  versionLabel
} from '../scripts/version.mjs'
import { withRunnerEnv } from './helpers/runner-env.mjs'

// LKM-209: no GIT_* (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …) or GITHUB_* variable of
// the parent reaches a git or script run here, so this checkout's checks read this
// checkout. Bun's children get the environment it started with (deleting from
// process.env does not reach them), so this file re-runs itself without them. The
// disposable repos below also get a private HOME and no global or system config.
const inherited = Object.keys(process.env).filter((key) => /^(GIT|GITHUB)_/.test(key))
if (inherited.length) {
  const env = { ...process.env }
  for (const key of inherited) delete env[key]
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env
  })
  process.exit(child.status ?? 1)
}

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')

// --- version.mjs ---
for (const good of [
  '0.0.1',
  '0.1.0',
  '1.2.3',
  '10.20.30',
  '1.0.0-beta.1',
  '1.0.0+build.5',
  '1.0.0-rc.1+sha.abc'
])
  assert.ok(isSemver(good), `${good} is SemVer`)
for (const bad of ['1', '1.2', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.3.4', '', null, 1])
  assert.ok(!isSemver(bad), `${bad} is not SemVer`)
assert.equal(bumpVersion('0.0.1', 'minor'), '0.1.0', 'the first native release is 0.1.0')
assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1')
assert.equal(bumpVersion('0.1.9', 'minor'), '0.2.0')
assert.equal(bumpVersion('0.9.3', 'major'), '1.0.0')
assert.equal(bumpVersion('1.2.3-beta.1', 'patch'), '1.2.4')
assert.throws(() => bumpVersion('1.2', 'patch'), /Not a SemVer/)
assert.throws(() => bumpVersion('1.2.3', 'build'), /Bump must be/)
assert.equal(
  versionLabel({ version: '0.1.0', build: '706', commit: 'abc1234' }),
  'Trezi 0.1.0 (build 706, abc1234)'
)
const pkg = '{\n  "name": "x",\n  "version": "0.0.1",\n  "deps": { "version": "keep" }\n}\n'
assert.equal(
  setPackageVersion(pkg, '0.1.0'),
  pkg.replace('"0.0.1"', '"0.1.0"'),
  'only the top version line changes'
)

const changelog =
  '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Added\n- New thing.\n\n### Fixed\n- A fix.\n\n## [0.0.1] - 2026-01-01\n\n### Added\n- First.\n'
assert.equal(unreleasedBody(changelog).trim(), '### Added\n- New thing.\n\n### Fixed\n- A fix.')
assert.equal(
  releaseChangelog(changelog, '0.1.0', '2026-10-01'),
  '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-01\n\n### Added\n- New thing.\n\n### Fixed\n- A fix.\n\n## [0.0.1] - 2026-01-01\n\n### Added\n- First.\n'
)
assert.equal(
  releaseChangelog('# C\n\n## Unreleased\n- Only.\n', '1.0.0', '2026-10-02'),
  '# C\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-02\n\n- Only.\n',
  'last section, unbracketed heading'
)
assert.throws(
  () => releaseChangelog('# C\n\n## [Unreleased]\n\n## [0.0.1] - x\n', '0.1.0', 'd'),
  /nothing under Unreleased/
)
assert.throws(() => releaseChangelog('# C\n', '0.1.0', 'd'), /no "## \[Unreleased\]"/)
assert.deepEqual(versioningProblems({ version: '0.1.0', changelog }), [])
assert.match(versioningProblems({ version: '0.1', changelog }).join(), /not valid SemVer/)
assert.match(
  versioningProblems({ version: '0.1.0', changelog: '# C\n## [0.1.0]\n' }).join(),
  /no "## \[Unreleased\]"/
)
assert.match(versioningProblems({ version: '0.1.0', changelog: null }).join(), /missing/)

// --- this checkout passes its own CI check, and the changelog rule is documented ---
assert.deepEqual(
  versioningProblems({
    version: JSON.parse(read('package.json')).version,
    changelog: read('CHANGELOG.md')
  }),
  []
)
assert.match(
  unreleasedBody(read('CHANGELOG.md')),
  /trezi --version/,
  'CHANGELOG has an entry for this change'
)
assert.match(read('.gitattributes'), /^CHANGELOG\.md merge=union$/m)
assert.match(read('AGENTS.md'), /CHANGELOG\.md/, 'AGENTS.md documents the changelog rule')
assert.match(
  read('.github/workflows/ci.yml'),
  /scripts\/check-version\.mjs/,
  'CI runs the version check'
)

// --- Info.plists: as written, and as built ---
const plutil = (text) => {
  const parsed = spawnSync('plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: text,
    encoding: 'utf8'
  })
  assert.equal(parsed.status, 0, parsed.stderr)
  return JSON.parse(parsed.stdout)
}
const info = buildInfo(root)
assert.ok(
  isSemver(info.version) && /^[1-9]\d*$/.test(info.build) && /^[0-9a-f]{7,}$/.test(info.commit),
  `buildInfo of this checkout: ${JSON.stringify(info)}`
)
assert.equal(info.version, JSON.parse(read('package.json')).version)
assert.equal(
  info.build,
  spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
)
for (const [name, plist, id] of [
  ['app', appInfoPlist, 'dev.praxis.native'],
  ['service', serviceInfoPlist, 'dev.trezi.service']
]) {
  const parsed = plutil(plist({ version: '0.1.0', build: '706', commit: 'abc1234' }))
  assert.equal(parsed.CFBundleIdentifier, id)
  assert.equal(parsed.CFBundleShortVersionString, '0.1.0', `${name} short version`)
  assert.equal(parsed.CFBundleVersion, '706', `${name} build number`)
  assert.equal(parsed.TreziCommit, 'abc1234', `${name} commit`)
}
const build = read('scripts/build-native.mjs')
assert.doesNotMatch(
  build + read('scripts/service-info.mjs'),
  /CFBundleVersion<\/key><string>\d/,
  'no hard-coded build number'
)
assert.match(build, /const info = buildInfo\(root\)/)
assert.match(build, /writeFileSync\(join\(contents, 'Info\.plist'\), appInfoPlist\(info\)\)/)
assert.match(
  build,
  /writeFileSync\(join\(serviceContents, 'Info\.plist'\), serviceInfoPlist\(info\)\)/
)
assert.match(build, /TREZI_VERSION: JSON\.stringify\(label\)/, 'both JS bundles are stamped')
const out = join(root, 'out/native')
const built = join(out, 'Trezi.app/Contents/Info.plist')
let builtNote = 'no build present: built plist check SKIPPED'
if (existsSync(built) && plutil(readFileSync(built, 'utf8')).TreziCommit) {
  const app = plutil(readFileSync(built, 'utf8'))
  const service = plutil(
    readFileSync(
      join(out, 'Trezi.app/Contents/XPCServices/dev.trezi.service.xpc/Contents/Info.plist'),
      'utf8'
    )
  )
  assert.ok(
    isSemver(app.CFBundleShortVersionString) && /^\d+$/.test(app.CFBundleVersion),
    'built app version keys'
  )
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion', 'TreziCommit'])
    assert.equal(service[key], app[key], `service ${key} matches the app`)
  const label = versionLabel({
    version: app.CFBundleShortVersionString,
    build: app.CFBundleVersion,
    commit: app.TreziCommit
  })
  for (const bundle of ['index.cjs', 'provider-helper.cjs'])
    assert.ok(
      readFileSync(join(out, 'Trezi.app/Contents/Resources/backend', bundle), 'utf8').startsWith(
        `// ${label}\n`
      ),
      `${bundle} carries ${label}`
    )
  builtNote = `built bundles carry ${label}`
}

// --- check-version.mjs and release.mjs against disposable repos ---
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-versioning-')))
try {
  // A runner-like HOME and TMPDIR under the scratch folder, no global or system Git
  // config, and Git never looks above the scratch folder for a repository.
  const env = { ...withRunnerEnv(process.env, scratch), GIT_CEILING_DIRECTORIES: scratch }
  const check = (dir) =>
    spawnSync(process.execPath, [join(root, 'scripts/check-version.mjs'), dir], {
      encoding: 'utf8',
      env
    })
  const project = (dir, version, log) => {
    spawnSync('mkdir', ['-p', dir])
    writeFileSync(
      join(dir, 'package.json'),
      `{\n  "name": "fixture",\n  "version": "${version}",\n  "private": true\n}\n`
    )
    if (log != null) writeFileSync(join(dir, 'CHANGELOG.md'), log)
  }
  project(join(scratch, 'ok'), '0.0.1', changelog)
  assert.equal(check(join(scratch, 'ok')).status, 0, 'a valid version and changelog pass')
  project(join(scratch, 'bad-version'), '0.1', changelog)
  const badVersion = check(join(scratch, 'bad-version'))
  assert.equal(badVersion.status, 1)
  assert.match(badVersion.stderr, /not valid SemVer/)
  project(join(scratch, 'no-unreleased'), '0.1.0', '# Changelog\n\n## [0.1.0] - 2026-10-01\n- x\n')
  const noUnreleased = check(join(scratch, 'no-unreleased'))
  assert.equal(noUnreleased.status, 1)
  assert.match(noUnreleased.stderr, /no "## \[Unreleased\]"/)
  project(join(scratch, 'no-changelog'), '0.1.0', null)
  assert.equal(check(join(scratch, 'no-changelog')).status, 1)

  const repo = join(scratch, 'repo')
  project(repo, '0.0.1', changelog)
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env })
  const must = (...args) => {
    const r = git(...args)
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  must('init', '-q', '-b', 'main')
  for (const [key, value] of [
    ['user.name', 'Trezi Test'],
    ['user.email', 'test@trezi.invalid'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false']
  ])
    must('config', key, value)
  must('add', '-A')
  must('commit', '-q', '-m', 'base')
  const release = (...args) =>
    spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), ...args], {
      cwd: repo,
      encoding: 'utf8',
      env
    })
  // Each refusal starts from the HEAD it is about, checked before release.mjs runs.
  const onBranch = (expected) =>
    assert.equal(
      git('symbolic-ref', '--quiet', '--short', 'HEAD').stdout.trim(),
      expected,
      `HEAD is ${expected || 'detached'}`
    )
  const unchanged = (result, pattern, why) => {
    assert.equal(result.status, 1, `${why}: refused`)
    assert.match(result.stderr, pattern, why)
    assert.equal(must('rev-list', '--count', 'HEAD'), '1', `${why}: no commit`)
    assert.equal(must('tag', '--list'), '', `${why}: no tag`)
    assert.match(
      readFileSync(join(repo, 'package.json'), 'utf8'),
      /"version": "0\.0\.1"/,
      `${why}: version kept`
    )
  }
  unchanged(release(), /usage: bun run release <major\|minor\|patch>/, 'no bump')
  unchanged(release('build'), /usage/, 'unknown bump')
  onBranch('main')
  must('checkout', '-q', '-b', 'feature')
  onBranch('feature')
  unchanged(release('patch'), /cut from main; this is branch feature/, 'off main')
  must('checkout', '-q', '--detach')
  onBranch('')
  unchanged(release('patch'), /detached HEAD/, 'detached HEAD')
  must('checkout', '-q', 'main')
  onBranch('main')
  // A failing `git symbolic-ref` is reported as itself, never as a detached HEAD.
  const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8', env })
  const fakeGit = join(scratch, 'fake git')
  mkdirSync(fakeGit)
  writeFileSync(
    join(fakeGit, 'git'),
    `#!/bin/sh\n[ "$1" = symbolic-ref ] && { echo 'fatal: simulated' >&2; exit 128; }\nexec '${realGit.stdout.trim()}' "$@"\n`,
    { mode: 0o755 }
  )
  const broken = spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), 'patch'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...env, PATH: `${fakeGit}:${env.PATH}` }
  })
  unchanged(broken, /git symbolic-ref HEAD failed \(status 128\): fatal: simulated/, 'git fails')
  writeFileSync(join(repo, 'CHANGELOG.md'), `${changelog}- Uncommitted.\n`)
  unchanged(release('patch'), /not clean[\s\S]*CHANGELOG\.md/, 'modified file')
  must('checkout', '-q', '--', 'CHANGELOG.md')
  onBranch('main')
  writeFileSync(join(repo, 'notes.txt'), 'untracked\n')
  unchanged(release('patch'), /not clean[\s\S]*notes\.txt/, 'untracked file')
  rmSync(join(repo, 'notes.txt'))
  must('tag', 'v0.1.0')
  const existing = release('minor')
  assert.equal(existing.status, 1)
  assert.match(existing.stderr, /tag v0\.1\.0 already exists/)
  assert.equal(must('status', '--porcelain'), '', 'an existing tag changes no file')
  must('tag', '-d', 'v0.1.0')

  const today = ((d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(
    new Date()
  )
  const minor = release('minor')
  assert.equal(minor.status, 0, minor.stderr)
  assert.match(minor.stdout, /Push it with: git push origin main v0\.1\.0/)
  assert.match(
    readFileSync(join(repo, 'package.json'), 'utf8'),
    /^ {2}"version": "0\.1\.0",$/m,
    'package.json bumped, formatting kept'
  )
  assert.equal(
    readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'),
    releaseChangelog(changelog, '0.1.0', today),
    'Unreleased moved under the dated version'
  )
  assert.equal(must('log', '-1', '--format=%s'), 'Release v0.1.0')
  assert.deepEqual(must('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [
    'CHANGELOG.md',
    'package.json'
  ])
  assert.equal(must('cat-file', '-t', 'v0.1.0'), 'tag', 'annotated tag')
  assert.equal(
    must('rev-parse', 'v0.1.0^{commit}'),
    must('rev-parse', 'HEAD'),
    'the tag points at the release commit'
  )
  assert.equal(must('status', '--porcelain'), '', 'clean after release')
  assert.equal(must('remote'), '', 'nothing to push to, and nothing pushed')
  // Nothing new under Unreleased: refused, nothing changes.
  const empty = release('patch')
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /nothing under Unreleased/)
  assert.equal(must('rev-list', '--count', 'HEAD'), '2')
  assert.equal(must('status', '--porcelain'), '')
  // A further entry then a patch.
  writeFileSync(
    join(repo, 'CHANGELOG.md'),
    readFileSync(join(repo, 'CHANGELOG.md'), 'utf8').replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n### Fixed\n- Later fix.\n'
    )
  )
  must('commit', '-q', '-am', 'fix')
  const patch = release('patch')
  assert.equal(patch.status, 0, patch.stderr)
  assert.deepEqual(must('tag', '--list').split('\n'), ['v0.1.0', 'v0.1.1'])
  assert.match(
    readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'),
    new RegExp(
      `## \\[Unreleased\\]\\n\\n## \\[0\\.1\\.1\\] - ${today}\\n\\n### Fixed\\n- Later fix\\.\\n\\n## \\[0\\.1\\.0\\] - ${today}`
    )
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(
  `VERSIONING OK — SemVer/bumps/changelog move; app and service plists carry version and commit-count build; check-version fails on bad version or missing Unreleased; release refuses off main/dirty/untracked/empty/existing tag and otherwise bumps, moves, commits and tags without pushing; ${builtNote}`
)
