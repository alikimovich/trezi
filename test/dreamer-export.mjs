// LKM-202: Export Dreamer Report… writes a redacted zip (report.md, proposals.json,
// evidence.json); the weekly run waits while a chat is busy. LKM-443: the review window
// has no Send to Agent OS (no action, no route, no Agent OS copy) and Export… is its only
// primary action; editing, selection, Copy as JSON and Open Chat still work, a cancelled
// export writes nothing, a failed one leaves no file, and nothing makes a network request
// even with the old Agent OS settings saved. Stub sheets and a recording global fetch:
// no network, no window, files only in a temporary folder.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DREAMER_LAST_KEY,
  DREAMER_LAST_RUN_KEY,
  DREAMER_SCHEDULE_KEY,
  NativeDreamerController
} from '../src/native/dreamer-controller.ts'
import * as dreamerExport from '../src/native/dreamer-export.ts'
import { withDreamerPane } from '../src/native/settings-dreamer.ts'
import { dreamerErrors } from '../src/shared/dreamer.ts'

const { exportDreamerReport } = dreamerExport
const HOME = homedir()
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123'
const PRIVATE = /jane\.doe@example\.com|ghp_abc|\/Users\/[^/\s"]+/
/** What an earlier version saved for Send to Agent OS: kept, never read or sent. */
const LEGACY = {
  'trezi:dreamer:agent-os-url': 'http://127.0.0.1:4317',
  'trezi:dreamer:agent-os-project': 'trezi',
  'trezi:dreamer:agent-os-token': 'tok',
  'trezi:dreamer:agent-os-start': 'on'
}
const AGENT_OS = /Agent OS|\bsen[dt]\b|Not sent|instead/i

const proposal = (id, extra = {}) => ({
  id,
  title: `Fix the build for jane.doe@example.com (${id})`,
  category: 'bug',
  problem: `It fails in ${HOME}/dev/app with token ${SECRET}.`,
  evidence: [{ session: 's1', turn: 2, quote: `see ${HOME}/dev/app/.env`, numbers: { count: 3 } }],
  proposal: 'Fix it.',
  impact: 'Green builds.',
  effort: 'S',
  acceptance: ['The build passes.'],
  areas: ['build'],
  ...extra
})
const FILE = {
  version: 1,
  generatedAt: '2026-10-07T09:00:00.000Z',
  scope: { project: null, days: 14 },
  summary: `Looked at chats in ${HOME}/dev.`,
  proposals: [proposal('build'), proposal('tests')]
}
const DIGEST = {
  version: 1,
  slowTurns: [{ session: 's1', turn: 2, quote: `mail jane.doe@example.com ${SECRET}`, ms: 5 }]
}
const scratch = mkdtempSync(join(tmpdir(), 'trezi-dreamer-test-'))

const unzip = (zip) => {
  const out = mkdtempSync(join(scratch, 'unzip-'))
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out])
  const read = (name) => readFileSync(join(out, 'Dreamer Report', name), 'utf8')
  return {
    names: readdirSync(join(out, 'Dreamer Report')).sort(),
    report: read('report.md'),
    proposals: read('proposals.json'),
    evidence: read('evidence.json')
  }
}

// Every fetch is recorded and refused: the Dreamer must make none.
const requests = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  requests.push(String(url))
  throw new Error('no network in this test')
}

try {
  // --- the export zip ---
  {
    const zip = join(scratch, 'Dreamer Report.zip')
    assert.deepEqual(await exportDreamerReport(zip, FILE, DIGEST, HOME), { proposals: 2 })
    const files = unzip(zip)
    assert.deepEqual(files.names, ['evidence.json', 'proposals.json', 'report.md'])
    for (const [name, text] of Object.entries(files))
      if (name !== 'names') assert.doesNotMatch(text, PRIVATE, `${name} is redacted`)
    assert.match(files.report, /^# Dreamer report/)
    assert.match(files.report, /\[email\]/)
    const proposals = JSON.parse(files.proposals)
    assert.deepEqual(dreamerErrors(proposals), [])
    assert.equal(proposals.proposals[0].problem, 'It fails in ~/dev/app with token [redacted].')
    assert.equal(JSON.parse(files.evidence).slowTurns[0].quote, 'mail [email] [redacted]')
    // Exporting again replaces the zip; no digest gives an empty evidence file.
    await exportDreamerReport(zip, FILE, null, HOME)
    assert.equal(unzip(zip).evidence.trim(), '{}')
    assert.equal(FILE.proposals[0].problem.includes(SECRET), true, 'the input is not changed')
    // A destination that cannot be written rejects and leaves no file.
    writeFileSync(join(scratch, 'a-file'), '')
    const bad = join(scratch, 'a-file', 'Dreamer Report.zip')
    await assert.rejects(exportDreamerReport(bad, FILE, DIGEST, HOME))
    assert.equal(existsSync(bad), false)
    // Only the export is left: Send to Agent OS and its settings are gone.
    assert.deepEqual(Object.keys(dreamerExport).sort(), ['exportDreamerReport', 'redactDeep'])
    console.log('dreamer-export: zip PASS')
  }

  // --- the review window: Export… only, no Send ---
  {
    const prefs = new Map(Object.entries(LEGACY))
    // A result saved by an earlier version, with the last send it recorded.
    prefs.set(
      DREAMER_LAST_KEY,
      JSON.stringify({
        file: FILE,
        digest: DIGEST,
        selected: ['tests'],
        model: 'x',
        sent: { at: '2026-10-07T10:00:00.000Z', tasks: ['AOS-9'] }
      })
    )
    const preferences = {
      get: (key) => prefs.get(key) ?? null,
      set: async (key, value) => void (value == null ? prefs.delete(key) : prefs.set(key, value)),
      apply: async (entries) => {
        for (const [key, value] of entries)
          value == null ? prefs.delete(key) : prefs.set(key, value)
      }
    }
    const toasts = []
    let ran = 0
    const sheets = {
      current: null,
      generation: 0,
      workspace: { state: { projects: [] } },
      present(state, handle) {
        this.current = { state: { ...state, id: `sheet-${++this.generation}` }, handle }
      },
      refresh() {},
      toast(message) {
        toasts.push(message)
      },
      async invoke(channel) {
        assert.equal(channel, 'dreamer:run')
        ran++
        return { file: structuredClone(FILE), digest: DIGEST, model: 'stub' }
      }
    }
    const picked = []
    let dest = null
    const copied = []
    const opened = []
    let busy = false
    const host = {
      pickExport: async (name) => {
        picked.push(name)
        return dest
      },
      copyText: async (text) => void copied.push(text),
      openChat: (session) => void opened.push(session),
      busy: () => busy
    }
    const dreamer = new NativeDreamerController(sheets, preferences, host)
    dreamer.review()
    const state = () => sheets.current.state
    const perform = async (action, values = {}) => {
      const sheet = sheets.current
      sheet.state.message = undefined
      await sheet.handle({ id: sheet.state.id, action, values })
      return sheet.state.message
    }

    // No send action, Export… the only primary (the window's default button, Return).
    assert.equal(state().title, 'Dreamer Proposals')
    const ids = state().actions.map((a) => a.id)
    assert.ok(!ids.includes('send'), 'no Send to Agent OS action')
    assert.deepEqual(
      ids.filter((id) => !id.startsWith('open:')),
      ['select-all', 'select-none', 'copy-json', 'export']
    )
    const primary = state().actions.filter((a) => a.primary)
    assert.deepEqual(primary, [
      { id: 'export', label: 'Export…', primary: true, section: 'overview' }
    ])
    // No Agent OS target, setup text or last send; the wording is about export.
    const overview = state().sections.find((s) => s.id === 'overview')
    assert.equal(
      overview.detail,
      'Edit any proposal in the sidebar, then export the selected ones as a redacted ZIP.'
    )
    assert.deepEqual(
      state()
        .fields.filter((f) => f.section === 'overview')
        .map((f) => f.id),
      ['filter', 'selected', 'run', 'report']
    )
    const include = state().fields.find((f) => f.id === 'include0:build')
    assert.equal(include.label, 'Include in export')
    assert.deepEqual(
      include.choices.map((c) => c.label),
      ['Selected', 'Not selected']
    )
    const labels = JSON.stringify([
      state().sections,
      state().actions,
      state().fields.map(({ label, help, choices }) => ({ label, help, choices }))
    ])
    assert.doesNotMatch(labels, AGENT_OS, 'no Agent OS or send wording')
    // The old route is gone: a stray 'send' does nothing.
    assert.equal(await perform('send'), undefined)
    assert.equal(picked.length, 0)

    // Editing and selection are kept and saved.
    await perform('save', {
      filter: 'bug',
      'title:build': '  Make the build green  ',
      'problem:build': 'It fails.',
      'acceptance:build': '- The build passes.\n\n[ ] No retries.',
      'include0:build': 'yes',
      'include0:tests': 'no'
    })
    assert.equal(dreamer.result.file.proposals[0].title, 'Make the build green')
    assert.deepEqual(dreamer.result.file.proposals[0].acceptance, [
      'The build passes.',
      'No retries.'
    ])
    assert.deepEqual(dreamer.result.selected, ['build'])
    assert.equal(state().fields.find((f) => f.id === 'selected').value, '1 of 2 proposals selected')
    assert.equal(state().fields.find((f) => f.id === 'filter').value, 'bug')
    assert.deepEqual(JSON.parse(prefs.get(DREAMER_LAST_KEY)).selected, ['build'])
    await perform('select-all')
    assert.deepEqual(dreamer.result.selected, ['build', 'tests'])
    await perform('select-none')
    assert.deepEqual(dreamer.result.selected, [])
    assert.ok(
      state().fields.some((f) => f.id === 'include2:build'),
      'Select None reseeds'
    )
    await perform('save', { 'include0:tests': 'yes', 'include2:build': 'yes' })
    assert.deepEqual(dreamer.result.selected, ['build'], 'a stale epoch is ignored')

    // Copy as JSON and Open Chat.
    assert.equal(await perform('copy-json'), 'Copied 1 proposal as JSON.')
    assert.deepEqual(
      JSON.parse(copied[0]).proposals.map((p) => p.id),
      ['build']
    )
    assert.doesNotMatch(copied[0], PRIVATE)
    await perform('open:build:0')
    assert.deepEqual(opened, ['s1'])

    // Export…: the save panel, then a redacted zip of the selected proposals.
    const out = join(scratch, 'out')
    mkdirSync(out)
    dest = join(out, 'Dreamer Report.zip')
    const message = await perform('export')
    assert.equal(message, `Exported the report to ${dest}.`)
    assert.doesNotMatch(message, AGENT_OS)
    assert.match(picked[0], /^Dreamer Report \d{4}-\d{2}-\d{2}\.zip$/)
    const zip = unzip(dest)
    assert.deepEqual(zip.names, ['evidence.json', 'proposals.json', 'report.md'])
    const exported = JSON.parse(zip.proposals)
    assert.deepEqual(
      exported.proposals.map((p) => [p.id, p.title, p.problem]),
      [['build', 'Make the build green', 'It fails.']]
    )
    assert.deepEqual(dreamerErrors(exported), [])
    for (const text of [zip.report, zip.proposals, zip.evidence]) assert.doesNotMatch(text, PRIVATE)

    // Cancel: no file, no message.
    rmSync(dest)
    dest = null
    assert.equal(await perform('export'), '')
    assert.equal(picked.length, 2)
    assert.deepEqual(readdirSync(out), [], 'a cancelled export writes nothing')

    // A failed export reports the error (the sheet shows it) and leaves no file.
    dest = join(scratch, 'a-file', 'Dreamer Report.zip')
    await assert.rejects(perform('export'))
    assert.equal(existsSync(dest), false)

    // Trezi → Export Dreamer Report…: the same zip, no send.
    dest = join(out, 'menu.zip')
    await dreamer.exportReport()
    assert.match(toasts.at(-1), /^Exported 1 proposal to .*menu\.zip\.$/)
    assert.ok(existsSync(dest))

    // The old Agent OS settings were never read into a request and are not erased.
    assert.deepEqual(requests, [], 'no Agent OS request')
    for (const [key, value] of Object.entries(LEGACY)) assert.equal(prefs.get(key), value)
    console.log('dreamer-export: review window export PASS')

    // The weekly run: off by default, waits while a chat is busy, then runs once a week.
    sheets.current = null
    const now = Date.parse('2026-10-07T12:00:00Z')
    assert.equal(await dreamer.tick(now), false, 'off by default')
    prefs.set(DREAMER_SCHEDULE_KEY, 'weekly')
    prefs.set(DREAMER_LAST_RUN_KEY, String(now - 8 * 24 * 60 * 60_000))
    busy = true
    assert.equal(await dreamer.tick(now), false, 'a busy chat waits')
    busy = false
    assert.equal(await dreamer.tick(now), true)
    assert.equal(ran, 1)
    assert.match(toasts.at(-1), /The Dreamer found 2 proposals\./)
    assert.equal(await dreamer.tick(now), false, 'not again within the week')
    console.log('dreamer-export: weekly run PASS')

    // Settings → Dreamer: only the weekly run; saving keeps the old Agent OS values.
    let handled = 0
    const settingsSheet = {
      state: {
        id: 'settings',
        sections: [{ id: 'dreamer', label: 'Dreamer' }],
        fields: [],
        actions: []
      },
      handle: async () => void handled++
    }
    const settings = withDreamerPane(
      { sheets: { current: settingsSheet, refresh() {} }, open: async () => {} },
      preferences
    )
    await settings.open()
    assert.deepEqual(
      settingsSheet.state.fields.map((f) => [f.id, f.value]),
      [['dreamerSchedule', 'weekly']]
    )
    assert.deepEqual(settingsSheet.state.actions, [])
    assert.doesNotMatch(JSON.stringify(settingsSheet.state.fields), AGENT_OS)
    await settingsSheet.handle({
      id: 'settings',
      action: 'save',
      values: { dreamerSchedule: 'off' }
    })
    assert.equal(prefs.get(DREAMER_SCHEDULE_KEY), 'off')
    assert.equal(handled, 1)
    for (const [key, value] of Object.entries(LEGACY)) assert.equal(prefs.get(key), value)
    assert.deepEqual(requests, [])
    console.log('dreamer-export: settings PASS')
  }
} finally {
  globalThis.fetch = realFetch
  rmSync(scratch, { recursive: true, force: true })
}
console.log('DREAMER EXPORT OK')
