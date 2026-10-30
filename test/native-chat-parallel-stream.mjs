import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formatTimeline, streamSample, watchStream } from '../src/native/smoke-stream-timeline.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-383: the assertions of the native `parallel-stream` smoke check. Synthetic samples pin what
// fails and what a loaded host may do; a fixture hosting the real NativeChat offscreen feeds them
// real `inspect()` payloads while two chats stream: they pass, and with frames dropped
// (`messageFramesFilter` keeps none, the check's acceptance control) they fail with a clear message.

const noWait = async () => {}
const sampleOf = (over = {}) => ({
  label: 'step',
  t: 0,
  expected: 'chat-a',
  bunActive: 'chat-a',
  swiftChat: 'chat-a',
  visible: true,
  sidebar: true,
  inView: 2,
  realized: 3,
  swiftCount: 4,
  bunCount: 4,
  bunRow: 'reply',
  bunLast: 100,
  swiftLast: 100,
  settling: false,
  ...over
})
/** Replays samples 100 ms apart, then repeats the last one with time running on. */
const replay = (samples) => {
  let at = 0
  return async () => {
    const sample = { ...samples[Math.min(at, samples.length - 1)], t: at * 100 }
    at += 1
    return sample
  }
}
const watch = (samples, over = {}) =>
  watchStream({
    label: 'step',
    read: replay(samples),
    timeline: [],
    boundMs: 1000,
    holdMs: 300,
    sleep: noWait,
    ...over
  })

await watch([sampleOf()])
for (const [wrong, message] of [
  [{ swiftChat: 'chat-b' }, /step: Swift shows chat chat-b, not the active chat chat-a for 1\.0 s/],
  [{ bunActive: 'chat-b', swiftChat: 'chat-b' }, /Bun's active chat is chat-b, not chat-a/],
  [{ visible: false }, /the chat column is hidden/],
  [{ sidebar: false }, /the sidebar row of chat-a is not selected/],
  [{ inView: 0, realized: 0 }, /no message row in view \(.*0 realized, 4 of 4 rows in Swift\)/]
])
  await assert.rejects(watch([sampleOf(wrong)]), message)
// A chat without messages (a new one) has no row to show; the rest still counts.
await watch([sampleOf({ inView: 0 })], { rows: false })
await assert.rejects(watch([sampleOf({ visible: false })], { rows: false }), /column is hidden/)
// A switch may take the bound to settle, and a short blank is no failure; a run past it is.
const blank = sampleOf({ inView: 0 })
await watch([blank, blank, blank, blank, blank, sampleOf()])
await watch([sampleOf(), blank, blank, sampleOf(), blank, sampleOf()])
await assert.rejects(watch([sampleOf(), ...Array(12).fill(blank)]), /no message row in view/)
// The text: Swift trails a streaming Bun and reaches what Bun had; a stale row does not.
await watch([
  ...Array(4).fill(sampleOf({ swiftLast: 90 })),
  sampleOf({ swiftLast: 100, bunLast: 200 })
])
await assert.rejects(
  watch([sampleOf({ swiftLast: 90 })]),
  /step: Swift's last row has 90 characters and did not reach Bun's 100 within 1\.0 s/
)
// Bun's last row moved on: the target row is no longer the last, the next step checks the new one.
await watch([...Array(4).fill(sampleOf({ swiftLast: 90 })), sampleOf({ bunRow: 'next' })])

// streamSample reads Swift's row of Bun's last id, and the sidebar only when it has rows.
const payload = {
  chat: 'chat-a',
  visible: true,
  visibleMessageIDs: ['one'],
  realizedRows: 1,
  messageCount: 2,
  latestSettling: true,
  messages: [
    { id: 'reply', text: 'abc' },
    { id: 'later', text: 'something else' }
  ]
}
const bun = { active: 'chat-a', messages: [{ id: 'reply', text: 'abcdef' }] }
const selected = { sidebarChats: [{ id: 'chat:chat-a', selected: true }] }
assert.deepEqual(streamSample('step', 'chat-a', payload, selected, bun, 5), {
  label: 'step',
  t: 5,
  expected: 'chat-a',
  bunActive: 'chat-a',
  swiftChat: 'chat-a',
  visible: true,
  sidebar: true,
  inView: 1,
  realized: 1,
  swiftCount: 2,
  bunCount: 1,
  bunRow: 'reply',
  bunLast: 6,
  swiftLast: 3,
  settling: true
})
const sidebar = (shell) => streamSample('step', 'chat-a', payload, shell, bun).sidebar
assert.equal(sidebar({ sidebarChats: [{ id: 'chat:chat-b', selected: true }] }), false)
assert.equal(sidebar({ sidebarChats: [{ id: 'chat:chat-a', selected: false }] }), false)
assert.equal(sidebar({}), false)
assert.equal(sidebar({ sidebarCollapsed: true }), true)
assert.equal(streamSample('step', 'chat-a', payload, {}, { ...bun, messages: [] }).bunLast, -1)

// The failure text carries the timeline: labels, times, and only the newest samples.
const long = Array.from({ length: 60 }, (_, i) => sampleOf({ label: `s${i}`, t: i * 100 }))
const text = formatTimeline(long)
assert.match(text, /^Timeline \(last 40 of 60 samples\):\n\+2\.0s s20 expected=chat-a/)
assert.match(text, /\+5\.9s s59 .*inView=2 realized=3 rows=4\/4 last=100\/100 settling=false$/)
assert.equal(formatTimeline([]), 'Timeline (last 0 of 0 samples):')

// The check itself: no scratch output or env, and its cleanup runs after a failure.
const source = (path) => readFileSync(new URL(`../src/native/${path}`, import.meta.url), 'utf8')
const check = source('smoke-parallel-stream.ts')
assert.doesNotMatch(check + source('smoke-stream-timeline.ts'), /\/tmp|process\.env/)
assert.match(check, /parallel-stream-timeline\.json/)
assert.match(check, /formatTimeline\(timeline\)/)
assert.match(
  source('smoke-core.ts'),
  /name: 'parallel-stream',[\s\S]{0,120}cleanup: \(\) => restoreParallelStream\(host\)/
)
// Restored after the turns end, and the second chat closed last.
const restore = check.slice(check.indexOf('export async function restoreParallelStream'))
const order = ['endSharedTurn(', 'cleanSharedChat(', 'stub.restore()', "type: 'close-chat'"].map(
  (step) => restore.indexOf(step)
)
assert.ok(
  order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
  `${order}`
)

if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-PARALLEL-STREAM SKIP — fixture needs macOS AppKit')
} else {
  const sources = [
    'ChatCommentRow',
    'ChatLandingCheck',
    'ChatLiveChange',
    'ChatIncident',
    'ChatAgentCard',
    'ChatUiModel',
    'ChatUi',
    'ChatScrollStyle',
    'ChatLatestButton',
    'ChatEnvironment',
    'ChatReveal',
    'ChatIsland',
    'IslandEditing',
    'ShadowIsland',
    'ChatActivity',
    'ChatActivityClock',
    'Cat',
    'ChatDivider',
    'ChatMarkdown',
    'ChatRichText',
    'ChatTextView',
    'ChatQuestion',
    'SnappedSlider',
    'ChatAttachments',
    'AttachmentThumbnail',
    'Composer',
    'ComposerProject',
    'ComposerVerification',
    'ComposerAttachments',
    'ComposerQueue',
    'ComposerBeam',
    'ComposerSending',
    'ScrollerDrag',
    'Chat'
  ].map((name) => `src/native/${name}.swift`)
  const binary = swiftBuild('chat-parallel-stream', [
    'test/fixtures/chat-parallel-stream/main.swift',
    ...sources
  ])
  const { kept, dropped } = JSON.parse(runFixture(binary))
  const steps = (records) => [...new Set(records.map((record) => record.label))]
  const texts = (rows) => rows.map(({ id, length }) => ({ id, text: ' '.repeat(length) }))
  /** Plays one recorded step through the smoke's own watch; running out of samples is a failure. */
  const playStep = async (records, label, timeline, options) => {
    const left = records.filter((record) => record.label === label)
    await watchStream({
      label,
      timeline,
      sleep: noWait,
      read: async () => {
        const record = left.shift()
        assert.ok(record, `${label}: the recording ended before the step passed`)
        const { expected, chat, bun: side, t } = record
        return streamSample(
          label,
          expected,
          { ...chat, messages: texts(chat.messages) },
          { sidebarCollapsed: true },
          { active: side.active, messages: texts(side.messages) },
          t
        )
      },
      ...options
    })
  }

  // Both chats stream and switch: every step passes the smoke's assertions. The fixture's cap (30
  // s) is the bound; a loaded runner may take its time, the row must come.
  const timeline = []
  assert.deepEqual(steps(kept), [
    'a-streaming',
    'b-streaming',
    'to-a-0',
    'to-b-0',
    'to-a-1',
    'to-b-1',
    'done-b',
    'done-a'
  ])
  for (const label of steps(kept))
    await playStep(kept, label, timeline, { boundMs: 30_000, holdMs: 600 })
  assert.ok(
    timeline.every((sample) => sample.swiftChat === sample.expected),
    formatTimeline(timeline)
  )
  // The stream grew in both chats, so the check saw a running reply and not an empty row.
  for (const [label, chat] of [
    ['to-b-1', 'b'],
    ['to-a-1', 'a']
  ]) {
    const last = kept.filter((record) => record.label === label).at(-1)
    const reply = last.bun.messages.at(-1)
    assert.equal(reply.id, `${chat}-reply`, label)
    assert.ok(reply.length > 1000, `${label} streamed ${reply.length} characters`)
  }

  // A Chat.swift that drops frames fails on the first step, names the state and shows the timeline.
  assert.ok(
    dropped.every((record) => record.chat.visibleMessageIDs.length === 0),
    'Frames were dropped'
  )
  const failed = []
  await assert.rejects(
    playStep(dropped, 'a-streaming', failed, { boundMs: 600, holdMs: 300 }),
    /^Error: a-streaming: no message row in view \(chatInspect\.visibleMessageIDs is empty, 0 realized, 8 of 8 rows in Swift\) for 0\.6 s$/
  )
  assert.match(
    formatTimeline(failed),
    /a-streaming expected=a bun=a swift=a .* inView=0 realized=0/
  )
  console.log(
    `NATIVE-CHAT-PARALLEL-STREAM PASS — ${timeline.length} samples over ${steps(kept).length} steps; dropped frames fail with a clear message`
  )
}
