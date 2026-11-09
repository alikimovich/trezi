// LKM-599: the inspector's Apply runs as its own background agent (a worktree spawn) and
// never waits for, steers or reuses the active chat. Drives the real installNativeInspector
// and NativeInspectorController with a chat held mid-turn, a recorded `agent:spawn-comment`
// seam (the backend's spawn, landing and conflict handling are covered by their own suites)
// and `spawn-finished` events delivered by hand. No desktop, provider or sleeps.
import assert from 'node:assert/strict'
import { setEditingOwner } from '../src/main/editing-owner.ts'
import { setSourceOwner } from '../src/main/source-owner.ts'
import { applyLabel, applyOutcome, applySummary } from '../src/native/inspector-apply.ts'
import { NativeInspectorController } from '../src/native/inspector-controller.ts'
import { installNativeInspector } from '../src/native/inspector-runtime.ts'
import { NativeView, serviceEvents } from '../src/native/platform.ts'

let hash = 'base'
let opacity = '1'
setSourceOwner({
  read: async (_root, file) => ({ path: file, hash, binary: false, size: 10 })
})
setEditingOwner({})
// The inspector's preview sends go through the in-process main view.
new NativeView('main')

const A = {
  tag: 'span',
  id: 'a',
  classes: [],
  source: '/p/src/card.tsx:3',
  componentSource: null,
  styles: {},
  selector: 'span#a',
  text: null,
  rect: { x: 0, y: 0, width: 10, height: 10 }
}
const B = { ...A, id: 'b', source: '/p/src/card.tsx:9', selector: 'span#b' }

const gate = () => {
  let open
  const promise = new Promise((resolve) => {
    open = resolve
  })
  return { promise, open }
}

let installed = null
const make = ({ spawn } = {}) => {
  if (installed) serviceEvents.removeAllListeners('event')
  const spawns = [],
    commands = []
  let next = 0
  // The interactive chat is mid-turn: Apply used to refuse with "Finish the current chat turn".
  const session = {
    ready: true,
    root: '/p',
    isRunning: true,
    queue: [],
    turn: 'chat-turn-1',
    settings: { provider: 'claude' }
  }
  const chat = {
    chats: new Map([['chat-1', session]]),
    active: 'chat-1',
    command: async (command) => commands.push(command),
    action: async () => {},
    services: { effect: () => {} }
  }
  const invoke = async (channel, ...args) => {
    if (channel === 'styles:read')
      return { values: { opacity, display: 'inline' }, specified: { opacity } }
    if (channel === 'controls:list') return []
    if (channel === 'agent:spawn-comment') {
      spawns.push(args)
      if (spawn) return spawn(args)
      return { ok: true, spawnId: `apply-${++next}` }
    }
    return null
  }
  const workspace = {
    state: {
      projects: [{ root: '/p', key: '/p', activeSessionKey: 'chat-1', sessionKeys: ['chat-1'] }],
      status: { kind: 'idle' }
    },
    active: { root: '/p', activeSessionKey: 'chat-1' },
    services: { invoke, render: () => {}, activate: async () => {} }
  }
  const context = { projects: new Map(), selection: () => {}, hideSelections: () => {} }
  const reports = []
  const { inspector } = installNativeInspector(
    { send: () => {}, on: () => {} },
    workspace,
    chat,
    context,
    async () => {},
    () => {},
    (error) => reports.push(String(error))
  )
  installed = inspector
  const act = (action, extra = {}) =>
    inspector.action({ root: '/p', generation: inspector.state.generation, action, ...extra })
  const finish = async (sessionId, event) => {
    serviceEvents.emit('event', 'agent:event', {
      type: 'spawn-finished',
      projectKey: 'chat-1',
      sessionId,
      branch: null,
      origin: 'text-edit',
      ...event
    })
    // The settle runs detached; let its source reads finish.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  return { inspector, session, spawns, commands, act, finish, reports }
}

const cases = []
const test = (name, run) => cases.push({ name, run })

test('Apply starts a background agent while the chat turn runs; the chat is untouched', async () => {
  const { inspector, session, spawns, commands, act, finish } = make()
  await inspector.activate('/p')
  await inspector.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  assert.equal(inspector.state.draft?.count, 1)
  await act('apply-drafts')
  assert.equal(spawns.length, 1, 'one background Apply')
  const [root, prompt, parent, options, origin, label, expectText, action] = spawns[0]
  assert.equal(root, '/p')
  assert.equal(parent, 'chat-1')
  assert.equal(origin, 'text-edit')
  assert.equal(options.permissionMode, undefined, 'the backend sets the spawn mode')
  // LKM-600: the user sees the change, not the selector, hash or instruction.
  assert.equal(label, 'Apply opacity: 0.4 on <span> in card.tsx:3')
  assert.equal(expectText, undefined)
  assert.deepEqual(action, {
    kind: 'inspector-apply',
    summary: 'opacity: 0.4 on <span> in card.tsx:3'
  })
  assert.match(prompt, /Target span#a from src\/card\.tsx:3\./)
  assert.match(prompt, /src\/card\.tsx \(staged against SHA-256 base\): set opacity to 0\.4/)
  assert.doesNotMatch(prompt, /\/p\//, 'no live absolute path reaches the agent')
  assert.equal(commands.length, 0, 'nothing submitted, seeded or stopped in the chat')
  assert.equal(session.turn, 'chat-turn-1')
  assert.equal(session.isRunning, true)
  assert.equal(inspector.state.draft?.submitted, true)
  assert.equal(inspector.state.error, '')
  // The edit lands: source hash moved and the page renders the value.
  hash = 'applied'
  opacity = '0.4'
  await finish('apply-1', { outcome: 'applied', files: ['card.tsx'] })
  assert.equal(inspector.state.draft, undefined, 'confirmed Apply clears its draft')
  assert.equal(commands.length, 0)
})

test('a double press dispatches once; Undo and Revert cannot rewrite the running Apply', async () => {
  const release = gate()
  const { inspector, spawns, act } = make({
    spawn: async () => {
      await release.promise
      return { ok: true, spawnId: 'apply-1' }
    }
  })
  await inspector.activate('/p')
  await inspector.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  const first = act('apply-drafts')
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  await act('apply-drafts')
  assert.equal(spawns.length, 1, 'a second press while dispatching starts nothing')
  release.open()
  await first
  await act('apply-drafts')
  assert.equal(spawns.length, 1, 'a press while it runs starts nothing')
  assert.equal(inspector.state.error, '', 'a repeated press is not reported as a stale draft')
  await act('undo-draft')
  await act('revert-draft')
  assert.equal(inspector.state.draft?.count, 1, 'the in-flight draft is kept')
  assert.equal(inspector.state.draft?.submitted, true)
})

test('a cancelled or failed Apply keeps the draft and says why; Apply again works', async () => {
  const { inspector, spawns, act, finish } = make()
  await inspector.activate('/p')
  await inspector.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  await act('apply-drafts')
  await finish('apply-1', { outcome: 'cancelled' })
  assert.equal(inspector.state.draft?.count, 1)
  assert.equal(inspector.state.draft?.submitted, false)
  assert.match(inspector.state.error, /Apply was cancelled\. The draft is still pending\./)
  await act('apply-drafts')
  assert.equal(spawns.length, 2)
  await finish('apply-2', {
    outcome: 'review',
    branch: 'trezi/comment-apply-2',
    summary: 'Not applied: the live project moved under it.'
  })
  assert.equal(inspector.state.draft?.count, 1)
  assert.match(
    inspector.state.error,
    /could not land safely; its change is kept on trezi\/comment-apply-2/
  )
  assert.match(inspector.state.error, /live project moved/)
})

test('a late result settles only its own draft, never a newer one on another element', async () => {
  const { inspector, act, finish } = make()
  await inspector.activate('/p')
  await inspector.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  await act('apply-drafts')
  await inspector.select(B)
  await act('apply', { field: 'style:opacity', value: '0.7' })
  await finish('apply-1', { outcome: 'failed', summary: 'The model refused.' })
  assert.equal(inspector.element?.id, 'b', 'the selection is not retargeted')
  assert.equal(inspector.state.draft?.count, 1)
  assert.equal(inspector.state.draft?.submitted, false)
  assert.equal(inspector.state.error, '', "A's failure is not shown on B")
  // An unrelated background agent (a comment) changes nothing.
  await finish('comment-9', { outcome: 'applied' })
  assert.equal(inspector.state.draft?.count, 1)
  // Back on A: its held draft settles as failed, still pending and recoverable.
  await inspector.select(A)
  assert.equal(inspector.state.draft?.count, 1)
  assert.equal(inspector.state.draft?.submitted, false)
  assert.match(inspector.state.error, /Apply failed\. The model refused\./)
})

test('an applied result whose source or render did not change is not reported as success', async () => {
  const { inspector, act, finish } = make()
  await inspector.activate('/p')
  await inspector.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  await act('apply-drafts')
  await finish('apply-1', { outcome: 'applied', files: ['card.tsx'] })
  assert.equal(inspector.state.draft?.count, 1)
  assert.match(inspector.state.error, /did not confirm source and rendered preview/)
})

test('a project that cannot run a background agent falls back to the chat, truthfully', async () => {
  const { inspector, session, commands, act } = make({
    spawn: async () => ({ ok: false, reason: 'not-a-repo' })
  })
  await inspector.activate('/p')
  await inspector.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  await act('apply-drafts')
  assert.match(inspector.state.error, /not a Git repository.*Finish the current chat turn/)
  assert.equal(commands.length, 0)
  assert.equal(inspector.state.draft?.submitted, false, 'the draft is still pending')
  session.isRunning = false
  await act('apply-drafts')
  assert.equal(commands.length, 1)
  assert.equal(commands[0].type, 'submit')
  // LKM-600: the fallback turn carries its explicit origin; the chat shows the summary.
  assert.deepEqual(commands[0].action, {
    kind: 'inspector-apply',
    summary: 'opacity: 0.4 on <span> in card.tsx:3'
  })
  assert.match(commands[0].text, /staged against SHA-256 base/, 'the worker keeps everything')
})

test('a result that arrives before its dispatch is recorded still settles it', async () => {
  const gated = gate()
  const c = new NativeInspectorController(
    async (channel) =>
      channel === 'styles:read'
        ? { values: { opacity, display: 'inline' }, specified: { opacity } }
        : channel === 'controls:list'
          ? []
          : null,
    async () => {},
    () => {},
    async () => {
      await c.settleDraftTurn(
        false,
        'apply-1',
        'Apply was cancelled. The draft is still pending.',
        true
      )
      gated.open()
      return 'apply-1'
    },
    async () => {}
  )
  await c.activate('/p')
  await c.select(A)
  const act = (action, extra = {}) =>
    c.action({ root: '/p', generation: c.state.generation, action, ...extra })
  await act('apply', { field: 'style:opacity', value: '0.4' })
  await act('apply-drafts')
  await gated.promise
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(c.state.draft?.submitted, false)
  assert.match(c.state.error, /cancelled/)
})

test('outcome text and rail label', () => {
  assert.deepEqual(applyOutcome({ outcome: 'applied' }), { success: true })
  assert.match(
    applyOutcome({ outcome: 'no-change', summary: 'Hash differs.' }).reason,
    /without changing source\. Hash differs\./
  )
  assert.match(
    applyOutcome({ outcome: 'failed' }).reason,
    /^Apply failed\. The draft is still pending\.$/
  )
  const summary = applySummary(
    { tag: 'span', source: '/Users/someone/dev/site/src/components/Preset.tsx:82:24' },
    [{ prop: 'font-weight', value: '400' }]
  )
  assert.equal(summary, 'font-weight: 400 on <span> in Preset.tsx:82')
  assert.equal(applyLabel({ kind: 'inspector-apply', summary }), `Apply ${summary}`)
  assert.equal(
    applySummary({ tag: 'div', source: null }, [
      { prop: 'a', value: '1' },
      { prop: 'b', value: '2' },
      { prop: 'c', value: '3' },
      { prop: 'd', value: '4' }
    ]),
    'a: 1, b: 2, c: 3 and 1 more on <div>'
  )
})

let failed = 0
for (const { name, run } of cases) {
  hash = 'base'
  opacity = '1'
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n  ${error.stack?.split('\n').slice(0, 4).join('\n  ')}`)
  }
}
setSourceOwner(null)
setEditingOwner(null)
if (failed) {
  console.log(`${failed} of ${cases.length} failed`)
  process.exit(1)
}
console.log(`${cases.length} passed`)
process.exit(0)
