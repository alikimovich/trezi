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
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
