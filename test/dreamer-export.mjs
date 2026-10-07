// LKM-202: Export Dreamer Report… writes a redacted zip (report.md, proposals.json,
// evidence.json); Send to Agent OS posts the selected proposals to the configured
// endpoint with the token, shows the created task ids, and falls back to the export
// when the send fails; the weekly run waits while a chat is busy. A stub fetch and
// stub sheets: no network, no window, files only in a temporary folder.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DREAMER_LAST_RUN_KEY,
  DREAMER_SCHEDULE_KEY,
  NativeDreamerController
} from '../src/native/dreamer-controller.ts'
import {
  DREAMER_PROJECT_KEY,
  DREAMER_TOKEN_KEY,
  DREAMER_URL_KEY,
  exportDreamerReport,
  sendToAgentOs
} from '../src/native/dreamer-export.ts'
import { dreamerErrors } from '../src/shared/dreamer.ts'

const HOME = homedir()
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123'
const PRIVATE = /jane\.doe@example\.com|ghp_abc|\/Users\/[^/\s"]+/

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
    report: read('report.md'),
    proposals: read('proposals.json'),
    evidence: read('evidence.json')
  }
}

try {
  // --- the export zip ---
  {
    const zip = join(scratch, 'Dreamer Report.zip')
    assert.deepEqual(await exportDreamerReport(zip, FILE, DIGEST, HOME), { proposals: 2 })
    const files = unzip(zip)
    for (const [name, text] of Object.entries(files))
      assert.doesNotMatch(text, PRIVATE, `${name} is redacted`)
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
    console.log('dreamer-export: zip PASS')
  }

  // --- Send to Agent OS ---
  const answer = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const stub = (...responses) => {
    const calls = []
    const fetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      const next = responses.shift()
      if (next instanceof Error) throw next
      return next
    }
    return { calls, fetch }
  }
  {
    const target = { url: 'http://127.0.0.1:4317/', project: 'my proj', token: ' secret-token ' }
    const ok = stub(answer(200, { created: [{ proposal: 'build', issue: 'AOS-7' }] }))
    assert.deepEqual(await sendToAgentOs(target, FILE, ok.fetch, HOME), {
      ok: true,
      tasks: ['AOS-7']
    })
    assert.equal(ok.calls[0].url, 'http://127.0.0.1:4317/api/projects/my%20proj/proposals')
    assert.equal(ok.calls[0].headers.authorization, 'Bearer secret-token')
    assert.doesNotMatch(JSON.stringify(ok.calls[0].body), PRIVATE)
    assert.deepEqual(dreamerErrors(ok.calls[0].body), [])

    // An Agent OS without the project route gets its `POST /proposals` import.
    const legacy = stub(answer(404, {}), answer(200, { created: [{ issue: 'AOS-8' }] }))
    assert.deepEqual((await sendToAgentOs(target, FILE, legacy.fetch, HOME)).tasks, ['AOS-8'])
    assert.equal(legacy.calls[1].url, 'http://127.0.0.1:4317/proposals')
    assert.equal(legacy.calls[1].body.projectId, 'my proj')
    assert.equal(legacy.calls[1].body.file.proposals.length, 2)

    const refused = stub(answer(400, { error: 'proposals[0].title too long' }))
    assert.deepEqual(await sendToAgentOs(target, FILE, refused.fetch, HOME), {
      ok: false,
      tasks: [],
      error: 'Agent OS answered 400: proposals[0].title too long'
    })
    const down = stub(new Error('connect ECONNREFUSED'))
    assert.match(
      (await sendToAgentOs(target, FILE, down.fetch, HOME)).error,
      /could not be reached \(connect ECONNREFUSED\)/
    )
    const none = stub()
    assert.match(
      (await sendToAgentOs({ ...target, url: 'not a url' }, FILE, none.fetch)).error,
      /not valid/
    )
    assert.match(
      (await sendToAgentOs({ ...target, url: 'file:///etc' }, FILE, none.fetch)).error,
      /http:\/\/ or https:\/\//
    )
    assert.match(
      (await sendToAgentOs({ ...target, project: ' ' }, FILE, none.fetch)).error,
      /project ID/
    )
    assert.equal(none.calls.length, 0, 'nothing is sent without a valid target')
    const open = stub(answer(200, {}))
    await sendToAgentOs({ url: '', project: 'p' }, FILE, open.fetch, HOME)
    assert.equal(
      open.calls[0].url,
      'http://127.0.0.1:4317/api/projects/p/proposals',
      'the default URL'
    )
    assert.equal(open.calls[0].headers.authorization, undefined, 'no token, no header')
    console.log('dreamer-export: send PASS')
  }

  // --- the review window's Send, with its export fallback ---
  {
    const prefs = new Map([
      [DREAMER_URL_KEY, 'http://agent-os.test'],
      [DREAMER_PROJECT_KEY, 'trezi'],
      [DREAMER_TOKEN_KEY, 'tok']
    ])
    const preferences = {
      get: (key) => prefs.get(key) ?? null,
      set: async (key, value) => void prefs.set(key, value),
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
    let responses = []
    let busy = false
    const host = {
      pickExport: async (name) => {
        picked.push(name)
        return join(scratch, 'fallback.zip')
      },
      copyText: async () => {},
      openChat: () => {},
      busy: () => busy,
      fetch: async () => {
        const next = responses.shift()
        if (next instanceof Error) throw next
        return next
      }
    }
    const dreamer = new NativeDreamerController(sheets, preferences, host)
    dreamer.result = {
      file: structuredClone(FILE),
      digest: DIGEST,
      selected: ['tests'],
      model: 'x'
    }
    dreamer.review()
    const perform = async (action) => {
      const sheet = sheets.current
      await sheet.handle({ id: sheet.state.id, action, values: {} })
      return sheet.state.message
    }

    responses = [answer(200, { created: [{ issue: 'AOS-9' }] })]
    assert.equal(await perform('send'), 'Sent 1 proposal to Agent OS. Created AOS-9.')
    assert.deepEqual(dreamer.result.sent.tasks, ['AOS-9'])
    assert.equal(picked.length, 0)

    responses = [new Error('offline')]
    const message = await perform('send')
    assert.match(message, /^Not sent: Agent OS could not be reached \(offline\)\./)
    assert.match(message, /Exported the report to .*fallback\.zip instead\./)
    assert.match(picked[0], /^Dreamer Report \d{4}-\d{2}-\d{2}\.zip$/)
    assert.ok(existsSync(join(scratch, 'fallback.zip')))
    const fallback = unzip(join(scratch, 'fallback.zip'))
    assert.deepEqual(
      JSON.parse(fallback.proposals).proposals.map((p) => p.id),
      ['tests'],
      'the fallback exports what would have been sent'
    )
    assert.doesNotMatch(fallback.proposals, PRIVATE)

    await perform('select-none')
    await assert.rejects(perform('send'), /Select at least one proposal/)

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
    console.log('dreamer-export: review send and weekly run PASS')
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log('DREAMER EXPORT OK')
