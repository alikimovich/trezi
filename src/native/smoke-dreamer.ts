import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DreamerFile } from '../shared/dreamer'
import type { NativeBridge } from './bridge'
import type { NativeDreamerController } from './dreamer-controller'
import type { PreferenceEntry } from './preferences'
import { inspectUntil } from './smoke-wait'

/**
 * LKM-202: the Dreamer's review window with a fixture result (no model run): it opens
 * from Trezi → Dreamer Proposals…, shows a proposal's pane, and (LKM-443) Export… is its
 * only primary action: the default button, a redacted zip of the selected proposals, a
 * cancel that writes nothing, and no request to Agent OS even with its old settings saved.
 * The save panel is stubbed at the controller's host; the real panel is an operator step.
 */

/** Settings an earlier version saved for the removed Send to Agent OS; now never read. */
export const LEGACY_AGENT_OS_KEYS = [
  'trezi:dreamer:agent-os-url',
  'trezi:dreamer:agent-os-project',
  'trezi:dreamer:agent-os-token'
]

export const DREAMER_FIXTURE: DreamerFile = {
  version: 1,
  generatedAt: '2026-10-07T09:00:00.000Z',
  scope: { project: null, days: 14 },
  summary: 'Bash steps took most of the tool time, and one landing failure repeated.',
  proposals: [
    {
      id: 'speed-bash',
      title: 'Speed up Bash steps',
      category: 'speed',
      problem: 'Bash took the most tool time: 12 steps, 340 s in total.',
      evidence: [{ quote: 'run the tests again', numbers: { steps: 12, totalMs: 340000 } }],
      proposal: 'Cache the test run between turns and run only the affected tests.',
      impact: 'Shorter turns.',
      effort: 'M',
      acceptance: ['Bash p90 drops in the next digest.'],
      areas: ['tools']
    },
    {
      id: 'repeated-failure',
      title: 'Fix a repeated landing failure',
      category: 'bug',
      problem: 'Landing failed 3 times in 2 chats.',
      evidence: [{ numbers: { count: 3 }, note: 'landing: Landing failed' }],
      proposal: 'Find the cause and fix it.',
      impact: 'Fewer failed turns.',
      effort: 'S',
      acceptance: ['The failure is gone from the log.'],
      areas: ['landing']
    }
  ]
}

export async function checkDreamerReview(
  host: NativeBridge,
  dreamer: NativeDreamerController,
  artifacts: string
) {
  const until = (check: (state: any) => boolean) =>
    inspectUntil((method) => host.request(method), 'sheetInspect', check)
  // The window's foreground pixels; the cached-display capture paints a sectioned
  // window's split view blank, so it is only the fallback (with the reason recorded).
  const captures: Record<string, string> = {}
  const capture = async (name: string) => {
    let png: string
    try {
      png = (await host.request('captureVisibleSheet')).png
      captures[name] = 'foreground'
    } catch (error) {
      png = await host.request('captureSheet')
      captures[name] = `cached display (${error instanceof Error ? error.message : String(error)})`
    }
    writeFileSync(join(artifacts, name), Buffer.from(png, 'base64'))
  }
  const requests: string[] = []
  // A local stand-in at the old Agent OS URL: nothing may reach it.
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(500).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const saved = LEGACY_AGENT_OS_KEYS.map(
    (key): PreferenceEntry => [key, dreamer.preferences.get(key)]
  )
  const pickExport = dreamer.host.pickExport
  const out = mkdtempSync(join(tmpdir(), 'trezi-dreamer-smoke-'))
  try {
    await dreamer.preferences.apply([
      [LEGACY_AGENT_OS_KEYS[0], `http://127.0.0.1:${port}`],
      [LEGACY_AGENT_OS_KEYS[1], 'smoke'],
      [LEGACY_AGENT_OS_KEYS[2], 'smoke-token']
    ])
    dreamer.result = {
      file: structuredClone(DREAMER_FIXTURE),
      digest: null,
      selected: ['speed-bash'],
      model: 'fixture'
    }
    host.emit('menu', { action: 'dreamer-review' })
    const overview = await until(
      (s: any) => s.visible && s.title === 'Dreamer Proposals' && s.section === 'overview'
    )
    assert.ok(!overview.actions.includes('send'), 'no Send to Agent OS')
    assert.ok(overview.actions.includes('export') && overview.actions.includes('copy-json'))
    assert.equal(overview.defaultAction, 'export', 'Return runs Export…')
    assert.ok(!overview.fields.includes('target') && !overview.fields.includes('sent'))
    const state = dreamer.sheets.current?.state
    assert.ok(state, 'the review window state')
    assert.deepEqual(
      state.actions.filter((a) => a.primary).map((a) => a.id),
      ['export'],
      'Export… is the only primary action'
    )
    const overviewText = JSON.stringify([
      state.sections?.find((s) => s.id === 'overview'),
      state.fields.filter((f) => f.section === 'overview'),
      state.actions.filter((a) => a.section === 'overview')
    ])
    assert.doesNotMatch(overviewText, /Agent OS|\bsen[dt]\b/i)
    await capture('dreamer-review.png')

    // Export…: the save panel (stubbed here) and the selected proposals in a zip.
    const picked: string[] = []
    const zip = join(out, 'Dreamer Report.zip')
    dreamer.host.pickExport = async (name) => {
      picked.push(name)
      return zip
    }
    await host.request('sheetPerform', { action: 'export' })
    const exported = await until((s: any) => !s.busy && /Exported the report to/.test(s.message))
    assert.match(picked[0], /^Dreamer Report \d{4}-\d{2}-\d{2}\.zip$/)
    assert.doesNotMatch(exported.message, /Agent OS|Not sent|instead/)
    const unzipped = join(out, 'unzipped')
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, unzipped])
    const archive = readdirSync(join(unzipped, 'Dreamer Report')).sort()
    assert.deepEqual(archive, ['evidence.json', 'proposals.json', 'report.md'])
    const proposals = JSON.parse(
      readFileSync(join(unzipped, 'Dreamer Report', 'proposals.json'), 'utf8')
    )
    assert.deepEqual(
      proposals.proposals.map((p: { id: string }) => p.id),
      ['speed-bash'],
      'only the selected proposal is exported'
    )

    // Cancel: no file, no message.
    const before = readdirSync(out).sort()
    dreamer.host.pickExport = async (name) => {
      picked.push(name)
      return null
    }
    await host.request('sheetPerform', { action: 'export' })
    const cancelled = await until((s: any) => !s.busy && picked.length === 2 && !s.message)
    assert.deepEqual(readdirSync(out).sort(), before, 'a cancelled export writes nothing')
    assert.equal(requests.length, 0, 'no request reaches Agent OS')
    writeFileSync(
      join(artifacts, 'dreamer-export.json'),
      JSON.stringify({ overview, exported, cancelled, picked, archive, requests }, null, 2)
    )
    // A proposal's own pane: editable fields and its evidence.
    dreamer.review('p:repeated-failure')
    const detail = await until((s: any) => s.visible && s.section === 'p:repeated-failure')
    assert.ok(detail.fields.includes('title:repeated-failure'))
    await capture('dreamer-proposal.png')
    writeFileSync(
      join(artifacts, 'dreamer-review.json'),
      JSON.stringify({ captures, detail }, null, 2)
    )
    await host.request('sheetPerform', { action: 'closeWindow' })
  } finally {
    dreamer.host.pickExport = pickExport
    server.close()
    rmSync(out, { recursive: true, force: true })
    await dreamer.preferences.apply(saved).catch(() => {})
  }
}
