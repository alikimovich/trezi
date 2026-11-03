// LKM-447: the opt-in Dreamer acceptance's rules (src/native/dreamer-acceptance.ts), GREEN on
// the shipping review window and exporter and RED on the broken paths they exist to catch:
// a clipped or covered button, a second primary or Agent OS copy, an archive with the wrong
// files, proposals or an unredacted secret. The footer is measured by the acceptance's own
// host code (src/native/DreamerAcceptance.swift) in a window that is never shown. The native
// run itself (`bun run acceptance:dreamer`) needs the foreground and is an operator step.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acceptanceFixture,
  archiveProblems,
  DREAMER_OVERVIEW_ACTIONS,
  DREAMER_WIDTHS,
  footerProblems,
  PLANTED,
  stepLog,
  UNSELECTED_MARKER
} from '../src/native/dreamer-acceptance.ts'
import { exportDreamerReport } from '../src/native/dreamer-export.ts'
import {
  reviewActions,
  reviewFields,
  reviewSections,
  selectedFile
} from '../src/native/dreamer-review.ts'
import { DREAMER_FIXTURE } from '../src/native/smoke-dreamer.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const result = {
  file: acceptanceFixture(DREAMER_FIXTURE),
  digest: null,
  selected: ['speed-bash'],
  model: 'fixture'
}

// The fixture plants secrets in the selected proposal and a marker in the other.
assert.match(result.file.proposals[0].problem, new RegExp(PLANTED.token))
assert.match(result.file.proposals[1].problem, new RegExp(UNSELECTED_MARKER))
assert.ok(
  !DREAMER_FIXTURE.proposals[0].problem.includes(PLANTED.token),
  'the smoke fixture is untouched'
)

// Footer rules on a synthetic measure shaped like the host's, with the titles' measured widths.
const titles = { 'Select All': 57, 'Select None': 74, 'Copy as JSON': 88, 'Export…': 50 }
const button = (id, label, x, width, extra = {}) => ({
  id,
  label,
  primary: id === 'export',
  frame: [x, 415, width, 20],
  labelWidth: titles[label] ?? 100,
  visible: true,
  hitPane: true,
  ...extra
})
const measure = (buttons, extra = {}) => ({
  foreground: true,
  width: 680,
  height: 760,
  minimumWidth: 680,
  section: 'overview',
  actions: buttons.map((b) => b.id),
  proxies: buttons.length,
  buttons,
  defaultButtonCell: null,
  axDefault: null,
  ...extra
})
const footer = [
  button('select-all', 'Select All', 230, 81),
  button('select-none', 'Select None', 323, 98),
  button('copy-json', 'Copy as JSON', 433, 107),
  button('export', 'Export…', 576, 74)
]
assert.deepEqual(footerProblems(measure(footer), 680), [])
const red = (label, m, pattern) => {
  const problems = footerProblems(m, 680)
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `RED ${label}: ${problems.join('; ')}`
  )
}
const swap = (i, next) => footer.map((b, n) => (n === i ? next : b))
red('background', measure(footer, { foreground: false }), /not the key window/)
red('wrong width', measure(footer, { width: 780 }), /780 pt wide, not 680/)
red(
  'clipped',
  measure(swap(2, { ...footer[2], frame: [433, 415, 60, 20] })),
  /Copy as JSON is clipped/
)
red(
  'overlap',
  measure(swap(2, { ...footer[2], frame: [400, 415, 107, 20] })),
  /Select None overlaps Copy as JSON/
)
red('outside', measure(swap(3, { ...footer[3], visible: false })), /Export… is outside/)
red('covered', measure(swap(3, { ...footer[3], hitPane: false })), /Export… is covered/)
red('two rows', measure(swap(0, { ...footer[0], frame: [230, 380, 81, 20] })), /not on one row/)
red(
  'not rightmost',
  measure(swap(0, { ...footer[0], frame: [660, 415, 10, 20] })),
  /not the rightmost/
)
red(
  'AX default',
  measure(footer, { axDefault: { label: 'Copy as JSON', title: '' } }),
  /accessibility default button is Copy as JSON/
)
red(
  'AppKit default',
  measure(footer, { defaultButtonCell: 'Select All' }),
  /default button is Select All/
)
red('missing proxy', measure(footer, { proxies: 3 }), /3 rendered buttons for 4 actions/)
red(
  'Send to Agent OS',
  measure([
    ...footer.slice(0, 3),
    button('send', 'Send to Agent OS', 540, 30, { primary: true }),
    footer[3]
  ]),
  /primary actions are send, export/
)
assert.ok(
  footerProblems(measure(footer, { axDefault: { label: 'Export…', title: '' } }), 680).length === 0
)
console.log('Dreamer acceptance footer rules: GREEN passes, 12 RED layouts fail with their reason.')

// Archive rules on the real exporter's zip.
const temp = mkdtempSync(join(tmpdir(), 'trezi-dreamer-acceptance-test-'))
try {
  const unpack = async (name, file) => {
    const zip = join(temp, `${name}.zip`)
    await exportDreamerReport(zip, file, null)
    const out = join(temp, name)
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out])
    const report = join(out, 'Dreamer Report')
    const entries = readdirSync(report).sort()
    return {
      root: readdirSync(out).sort(),
      entries,
      files: Object.fromEntries(entries.map((f) => [f, readFileSync(join(report, f), 'utf8')]))
    }
  }
  const green = await unpack('green', selectedFile(result))
  assert.deepEqual(archiveProblems(green, ['speed-bash']), [])
  const all = await unpack('all', result.file)
  assert.ok(
    archiveProblems(all, ['speed-bash']).some((p) => /holds speed-bash, repeated-failure/.test(p))
  )
  assert.ok(archiveProblems(all, ['speed-bash']).some((p) => /not selected/.test(p)))
  const raw = {
    ...green,
    files: { ...green.files, 'proposals.json': JSON.stringify(selectedFile(result)) }
  }
  const leaks = archiveProblems(raw, ['speed-bash'])
  for (const kind of Object.keys(PLANTED))
    assert.ok(
      leaks.some((p) => p.includes(`leaks the planted ${kind}`)),
      `RED unredacted ${kind}`
    )
  const extra = { ...green, entries: [...green.entries, 'transcript.txt'] }
  assert.ok(archiveProblems(extra, ['speed-bash']).some((p) => /Dreamer Report holds/.test(p)))
  console.log(
    'Dreamer acceptance archive rules: the real export passes; all proposals, raw text and extra files fail.'
  )

  // The opt-in check never stubs the save panel except in its declared RED mode.
  const source = readFileSync(join(root, 'src/native/smoke-dreamer-acceptance.ts'), 'utf8')
  assert.deepEqual(
    [...source.matchAll(/^.*\.pickExport = .*$/gm)].map((m) => m[0].trim()),
    [
      "if (red === 'stub-save-panel') dreamer.host.pickExport = async () => join(out, 'stub.zip')",
      'dreamer.host.pickExport = pickExport'
    ],
    'pickExport is replaced only for RED and restored after'
  )

  // The footer as the acceptance's host code measures the shipping review window.
  if (process.platform !== 'darwin')
    console.log('Dreamer acceptance footer measure SKIP — macOS AppKit required')
  else {
    const state = (actions) => ({
      id: 'dreamer',
      title: 'Dreamer Proposals',
      detail: '',
      busy: false,
      autosave: true,
      section: 'overview',
      sections: reviewSections(result, 'all'),
      fields: reviewFields(result, 'all'),
      actions
    })
    const shipping = reviewActions(result)
    const long = shipping.map((a) =>
      a.id === 'copy-json' ? { ...a, label: 'Copy the Selected Proposals as JSON' } : a
    )
    // The review window before LKM-443: Send to Agent OS primary beside Export….
    const before = [
      ...shipping.filter((a) => a.id !== 'export'),
      { id: 'export', label: 'Export…', section: 'overview' },
      { id: 'send', label: 'Send to Agent OS', primary: true, section: 'overview' }
    ]
    const cases = [
      { name: 'ordinary', width: DREAMER_WIDTHS.ordinary, state: state(shipping) },
      { name: 'minimum', width: DREAMER_WIDTHS.minimum, state: state(shipping) },
      { name: 'long-label', width: DREAMER_WIDTHS.minimum, state: state(long) },
      { name: 'send-primary', width: DREAMER_WIDTHS.minimum, state: state(before) }
    ]
    const input = join(temp, 'cases.json')
    writeFileSync(input, JSON.stringify(cases))
    const binary = swiftBuild('dreamer-acceptance', [
      'test/fixtures/dreamer-acceptance/main.swift',
      ...[
        'Sheets',
        'SheetSections',
        'SheetSidebar',
        'SheetAlert',
        'SourceList',
        'SidebarIcon',
        'DreamerAcceptance'
      ].map((name) => `src/native/${name}.swift`)
    ])
    const measured = Object.fromEntries(
      runFixture(binary, [input])
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .map((m) => [m.case, m])
    )
    for (const name of ['ordinary', 'minimum']) {
      const m = measured[name]
      assert.equal(m.foreground, false, 'the fixture window is never shown')
      assert.deepEqual(m.actions, DREAMER_OVERVIEW_ACTIONS)
      // Offscreen, so foreground is the native run's to prove; every other rule holds here.
      assert.deepEqual(footerProblems({ ...m, foreground: true }, DREAMER_WIDTHS[name]), [], name)
    }
    const clipped = footerProblems(
      { ...measured['long-label'], foreground: true },
      DREAMER_WIDTHS.minimum
    )
    assert.ok(
      clipped.some((p) => /Copy the Selected Proposals as JSON is clipped/.test(p)),
      clipped.join('; ')
    )
    const sent = footerProblems(
      { ...measured['send-primary'], foreground: true },
      DREAMER_WIDTHS.minimum
    )
    assert.ok(
      sent.some((p) => /primary actions are send/.test(p)),
      sent.join('; ')
    )
    assert.ok(
      sent.some((p) => /Agent OS copy on a button/.test(p)),
      sent.join('; ')
    )
    // Five buttons do not fit at the minimum width: SwiftUI cuts their titles.
    assert.ok(
      sent.some((p) => /Copy as JSON is clipped/.test(p)),
      sent.join('; ')
    )
    console.log(
      `Dreamer acceptance footer measure: shipping footer passes at ${DREAMER_WIDTHS.ordinary} and ${DREAMER_WIDTHS.minimum} pt; a long label and Send to Agent OS fail.`
    )

    // LKM-452: the save-panel snapshot written before each wait, and the button savePress picks.
    const local = measured['panel-in-process']
    const remote = measured['panel-remote']
    for (const field of [
      'visible',
      'key',
      'attached',
      'keyWindow',
      'firstResponder',
      'remote',
      'views',
      'buttons',
      'saveTarget',
      'cancelTarget'
    ])
      assert.ok(field in local && field in remote, `the snapshot reports ${field}`)
    assert.equal(local.remote, false)
    assert.equal(local.saveTarget, 'Save', 'the visible Return button, not the hidden one')
    assert.equal(local.cancelTarget, 'Cancel')
    assert.deepEqual(
      local.buttons.map((b) => [b.title, b.hidden, b.key]),
      [
        ['New Folder', true, 'return'],
        ['Cancel', false, 'escape'],
        ['Save', false, 'return']
      ]
    )
    assert.equal(remote.remote, true, 'a remote view in the panel is reported')
    assert.deepEqual(remote.buttons, [])
    assert.equal(remote.saveTarget, null, 'no in-process Save: savePress takes the remote route')
    assert.equal(remote.cancelTarget, null)
    console.log(
      'Dreamer acceptance save panel snapshot: focus, views and buttons reported; Save picked in process, none behind a remote view.'
    )

    // Route selection: in-process buttons stay local; the remote key needs access and every focus check.
    const routes = Object.fromEntries(measured.routes.routes.map((r) => [r.name, r]))
    assert.deepEqual(routes.local, { name: 'local', route: 'local', refused: null })
    assert.deepEqual(routes.remote, { name: 'remote', route: 'remote', refused: null })
    assert.match(routes['no-access'].refused, /CGPreflightPostEventAccess\(\) is false/)
    for (const [name, reason] of Object.entries({
      inactive: 'app not active',
      'not-frontmost': 'app not frontmost',
      detached: 'panel not attached to the Dreamer window',
      offscreen: 'panel not on screen',
      'not-key': 'panel not key'
    })) {
      assert.equal(routes[name].route, 'remote', name)
      assert.equal(routes[name].refused, `the save panel is not in focus: ${reason}`, name)
    }

    // Guard denied: preflight false sends nothing and writes the access receipt.
    const denied = measured['press-remote-no-access']
    assert.equal(denied.route, 'remote')
    assert.equal(denied.input, 'window-server return')
    assert.equal(denied.sent, false)
    assert.equal(denied.preflight, false)
    assert.match(denied.refused, /not granted/)
    assert.deepEqual(denied.posted, { keys: [], clicks: 0, preflightCalls: 1 })
    assert.equal(denied.receipt.check, 'dreamer-export-primary')
    assert.equal(denied.receipt.preflight, false)
    assert.equal(denied.receipt.route, 'remote window-server return')
    assert.match(denied.receipt.access, /never requested/)
    for (const field of ['process', 'pid', 'bundle', 'parentPid', 'parent'])
      assert.ok(field in denied.receipt, `the receipt names the ${field}`)
    assert.ok(!denied.receipt.parent.includes('/'), 'the receipt names the parent without its path')
    assert.equal(denied.before.remote, true, 'the pre-input snapshot is kept')
    // Wrong focus: access granted, but this panel is hidden, unattached and not key.
    const unfocused = measured['press-remote-unfocused']
    assert.equal(unfocused.sent, false)
    assert.equal(unfocused.preflight, true)
    assert.deepEqual(unfocused.posted.keys, [], 'no global Escape without focus')
    assert.equal(unfocused.posted.clicks, 0)
    assert.equal(unfocused.guard.attached, false)
    assert.equal(unfocused.guard.foreground, false)
    assert.equal(unfocused.guard.key, false)
    assert.match(
      unfocused.refused,
      /not in focus: .*panel not attached.*panel not on screen.*panel not key/
    )
    assert.equal(unfocused.receipt.route, 'remote window-server escape')
    // Local: an in-process Save or Cancel is clicked through the app queue, with no access check.
    for (const [name, title] of [
      ['press-local-save', 'Save'],
      ['press-local-cancel', 'Cancel']
    ]) {
      const local = measured[name]
      assert.equal(local.route, 'local', name)
      assert.equal(local.pressed, title, name)
      assert.equal(local.sent, true, name)
      assert.deepEqual(local.posted, { keys: [], clicks: 1, preflightCalls: 0 }, name)
      assert.ok(!('receipt' in local), name)
    }
    console.log(
      'Dreamer acceptance save panel input: local clicks in process; the remote key is refused without access or focus and sends nothing.'
    )
  }

  // Save and Cancel keep their real semantics: the host never saves or cancels the panel
  // itself (only the failure cleanup cancels), never asks for access, and the check still
  // needs the panel to close, the zip, and an empty folder and message after Cancel.
  const swift = readFileSync(join(root, 'src/native/DreamerAcceptance.swift'), 'utf8')
  const pressCode = swift.slice(
    swift.indexOf('static func pressSavePanel'),
    swift.indexOf('static func postWindowServerKey')
  )
  assert.ok(pressCode.includes('postKey(code, true)'), 'pressSavePanel found')
  assert.doesNotMatch(pressCode, /\.ok\(|\.cancel\(|performClick|NSApp\.postEvent/)
  assert.equal([...swift.matchAll(/\.cancel\(nil\)/g)].length, 1, 'only dismissSavePanel cancels')
  assert.doesNotMatch(
    swift,
    /CGRequestPostEventAccess|AXIsProcessTrustedWithOptions|kAXTrustedCheckOptionPrompt|System Events|NSAppleScript|osascript|x-apple\.systempreferences/
  )
  const sentAt = source.indexOf('if (!press.sent)')
  assert.ok(
    sentAt > 0 && sentAt < source.indexOf("until('save panel closed'"),
    'a refused press fails before the close wait'
  )
  for (const kept of [
    "until('save panel closed'",
    "'the save panel wrote one zip where it was told'",
    "archiveProblems(archive, ['speed-bash'])",
    "'a cancelled export writes nothing'",
    "s.message === ''",
    "'no request reaches the Agent OS stand-in'"
  ])
    assert.ok(source.includes(kept), `the check still has ${kept}`)

  // LKM-452: a wait is noted before it starts, and a failed one adds the host state seen then.
  const written = []
  const log = stepLog(
    (steps) => written.push(JSON.parse(JSON.stringify(steps))),
    () => 'now'
  )
  log.note('savePress save', { press: { route: 'remote', pressed: null, sent: true } })
  assert.equal(
    await log.wait(
      'ready',
      async () => 'ok',
      async () => 'unused'
    ),
    'ok'
  )
  await assert.rejects(
    log.wait(
      'save panel closed',
      async () => {
        assert.deepEqual(written.at(-1).at(-1), { step: 'wait: save panel closed', at: 'now' })
        throw new Error('Native check timed out: save panel closed; false')
      },
      async () => ({ savePanel: { open: true, remote: true } })
    ),
    /save panel closed; false/
  )
  assert.deepEqual(
    written.at(-1).map((s) => s.step),
    ['savePress save', 'wait: ready', 'wait: save panel closed', 'failed: save panel closed']
  )
  assert.deepEqual(written.at(-1).at(-1).state, { savePanel: { open: true, remote: true } })
  await assert.rejects(
    log.wait(
      'broken',
      async () => {
        throw new Error('x')
      },
      async () => {
        throw new Error('host gone')
      }
    ),
    /x/
  )
  assert.match(written.at(-1).at(-1).state, /state unavailable: Error: host gone/)

  // Every wait in the check goes through the log, and an export is recorded before its waits.
  const waits = [...source.matchAll(/\b(waitFor|inspectUntil)\(/g)].length
  assert.equal(waits, 2, 'waitFor and inspectUntil are called only inside until() and sheet()')
  const at = (text) => {
    const index = source.indexOf(text)
    assert.ok(index >= 0, `smoke-dreamer-acceptance.ts has ${text}`)
    return index
  }
  assert.ok(
    at('.push(entry)') < at('`real NSSavePanel opened by'),
    'the export entry exists before its first wait'
  )
  assert.ok(
    at('log.note(`savePress ${button}`') < at("until('save panel closed'"),
    'the press and the panel it saw are written before the panel must close'
  )
  console.log(
    'Dreamer acceptance step log: notes precede every wait; a timeout keeps its error and the host state.'
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
