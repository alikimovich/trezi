// LKM-200: every Trezi tool call is logged with its duration and phases, and each turn
// ends with one summary line (count and total ms per tool); the agent reads the same
// timing through workspace_state. Everything writes into a temporary log folder.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProductLog, readLogs } from '../src/main/product-log.ts'
import { formatPhases, notePhase, phase, timedToolCall } from '../src/main/tool-timing.ts'
import {
  formatToolSummary,
  summarizeTools,
  TOOL_LIMIT,
  TurnTimings,
  turnTimings
} from '../src/main/turn-timing.ts'

// The summary: count and total per tool, slowest first; `-` without calls.
assert.deepEqual(
  summarizeTools([
    { tool: 'preview_inspect', ms: 40 },
    { tool: 'preview_screenshot', ms: 210.4 },
    { tool: 'preview_inspect', ms: 35 },
    { tool: 'open_preview', ms: null }
  ]),
  [
    { tool: 'preview_screenshot', count: 1, ms: 210 },
    { tool: 'preview_inspect', count: 2, ms: 75 },
    { tool: 'open_preview', count: 1, ms: 0 }
  ]
)
assert.equal(
  formatToolSummary(
    summarizeTools([
      { tool: 'a', ms: 5 },
      { tool: 'b', ms: 9 },
      { tool: 'a', ms: 6 }
    ])
  ),
  'a:2/11ms,b:1/9ms'
)
assert.equal(formatToolSummary([]), '-')
assert.equal(
  formatPhases(
    new Map([
      ['page', 8.6],
      ['capture', 120]
    ])
  ),
  'page:9,capture:120'
)

// A turn on a fake clock: received → sent → tools → provider end → landing → completed.
{
  let now = 1_000
  const lines = []
  const timings = new TurnTimings(
    () => now,
    (message, fields) => lines.push({ message, fields })
  )
  timings.received('chat-1', 'turn-1', 990)
  now = 1_050
  timings.sent('chat-1', 'turn-1')
  now = 1_100
  const shot = timings.toolStarted('chat-1', 'preview_screenshot')
  assert.equal(shot.turn, 'turn-1')
  const running = timings.report('chat-1').current
  assert.equal(running.running, true)
  assert.deepEqual(running.tools, [{ tool: 'preview_screenshot', startedAfterMs: 110, ms: null }])
  shot.end(212.4, true)
  now = 1_400
  timings.toolStarted('chat-1', 'preview_inspect').end(31, true)
  timings.toolStarted('chat-1', 'preview_inspect').end(29, false)
  now = 2_000
  timings.providerEnded('chat-1', 'turn-1', 'done')
  timings.providerEnded('chat-1', 'turn-1', 'error')
  now = 2_300
  timings.landed('chat-1', 'merged', 3)
  now = 2_500
  timings.completed('chat-1', 'other-turn')
  assert.notEqual(timings.report('chat-1').current, null, 'another turn id does not end it')
  timings.completed('chat-1', 'turn-1')
  const report = timings.report('chat-1')
  assert.equal(report.current, null)
  assert.match(report.note, /Milliseconds from when Trezi received the message/)
  const { receivedAt, ...last } = report.last
  assert.equal(receivedAt, new Date(990).toISOString())
  assert.deepEqual(last, {
    turn: 'turn-1',
    running: false,
    totalMs: 1_510,
    sentAfterMs: 60,
    providerEndedAfterMs: 1_010,
    providerOutcome: 'done',
    landing: { outcome: 'merged', files: 3, afterMs: 1_310 },
    completedAfterMs: 1_510,
    tools: [
      { tool: 'preview_screenshot', startedAfterMs: 110, ms: 212 },
      { tool: 'preview_inspect', startedAfterMs: 410, ms: 31 },
      { tool: 'preview_inspect', startedAfterMs: 410, ms: 29, ok: false }
    ],
    toolSummary: [
      { tool: 'preview_screenshot', count: 1, ms: 212 },
      { tool: 'preview_inspect', count: 2, ms: 60 }
    ]
  })
  assert.deepEqual(
    lines.map((l) => l.message),
    ['Turn received', 'Turn timing']
  )
  assert.deepEqual(lines[1].fields, {
    chat: 'chat-1',
    turn: 'turn-1',
    end: 'completed',
    ms: 1_510,
    sentMs: 60,
    providerMs: 1_010,
    landingMs: 1_310,
    calls: 3,
    toolMs: 272,
    perTool: 'preview_screenshot:1/212ms,preview_inspect:2/60ms'
  })

  // A new message before the last one completed supersedes it (its line still logs).
  timings.received('chat-1', 'turn-2', now)
  timings.received('chat-1', 'turn-2', now)
  now = 2_600
  timings.received('chat-1', 'turn-3', now)
  assert.equal(lines.at(-1).message, 'Turn received')
  const superseded = lines.find((l) => l.fields.turn === 'turn-2' && l.message === 'Turn timing')
  assert.equal(superseded.fields.end, 'superseded')
  assert.equal(superseded.fields.perTool, '-')
  assert.equal(timings.report('chat-1').current.turn, 'turn-3')
  assert.equal(timings.report('chat-1').last.turn, 'turn-2')

  // Calls past the per-turn list limit still count in the summary.
  for (let i = 0; i < TOOL_LIMIT + 5; i++)
    timings.toolStarted('chat-1', 'preview_console').end(1, true)
  const busy = timings.report('chat-1').current
  assert.equal(busy.tools.length, TOOL_LIMIT)
  assert.deepEqual(busy.toolSummary, [
    { tool: 'preview_console', count: TOOL_LIMIT + 5, ms: TOOL_LIMIT + 5 }
  ])
  // A call outside any turn (a chat with no message in flight) is timed, never listed.
  assert.equal(timings.toolStarted('chat-idle', 'workspace_state').turn, undefined)
  assert.equal(timings.report('chat-idle').current, null)
  assert.equal(timings.report('chat-idle').last, null)
}

// The product log: one "Tool call" line per call with its phases, one "Turn timing" per turn.
const dir = mkdtempSync(join(tmpdir(), 'trezi-turn-timing-'))
try {
  initProductLog('backend', { TREZI_LOG_DIR: dir })
  turnTimings.received('chat-log', 'turn-log')
  turnTimings.sent('chat-log', 'turn-log')
  const answer = await timedToolCall('chat-log', 'preview_screenshot', async () => {
    await phase('page', () => new Promise((resolve) => setTimeout(resolve, 5)))
    notePhase('snapshot', 41.6)
    notePhase('encode', 'not a number')
    notePhase('transfer', 3)
    return { content: [] }
  })
  assert.deepEqual(answer, { content: [] })
  await timedToolCall('chat-log', 'open_preview', async () => ({ error: 'no server' }))
  await assert.rejects(
    timedToolCall('chat-log', 'preview_inspect', async () => {
      throw new Error('boom')
    }),
    /boom/
  )
  // Phases outside a call are no-ops.
  assert.equal(await phase('page', () => 7), 7)
  notePhase('snapshot', 1)
  turnTimings.completed('chat-log', 'turn-log')
  const logged = readLogs(dir, 60_000).join('\n')
  const call = (tool, ok) =>
    new RegExp(` tool chat=chat-log turn=turn-log Tool call tool=${tool} ms=\\d+ ok=${ok}`)
  assert.match(logged, call('preview_screenshot', true))
  assert.match(
    logged,
    / tool=preview_screenshot ms=\d+ ok=true phases=page:\d+,snapshot:42,transfer:3$/m
  )
  assert.match(logged, call('open_preview', false))
  assert.match(logged, call('preview_inspect', false))
  assert.match(
    logged,
    / chat chat=chat-log turn=turn-log Turn timing end=completed ms=\d+ sentMs=\d+ calls=3 toolMs=\d+ perTool=\S*preview_screenshot:1\/\d+ms/
  )
  // The turn's report lists the calls in order; arguments and answers are never logged.
  const last = turnTimings.report('chat-log').last
  assert.deepEqual(
    last.tools.map((t) => [t.tool, t.ok ?? true]),
    [
      ['preview_screenshot', true],
      ['open_preview', false],
      ['preview_inspect', false]
    ]
  )
  assert.doesNotMatch(logged, /no server|boom/)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(
  'TURN-TIMING OK — per-tool summary, turn lifecycle, supersede, limits, tool-call log lines'
)
