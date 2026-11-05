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
  ANNOTATION_COMPOSITE_CHECK,
  ANNOTATION_COMPOSITE_FLAG,
  CHAT_RECOVERY_ACCEPTANCE_CHECK,
  DREAMER_ACCEPTANCE_CHECK,
  DREAMER_ACCEPTANCE_FLAG,
  MARKUP_ACCEPTANCE_CHECK,
  MARKUP_ACCEPTANCE_FLAG,
  NATIVE_SMOKE_GROUPS,
  parseSmokeGroups,
  SMOKE_CHECK_GROUPS,
  SMOKE_PRELUDE,
  SOURCE_POPOUT_ACCEPTANCE_CHECK,
  SOURCE_POPOUT_ACCEPTANCE_FLAG,
  selectAnnotationComposite,
  selectDreamerAcceptance,
  selectMarkupAcceptance,
  selectSmokeChecks,
  selectSourcePopoutAcceptance,
  smokeLauncherTimeoutMs
} from '../src/native/smoke-groups.ts'

const OPT_IN_LIVE = 'live-provider'

const all = [
  'core',
  'islands',
  'shadow-light',
  'sidebar',
  'settings',
  'chat',
  'composer',
  'agent-browser',
  'selection',
  'changes'
]
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
assert.equal(smokeLauncherTimeoutMs(parseSmokeGroups([])), 600_000)
assert.equal(smokeLauncherTimeoutMs(parseSmokeGroups(['--only=core'])), 300_000)
// LKM-277: the Scraib acceptance budget only extends a run that includes core.
assert.equal(smokeLauncherTimeoutMs(parseSmokeGroups(['--only=core']), 60_000), 360_000)
assert.equal(smokeLauncherTimeoutMs(parseSmokeGroups([]), 60_000), 660_000)
assert.equal(smokeLauncherTimeoutMs(parseSmokeGroups(['--only=chat']), 60_000), 300_000)
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
// The opt-in checks are pushed onto the list under their flag, so the pattern skips them.
for (const name of Object.keys(SMOKE_CHECK_GROUPS).filter(
  (key) => key !== CHAT_RECOVERY_ACCEPTANCE_CHECK
))
  assert.ok(
    [
      OPT_IN_LIVE,
      DREAMER_ACCEPTANCE_CHECK,
      MARKUP_ACCEPTANCE_CHECK,
      SOURCE_POPOUT_ACCEPTANCE_CHECK
    ].includes(name) || names.some((check) => check.name === name),
    `Group map names a real check: ${name}`
  )
// LKM-453: the chat recovery acceptance is opt-in too; test/chat-recovery-selection.mjs
// covers its selector and flag guards.
assert.deepEqual(SMOKE_CHECK_GROUPS[CHAT_RECOVERY_ACCEPTANCE_CHECK], ['chat'])
for (const pushed of [
  `'${OPT_IN_LIVE}'`,
  'DREAMER_ACCEPTANCE_CHECK',
  'MARKUP_ACCEPTANCE_CHECK',
  'SOURCE_POPOUT_ACCEPTANCE_CHECK'
])
  assert.match(source, new RegExp(`checks\\.push\\(\\{\\n\\s*name: ${pushed},`))
const listed = names.map((check) => check.name)
assert.deepEqual(
  selectSmokeChecks(names, parseSmokeGroups(['--only=selection']), () => {}).map((c) => c.name),
  ['startup', 'open-project', 'chat-ready', 'selection-input', 'text-edit', 'final-shell'],
  'Selection runs only its two checks plus the prelude'
)
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
    'composer-send',
    'native-chat',
    'sidebar-status',
    'sidebar-chats',
    'sent-attachments',
    'comment-rows',
    'incident-row',
    'landing-check',
    'agent-question',
    'chat-text',
    'chat-ui',
    'code-link-click',
    'parallel-stream',
    'mixed-origin-compatible',
    'mixed-origin-incompatible',
    'quit-alert',
    'final-shell'
  ]
)
// LKM-366: the small changes group runs without core; chat,changes is the targeted run.
assert.deepEqual(
  selectSmokeChecks(names, parseSmokeGroups(['--only=changes'])).map((c) => c.name),
  ['startup', 'open-project', 'chat-ready', 'changes-panel', 'final-shell']
)
const targeted = selectSmokeChecks(names, parseSmokeGroups(['--only=chat,changes'])).map(
  (c) => c.name
)
assert.ok(['code-link-click', 'changes-panel'].every((name) => targeted.includes(name)))
assert.equal(smokeLauncherTimeoutMs(parseSmokeGroups(['--only=chat,changes'])), 300_000)
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
  /^NATIVE SMOKE FILTERED \(--only=chat\): running 20 of \d+ checks.*not full-suite acceptance/
)
console.log(
  'Native smoke check selection: every check classified, prelude kept, dependencies satisfied for each group.'
)

// LKM-447: --dreamer-acceptance runs the prelude and its one opt-in check, nothing else.
const optIn = [...names, { name: DREAMER_ACCEPTANCE_CHECK, dependsOn: ['open-project'] }]
const acceptanceArgv = ['--test', '--only=settings', DREAMER_ACCEPTANCE_FLAG]
const acceptanceNotices = []
assert.deepEqual(
  selectDreamerAcceptance(
    selectSmokeChecks(optIn, parseSmokeGroups(acceptanceArgv), () => {}),
    acceptanceArgv,
    (line) => acceptanceNotices.push(line)
  ).map((c) => c.name),
  ['startup', 'open-project', 'chat-ready', 'final-shell', DREAMER_ACCEPTANCE_CHECK]
)
assert.match(acceptanceNotices.join(), /^DREAMER ACCEPTANCE .*not full-suite acceptance/)
assert.equal(
  selectDreamerAcceptance(names, ['--test'], () => {}),
  names,
  'No flag: unchanged'
)
assert.throws(
  () => parseSmokeGroups(['--only=chat', DREAMER_ACCEPTANCE_FLAG]),
  /--dreamer-acceptance needs the settings group/
)
assert.throws(
  () => selectDreamerAcceptance(names, acceptanceArgv, () => {}),
  /dreamer-export-primary check was not selected/
)
assert.throws(
  () => selectDreamerAcceptance(optIn, [...acceptanceArgv, '--live'], () => {}),
  /cannot run with --live/
)
console.log(
  'Dreamer acceptance selection: prelude plus dreamer-export-primary only; bad combinations fail.'
)

const markupArgv = ['--test', '--only=core', MARKUP_ACCEPTANCE_FLAG]
const markupChecks = [...names, { name: MARKUP_ACCEPTANCE_CHECK, dependsOn: ['chat-ready'] }]
assert.deepEqual(
  selectMarkupAcceptance(
    selectSmokeChecks(markupChecks, parseSmokeGroups(markupArgv), () => {}),
    markupArgv
  ).map((c) => c.name),
  [...SMOKE_PRELUDE, MARKUP_ACCEPTANCE_CHECK]
)
assert.throws(
  () => parseSmokeGroups(['--only=chat', MARKUP_ACCEPTANCE_FLAG]),
  /needs the core group/
)
assert.throws(() => selectMarkupAcceptance(names, markupArgv), /was not selected/)
assert.throws(() => selectMarkupAcceptance(markupChecks, [...markupArgv, '--live']), /cannot run/)
assert.throws(
  () => selectMarkupAcceptance(markupChecks, [...markupArgv, DREAMER_ACCEPTANCE_FLAG]),
  /cannot run/
)
// The two opt-in core acceptances never combine: each would drop the other's check.
assert.throws(
  () => selectMarkupAcceptance(markupChecks, [...markupArgv, SOURCE_POPOUT_ACCEPTANCE_FLAG]),
  /cannot run/
)
assert.throws(
  () =>
    selectSourcePopoutAcceptance(
      [...markupChecks, { name: SOURCE_POPOUT_ACCEPTANCE_CHECK }],
      ['--test', '--only=core', SOURCE_POPOUT_ACCEPTANCE_FLAG, MARKUP_ACCEPTANCE_FLAG],
      () => {}
    ),
  /cannot run/
)

const compositeArgv = ['--test', '--only=core', ANNOTATION_COMPOSITE_FLAG]
const compositeChecks = names
const compositeIndex = names.findIndex((check) => check.name === ANNOTATION_COMPOSITE_CHECK)
assert.ok(compositeIndex > 0, 'the composite check is registered in the ordinary smoke list')
assert.equal(names.filter((check) => check.name === ANNOTATION_COMPOSITE_CHECK).length, 1)
assert.deepEqual(names[compositeIndex].dependsOn, ['chat-ready'])
assert.equal(names[compositeIndex - 1].name, 'preview-markup')
assert.equal(names[compositeIndex + 1].name, 'text-edit')
for (const argv of [[], ['--only=core']]) {
  const selected = selectSmokeChecks(names, parseSmokeGroups(argv), () => {})
  assert.equal(selected.filter((check) => check.name === ANNOTATION_COMPOSITE_CHECK).length, 1)
  assert.equal(
    selectAnnotationComposite(selected, argv),
    selected,
    'ordinary selection is unchanged'
  )
}
assert.ok(
  !selectSmokeChecks(names, parseSmokeGroups(['--only=chat']), () => {}).some(
    (check) => check.name === ANNOTATION_COMPOSITE_CHECK
  ),
  'the check stays in core'
)
assert.match(
  source,
  /name: 'annotation-composite-send-native',\n\s*dependsOn: \['chat-ready'\],\n\s*run: async \(\) => \{\n\s*await checkAnnotationCompositeSend\(host, page, artifacts\)\n\s*await restorePreviewMarkup\(host, page\)/,
  'a successful composite check restores the preview before text-edit'
)
assert.match(
  source,
  /'annotation fixture page removed'\s*\)\s*assert\.equal\(\(await host\.request\('previewMarkupInspect'\)\)\.open, false\)\s*\},\s*cleanup: \(\) => restorePreviewMarkup\(host, page\)/,
  'success waits for the synthetic page to disappear and verifies the overlay is closed; failure retains cleanup'
)
const markupSource = readFileSync(
  fileURLToPath(new URL('../src/native/smoke-preview-markup.ts', import.meta.url)),
  'utf8'
)
assert.match(markupSource, /const PAGE = `\(\(\) => \{/, 'the check uses a local synthetic page')
assert.match(
  markupSource,
  /if \(channel === 'agent:send'\) \{\s*sent\.push\(args\)\s*return/,
  'Send is intercepted before a provider call'
)
assert.match(
  markupSource,
  /finally \{\s*nativeChat\.services\.invoke = invoke/,
  'Send interception is restored'
)
assert.match(
  markupSource,
  /document\.querySelector\("#markup-smoke"\)\?\.remove\(\)/,
  'cleanup removes the synthetic page'
)
assert.doesNotMatch(
  markupSource,
  /\bfetch\s*\(|feedback.{0,30}POST/i,
  'the scenario has no network or feedback POST'
)
assert.deepEqual(
  selectAnnotationComposite(
    selectSmokeChecks(compositeChecks, parseSmokeGroups(compositeArgv), () => {}),
    compositeArgv
  ).map((c) => c.name),
  ['startup', 'open-project', 'chat-ready', ANNOTATION_COMPOSITE_CHECK, 'final-shell'],
  'the annotation composite has a narrow selectable route'
)
assert.throws(
  () => parseSmokeGroups(['--only=chat', ANNOTATION_COMPOSITE_FLAG]),
  /needs the core group/
)
assert.throws(
  () =>
    selectAnnotationComposite(
      names.filter((check) => check.name !== ANNOTATION_COMPOSITE_CHECK),
      compositeArgv
    ),
  /was not selected/
)
assert.throws(
  () => selectAnnotationComposite(compositeChecks, [...compositeArgv, '--live']),
  /cannot run/
)
assert.throws(
  () => selectAnnotationComposite(compositeChecks, [...compositeArgv, MARKUP_ACCEPTANCE_FLAG]),
  /cannot run/
)
for (const flag of [
  DREAMER_ACCEPTANCE_FLAG,
  SOURCE_POPOUT_ACCEPTANCE_FLAG,
  '--chat-recovery-acceptance'
])
  assert.throws(
    () => selectAnnotationComposite(compositeChecks, [...compositeArgv, flag]),
    /cannot run/,
    `${flag} cannot combine with the narrow composite route`
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
  const acceptanceWithoutTest = dev(DREAMER_ACCEPTANCE_FLAG)
  assert.equal(acceptanceWithoutTest.status, 1)
  assert.match(acceptanceWithoutTest.stderr, /--dreamer-acceptance .*requires --test/)
  const acceptanceGroup = dev('--test', '--only=chat', DREAMER_ACCEPTANCE_FLAG)
  assert.equal(acceptanceGroup.status, 1)
  assert.match(acceptanceGroup.stderr, /needs the settings group/)
  assert.doesNotMatch(acceptanceGroup.stdout, /Building/)
  const markupWithoutTest = dev(MARKUP_ACCEPTANCE_FLAG)
  assert.equal(markupWithoutTest.status, 1)
  assert.match(markupWithoutTest.stderr, /requires --test/)
  const markupGroup = dev('--test', '--only=chat', MARKUP_ACCEPTANCE_FLAG)
  assert.equal(markupGroup.status, 1)
  assert.match(markupGroup.stderr, /needs the core group/)
  assert.doesNotMatch(markupGroup.stdout, /Building/)
  const help = dev('--help')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--only=group,group/)
  assert.match(help.stdout, /--dreamer-acceptance/)
  assert.match(help.stdout, /--markup-acceptance/)
  assert.ok(
    all.every((group) => help.stdout.includes(group)),
    'Help lists every group'
  )
  console.log('dev-native: bad --only selections fail before building; --help lists the groups.')
} else console.log('dev-native launcher checks SKIP — macOS only.')
