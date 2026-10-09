import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const calls = [],
  renders = [],
  effects = []
const context = (chat) => ({
  chat,
  root: '/fixture',
  selection: null,
  turn: {},
  setup: { needed: false, dismissed: false, status: null },
  tokens: { needed: false, dismissed: false },
  notes: [],
  spawns: []
})
const live = (chat) => ({
  sessionKey: chat,
  record: { transcript: [], title: 'Restored' },
  isRunning: false,
  options: { provider: 'codex', permissionMode: 'auto' }
})
let snapshot = { projects: [{ root: '/fixture', chats: [live('a'), live('b')] }] }
let rejectModel = false,
  failSend = false
const controller = new NativeChatController({
  invoke: async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'agent:workspace-snapshot') return snapshot
    if (channel === 'providers:choices')
      return [
        {
          value: 'codex:default',
          modelId: 'default',
          provider: 'codex',
          group: 'Codex',
          label: 'Default'
        },
        {
          value: 'codex:other',
          modelId: 'other',
          provider: 'codex',
          group: 'Codex',
          label: 'Other model'
        }
      ]
    if (channel === 'agent:restart-chat')
      return { ok: !rejectModel, error: rejectModel ? 'Cannot restart' : undefined }
    if (channel === 'agent:send' && failSend) throw new Error('Provider unavailable')
    return { ok: true }
  },
  render: (state) => renders.push(structuredClone(state)),
  effect: (effect) => effects.push(structuredClone(effect))
})
await controller.refreshChoices()
await controller.command({ type: 'context', context: context('a') })
assert.equal(controller.get('a').settings.provider, 'codex')
let rev = 0
const input = (text, chat = controller.active) =>
  controller.composer({ chat, action: 'input', text, caret: text.length, revision: ++rev })
const send = () => controller.composer({ chat: controller.active, action: 'send' })
const emit = (event) => controller.event({ projectKey: 'a', ...event })
await input('draft for a')
await controller.command({ type: 'context', context: context('b') })
await input('draft for b')
await controller.composer({
  chat: 'a',
  action: 'input',
  text: 'stale event',
  caret: 11,
  revision: 100
})
assert.equal(controller.get('a').text, 'draft for a')
await controller.command({ type: 'context', context: context('a') })
assert.equal(renders.at(-1).composer.text, 'draft for a')
emit({
  type: 'commands',
  commands: [{ name: 'design', description: 'Design skill', source: 'project' }]
})
await input('/des')
assert.equal(renders.at(-1).composer.suggestions[0].title, '/design')
await controller.composer({ chat: 'a', action: 'key', key: 'Tab' })
assert.equal(controller.get('a').text, '/design ')
assert.equal(renders.at(-1).composer.suggestions.length, 0)
controller.get('a').context.turn = { projectUi: true, projectUiEngine: 'agent' }
await input('First')
await send()
await tick()
assert.equal(calls.filter((c) => c[0] === 'agent:send').length, 1)
assert.equal(controller.get('a').text, '')
assert.equal(controller.get('a').isRunning, true)
assert.equal(renders.at(-1).composer.running, true)
assert.equal(renders.at(-1).composer.stop, true)
assert.equal(renders.at(-1).composer.thinking, true)
assert.equal(renders.at(-1).activity.label, 'Thinking…')
emit({ type: 'delta', text: 'Before' })
assert.equal(renders.at(-1).activity.kind, 'writing')
const beforeBurst = renders.length
emit({ type: 'delta', text: ' ✨' })
emit({ type: 'delta', text: ' café' })
assert.equal(renders.length, beforeBurst, 'Text bursts should share a render')
emit({ type: 'status', text: 'Reading' })
assert.equal(renders.at(-1).activity.label, 'Reading')
assert.equal(
  renders.at(-1).messages.at(-1).text,
  'Before ✨ café',
  'Status must flush pending text'
)
emit({ type: 'delta', text: 'After' })
assert.deepEqual(
  controller
    .get('a')
    .messages.at(-1)
    .segments.map((s) => s.kind),
  ['text', 'tools', 'text']
)
emit({ type: 'delta', text: 'DETACHED', sessionId: 'spawn' })
assert.equal(controller.get('a').messages.at(-1).text, 'Before ✨ caféAfter')
controller.get('a').context.turn = { projectUi: true, projectUiEngine: 'jev' }
await input('Second')
assert.equal(renders.at(-1).composer.running, true)
assert.equal(renders.at(-1).composer.stop, false)
assert.equal(renders.at(-1).composer.thinking, true)
await send()
assert.equal(controller.get('a').queue.length, 1)
assert.deepEqual(calls.filter((c) => c[0] === 'agent:send')[0][4], {
  projectUi: true,
  projectUiEngine: 'agent'
})
controller.get('a').context.turn = { projectUi: false, projectUiEngine: 'agent' }
assert.deepEqual(controller.get('a').queue[0].turn, { projectUi: true, projectUiEngine: 'jev' })
assert.equal(renders.at(-1).composer.queue[0].text, 'Second')
assert.ok(!renders.at(-1).cards.some((card) => card.id.startsWith('queued-')))
await controller.command({ type: 'context', context: context('b') })
emit({ type: 'done', landingPending: true })
await tick()
assert.equal(calls.filter((c) => c[0] === 'agent:send').length, 1)
emit({ type: 'landing-finished' })
await tick()
assert.equal(calls.filter((c) => c[0] === 'agent:send').length, 2)
assert.equal(calls.filter((c) => c[0] === 'agent:send').at(-1)[3], 'a')
assert.deepEqual(calls.filter((c) => c[0] === 'agent:send').at(-1)[4], {
  projectUi: true,
  projectUiEngine: 'jev'
})
assert.equal(renders.at(-1).chat, 'b')
await controller.command({
  type: 'context',
  context: { ...context('a'), turn: { projectUi: false, projectUiEngine: 'jev' } }
})
await input('Third')
await send()
await controller.action({ chat: 'a', action: 'stop' })
assert.equal(renders.at(-1).composer.thinking, false)
assert.equal(renders.at(-1).activity.kind, 'stopping')
assert.deepEqual(calls.at(-1), ['agent:interrupt', 'a'])
emit({ type: 'done' })
await tick()
assert.equal(controller.get('a').queue.length, 1)
await controller.action({ chat: 'a', action: 'queue-resume' })
await tick()
assert.equal(controller.get('a').queue.length, 0)
assert.deepEqual(calls.filter((c) => c[0] === 'agent:send').at(-1)[4], {
  projectUi: false,
  projectUiEngine: 'jev'
})
emit({ type: 'error', message: 'failed' })
emit({ type: 'done' })
await tick()
assert.equal(controller.get('a').paused, true)
assert.equal(renders.at(-1).composer.running, false)
assert.equal(renders.at(-1).composer.thinking, false)
assert.equal(renders.at(-1).activity, null)
assert.equal(renders.at(-1).composer.ready, true)
emit({
  type: 'permission-request',
  request: { id: 'p', sessionKey: 'a', title: 'Allow?', toolName: 'Read' }
})
const before = calls.length
await controller.action({ chat: 'b', action: 'permission', id: 'p', value: 'allow' })
assert.equal(calls.length, before)
await controller.action({ chat: 'a', action: 'permission', id: 'p', value: 'deny' })
assert.equal(controller.get('a').permissions.length, 0)
emit({ type: 'question-request', request: { id: 'q', sessionKey: 'a', questions: [] } })
await controller.action({ chat: 'a', action: 'question', id: 'q', answers: null })
assert.deepEqual(calls.at(-1), ['agent:respond-question', 'q', null])
await controller.composer({
  chat: 'a',
  action: 'choice',
  label: 'Permission mode',
  value: 'default'
})
assert.deepEqual(calls.at(-1), ['agent:set-permission-mode', 'default', 'a'])
assert.equal(controller.get('a').settings.permissionMode, 'default')
await controller.composer({ chat: 'a', action: 'choice', label: 'Model', value: 'codex:other' })
assert.ok(controller.get('a').pendingModel)
rejectModel = true
await controller.action({ chat: 'a', action: 'model-confirm' })
assert.equal(controller.get('a').settings.model, 'default')
assert.match(controller.get('a').error, /Cannot restart/)
assert.equal(controller.get('a').switching, false)
rejectModel = false
await controller.composer({ chat: 'a', action: 'choice', label: 'Model', value: 'codex:other' })
await controller.action({ chat: 'a', action: 'model-confirm' })
assert.equal(controller.get('a').settings.model, 'codex:other')
// Queued context is immutable when the selection/draft/project changes.
const selected = context('a')
selected.selection = {
  label: 'button',
  prompt: 'Selected button. ',
  bubble: { tag: 'button', ident: '#save', source: null }
}
await controller.command({ type: 'context', context: selected })
await input('With context')
await send()
await tick()
assert.equal(calls.filter((c) => c[0] === 'agent:send').at(-1)[1], 'Selected button. With context')
await input('Never send after close')
await send()
const count = calls.filter((c) => c[0] === 'agent:send').length
controller.close('a')
emit({ type: 'done' })
await tick()
assert.equal(calls.filter((c) => c[0] === 'agent:send').length, count)
// Transcripts initialize from the service, with no React/window object present.
snapshot.projects[0].chats.push({
  ...live('restored'),
  record: {
    transcript: [
      { role: 'user', text: 'Prior message' },
      { role: 'assistant', text: 'Prior reply' }
    ]
  }
})
await controller.command({ type: 'context', context: context('restored') })
assert.deepEqual(
  controller.get('restored').messages.map((m) => m.text),
  ['Prior message', 'Prior reply']
)
failSend = true
await input('Fail this')
await send()
await tick()
assert.equal(controller.get('restored').isRunning, false)
assert.match(controller.get('restored').messages.at(-1).text, /Provider unavailable/)
console.log(
  'Native Bun chat controller: drafts, skills, restore, stream isolation, queues, cancellation, permissions, questions, models, context and errors passed.'
)

// Stop during clipboard materialization must prevent the provider call.
let resolveAttachment
const attachmentReady = new Promise((resolve) => {
  resolveAttachment = resolve
})
const invokeBeforeAttachment = controller.services.invoke
failSend = false
controller.services.invoke = (channel, ...args) =>
  channel === 'attachments:save' ? attachmentReady : invokeBeforeAttachment(channel, ...args)
await controller.composer({
  chat: 'restored',
  action: 'files',
  files: [{ name: 'clipboard.png', path: '', type: 'image/png', data: 'AA==' }]
})
assert.deepEqual(renders.at(-1).composer.attachments, [
  {
    id: controller.get('restored').attachments[0].id,
    name: 'clipboard.png',
    type: 'image/png',
    data: 'AA=='
  }
])
await input('Clipboard')
await send()
const sendCount = calls.filter((c) => c[0] === 'agent:send').length
await controller.action({ chat: 'restored', action: 'stop' })
resolveAttachment('/tmp/clipboard.png')
await tick()
assert.equal(calls.filter((c) => c[0] === 'agent:send').length, sendCount)
assert.equal(controller.get('restored').isRunning, false)
controller.services.invoke = invokeBeforeAttachment
// Renderer reload can reattach a fresh mirror without losing native drafts.
await input('Survives renderer reload')
const effectCount = effects.filter((e) => e.type === 'mirror').length
await controller.command({ type: 'attach' })
assert.ok(effects.filter((e) => e.type === 'mirror').length > effectCount)
assert.equal(controller.get('restored').text, 'Survives renderer reload')
// A delayed snapshot for a closed instance cannot initialize a replacement chat.
const delayed = []
const racing = new NativeChatController({
  invoke: () => new Promise((resolve) => delayed.push(resolve)),
  render() {},
  effect() {}
})
const first = racing.command({ type: 'context', context: context('a') })
racing.close('a')
const second = racing.command({ type: 'context', context: context('a') })
delayed[0]({
  projects: [
    {
      root: '/fixture',
      chats: [{ ...live('a'), record: { transcript: [{ role: 'user', text: 'stale' }] } }]
    }
  ]
})
await first
assert.equal(racing.get('a').ready, false)
delayed[1]({ projects: [{ root: '/fixture', chats: [live('a')] }] })
await second
assert.equal(racing.get('a').ready, true)
assert.deepEqual(racing.get('a').messages, [])
console.log(
  'Native controller: root scoping, clipboard cancellation, renderer reattach and close/reopen race passed.'
)

// Usage is counted per turn on its response (cached input is a subset, not
// additional usage); the chat total stays in the mirror and the tooltip. There
// is no pinned status line any more (LKM-141); the running turn's counter rides
// on its live status and is gone once the turn ends (LKM-145/147).
{
  const { snapshot: usageSnapshot } = await import('../src/native/chat-snapshot.ts')
  const {
    newChat: usageNew,
    reduce: usageReduce,
    assistant: usageAssistant
  } = await import('../src/native/chat-state.ts')
  const usageChat = usageNew('usage')
  usageChat.usage = { input: 1000, output: 10, cached: 0 }
  usageChat.messages.push({
    id: 'earlier',
    role: 'assistant',
    text: 'Earlier',
    segments: [],
    statuses: []
  })
  usageChat.isRunning = true
  usageAssistant(usageChat) // the response `run()` opens with the turn
  usageReduce(usageChat, { type: 'usage', input: 1000000, output: 3000, cached: 1200000 })
  usageReduce(usageChat, { type: 'usage', input: 388777, output: 491, cached: 0 })
  const running = usageSnapshot(usageChat, [])
  assert.equal('status' in running, false, 'No pinned status counter')
  const live = running.activity.tokens
  assert.equal(live.label, '↑ 1.4M  ↓ 3.5k', 'Running turn counts its own tokens')
  assert.match(live.detail, /not current context size/)
  assert.match(live.detail, /Input: 1,388,777/)
  assert.match(live.detail, /Cached input \(included above\): 1,200,000/)
  assert.match(live.detail, /Output: 3,491/)
  assert.match(live.detail, /This chat so far: 1,389,777 input, 3,501 output/)
  assert.ok(
    running.messages.every((m) => !('tokens' in m)),
    'Messages carry no counter of their own'
  )
  assert.equal(running.activity.label, 'Thinking…')
  // Streamed usage deltas grow the live counter between reports (LKM-147).
  usageReduce(usageChat, { type: 'usage', input: 0, output: 1500, cached: 0 })
  assert.equal(usageSnapshot(usageChat, []).activity.tokens.label, '↑ 1.4M  ↓ 5.0k')
  usageReduce(usageChat, { type: 'done' })
  // A report after done belongs to the response that just finished.
  usageReduce(usageChat, { type: 'usage', input: 1, output: 9, cached: 0 })
  const done = usageSnapshot(usageChat, [])
  assert.equal(done.activity, null, 'No status line and no counter once the turn ends')
  assert.ok(done.messages.every((m) => !('tokens' in m)))
  assert.deepEqual(done.messages.at(-1).usage, { input: 1388778, output: 5000, cached: 1200000 })

  // Usage before any response exists never creates an empty message. A turn
  // that ends with no text or status leaves none behind, but still counts in
  // the chat total; one that does start a response carries the usage.
  const quiet = usageNew('quiet')
  quiet.isRunning = true
  usageReduce(quiet, { type: 'usage', input: 5, output: 7, cached: 0 })
  assert.equal(quiet.messages.length, 0, 'Usage alone creates no message')
  usageReduce(quiet, { type: 'done' })
  assert.equal(quiet.messages.length, 0, 'A turn with no output leaves no empty assistant message')
  assert.deepEqual(
    quiet.usage,
    { input: 5, output: 7, cached: 0 },
    'The chat total still counts it'
  )
  assert.equal(usageSnapshot(quiet, []).messages.length, 0)
  const early = usageNew('early')
  early.isRunning = true
  usageReduce(early, { type: 'usage', input: 5, output: 7, cached: 0 })
  usageReduce(early, { type: 'delta', text: 'Hello' })
  assert.deepEqual(
    early.messages[0].usage,
    { input: 5, output: 7, cached: 0 },
    'Early usage lands on the response once it exists'
  )
  assert.equal(usageSnapshot(early, []).activity.tokens.label, '↑ 5  ↓ 7')
  const waiting = usageNew('waiting')
  waiting.isRunning = true
  usageReduce(waiting, { type: 'usage', input: 3, output: 4, cached: 0 })
  assert.equal(
    usageSnapshot(waiting, []).activity.tokens.label,
    '↑ 3  ↓ 4',
    'Usage before any response still shows'
  )
}

// One status line with a step clock; heartbeats only keep it alive (LKM-147).
{
  const { snapshot: progressSnapshot } = await import('../src/native/chat-snapshot.ts')
  const {
    newChat: progressNew,
    reduce: progressReduce,
    begin
  } = await import('../src/native/chat-state.ts')
  const turn = progressNew('progress')
  turn.isRunning = true
  begin(turn, 1000)
  let shown = progressSnapshot(turn, []).activity
  assert.deepEqual(
    [shown.kind, shown.label, shown.since, shown.aliveAt],
    ['thinking', 'Thinking…', 1000, 1000]
  )
  progressReduce(turn, { type: 'progress' }, 6000)
  shown = progressSnapshot(turn, []).activity
  assert.deepEqual(
    [shown.label, shown.since, shown.aliveAt],
    ['Thinking…', 1000, 6000],
    'A heartbeat renews liveness, not the step'
  )
  assert.equal(turn.messages.length, 0, 'A heartbeat never enters the transcript')
  progressReduce(turn, { type: 'progress', step: 'Still thinking…' }, 7000)
  shown = progressSnapshot(turn, []).activity
  assert.deepEqual(
    [shown.label, shown.since],
    ['Still thinking…', 1000],
    'The owner’s step replaces the label; its timer keeps going'
  )
  assert.equal(turn.messages.length, 0, 'No duplicate "Still thinking…" row')
  progressReduce(turn, { type: 'status', text: 'Running bun test' }, 9000)
  shown = progressSnapshot(turn, []).activity
  assert.deepEqual(
    [shown.kind, shown.label, shown.since, shown.aliveAt],
    ['working', 'Running bun test', 9000, 9000],
    'A tool starts its own step'
  )
  progressReduce(turn, { type: 'progress' }, 90000)
  shown = progressSnapshot(turn, []).activity
  assert.deepEqual(
    [shown.label, shown.since, shown.aliveAt],
    ['Running bun test', 9000, 90000],
    'A long tool run keeps its step while beating'
  )
  progressReduce(turn, { type: 'delta', text: 'Done' }, 91000)
  shown = progressSnapshot(turn, []).activity
  assert.deepEqual([shown.kind, shown.since], ['writing', 91000])
  progressReduce(turn, { type: 'delta', text: ' now' }, 95000)
  assert.equal(
    progressSnapshot(turn, []).activity.since,
    91000,
    'More text continues the writing step'
  )
  progressReduce(turn, { type: 'done' }, 96000)
  assert.equal(progressSnapshot(turn, []).activity, null)
  // A heartbeat that races the end is dropped by the controller.
  const beats = []
  const quiet = new NativeChatController({
    invoke: async () => ({ ok: true }),
    render: (state) => beats.push(state),
    effect() {}
  })
  quiet.get('q').isRunning = false
  quiet.event({ projectKey: 'q', type: 'progress' })
  assert.equal(quiet.get('q').needsReview, false, 'A stray heartbeat after the turn flags nothing')
  assert.equal(beats.length, 0)
}

// Running includes landing and user waits; those must not imply active thinking.
const { newChat, reduce } = await import('../src/native/chat-state.ts')
const { snapshot: viewState } = await import('../src/native/chat-snapshot.ts')
const phaseChat = newChat('phases')
phaseChat.ready = true
phaseChat.text = 'An idle draft'
assert.equal(viewState(phaseChat, []).composer.thinking, false)
phaseChat.isRunning = true
reduce(phaseChat, {
  type: 'permission-request',
  request: { id: 'permission', sessionKey: 'phases', title: 'Allow?' }
})
assert.equal(viewState(phaseChat, []).activity.label, 'Waiting for approval')
assert.equal(viewState(phaseChat, []).composer.thinking, false)
reduce(phaseChat, { type: 'permission-resolved', id: 'permission' })
assert.equal(viewState(phaseChat, []).composer.thinking, true)
reduce(phaseChat, {
  type: 'question-request',
  request: { id: 'question', sessionKey: 'phases', questions: [] }
})
assert.equal(viewState(phaseChat, []).activity.label, 'Waiting for your answer')
assert.equal(viewState(phaseChat, []).composer.thinking, false)
reduce(phaseChat, { type: 'question-resolved', id: 'question' })
reduce(phaseChat, { type: 'done', landingPending: true })
assert.equal(viewState(phaseChat, []).activity.kind, 'applying')
assert.equal(viewState(phaseChat, []).composer.running, true)
assert.equal(viewState(phaseChat, []).composer.thinking, false)
reduce(phaseChat, { type: 'landing-finished' })
assert.equal(viewState(phaseChat, []).activity, null)
console.log(
  'Native activity: thinking, writing, tool status, waiting, stopping, landing and idle beam states passed.'
)

const batchedRenders = []
const batched = new NativeChatController({
  invoke: async () => ({}),
  render: (state) => batchedRenders.push(structuredClone(state)),
  effect: () => {}
})
batched.active = 'batch'
batched.get('batch').isRunning = true
batched.get('batch').ready = true
const token = (text) => batched.event({ type: 'delta', projectKey: 'batch', text })
token('first')
token(' second')
token(' third')
assert.equal(batchedRenders.length, 1)
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(batchedRenders.length, 2)
assert.equal(batchedRenders.at(-1).messages.at(-1).text, 'first second third')
token(' final')
batched.event({ type: 'done', projectKey: 'batch' })
assert.equal(batchedRenders.at(-1).messages.at(-1).text, 'first second third final')
assert.equal(batchedRenders.at(-1).activity, null)
const completedRenders = batchedRenders.length
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(batchedRenders.length, completedRenders, 'Completion cancels pending stream renders')
token(' late')
token(' pending')
batched.close('batch')
const closedRenders = batchedRenders.length
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(batchedRenders.length, closedRenders, 'Closed chat cannot receive a pending render')
console.log(
  'Native streaming: bounded render batches, lossless final flush and cancellation passed.'
)

phaseChat.paused = true
phaseChat.queue = [
  { id: 'one', text: 'First queued message', attachments: [], selection: null, turn: {} },
  {
    id: 'two',
    text: '',
    attachments: [{ id: 'file', name: 'image.png' }],
    selection: null,
    turn: {}
  }
]
const stacked = viewState(phaseChat, [])
assert.deepEqual(stacked.composer.queue, [
  { id: 'queued-one', text: 'First queued message', attachments: 0 },
  { id: 'queued-two', text: '', attachments: 1 }
])
assert.equal(stacked.composer.queuePaused, true)
assert.ok(
  !stacked.cards.some((card) => card.id === 'queue-paused' || card.id.startsWith('queued-'))
)
console.log('Native composer queue: ordered previews, attachment counts and paused state passed.')
controller.closed.delete('a')
for (const [outcome, branch, expected] of [
  ['applied', null, 'Comment applied.'],
  ['failed', null, 'Comment failed.'],
  ['cancelled', null, 'Comment cancelled.'],
  ['no-change', null, 'Comment finished without changes.'],
  ['review', 'trezi/comment-test', 'Comment finished — changes are ready for review.'],
  ['failed', 'trezi/comment-test', 'Comment failed. Partial changes are saved for review.']
]) {
  controller.event({
    type: 'spawn-finished',
    projectKey: 'a',
    sessionId: 'outcome-test',
    outcome,
    branch,
    origin: 'comment'
  })
  const message = controller.get('a').messages.at(-1)
  assert.equal(message.text, expected)
  assert.equal(message.revertGroup, outcome === 'applied' ? 'comment:outcome-test' : undefined)
  assert.equal(`${message.comment.title}.`, expected.split('. ')[0].replace(/\.?$/, '.'))
  assert.equal(message.comment.line, '')
}
// LKM-178: the collapsed row names the comment by its text; without it (older events),
// by the summary's first line. The detail holds the partial-changes note and summary.
controller.event({
  type: 'spawn-finished',
  projectKey: 'a',
  sessionId: 'labelled',
  outcome: 'failed',
  branch: 'trezi/comment-labelled',
  origin: 'comment',
  label: 'Make the heading blue',
  summary: 'Edited the heading.\nThe build failed.'
})
assert.deepEqual(controller.get('a').messages.at(-1).comment, {
  title: 'Comment failed',
  line: 'Make the heading blue',
  detail: 'Partial changes are saved for review.\n\nEdited the heading.\nThe build failed.'
})
controller.event({
  type: 'spawn-finished',
  projectKey: 'a',
  sessionId: 'unlabelled',
  outcome: 'no-change',
  branch: null,
  origin: 'comment',
  summary: '\n  The button is already blue.  \nNothing changed.'
})
assert.deepEqual(controller.get('a').messages.at(-1).comment, {
  title: 'Comment finished without changes',
  line: 'The button is already blue.',
  detail: '\n  The button is already blue.  \nNothing changed.'
})
assert.equal(
  controller.get('a').messages.at(-1).text,
  'Comment finished without changes.\n\n\n  The button is already blue.  \nNothing changed.'
)

// Timing belongs to a turn, not the lifetime of a chat; waits/landing are included.
const {
  newChat: timingChat,
  append: timingAppend,
  finish: timingFinish,
  hydrate: timingHydrate
} = await import('../src/native/chat-state.ts')
const timed = timingChat('timed')
timed.isRunning = true
timed.turnStartedAt = Date.now() - 104000
timingAppend(timed, 'Commentary', false, 1000)
timingAppend(timed, 'Read file', true)
timingAppend(timed, 'Result', false, 2000)
timingFinish(timed, true)
assert.equal(timed.messages[0].workedMs, undefined, 'Landing must not freeze elapsed time early')
timingFinish(timed)
assert(timed.messages[0].workedMs >= 104000)
const elapsed = timed.messages[0].workedMs
timingFinish(timed)
assert.equal(timed.messages[0].workedMs, elapsed, 'Duplicate completion must not overwrite timing')
assert.equal(timed.messages[0].segments[0].at, 1000)
assert.equal(timed.messages[0].segments[2].at, 2000)
timingHydrate(timed, [
  { role: 'user', text: 'Do it', at: 1000, completedAt: 105000 },
  { role: 'assistant', text: 'Done', at: 90000 },
  { role: 'user', text: 'Old history', at: 200000 },
  { role: 'assistant', text: 'Legacy', at: 210000 }
])
assert.equal(timed.messages[1].workedMs, 104000)
assert.equal(timed.messages[1].segments[0].at, 90000)
assert.equal(timed.messages[3].workedMs, undefined, 'Do not invent duration for legacy history')
console.log(
  'Native timing: landing, duplicate terminal, segment timestamps and persisted history passed.'
)

const { createRecordCapture } = await import('../src/main/backends/record.ts')
const capture = createRecordCapture('/tmp/timing', 'timing')
const actualNow = Date.now
try {
  Date.now = () => 1000
  capture.appendAssistant('First comment')
  Date.now = () => 5000
  capture.noteTool('Read', { path: 'file.ts' })
  Date.now = () => 9000
  capture.appendAssistant('Final comment')
  Date.now = () => 10000
  capture.finalize()
  assert.deepEqual(
    capture.record.transcript.map((entry) => entry.at),
    [1000, 5000, 9000]
  )
} finally {
  Date.now = actualNow
}
