/**
 * LKM-323: Inspector Custom tab requests. The pure answer → panel rules
 * (control-requests.ts), plus the historical chat request lifecycle. The inspector
 * no longer offers a request route (LKM-538).
 *
 * Run with: bun test/control-requests.mjs
 */
import assert from 'node:assert/strict'
import { resolveLiteralValue } from '../src/main/control-manifest.ts'
import {
  changedParams,
  panelId,
  parseControlsAnswer,
  placePanel,
  requestedPanel,
  unresolvedLiterals,
  withoutParam
} from '../src/main/control-requests.ts'
import { chatRequests, requestAnswer } from '../src/native/inspector-custom.ts'
import { controlsPrompt } from '../src/shared/controls-prompt.ts'

const FILE = 'src/Card.tsx'
const radius = (max = 48) => ({
  id: 'radius',
  label: 'Corner radius',
  kind: 'number',
  unit: 'px',
  min: 0,
  max,
  step: 1,
  apply: { strategy: 'literal', anchor: 'const RADIUS_PX = ' }
})
const shadow = {
  id: 'shadow',
  label: 'Shadow',
  kind: 'toggle',
  apply: { strategy: 'literal', anchor: 'const SHADOW = ' }
}
const gap = {
  id: 'gap',
  label: 'Gap',
  kind: 'number',
  apply: { strategy: 'literal', anchor: 'const GAP = ' }
}
const card = (params, extra = {}) => ({
  file: FILE,
  component: 'Card',
  title: 'Card',
  params,
  ...extra
})
const block = (request, body) =>
  `Here you go.\n\`\`\`trezi-controls\n${JSON.stringify({ request, ...body })}\n\`\`\``

// --- parseControlsAnswer: only this request's block counts; declines and junk are errors.
assert.deepEqual(parseControlsAnswer(block('r1', { manifest: { a: 1 } }), 'r1'), {
  manifest: { a: 1 }
})
assert.match(parseControlsAnswer('No block.', 'r1').error, /without a control panel/)
assert.match(
  parseControlsAnswer(block('r0', { manifest: {} }), 'r1').error,
  /could not be read/,
  'Another request’s block is not this answer'
)
assert.match(parseControlsAnswer('```trezi-controls\n{oops\n```', 'r1').error, /could not be read/)
assert.match(
  parseControlsAnswer(block('r1', { error: 'no such value' }), 'r1').error,
  /could not make these controls: no such value/
)
assert.deepEqual(
  parseControlsAnswer(
    `${block('r1', { manifest: { v: 1 } })}\nFixed:\n${block('r1', { manifest: { v: 2 } })}`,
    'r1'
  ),
  { manifest: { v: 2 } },
  'The last block wins'
)

// --- panelId: readable and unique.
assert.equal(panelId('Corner & Shadow!', []), 'corner-shadow')
assert.equal(panelId('Card', ['card', 'card-2']), 'card-3')
assert.equal(panelId('', []), 'controls')
assert.equal(panelId(42, ['controls']), 'controls-2')

// --- requestedPanel: new, panel comment, control comment.
const now = '2026-10-23T00:00:00.000Z'
const fresh = requestedPanel(
  card([radius(), shadow], { id: 'ignored' }),
  [FILE],
  ['card'],
  undefined,
  now
)
assert.equal(fresh.id, 'card-2', 'A new panel gets a fresh id, never the answer’s')
assert.equal(fresh.revision, 1)
assert.equal(fresh.createdAt, now)
assert.match(
  requestedPanel(card([radius()], { file: 'src/Other.tsx' }), [FILE], []).error,
  /must use the selected element's source/
)
assert.match(
  requestedPanel(card([{ ...radius(), options: ['a'] }]), [FILE], []).error,
  /not valid/,
  'The answer is validated like any manifest'
)
assert.match(requestedPanel('text', [FILE], []).error, /no control panel/)

const old = { ...fresh, id: 'card', replay: undefined }
delete old.replay
const panelComment = requestedPanel(
  card([radius(96), gap], { title: 'Card spacing' }),
  [FILE],
  ['card'],
  {
    panel: old
  }
)
assert.equal(panelComment.id, 'card')
assert.equal(panelComment.createdAt, now)
assert.equal(panelComment.revision, 2)
assert.deepEqual(
  panelComment.params.map((p) => p.id),
  ['radius', 'gap']
)

const controlComment = requestedPanel(card([radius(64), gap]), [], [], {
  panel: old,
  param: 'radius'
})
assert.equal(controlComment.revision, 2)
assert.deepEqual(
  controlComment.params.map((p) => [p.id, p.max]),
  [
    ['radius', 64],
    ['shadow', undefined]
  ],
  'Only the commented control changes; the other is kept and nothing is added'
)
const renamed = requestedPanel(card([{ ...radius(64), id: 'corner' }]), [], [], {
  panel: old,
  param: 'radius'
})
assert.deepEqual(
  renamed.params.map((p) => p.id),
  ['corner', 'shadow'],
  'A single new control replaces the commented one in place'
)
assert.match(
  requestedPanel(card([radius()], { file: 'src/Other.tsx' }), [], [], {
    panel: old,
    param: 'radius'
  }).error,
  /stays in its panel's file/
)
assert.match(
  requestedPanel(card([gap, { ...gap, id: 'gap-2' }]), [], [], { panel: old, param: 'radius' })
    .error,
  /did not change “Corner radius”/
)
assert.match(
  requestedPanel(card([radius()]), [], [], { panel: old, param: 'gone' }).error,
  /removed meanwhile/
)

// --- changedParams / unresolvedLiterals: only new or changed controls must resolve now.
assert.deepEqual(
  changedParams(controlComment, old).map((p) => p.id),
  ['radius']
)
const code = 'const RADIUS_PX = 12\nconst SHADOW = true\n'
assert.deepEqual(unresolvedLiterals(code, [radius(), shadow]), [])
assert.match(unresolvedLiterals(code, [gap])[0], /is not in the file/)
assert.match(
  unresolvedLiterals(`${code}const GAP = 1\nconst GAP = 2\n`, [gap])[0],
  /more than once/
)
assert.match(unresolvedLiterals(null, [gap])[0], /file is missing/)
assert.match(unresolvedLiterals('const GAP = "x"\n', [gap])[0], /no number literal/)

// --- placePanel / withoutParam.
const two = placePanel([old], { ...fresh, id: 'card-2' })
assert.deepEqual(
  two.map((p) => p.id),
  ['card', 'card-2']
)
assert.match(placePanel([old], old).error, /already used/)
assert.match(placePanel([], old, 'card').error, /removed meanwhile/)
assert.equal(placePanel(two, controlComment, 'card')[0].revision, 2)
assert.match(
  placePanel(
    Array.from({ length: 20 }, (_, i) => ({ ...old, id: `p${i}` })),
    old
  ).error,
  /already has 20 control panels/
)
const less = withoutParam([old], 'card', 'shadow')
assert.deepEqual(
  less[0].params.map((p) => p.id),
  ['radius']
)
assert.equal(less[0].revision, 2)
assert.deepEqual(withoutParam(less, 'card', 'radius'), [], 'The last control removes its panel')
assert.match(withoutParam([old], 'card', 'gone').error, /removed meanwhile/)

// --- requestAnswer / chatRequests: only the turn that begins with the request counts.
const header = (id) => `Inspector Custom tab request ${id}.\n…`
const user = (text) => ({ id: text, role: 'user', text, segments: [] })
const reply = (text) => ({ id: `a-${text}`, role: 'assistant', text, segments: [] })
assert.equal(requestAnswer([user(header('r1'))], 'r1'), null)
assert.equal(requestAnswer([user('hi'), reply('x')], 'r1'), null)
assert.equal(requestAnswer([user(header('r1')), reply('done')], 'r1'), 'done')
{
  const boundaries = new Set(),
    changes = new Set(),
    messages = [user('earlier')]
  let queued = [],
    running = false,
    paused = false,
    open = true
  let sendBehaviour = async (text) => {
    messages.push(user(text))
    running = true
  }
  const change = () => {
    for (const listener of [...changes]) listener('chat')
  }
  const emit = (kind, turn) => {
    for (const listener of [...boundaries]) listener('chat', kind, turn)
  }
  const reset = () => {
    queued = []
    running = false
    paused = false
    messages.splice(1)
  }
  const dequeued = []
  const generate = chatRequests({
    chatFor: (root) => (root === '/p' ? 'chat' : null),
    state: () => open && { messages, queued, running, paused },
    submit: (_key, text) => sendBehaviour(text),
    dequeue: (_key, id) => {
      dequeued.push(id)
      queued = queued.filter((text) => !text.includes(id))
      change()
    },
    boundaries,
    changes
  })
  await assert.rejects(generate('/other', 'x', 'r1'), /No chat is open/)
  // Queued behind a running turn: that turn's end is not this answer.
  const pending = generate('/p', header('r1'), 'r1')
  await Promise.resolve()
  emit('landed', 't0')
  messages.push(reply('working'))
  emit('begin', 't1')
  emit('landed', 't0')
  messages.push(reply(block('r1', { manifest: card([radius()]) })))
  emit('landed', 't1')
  assert.match(await pending, /trezi-controls/)
  assert.equal(boundaries.size + changes.size, 0, 'The listeners are removed once it settles')
  running = false
  const failing = generate('/p', header('r2'), 'r2')
  await Promise.resolve()
  emit('begin', 't2')
  emit('failed', 't2')
  await assert.rejects(failing, /did not land/)
  reset()
  const closed = generate('/p', header('r3'), 'r3')
  await Promise.resolve()
  messages.pop()
  emit('failed', null)
  await assert.rejects(closed, /chat closed/)

  // A request must never wait forever: each way its turn can no longer begin settles it.
  // The send failed without a boundary event (chat-controller appends "Unable to send").
  reset()
  const unsent = generate('/p', header('r4'), 'r4')
  await new Promise((r) => setTimeout(r))
  messages.push(reply('Unable to send: boom'))
  running = false
  paused = true
  change()
  await assert.rejects(unsent, /did not run this request/)
  // The send was refused (the chat is not ready or a start holds it): nothing is queued.
  reset()
  sendBehaviour = async () => {}
  await assert.rejects(generate('/p', header('r5'), 'r5'), /not sent to the agent/)
  // Queued behind a running turn that the user then stops: the request is taken back out.
  reset()
  running = true
  sendBehaviour = async (text) => {
    queued.push(text)
  }
  const stopped = generate('/p', header('r6'), 'r6')
  await new Promise((r) => setTimeout(r))
  change()
  running = false
  paused = true
  change()
  await assert.rejects(stopped, /chat is stopped/)
  assert.deepEqual(dequeued, ['r6'])
  assert.deepEqual(queued, [])
  // Queued, then discarded by the user.
  reset()
  running = true
  const discarded = generate('/p', header('r7'), 'r7')
  await new Promise((r) => setTimeout(r))
  queued = []
  change()
  await assert.rejects(discarded, /not sent to the agent/)
  // A queued request that is still waiting behind a running turn keeps waiting.
  reset()
  running = true
  const waiting = generate('/p', header('r8'), 'r8')
  await new Promise((r) => setTimeout(r))
  change()
  assert.equal(boundaries.size, 1, 'It is still listening')
  // The user cancels it: it leaves the queue and rejects.
  const abort = new AbortController()
  const cancelled = generate('/p', header('r9'), 'r9', abort.signal)
  await new Promise((r) => setTimeout(r))
  abort.abort()
  await assert.rejects(cancelled, /cancelled/)
  assert.ok(dequeued.includes('r9'))
  await assert.rejects(
    generate('/p', header('r10'), 'r10', AbortSignal.abort()),
    /cancelled/,
    'An already aborted request never sends'
  )
  // The chat closing settles a waiting request.
  open = false
  change()
  await assert.rejects(waiting, /chat closed/)
  open = true
  // A turn that ended without a recorded begin still settles with its answer.
  reset()
  sendBehaviour = async (text) => {
    messages.push(user(text))
    running = true
  }
  const unseen = generate('/p', header('r11'), 'r11')
  await new Promise((r) => setTimeout(r))
  messages.push(reply(block('r11', { manifest: card([radius()]) })))
  running = false
  change()
  assert.match(await unseen, /trezi-controls/)
}

console.log('CONTROL REQUESTS OK — parser, panel rules, and chat request lifecycle')
