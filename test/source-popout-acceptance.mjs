// LKM-456: the opt-in `fullscreen-popout-close-native` acceptance for LKM-444, without a desktop.
// Its rules (src/native/source-popout-acceptance.ts) GREEN on the real `SourcePopout`'s steps
// and RED on the stranded state the old order-out leaves; input receipts that were refused,
// unlabelled or off target never pass; the host steps post input and never close through a
// control callback, `performClick`, the menu or `insertText`; the opt-in selection; and the
// operator command's guards, which all stop before any build. The native run itself
// (`bun run acceptance:source-popout`) needs the foreground and is an operator step.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  parseSmokeGroups,
  SMOKE_CHECK_GROUPS,
  SOURCE_POPOUT_ACCEPTANCE_CHECK,
  SOURCE_POPOUT_ACCEPTANCE_FLAG,
  selectSourcePopoutAcceptance
} from '../src/native/smoke-groups.ts'
import {
  closedProblems,
  evidenceFolder,
  probeProblems,
  receiptProblems,
  redMet,
  SOURCE_POPOUT_INPUT_ORIGIN,
  SOURCE_POPOUT_INPUT_ROUTE,
  SOURCE_POPOUT_RED_MODES,
  SOURCE_POPOUT_RED_STEP
} from '../src/native/source-popout-acceptance.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const draft = '<!-- LKM-456 pop-out draft -->\n<!doctype html>'
const expected = { full: true, text: draft, selection: [5, 7] }

// A closed pop-out as the host reports it after a fixed full-screen close.
const green = (steps) => ({
  settled: true,
  visible: false,
  fullScreen: false,
  phase: 'windowed',
  pendingHide: false,
  strayFullScreenWindows: 0,
  mainVisible: true,
  mainKey: true,
  keyIsMain: true,
  mainOnActiveSpace: true,
  composerFocus: true,
  hitTest: true,
  ignoresMouse: false,
  steps,
  text: draft,
  selection: [5, 7]
})

// GREEN on the real SourcePopout's steps (the LKM-444 fixture, AppKit's notifications scripted).
let fullSteps = ['full', 'exit-full-screen', 'exiting', 'windowed', 'order-out', 'main-key']
if (process.platform === 'darwin') {
  const binary = swiftBuild('source-popout', [
    'test/fixtures/source-popout/main.swift',
    'src/native/SourcePopout.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  fullSteps = report.full.steps
  assert.deepEqual(closedProblems(green(report.exiting.steps), 'exiting', expected), [])
  assert.deepEqual(
    closedProblems(green(report.windowed.steps), 'windowed', { ...expected, full: false }),
    []
  )
} else console.log('SOURCE-POPOUT-ACCEPTANCE: real SourcePopout steps SKIP — macOS AppKit required')
assert.deepEqual(closedProblems(green(fullSteps), 'full', expected), [], 'GREEN on the fixed close')

// RED: the pre-LKM-444 order-out leaves the pop-out off screen and still in full screen.
const stranded = {
  ...green(['full', 'order-out']),
  settled: false,
  fullScreen: true,
  phase: 'full',
  mainKey: false,
  keyIsMain: false,
  mainOnActiveSpace: false
}
const redProblems = closedProblems(stranded, SOURCE_POPOUT_RED_STEP, expected)
for (const problem of [
  'not settled',
  'the pop-out is still in full screen',
  'phase full, not windowed',
  'the main window is not key',
  'the main window is not on the active Space',
  'ordered out before didExitFullScreen'
])
  assert.ok(redProblems.includes(`${SOURCE_POPOUT_RED_STEP}: ${problem}`), `RED: ${problem}`)
const redFailure = redProblems.join('; ')
assert.equal(redMet(redFailure, stranded), true, 'RED is met by the stranded Space')
assert.equal(redMet(null, stranded), false, 'a passing run never meets RED')
assert.equal(redMet(redFailure, green(fullSteps)), false, 'RED needs the stranded state recorded')
assert.equal(
  redMet(redFailure.replaceAll(SOURCE_POPOUT_RED_STEP, 'fullscreen-close-button'), stranded),
  false,
  'RED fails on its armed step only'
)
assert.equal(
  redMet(
    `${SOURCE_POPOUT_RED_STEP}: input refused before posting: the app is not active`,
    stranded
  ),
  false,
  'a refused input is not RED'
)

// Each lifecycle assertion the source-popout smoke makes still fails on its own.
const flips = {
  visible: true,
  pendingHide: true,
  strayFullScreenWindows: 1,
  mainVisible: false,
  ignoresMouse: true,
  composerFocus: false,
  hitTest: false,
  steps: ['full', 'windowed'],
  text: 'changed',
  selection: [0, 0]
}
for (const [key, value] of Object.entries(flips))
  assert.equal(
    closedProblems({ ...green(fullSteps), [key]: value }, 'case', expected).length,
    1,
    `${key} is checked`
  )

// Receipts: posted through the stated route after a preflight that found the target.
const receipt = (kind, extra = {}, preflight = {}) => ({
  kind,
  target: kind === 'pointer' ? 'editor-close' : 'cmd-w',
  route: SOURCE_POPOUT_INPUT_ROUTE,
  origin: SOURCE_POPOUT_INPUT_ORIGIN,
  posted: true,
  preflight: { appActive: true, targetKey: true, hitIsTarget: true, ...preflight },
  ...extra
})
assert.deepEqual(receiptProblems(receipt('pointer'), 'x'), [])
assert.deepEqual(receiptProblems(receipt('keyboard'), 'x'), [])
assert.match(
  receiptProblems(receipt('pointer', { posted: false, refused: 'the app is not active' }), 'x')[0],
  /input refused before posting: the app is not active/
)
for (const [bad, pattern] of [
  [receipt('pointer', { posted: false }), /no event was posted/],
  [receipt('pointer', { route: 'performClick' }), /route performClick/],
  [receipt('pointer', { origin: 'hardware' }), /unlabelled origin/],
  [receipt('pointer', {}, { appActive: false }), /not active/],
  [receipt('pointer', {}, { hitIsTarget: false }), /did not hit-test/],
  [receipt('keyboard', {}, { targetKey: false }), /not the key window/]
])
  assert.match(receiptProblems(bad, 'x').join(), pattern)
assert.match(receiptProblems(undefined, 'x')[0], /no input receipt/)
assert.match(SOURCE_POPOUT_INPUT_ORIGIN, /^programmatic: .*not OS or HID hardware input$/)

// The main window through input: click focuses the composer, a key types, Delete restores.
const probe = {
  click: receipt('pointer', { target: 'composer' }),
  type: receipt('keyboard', { target: 'type-x' }),
  erase: receipt('keyboard', { target: 'delete' }),
  focused: true,
  typed: true,
  restored: true,
  mainKey: true,
  appActive: true
}
assert.deepEqual(probeProblems(probe, 'p'), [])
for (const key of ['focused', 'typed', 'restored', 'mainKey'])
  assert.equal(probeProblems({ ...probe, [key]: false }, 'p').length, 1, `probe ${key}`)
assert.match(
  probeProblems({ ...probe, click: { refused: 'p: Trezi is not key', posted: false } }, 'p').join(),
  /refused/
)
assert.match(probeProblems(undefined, 'p').join(), /no main-window input probe/)

// Evidence folders: one per SHA, mode and start, never shared.
const sha = 'a'.repeat(40)
assert.equal(
  evidenceFolder(sha, 'red-legacy-order-out', '2026-11-03T12:00:00.000Z'),
  'aaaaaaaaaaaa-red-legacy-order-out-2026-11-03T12-00-00-000Z'
)
assert.notEqual(
  evidenceFolder(sha, 'green', '2026-11-03T12:00:00.000Z'),
  evidenceFolder(sha, 'green', '2026-11-03T12:00:01.000Z')
)
assert.throws(() => evidenceFolder('abc123', 'green', 'now'), /Not a full commit SHA/)

// The host steps post input and never take the shortcuts the ticket rules out as proof.
const swift = read('src/native/SourcePopoutAcceptance.swift')
assert.ok(swift.includes(`"${SOURCE_POPOUT_INPUT_ORIGIN}"`), 'Swift states the same origin')
assert.ok(swift.includes(`"route": "${SOURCE_POPOUT_INPUT_ROUTE}"`), 'Swift states the route')
assert.match(swift, /NSApp\.postEvent\(event, atStart: false\)/)
for (const banned of [
  /performClick/,
  /performKeyEquivalent/,
  /insertText/,
  /makeFirstResponder/,
  /sendAction/,
  /CGEvent/,
  /AXIsProcessTrusted/,
  /CGRequest/
])
  assert.doesNotMatch(swift, banned, `SourcePopoutAcceptance.swift uses no ${banned.source}`)
// The RED order-out is armed per input and restored, in the test profile only.
assert.match(
  swift,
  /defer \{ editor\.presenter = presenter; Host\.sourcePopoutRedPresenter = nil \}/
)
const inspect = read('src/native/HostInspect.swift')
assert.match(
  inspect,
  /case "sourcePopoutAcceptance":[^\n]*\n[^\n]*\n\s*guard ephemeral,/,
  'the host steps need the test profile'
)
assert.ok(read('scripts/build-native.mjs').includes("'src/native/SourcePopoutAcceptance.swift'"))
// Closes and docks go through the posted input; the smoke never hides or docks by callback.
const smoke = read('src/native/smoke-source-popout-acceptance.ts')
assert.doesNotMatch(smoke, /perform\('(hide|dock)'\)/)
assert.doesNotMatch(smoke, /close', \{ via/)
for (const input of ['editor-close', 'editor-dock', 'window-close', 'cmd-w'])
  assert.ok(smoke.includes(`'${input}'`), `the acceptance drives ${input}`)
for (const label of [
  'windowed-close-control',
  'windowed-dock',
  'fullscreen-close-button',
  'fullscreen-close-key',
  'fullscreen-dock',
  'entering-close-control',
  'entering-dock',
  'exiting-close-key',
  'exiting-dock',
  'main-fullscreen-docked'
])
  assert.ok(smoke.includes(`'${label}'`), `the acceptance covers ${label}`)
assert.match(smoke, /close\(SOURCE_POPOUT_RED_STEP, 'editor-close', 'full', !!red\)/)

// Selection: opt-in, the core group, the prelude and the one check.
assert.deepEqual(SMOKE_CHECK_GROUPS[SOURCE_POPOUT_ACCEPTANCE_CHECK], ['core'])
const checks = ['startup', 'open-project', 'source-popout', 'chat-ready', 'final-shell']
  .concat(SOURCE_POPOUT_ACCEPTANCE_CHECK)
  .map((name) => ({ name }))
const argv = ['--test', '--only=core', SOURCE_POPOUT_ACCEPTANCE_FLAG]
const notices = []
assert.deepEqual(
  selectSourcePopoutAcceptance(checks, argv, (line) => notices.push(line)).map((c) => c.name),
  ['startup', 'open-project', 'chat-ready', 'final-shell', SOURCE_POPOUT_ACCEPTANCE_CHECK]
)
assert.match(notices.join(), /^SOURCE POP-OUT ACCEPTANCE .*not full-suite acceptance/)
assert.equal(
  selectSourcePopoutAcceptance(checks, ['--test'], () => {}),
  checks,
  'no flag: unchanged'
)
assert.throws(() => selectSourcePopoutAcceptance(checks, [...argv, '--live'], () => {}), /--live/)
assert.throws(
  () => selectSourcePopoutAcceptance(checks, [...argv, '--dreamer-acceptance'], () => {}),
  /cannot run with --dreamer-acceptance/
)
assert.throws(
  () => selectSourcePopoutAcceptance(checks.slice(0, 5), argv, () => {}),
  /fullscreen-popout-close-native check was not selected/
)
assert.throws(
  () => parseSmokeGroups(['--only=chat', SOURCE_POPOUT_ACCEPTANCE_FLAG]),
  /needs the core group/
)
assert.deepEqual(SOURCE_POPOUT_RED_MODES, ['legacy-order-out'])

// The operator command and the launcher stop before any build on bad input.
const run = (script, args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...env }
  })
const command = 'scripts/source-popout-acceptance.mjs'
for (const [args, env, pattern] of [
  [['--red=bogus'], {}, /unknown RED mode bogus/],
  [['--bogus'], {}, /unknown argument --bogus; the only option is --red=legacy-order-out/],
  [['--red=legacy-order-out'], { TREZI_NATIVE_BACKGROUND_TEST: '1' }, /needs the foreground/]
]) {
  const result = run(command, args, env)
  if (process.platform !== 'darwin' && !/RED|argument/.test(pattern.source)) continue
  assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`)
  assert.match(result.stderr, pattern)
  assert.doesNotMatch(result.stdout, /Building|SOURCE POP-OUT ACCEPTANCE \(/)
}
if (process.platform === 'darwin') {
  const launcher = run('scripts/dev-native.mjs', [SOURCE_POPOUT_ACCEPTANCE_FLAG])
  assert.equal(launcher.status, 1)
  assert.match(
    launcher.stderr,
    /--source-popout-acceptance is a native smoke check and requires --test/
  )
  const group = run('scripts/dev-native.mjs', [
    '--test',
    '--only=chat',
    SOURCE_POPOUT_ACCEPTANCE_FLAG
  ])
  assert.equal(group.status, 1)
  assert.match(group.stderr, /needs the core group/)
  assert.doesNotMatch(group.stdout, /Building/)
  assert.match(run('scripts/dev-native.mjs', ['--help']).stdout, /--source-popout-acceptance/)
}
console.log(
  'SOURCE-POPOUT-ACCEPTANCE PASS: rules GREEN on the fixed close and RED on the stranded Space; receipts, host steps, selection and command guards.'
)
