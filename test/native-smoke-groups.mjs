/**
 * Native smoke `--only=group,group` selection (src/native/smoke-groups.ts) and the
 * dev-native launcher's early rejection of bad selections — before any build, so
 * no desktop is needed. The groups themselves run in the native tier.
 *
 * Run with: bun test/native-smoke-groups.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  NATIVE_SMOKE_GROUPS,
  parseSmokeGroups,
  SMOKE_CHECK_GROUPS,
  SMOKE_PRELUDE,
  selectSmokeChecks
} from '../src/native/smoke-groups.ts'

const all = ['core', 'islands', 'shadow-light', 'sidebar', 'settings', 'chat', 'composer']
assert.deepEqual([...NATIVE_SMOKE_GROUPS], all)
assert.deepEqual([...parseSmokeGroups([])], all, 'No flag runs every group')
assert.deepEqual([...parseSmokeGroups(['--test', '--project', '/tmp/x'])], all)
assert.deepEqual([...parseSmokeGroups(['--test', '--only=chat,composer'])], ['chat', 'composer'])
assert.deepEqual(
  [...parseSmokeGroups(['--only= sidebar , shadow-light '])],
  ['sidebar', 'shadow-light']
)
assert.deepEqual([...parseSmokeGroups(['--only=core,core'])], ['core'])
assert.throws(
  () => parseSmokeGroups(['--only=core,bogus']),
  /Unknown native smoke group: bogus\. Known groups: core, islands, shadow-light, sidebar, settings, chat, composer/
)
assert.throws(
  () => parseSmokeGroups(['--only=nope,also']),
  /Unknown native smoke groups: nope, also\./
)
assert.throws(() => parseSmokeGroups(['--only=']), /--only needs at least one group/)
assert.throws(() => parseSmokeGroups(['--only']), /--only needs at least one group/)
assert.throws(() => parseSmokeGroups(['--only=core', '--only=chat']), /--only may be given once/)
assert.throws(() => parseSmokeGroups(['--live', '--only=chat']), /--live needs the core group/)
assert.deepEqual([...parseSmokeGroups(['--live', '--only=core,chat'])], ['core', 'chat'])
console.log(
  'Native smoke group selection: default, subset, unknown/empty/repeated and --live guards passed.'
)

// Selection filters smoke-core's named checks: every real check is classified, so a new
// check cannot silently escape --only; dependencies must survive every selection.
// Each check is a Biome-formatted object literal: `{`, then `name:` and an optional
// `dependsOn:` on their own lines.
const source = readFileSync(
  fileURLToPath(new URL('../src/native/smoke-core.ts', import.meta.url)),
  'utf8'
)
const checkPattern = /^\s*\{\n\s*name: '([\w-]+)',(?:\n\s*dependsOn: \[([^\]]*)\],)?/gm
const names = [...source.matchAll(checkPattern)].map((m) => ({
  name: m[1],
  dependsOn: [...(m[2] ?? '').matchAll(/'([\w-]+)'/g)].map((d) => d[1])
}))
assert.ok(names.length >= 19, `Found smoke-core checks (${names.length})`)
assert.ok(
  SMOKE_PRELUDE.every((name) => names.some((check) => check.name === name)),
  'Prelude names real checks'
)
for (const { name } of names)
  assert.ok(SMOKE_PRELUDE.includes(name) || SMOKE_CHECK_GROUPS[name], `Check ${name} needs a group`)
for (const name of Object.keys(SMOKE_CHECK_GROUPS))
  assert.ok(
    name === 'live-provider' || names.some((check) => check.name === name),
    `Group map names a real check: ${name}`
  )
const listed = names.map((check) => check.name)
assert.deepEqual(
  selectSmokeChecks(names, parseSmokeGroups([])).map((c) => c.name),
  listed,
  'No flag keeps every check in order'
)
for (const group of NATIVE_SMOKE_GROUPS) {
  const picked = selectSmokeChecks(names, parseSmokeGroups([`--only=${group}`])).map((c) => c.name)
  assert.ok(
    SMOKE_PRELUDE.every((name) => picked.includes(name)),
    `${group} keeps the prelude`
  )
  assert.ok(picked.length > SMOKE_PRELUDE.length, `${group} selects a check`)
  assert.deepEqual(
    picked,
    listed.filter((name) => picked.includes(name)),
    `${group} keeps run order`
  )
  for (const check of names.filter((c) => picked.includes(c.name)))
    for (const dep of check.dependsOn)
      assert.ok(
        picked.includes(dep),
        `${group}: ${check.name} depends on ${dep}, which was filtered out`
      )
}
assert.deepEqual(
  selectSmokeChecks(names, parseSmokeGroups(['--only=chat'])).map((c) => c.name),
  [
    'startup',
    'open-project',
    'chat-ready',
    'native-chat',
    'sent-attachments',
    'comment-rows',
    'chat-text',
    'final-shell'
  ]
)
for (const group of ['islands', 'shadow-light'])
  assert.ok(
    selectSmokeChecks(names, parseSmokeGroups([`--only=${group}`])).some(
      (c) => c.name === 'chat-islands'
    )
  )
assert.throws(
  () => selectSmokeChecks([{ name: 'brand-new' }], parseSmokeGroups([])),
  /brand-new has no group/
)
const notices = []
selectSmokeChecks(names, parseSmokeGroups([]), (line) => notices.push(line))
assert.deepEqual(notices, [], 'A full run prints no filter notice')
selectSmokeChecks(names, parseSmokeGroups(['--only=chat']), (line) => notices.push(line))
assert.match(
  notices.join(),
  /^NATIVE SMOKE FILTERED \(--only=chat\): running 8 of \d+ checks.*not full-suite acceptance/
)
console.log(
  'Native smoke check selection: every check classified, prelude kept, dependencies satisfied for each group.'
)

if (process.platform === 'darwin') {
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const dev = (...args) =>
    spawnSync(process.execPath, ['scripts/dev-native.mjs', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 20000
    })
  const unknown = dev('--test', '--only=core,bogus')
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown native smoke group: bogus\. Known groups:/)
  assert.doesNotMatch(unknown.stdout, /Building/, 'A bad group name fails before the build')
  const withoutTest = dev('--only=core')
  assert.equal(withoutTest.status, 1)
  assert.match(withoutTest.stderr, /requires --test/)
  const help = dev('--help')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--only=group,group/)
  assert.ok(
    all.every((group) => help.stdout.includes(group)),
    'Help lists every group'
  )
  console.log('dev-native: bad --only selections fail before building; --help lists the groups.')
} else console.log('dev-native launcher checks SKIP — macOS only.')
