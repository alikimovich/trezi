// Safety of the changed-file selection and the typecheck plan (LOCAL-TEST-CLEANUP-V2):
// narrowing only for audited docs, test-only and UI changes, everything else (and every
// failure) falls back or fails; the audited reader lists stay current.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BROAD,
  changedFiles,
  FIXTURES,
  parseNameStatus,
  planChanges,
  READERS,
  repoContext,
  SELECTOR_FILES,
  typecheckPlan,
  UI_SOURCES
} from './helpers/test-plan.mjs'
import { TIERS, UNIT } from './tiers.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ctx = repoContext(ROOT)
const plan = (...changes) =>
  planChanges(
    changes.map((c) => (typeof c === 'string' ? { status: 'M', path: c } : c)),
    ctx
  )
const selected = (result, ...names) => {
  assert.equal(result.mode, 'selected', JSON.stringify(result.reasons))
  assert.equal(result.typecheck, false)
  assert.deepEqual(
    result.unit,
    UNIT.filter((name) => result.unit.includes(name)),
    'registration order'
  )
  for (const name of names) assert.ok(result.unit.includes(name), `${name} in ${result.unit}`)
  return result
}
const fullBecause = (result, pattern) => {
  assert.equal(result.mode, 'full')
  assert.equal(result.typecheck, true)
  assert.equal(result.appBuild, true)
  assert.match(result.reasons.join('\n'), pattern)
}

// Docs: only their readers, no typecheck, no app build.
const guide = selected(plan('docs/agent-guide/verification.md'), 'docs-links', 'legacy-names-audit')
assert.equal(guide.appBuild, false)
assert.deepEqual(guide.native, [])
selected(plan('CHANGELOG.md'), 'versioning')
selected(plan('docs/SWIFT-BACKEND-ROUTES.md'), 'service-contract')
selected(plan('docs/SWIFT-BACKEND-RETIREMENT.md'), 'retirement-census', 'distribution')
selected(plan({ status: 'A', path: 'docs/a new page.md' }), 'docs-links')
selected(plan({ status: 'D', path: 'docs/gone.md' }), 'docs-links')
selected(plan({ status: 'R', from: 'docs/old name.md', path: 'docs/new name.md' }), 'docs-links')
fullBecause(
  plan('docs/evidence/lkm-273/scraib-validation/xcode-target-previews.swift'),
  /no selection rule/
)

// Test-only: the script itself plus the scanners of test/. The sample's path is built
// here, so this file does not count as a user of it.
const sample = 'display-path'
const script = `test/${sample}.mjs`
assert.deepEqual(
  plan(script).unit.sort(),
  [sample, 'legacy-names-audit', 'lint', 'no-system-preferences'].sort()
)
fullBecause(plan('test/distribution.mjs'), /also used by .*\.github\/workflows\/ci\.yml/)
const unregistered = ctx.files.find(
  (f) =>
    /^test\/[^/]+\.mjs$/.test(f) &&
    !SELECTOR_FILES.includes(f) &&
    !Object.values(TIERS).flat().includes(f.slice(5, -4))
)
assert.ok(unregistered, 'the checkout has an unregistered test script')
fullBecause(plan(unregistered), /not registered/)
fullBecause(plan({ status: 'A', path: 'test/brand-new.mjs' }), /not registered/)
fullBecause(plan({ status: 'A', path: script }), /new test script/)
fullBecause(plan({ status: 'D', path: script }), /deleted/)
fullBecause(plan({ status: 'R', from: script, path: 'test/x.mjs' }), /renamed/)
fullBecause(plan('test/native-runtime.mjs'), /native test/)
fullBecause(plan('test/helpers/darwin.mjs'), /shared test helper/)
fullBecause(plan('test/fixtures/chat-text/main.swift'), /fixture without an audited/)
for (const [dir, users] of Object.entries(FIXTURES)) {
  selected(plan(`${dir}main.swift`), ...users)
  fullBecause(plan({ status: 'A', path: `${dir}extra.swift` }), /added fixture/)
  // A new user found by the folder's bare name: a registered test joins the plan; a
  // helper or an unregistered script forces the full run.
  const bare = dir.slice('test/fixtures/'.length, -1)
  const naming = (file) => ({
    files: [...ctx.files, file],
    read: (f) => (f === file ? `join(TEST_DIR, 'fixtures', '${bare}')` : ctx.read(f))
  })
  const change = [{ status: 'M', path: `${dir}main.swift` }]
  const joined = { ...naming(script), files: ctx.files }
  selected(planChanges(change, joined), ...users, sample)
  for (const file of ['test/helpers/new-helper.mjs', 'test/not-registered.mjs'])
    fullBecause(planChanges(change, naming(file)), /fixture named outside registered unit tests/)
}

// Audited UI sources: consumers, scanners, app build and the native groups still owed.
for (const [path, entry] of Object.entries(UI_SOURCES)) {
  const ui = selected(plan(path), ...entry.unit, 'native-slider-ticks', 'no-system-preferences')
  assert.equal(ui.appBuild, true)
  assert.deepEqual(ui.native, entry.native)
  fullBecause(plan({ status: 'A', path }), /added audited UI source/)
  const sneaky = {
    files: [...ctx.files, 'test/helpers/new-helper.mjs'],
    read: (file) => (file === 'test/helpers/new-helper.mjs' ? entry.stem : ctx.read(file))
  }
  fullBecause(planChanges([{ status: 'M', path }], sneaky), /outside the audited consumers/)
  // Every registered test naming the type is an audited consumer (keeps the audit current).
  const naming = UNIT.filter((name) => ctx.read(`test/${name}.mjs`)?.includes(entry.stem))
  for (const name of naming) assert.ok(entry.unit.includes(name), `${name} is not audited`)
}
fullBecause(plan('src/native/Shell.swift'), /no selection rule/)
fullBecause(plan('src/main/index.ts'), /no selection rule/)

// Runner, selector and workflow changes, mixes with them, and broad or odd diffs.
for (const path of [...SELECTOR_FILES, '.github/workflows/ci.yml'])
  fullBecause(plan('docs/TESTING.md', path), /runner, selector or CI workflow/)
fullBecause(plan('docs/TESTING.md', 'package.json'), /package\.json: no selection rule/)
selected(plan('docs/TESTING.md', script), sample, 'legacy-names-audit')
fullBecause(plan(), /no changed paths/)
fullBecause(
  plan(...Array.from({ length: BROAD + 1 }, (_, i) => `docs/page-${i}.md`)),
  /broad change/
)
fullBecause(plan({ status: 'T', path: 'docs/link.md' }), /git status T/)

// Name-status parsing: NUL-separated, spaces kept, anything unexpected throws.
assert.deepEqual(parseNameStatus('M\0a b.md\0R087\0old.md\0new.md\0D\0gone.mjs\0'), [
  { status: 'M', path: 'a b.md' },
  { status: 'R', from: 'old.md', path: 'new.md' },
  { status: 'D', path: 'gone.mjs' }
])
assert.throws(() => parseNameStatus('Q\0x\0'), /unexpected git status/)
assert.throws(() => parseNameStatus('R100\0only\0'), /truncated/)

// Real Git: staged rename, unstaged edit, deletion, untracked file with spaces, refs.
const temp = mkdtempSync(join(tmpdir(), 'trezi-selection-'))
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
try {
  const repo = join(temp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  for (const path of ['docs/guide.md', 'docs/old name.md', 'src/a.ts'])
    write(repo, path, `${path}\n`)
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'tag', 'base')
  assert.deepEqual(changedFiles(repo, 'base').changes, [], 'a clean tree has no changes')
  write(repo, 'docs/guide.md', 'edited\n')
  git(repo, 'mv', 'docs/old name.md', 'docs/new name.md')
  git(repo, 'rm', '-q', 'src/a.ts')
  write(repo, 'notes/new file.txt', 'x\n')
  const { changes, base } = changedFiles(repo, 'base')
  assert.equal(base.mergeBase, git(repo, 'rev-parse', 'base').trim())
  assert.deepEqual(
    changes.map(({ status, from, path }) => [status, from, path]),
    [
      ['M', undefined, 'docs/guide.md'],
      ['R', 'docs/old name.md', 'docs/new name.md'],
      ['D', undefined, 'src/a.ts'],
      ['A', undefined, 'notes/new file.txt']
    ]
  )
  assert.throws(() => changedFiles(repo, 'no-such-ref'), /not a commit/)
  assert.throws(() => changedFiles(repo, '--output=x'), /invalid base ref/)
  const tree = git(repo, 'write-tree').trim()
  const orphan = git(repo, 'commit-tree', tree, '-m', 'unrelated').trim()
  assert.throws(() => changedFiles(repo, orphan), /no merge base/)

  // The runner and the CLI on a copy: selected runs execute exactly the plan, failures
  // exit 2 before anything runs, a selector change runs everything.
  const cli = join(temp, 'cli')
  for (const path of [
    'test/run.mjs',
    'test/tiers.mjs',
    'test/select.mjs',
    'test/helpers/test-plan.mjs',
    'test/helpers/test-runner.mjs'
  ]) {
    mkdirSync(dirname(join(cli, path)), { recursive: true })
    copyFileSync(join(ROOT, path), join(cli, path))
  }
  write(cli, '.gitignore', 'test/artifacts/\n.local/\n')
  for (const name of ['legacy-names-audit', 'docs-links'])
    write(cli, `test/${name}.mjs`, `console.log('${name.toUpperCase()} PASS')\n`)
  write(cli, 'docs/agent-guide/page.md', '# page\n')
  git(cli, 'init', '-q', '-b', 'main')
  git(cli, 'add', '.')
  git(cli, 'commit', '-qm', 'base')
  const run = (args, env = {}) =>
    spawnSync('node', args, {
      cwd: cli,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...env }
    })
  const listed = (result) => result.stdout.trim().split('\n').filter(Boolean)
  const empty = run(['test/run.mjs', 'unit', '--changed=HEAD', '--list'])
  assert.equal(empty.status, 0, empty.stderr)
  assert.match(empty.stderr, /Plan: FULL[\s\S]*no changed paths/)
  assert.equal(listed(empty).length, UNIT.length, 'an empty diff runs everything')

  write(cli, 'docs/agent-guide/page.md', '# page, edited\n')
  const docs = run(['test/run.mjs', 'unit', '--changed=HEAD', '--list', '--typecheck'])
  assert.equal(docs.status, 0, docs.stderr)
  assert.deepEqual(listed(docs), ['unit\tlegacy-names-audit', 'unit\tdocs-links'])
  assert.match(docs.stderr, /Plan: SELECTED[\s\S]*not run: typecheck typecheck-native/)
  assert.equal(existsSync(join(cli, 'test/artifacts')), false, 'listing writes nothing')
  const executed = run(['test/run.mjs', 'unit', '--changed=HEAD'])
  assert.equal(executed.status, 0, executed.stdout + executed.stderr)
  const report = /^Report: (.+)$/m.exec(executed.stdout)[1]
  const summary = JSON.parse(readFileSync(report, 'utf8'))
  assert.deepEqual(summary.results.map((r) => r.name).sort(), ['docs-links', 'legacy-names-audit'])
  assert.equal(summary.selection.mode, 'selected')
  assert.ok(existsSync(join(dirname(report), 'plan.json')))
  for (const args of [
    ['unit', '--changed=no-such-ref'],
    ['unit', '--changed=HEAD', '--filter=docs-links'],
    ['native', '--changed=HEAD', '--list'],
    ['unit', 'native', '--changed=HEAD', '--list']
  ]) {
    const refused = run(['test/run.mjs', ...args])
    assert.equal(refused.status, 2, `${args}: ${refused.stdout}${refused.stderr}`)
  }
  assert.match(run(['test/run.mjs', 'unit', '--changed=nope']).stderr, /nothing was run/)
  assert.equal(run(['test/select.mjs', '--base=nope']).status, 2)
  assert.equal(run(['test/select.mjs']).status, 2)
  // --path plans an edit of an existing file: a typo or a missing file has no plan.
  assert.equal(run(['test/select.mjs', '--path=docs/agent-guide/page.md']).status, 0)
  for (const path of ['docs/agent-guide/pgae.md', 'docs/gone.md']) {
    const typo = run(['test/select.mjs', `--path=${path}`])
    assert.equal(typo.status, 2, typo.stdout)
    assert.match(typo.stderr, /not an existing tracked or untracked file/)
  }

  appendFileSync(join(cli, 'test/helpers/test-plan.mjs'), '// edited\n')
  const output = join(temp, 'github-output')
  const gate = run(['test/select.mjs', '--base=HEAD', '--github-output'], { GITHUB_OUTPUT: output })
  assert.equal(gate.status, 0, gate.stderr)
  assert.match(gate.stdout, /test\/helpers\/test-plan\.mjs: runner, selector or CI workflow/)
  assert.equal(readFileSync(output, 'utf8'), 'mode=full\napp_build=true\nunit_count=all\n')
  assert.equal(
    listed(run(['test/run.mjs', 'unit', '--changed=HEAD', '--list'])).length,
    UNIT.length
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}

// Typecheck plan: the real configs are one program (and tsc resolves them alike);
// anything divergent or unreadable runs both.
const real = (path) => readFileSync(join(ROOT, path), 'utf8')
assert.deepEqual(typecheckPlan(real).run, ['typecheck'])
const tsc = (project) =>
  JSON.parse(
    execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['--showConfig', '-p', project], {
      cwd: ROOT,
      encoding: 'utf8'
    })
  )
const { composite = false, ...nativeOptions } = tsc('tsconfig.native.json').compilerOptions
assert.equal(composite, false)
assert.deepEqual(nativeOptions, tsc('tsconfig.node.json').compilerOptions)
assert.deepEqual(tsc('tsconfig.native.json').files, tsc('tsconfig.node.json').files)
const variant = (path, change) => (file) =>
  file === path ? JSON.stringify(change(JSON.parse(real(path)))) : real(file)
for (const read of [
  variant('tsconfig.native.json', (c) => ({
    ...c,
    compilerOptions: { ...c.compilerOptions, lib: ['ES2022'] }
  })),
  variant('tsconfig.native.json', (c) => ({ ...c, include: [...c.include, 'src/extra/**/*.ts'] })),
  variant('tsconfig.native.json', (c) => ({ ...c, compilerOptions: { composite: true } })),
  // Falsy but not `false`: tsc rejects these (TS5024), so they must never look default.
  ...[0, '', null, 'false'].map((composite) =>
    variant('tsconfig.native.json', (c) => ({
      ...c,
      compilerOptions: { ...c.compilerOptions, composite }
    }))
  ),
  variant('tsconfig.native.json', (c) => ({ ...c, compilerOptions: ['composite'] })),
  variant('tsconfig.native.json', (c) => ({ ...c, compilerOptions: 'composite' })),
  variant('tsconfig.native.json', (c) => ({ ...c, files: ['x.ts'] })),
  variant('tsconfig.node.json', (c) => ({ ...c, extends: './base.json' })),
  variant('package.json', (c) => ({
    ...c,
    scripts: { ...c.scripts, typecheck: 'bun run typecheck:preview' }
  })),
  (file) => (file === 'tsconfig.native.json' ? '// comment\n{}' : real(file)),
  () => {
    throw new Error('unreadable')
  }
])
  assert.deepEqual(typecheckPlan(read).run, ['typecheck', 'typecheck-native'])

// Audited lists name registered tests and real smoke groups.
const groups = real('src/native/smoke-groups.ts')
for (const name of [...Object.keys(READERS), ...Object.values(FIXTURES).flat()])
  assert.ok(UNIT.includes(name), `${name} is a registered unit test`)
for (const entry of Object.values(UI_SOURCES)) {
  for (const name of entry.unit) assert.ok(UNIT.includes(name), name)
  for (const group of entry.native) assert.match(groups, new RegExp(`^  '${group}',?$`, 'm'))
}

// Drift guards: a registered test or helper that walks the tree or names a repository doc
// must be a reader above or one of these audited exemptions, so docs and test-only plans
// keep every test that could see the change.
// Walk only temp folders, caches, build output or their own fixture output.
const TEMP_WALKERS = [
  'operation-ledger',
  'memory-owner',
  'skills-registry',
  'skills-registry-boundaries',
  'skills-registry-safety',
  'skills-projection',
  'source-owner',
  'provider-owner',
  'provider-login',
  'editing-owner',
  'workflow-owner',
  'platform-owner',
  'rename-compat',
  'browser-setup',
  'browser-setup-recovery',
  'browser-tools-install',
  'syntax-bundle',
  'product-log',
  'states-build',
  'legacy-names-migrate',
  'annotation-store',
  'native-build-cache',
  'file-tree',
  'swift-preview-settings',
  'swift-preview-shadow',
  'swift-preview-build',
  'swift-preview-generate',
  'helpers/browser-setup-packaged',
  'helpers/platform-checks',
  'helpers/skills-fixture',
  'helpers/swift-build',
  'helpers/test-plan',
  'helpers/workflow-durability',
  'helpers/workflow-tools-checks'
]
// Name docs only as data or inside temp repositories; swift-preview-build reads a
// non-Markdown evidence file, which no docs rule covers.
const DOC_NAMES_ONLY = [
  'skills-registry-safety',
  'skills-github',
  'skills-github-import',
  'source-tree',
  'live-change-watch',
  'publish-progress',
  'dependency-issue',
  'syntax-highlight',
  'publish-message',
  'skills-discovery',
  'environment-changes',
  'file-tree',
  'docs-merge-union',
  'swift-preview-build',
  'helpers/test-plan'
]
const WALKS = /readdirSync|readdir\(|globSync|new Glob\(|['"]grep['"]|ls-files/
const NAMES_DOC = /['"`](?:\.\.\/)*(?:docs\/|AGENTS\.md|README\.md|CHANGELOG\.md|CLAUDE\.md)/
const scripts = [
  ...UNIT.filter((name) => name !== 'test-selection'),
  ...readdirSync(join(ROOT, 'test/helpers')).map((file) => `helpers/${file.replace(/\.mjs$/, '')}`)
]
for (const name of scripts) {
  const text = real(`test/${name}.mjs`)
  if (WALKS.test(text))
    assert.ok(name in READERS || TEMP_WALKERS.includes(name), `audit the tree walk in ${name}`)
  if (NAMES_DOC.test(text))
    assert.ok(name in READERS || DOC_NAMES_ONLY.includes(name), `audit the doc read in ${name}`)
}
console.log(
  'TEST-SELECTION OK — docs/test/UI narrowing, full fallbacks, git parsing, typecheck plan'
)
