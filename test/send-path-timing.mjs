import assert from 'node:assert/strict'
import { sendPathStages, summarizeSendPath } from '../src/native/send-path-timing.ts'

const lines = [
  '2026-10-24T00:00:00.000Z debug app send-path host action=send stage=pressed uptimeNs=100',
  '2026-10-24T00:00:00.025Z debug service send-path service action=send stage=dequeued queueMs=15 uptimeNs=200',
  '2026-10-24T00:00:00.050Z debug backend send-path bun action=send stage=received uptimeNs=300',
  '2026-10-24T00:00:00.055Z debug backend chat Prompt text=private',
  '2026-10-24T00:00:00.060Z debug app send-path host action=code stage=pressed uptimeNs=400'
].join('\n')
const stages = sendPathStages(lines)
assert.equal(stages.length, 4)
assert.equal(stages[1].queueMs, 15)
assert.equal(stages[1].uptimeNs, 200n)
assert.deepEqual(
  stages.map((stage) => stage.action),
  ['send', 'send', 'send', 'code']
)
assert.equal(
  sendPathStages(
    'bad data\n2026-10-24T00:00:00Z debug app send-path action=send stage=pressed uptimeNs=oops'
  ).length,
  0
)
const summary = summarizeSendPath(stages, Date.parse('2026-10-24T00:00:00.020Z'))
assert.match(summary, /send:service:dequeued@5ms queue=15ms/)
assert.ok(!summary.includes('private'))
