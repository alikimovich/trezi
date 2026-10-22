// Changed-file test selection and the typecheck plan (LOCAL-TEST-CLEANUP-V2). A few
// audited rules narrow docs, test-script and listed Swift UI changes; any path they do
// not cover runs everything. Rules: docs/TESTING.md "Changed-file selection"; audit and
// measurements: docs/TEST-CLEANUP-V2.md.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { TIERS, UNIT } from '../tiers.mjs'

// More changed paths than this is a broad change: everything runs.
export const BROAD = 40
// How tests are chosen and run: a change here always runs everything.
export const SELECTOR_FILES = [
  'test/run.mjs',
  'test/tiers.mjs',
  'test/select.mjs',
  'test/helpers/test-plan.mjs',
  'test/helpers/test-runner.mjs'
]

const CODE = /\.(mjs|cjs|js|ts|tsx|swift|sh)$/
const BIOME = /\.(mjs|cjs|js|jsx|ts|tsx|json|jsonc|css)$/
const TEXT = /\.(mjs|cjs|js|jsx|ts|tsx|swift|json|ya?ml|sh|html|css|svelte)$/
const GUIDE = /^(AGENTS|CLAUDE|README)\.md$|^docs\/agent-guide\/[^/]+\.md$/

/** Markdown at the top level or under docs/. Other files under docs/ (evidence sources,
 *  JSON, images) are not docs here: `swift-preview-build` compiles one of them. */
export const isDoc = (path) => /^[^/]+\.md$/.test(path) || /^docs\/.+\.md$/.test(path)

// Unit tests that read repository files they do not import: tree scanners and doc
// readers. A narrowed plan adds each one whose scope covers a changed path. Audited
// 2026-10-20; test/test-selection.mjs fails when a registered test starts walking the
// tree or reading a repository doc without being listed here or in its exemptions.
export const READERS = {
  // `git grep` over every tracked and untracked file.
  'legacy-names-audit': () => true,
  // Links in the guides; `git ls-files` existence of every referenced path.
  'docs-links': (path, change) => GUIDE.test(path) || change.status !== 'M',
  'no-system-preferences': (path) => /^(src|test|scripts|bin)\//.test(path) && CODE.test(path),
  lint: (path) => /^(src|test)\//.test(path) && BIOME.test(path),
  'retirement-census': (path) =>
    path === 'docs/SWIFT-BACKEND-RETIREMENT.md' ||
    (/^(src|scripts|bin)\//.test(path) && CODE.test(path)),
  distribution: (path) => path === 'docs/SWIFT-BACKEND-RETIREMENT.md',
  'service-contract': (path) =>
    /^docs\/SWIFT-BACKEND-(ROADMAP|MODULES|ROUTES|EVENTS)\.md$/.test(path),
  versioning: (path) => path === 'CHANGELOG.md' || path === 'AGENTS.md',
  'native-slider-ticks': (path) => /^src\/native\/[^/]+\.swift$/.test(path),
  'conversation-owner': (path) => path.startsWith('src/main/backends/')
}

// Audited product UI sources: the unit Swift fixtures that compile or measure them, and
// the native smoke groups that show them. The unit tier never runs those groups; a
// plan names them as evidence still owed from a Mac. Any test file that names the
// source's type outside these consumers sends the change to the full run.
export const UI_SOURCES = {
  'src/native/SidebarIcon.swift': {
    stem: 'SidebarIcon',
    unit: ['sidebar-icon', 'native-settings-layout', 'sidebar-evidence'],
    native: ['sidebar', 'settings']
  }
}
// Audited fixture folders and every test that uses them.
export const FIXTURES = {
  'test/fixtures/sidebar-icon/': ['sidebar-icon']
}

const tierOf = (name) => Object.keys(TIERS).find((tier) => TIERS[tier].includes(name))
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Files under test/, src/, scripts/, bin/ or .github/ that name `file` (a test script). */
function referrers(file, ctx) {
  const name = file.slice('test/'.length)
  const pattern = new RegExp(`(?<![\\w.-])${literal(name)}(?![\\w-])`)
  return ctx.files.filter(
    (other) =>
      other !== file &&
      /^(test|src|scripts|bin|\.github)\//.test(other) &&
      TEXT.test(other) &&
      pattern.test(ctx.read(other) ?? '')
  )
}

/** Registered unit tests that name `stem` directly or through a fixture folder they use;
 *  `unknown` is a test file that names it some other way (a helper, an unregistered or
 *  native test, a fixture no unit test names). */
function consumers(entry, ctx) {
  const found = new Set()
  for (const file of ctx.files) {
    if (
      !file.startsWith('test/') ||
      SELECTOR_FILES.includes(file) ||
      !TEXT.test(file) ||
      !ctx.read(file)?.includes(entry.stem)
    )
      continue
    const script = /^test\/([^/]+)\.mjs$/.exec(file)?.[1]
    const fixture = /^(test\/fixtures\/[^/]+\/)/.exec(file)?.[1]
    if (script && tierOf(script) === 'unit') {
      found.add(script)
      continue
    }
    const names = fixture ? fixtureUsers(fixture, ctx) : null
    if (!names) return { unknown: file }
    for (const name of names) found.add(name)
  }
  return { found }
}

/** Registered unit tests that name the fixture folder `dir` by its bare name (so
 *  `join('fixtures', 'x')` and `new URL('./fixtures/x/…')` count too). Null when there is
 *  none, or when any other file under test/ (a helper, an unregistered or native test,
 *  another fixture) names it. */
function fixtureUsers(dir, ctx) {
  const pattern = new RegExp(
    `(?<![\\w-])${literal(dir.slice('test/fixtures/'.length, -1))}(?![\\w-])`
  )
  const names = []
  for (const file of ctx.files) {
    if (
      !file.startsWith('test/') ||
      file.startsWith(dir) ||
      SELECTOR_FILES.includes(file) ||
      !TEXT.test(file) ||
      !pattern.test(ctx.read(file) ?? '')
    )
      continue
    const script = /^test\/([^/]+)\.mjs$/.exec(file)?.[1]
    if (!script || tierOf(script) !== 'unit') return null
    names.push(script)
  }
  return names.length ? names : null
}

function classify(change, ctx) {
  const { status, path, from } = change
  const paths = from ? [from, path] : [path]
  if (!'MADRC'.includes(status)) return { why: `git status ${status}` }
  if (paths.some((p) => SELECTOR_FILES.includes(p) || p.startsWith('.github/')))
    return { why: 'runner, selector or CI workflow' }
  if (paths.every(isDoc)) return { kind: 'doc', unit: [] }
  if (from) return { why: 'renamed or copied' }
  if (status === 'D') return { why: 'deleted' }
  const ui = UI_SOURCES[path]
  if (ui) {
    if (status !== 'M') return { why: 'added audited UI source' }
    const { found, unknown } = consumers(ui, ctx)
    if (unknown) return { why: `${unknown} names ${ui.stem} outside the audited consumers` }
    return { kind: 'ui', unit: [...new Set([...ui.unit, ...found])], native: ui.native }
  }
  const fixture = Object.keys(FIXTURES).find((dir) => path.startsWith(dir))
  if (fixture) {
    if (status !== 'M') return { why: 'added fixture file' }
    const users = fixtureUsers(fixture, ctx)
    if (!users) return { why: 'fixture named outside registered unit tests' }
    return { kind: 'test', unit: [...new Set([...FIXTURES[fixture], ...users])] }
  }
  if (path.startsWith('test/fixtures/')) return { why: 'fixture without an audited consumer list' }
  if (path.startsWith('test/helpers/')) return { why: 'shared test helper' }
  const script = /^test\/([^/]+)\.mjs$/.exec(path)?.[1]
  if (!script) return { why: 'no selection rule covers it (product, build, config or other)' }
  const tier = tierOf(script)
  if (!tier) return { why: 'test script not registered in test/tiers.mjs' }
  if (tier !== 'unit') return { why: `${tier} test; the unit tier cannot run it` }
  if (status !== 'M') return { why: 'new test script' }
  const users = referrers(path, ctx)
  if (users.length) return { why: `also used by ${users.join(', ')}` }
  return { kind: 'test', unit: [script] }
}

const label = ({ status, path, from }) => `${status} ${from ? `${from} -> ` : ''}${path}`

function full(base, changes, reasons) {
  return { mode: 'full', ...base, changes, reasons, typecheck: true, appBuild: true, native: [] }
}

/**
 * The plan for `changes` ({status: M|A|D|R|C|…, path, from?}). `ctx.files` lists the
 * repository's paths and `ctx.read(path)` returns a file's text or null.
 */
export function planChanges(changes, ctx, base = {}) {
  if (!changes.length)
    return full(base, changes, ['no changed paths against the base: nothing to narrow'])
  if (changes.length > BROAD)
    return full(base, changes, [
      `${changes.length} changed paths (more than ${BROAD}): broad change`
    ])
  const selected = new Map()
  const add = (name, why) => selected.set(name, [...(selected.get(name) ?? []), why])
  const fallback = []
  const native = new Set()
  let appBuild = false
  for (const change of changes) {
    const result = classify(change, ctx)
    if (!result.kind) {
      fallback.push(`${label(change)}: ${result.why}`)
      continue
    }
    for (const name of result.unit) add(name, `${label(change)}: ${result.kind} change`)
    for (const [name, reads] of Object.entries(READERS))
      if ([change.from, change.path].some((path) => path && reads(path, change)))
        add(name, `${label(change)}: reads or scans it`)
    if (result.kind === 'ui') {
      appBuild = true
      for (const group of result.native) native.add(group)
    }
  }
  if (fallback.length) return full(base, changes, fallback)
  const unknown = [...selected.keys()].filter((name) => tierOf(name) !== 'unit')
  if (unknown.length)
    return full(base, changes, [`selector names unregistered unit tests: ${unknown.join(', ')}`])
  if (!selected.size) return full(base, changes, ['the selection came out empty'])
  return {
    mode: 'selected',
    ...base,
    changes,
    reasons: UNIT.filter((name) => selected.has(name)).map((name) => [name, selected.get(name)]),
    unit: UNIT.filter((name) => selected.has(name)),
    typecheck: false,
    typecheckReason:
      'no TypeScript program input changed (Markdown, unit test scripts, audited Swift)',
    appBuild,
    native: [...native]
  }
}

/** Every tracked and untracked (not ignored) path, and a reader for their text. */
export function repoContext(root) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 << 20
    }
  )
  const cache = new Map()
  const read = (path) => {
    if (!cache.has(path)) {
      const file = join(root, path)
      cache.set(path, existsSync(file) ? readFileSync(file, 'utf8') : null)
    }
    return cache.get(path)
  }
  return { files: [...new Set(out.split('\0').filter(Boolean))], read }
}

/** `git diff --name-status -z` output as changes; throws on anything unexpected. */
export function parseNameStatus(out) {
  const parts = out.split('\0')
  if (parts.at(-1) === '') parts.pop()
  const changes = []
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]
    if (!/^([MADTUX]|[RC]\d{0,3})$/.test(code)) throw new Error(`unexpected git status: ${code}`)
    const status = code[0]
    const from = 'RC'.includes(status) ? parts[i++] : undefined
    const path = parts[i++]
    if (!path || ('RC'.includes(status) && !from))
      throw new Error(`truncated git diff output at ${code}`)
    changes.push(from ? { status, from, path } : { status, path })
  }
  return changes
}

/**
 * Changes from the merge base of `base` and HEAD to the working tree, staged or not,
 * plus untracked files as additions. Throws for a ref that is not a commit or has no
 * merge base: there is no plan without a trustworthy diff.
 */
export function changedFiles(root, base) {
  if (typeof base !== 'string' || !base || base.startsWith('-'))
    throw new Error(`invalid base ref: ${JSON.stringify(base)}`)
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 << 20
    })
  let commit
  let mergeBase
  try {
    commit = git('rev-parse', '--verify', '--quiet', `${base}^{commit}`).trim()
  } catch {
    throw new Error(`base is not a commit here: ${base}`)
  }
  try {
    mergeBase = git('merge-base', commit, 'HEAD').trim()
  } catch {
    throw new Error(`no merge base between ${base} and HEAD (a shallow clone needs full history)`)
  }
  const changes = parseNameStatus(
    git('diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', mergeBase, '--')
  )
  for (const path of git('ls-files', '-z', '--others', '--exclude-standard').split('\0'))
    if (path) changes.push({ status: 'A', path, untracked: true })
  return { base: { base, commit, mergeBase }, changes }
}

/** The plan for the working tree against `base` in the checkout at `root`. */
export function planFromGit(root, base) {
  const { base: info, changes } = changedFiles(root, base)
  return planChanges(changes, repoContext(root), info)
}

function nativeChecksNodeProgram(read) {
  const scripts = JSON.parse(read('package.json')).scripts ?? {}
  if (
    scripts['typecheck:native'] !== 'tsc --noEmit -p tsconfig.native.json' ||
    scripts['typecheck:node'] !== 'tsc --noEmit -p tsconfig.node.json' ||
    !/(^|&& )bun run typecheck:node( &&|$)/.test(scripts.typecheck ?? '')
  )
    return false
  const node = JSON.parse(read('tsconfig.node.json'))
  const native = JSON.parse(read('tsconfig.native.json'))
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(node) || !object(native) || !object(node.compilerOptions)) return false
  if (native.compilerOptions !== undefined && !object(native.compilerOptions)) return false
  if (Object.keys(node).some((key) => !['compilerOptions', 'include'].includes(key))) return false
  if (
    native.extends !== './tsconfig.node.json' ||
    Object.keys(native).some((key) => !['extends', 'compilerOptions', 'include'].includes(key))
  )
    return false
  // `composite` only matters for project references and emit; `false`, exactly, is its
  // default. Any other value (true, 0, '', null, 'false') stays and makes them differ:
  // tsc rejects a non-boolean one, so that config must still be checked.
  const options = (all) => {
    const copy = { ...all }
    if (copy.composite === false) delete copy.composite
    return copy
  }
  return (
    isDeepStrictEqual(
      options({ ...node.compilerOptions, ...native.compilerOptions }),
      options(node.compilerOptions)
    ) && isDeepStrictEqual(native.include ?? node.include, node.include)
  )
}

/**
 * Which `--typecheck` entries run. `typecheck` runs `typecheck:node`; while
 * tsconfig.native.json resolves to the same options and files, `typecheck-native` would
 * check that program a second time, so it is not run. Anything unreadable or different
 * runs both.
 */
export function typecheckPlan(read) {
  let same = false
  try {
    same = nativeChecksNodeProgram(read)
  } catch {}
  return same
    ? {
        run: ['typecheck'],
        notRun: [
          {
            name: 'typecheck-native',
            reason: 'tsconfig.native.json resolves to tsconfig.node.json, which typecheck checks'
          }
        ]
      }
    : { run: ['typecheck', 'typecheck-native'], notRun: [] }
}

/** Readable plan, one line each. */
export function describePlan(plan) {
  const lines = []
  if (plan.commit)
    lines.push(`Selection against ${plan.base} (merge base ${plan.mergeBase.slice(0, 12)}):`)
  lines.push(`  ${plan.changes.length} changed path(s)`)
  for (const change of plan.changes.slice(0, 50)) lines.push(`    ${label(change)}`)
  if (plan.changes.length > 50) lines.push(`    … ${plan.changes.length - 50} more`)
  if (plan.mode === 'full') {
    lines.push('Plan: FULL — every test in the tier runs:')
    for (const reason of plan.reasons) lines.push(`  ${reason}`)
    return lines.join('\n')
  }
  lines.push(`Plan: SELECTED — ${plan.unit.length} of ${UNIT.length} unit tests:`)
  for (const [name, why] of plan.reasons) lines.push(`  ${name} — ${why.join('; ')}`)
  lines.push(`Typecheck: not needed — ${plan.typecheckReason}`)
  lines.push(
    plan.appBuild
      ? 'App build: required (product source changed)'
      : 'App build: not needed (docs and test-only change)'
  )
  if (plan.native.length)
    lines.push(
      `Native evidence still owed (not run by this tier): bun test/native-runtime.mjs --only=${plan.native.join(',')}`
    )
  return lines.join('\n')
}
