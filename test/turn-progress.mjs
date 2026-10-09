import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { runProviderHelper, setHelperHeartbeat } from '../src/main/backends/helper-host.ts'
import { CHARS_PER_TOKEN, streamedChars, streamUsage } from '../src/main/backends/stream-usage.ts'
import { swiftBuild } from './helpers/swift-build.mjs'

// LKM-147: live turn progress below the UI — the streamed token estimate, the
// helper's heartbeat and the status line's clock.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Streamed usage: a throttled estimate between Claude's cumulative reports,
// never counting anything twice.
{
  let clock = 0
  const sent = []
  const usage = streamUsage(
    (delta) => sent.push(delta),
    250,
    () => clock
  )
  const total = () =>
    sent.reduce(
      (sum, d) => ({
        input: sum.input + d.input,
        output: sum.output + d.output,
        cached: sum.cached + d.cached
      }),
      { input: 0, output: 0, cached: 0 }
    )
  usage.start()
  usage.report({ input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 1 })
  assert.deepEqual(
    total(),
    { input: 1000, output: 1, cached: 100 },
    'message_start counts the input side'
  )
  clock = 1000
  usage.streamed(40)
  assert.equal(total().output, 10, 'streamed characters grow the output live')
  clock = 1100
  usage.streamed(400)
  assert.equal(total().output, 10, 'the estimate is throttled')
  clock = 1300
  usage.streamed(4)
  assert.equal(
    total().output,
    Math.floor(444 / CHARS_PER_TOKEN),
    'the held-back characters count at the next report'
  )
  const before = sent.length
  usage.report({ input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 50 })
  assert.equal(sent.length, before, 'a report under the estimate adds nothing')
  usage.report({ input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 160 })
  assert.deepEqual(
    total(),
    { input: 1000, output: 160, cached: 100 },
    'the authoritative report adds only the rest'
  )
  usage.report({ input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 160 })
  assert.deepEqual(
    total(),
    { input: 1000, output: 160, cached: 100 },
    'a repeated report counts nothing twice'
  )
  usage.start()
  usage.report({ input_tokens: 50, output_tokens: 2 })
  assert.deepEqual(
    total(),
    { input: 1050, output: 162, cached: 100 },
    'the next request counts from zero again'
  )
  usage.streamed(0)
  assert.equal(total().output, 162)

  assert.equal(
    streamedChars({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'héllo' } }),
    5
  )
  assert.equal(
    streamedChars({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'abc' }
    }),
    3
  )
  assert.equal(
    streamedChars({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '{"a":1}' }
    }),
    7
  )
  assert.equal(
    streamedChars({
      type: 'content_block_delta',
      delta: { type: 'signature_delta', signature: 'xyz' }
    }),
    0
  )
  assert.equal(streamedChars({ type: 'message_stop' }), 0)
  assert.equal(streamedChars(undefined), 0)
  console.log('Turn progress: streamed usage estimate, throttle, running max and reset passed.')
}

// The helper beats while a turn is open — through a long silent tool run — and
// stops when it ends.
{
  setHelperHeartbeat(40)
  const input = new PassThrough(),
    output = new PassThrough()
  const frames = []
  let buffer = ''
  output.on('data', (chunk) => {
    const lines = (buffer + chunk).split('\n')
    buffer = lines.pop()
    for (const line of lines) frames.push(JSON.parse(line))
  })
  let emit
  const provider = {
    id: 'fake',
    startSession: async (root, options, _prompt, ctx) => {
      emit = (event) => ctx.onEvent(event)
      return {
        key: root,
        root,
        options,
        pending: new Map(),
        emit: () => {},
        record: { transcript: [], filesTouched: [] },
        send: () => emit({ type: 'status', text: 'Running bun test' }),
        finalize() {},
        dispose() {},
        shutdown() {}
      }
    }
  }
  let exited
  runProviderHelper(
    { fake: provider },
    {
      input,
      output,
      exit: (code) => {
        exited = code
      }
    }
  )
  const frame = (value) => input.write(`${JSON.stringify(value)}\n`)
  const beats = () => frames.filter((f) => f.type === 'event' && f.event.type === 'progress')
  frame({ type: 'send', text: 'too early' })
  await sleep(150)
  assert.equal(beats().length, 0, 'no session, no heartbeat')
  frame({ type: 'open', provider: 'fake', root: '/fixture', options: {} })
  await sleep(20)
  assert.ok(frames.some((f) => f.type === 'ready'))
  await sleep(150)
  assert.equal(beats().length, 0, 'an idle session does not beat')
  frame({ type: 'send', text: 'run the tests' })
  await sleep(400)
  const during = beats().length
  assert.ok(during >= 5, `beats through a silent tool run (${during})`)
  assert.ok(
    beats().every((f) => Object.keys(f.event).join() === 'type'),
    'a heartbeat names no step'
  )
  emit({ type: 'done' })
  const atDone = beats().length
  await sleep(200)
  assert.equal(beats().length, atDone, 'no heartbeat after the turn ends')
  frame({ type: 'send', text: 'again' })
  await sleep(200)
  assert.ok(beats().length > atDone, 'the next turn beats again')
  emit({ type: 'error', message: 'failed' })
  const atError = beats().length
  await sleep(200)
  assert.equal(beats().length, atError, 'an error ends the heartbeat too')
  frame({ type: 'send', text: 'last' })
  await sleep(100)
  frame({ type: 'shutdown' })
  await sleep(50)
  const atStop = beats().length
  await sleep(200)
  assert.equal(beats().length, atStop, 'stopping the helper ends the heartbeat')
  assert.equal(exited, 0)
  setHelperHeartbeat(5000)
  console.log(
    `Turn progress: helper heartbeat (${during} beats in 400 ms at 40 ms) only while a turn is open passed.`
  )
}

// The status line's clock: the step's elapsed time, and the idle hint only once
// heartbeats stopped for a minute.
if (process.platform !== 'darwin') {
  console.log('TURN-PROGRESS CLOCK SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('activity-clock', [
    'src/native/ChatActivityClock.swift',
    'test/fixtures/activity-clock/main.swift'
  ])
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 180_000 })
  assert.equal(
    result.status,
    0,
    `${binary}: ${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`
  )
  const shown = Object.fromEntries(
    JSON.parse(result.stdout).map(({ case: name, ...rest }) => [name, rest.label ?? rest.idle])
  )
  assert.equal(shown.fresh, 'Thinking…', 'a step just started shows no timer')
  assert.equal(shown.thinking, 'Thinking · 0:45')
  assert.equal(shown.tool, 'Running bun test · 1:24')
  assert.equal(shown.hour, 'Running bun test · 1:02:05')
  assert.equal(shown.unstamped, 'Writing…')
  assert.equal(shown.beating, '', 'no hint while heartbeats arrive')
  assert.equal(shown.almost, '', 'no hint under a minute')
  assert.equal(shown.stopped, 'No activity for 1 min')
  assert.equal(shown.long, 'No activity for 3 min')
  assert.equal(shown.none, '')
  console.log(
    'Turn progress: status clock (m:ss, h:mm:ss, 2 s threshold) and idle hint (60 s without heartbeats) passed.'
  )
}
