import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { DreamerFile } from '../shared/dreamer'
import type { NativeBridge } from './bridge'
import type { NativeDreamerController } from './dreamer-controller'
import { DREAMER_PROJECT_KEY, DREAMER_TOKEN_KEY, DREAMER_URL_KEY } from './dreamer-export'
import { inspectUntil } from './smoke-wait'

/**
 * LKM-202: the Dreamer's review window with a fixture result (no model run): it opens
 * from Trezi → Dreamer Proposals…, shows a proposal's pane, and Send to Agent OS posts
 * the selected proposals to a local stub and shows the task ids it answers.
 */

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
  const requests: { path: string; auth: string | null; body: any }[] = []
  // A local stand-in for Agent OS that answers like its proposal import.
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push({
        path: request.url ?? '',
        auth: request.headers.authorization ?? null,
        body: JSON.parse(body || 'null')
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ created: [{ proposal: 'speed-bash', issue: 'SMK-101', started: false }] })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await dreamer.preferences.apply([
      [DREAMER_URL_KEY, `http://127.0.0.1:${port}`],
      [DREAMER_PROJECT_KEY, 'smoke'],
      [DREAMER_TOKEN_KEY, 'smoke-token']
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
    assert.ok(overview.actions.includes('send') && overview.actions.includes('copy-json'))
    await capture('dreamer-review.png')
    await host.request('sheetPerform', { action: 'send' })
    const sent = await until((s: any) => !s.busy && /SMK-101/.test(s.message))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].path, '/api/projects/smoke/proposals')
    assert.equal(requests[0].auth, 'Bearer smoke-token')
    assert.deepEqual(
      requests[0].body.proposals.map((p: { id: string }) => p.id),
      ['speed-bash'],
      'only the selected proposal is sent'
    )
    writeFileSync(
      join(artifacts, 'dreamer-sent.json'),
      JSON.stringify({ overview, sent, requests }, null, 2)
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
    server.close()
    await dreamer.preferences
      .apply([
        [DREAMER_URL_KEY, null],
        [DREAMER_PROJECT_KEY, null],
        [DREAMER_TOKEN_KEY, null]
      ])
      .catch(() => {})
  }
}
