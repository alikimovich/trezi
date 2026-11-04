// LKM-151, no desktop: the live-checkout write guard, project-relative selection
// sources, the dev-server error reader, and the chat controller's post-Stop card,
// preview-error card and paused-queue "Send now". The Git side (a stopped turn is held,
// reverts byte-exact, keeps, finishes) is test/stop-recovery.mjs.
import assert from 'node:assert/strict'
import { liveCheckoutEdit } from '../src/main/live-write-guard.ts'
import { setRecoveryRequestDeadlineForTests } from '../src/native/chat-actions.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { readableRecoveryReport } from '../src/native/chat-recovery-report.ts'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { DevErrorReader, touchedFile } from '../src/shared/dev-error.ts'
import { projectRelative } from '../src/shared/project-path.ts'
import { describeSelectionForPrompt } from '../src/shared/selection-context.ts'

// The guard: an edit tool aimed at the live checkout from a worktree chat is denied,
// with the worktree path to use; everything else passes.
const live = '/Users/me/app',
  wt = '/Users/me/.trezi/worktrees/chat-1'
const denied = liveCheckoutEdit('Edit', { file_path: `${live}/src/top-app-bar.tsx` }, wt, live)
assert.equal(denied.path, `${wt}/src/top-app-bar.tsx`)
assert.match(denied.reason, /not the live checkout/)
assert.ok(denied.reason.includes(`${wt}/src/top-app-bar.tsx`))
for (const tool of ['Write', 'MultiEdit'])
  assert.ok(liveCheckoutEdit(tool, { file_path: `${live}/a.ts` }, wt, live))
assert.ok(liveCheckoutEdit('NotebookEdit', { notebook_path: `${live}/n.ipynb` }, wt, live))
assert.ok(
  liveCheckoutEdit('Edit', { file_path: `${live}/src/../a.ts` }, wt, live),
  'normalized before the check'
)
assert.equal(
  liveCheckoutEdit('Edit', { file_path: `${wt}/src/a.ts` }, wt, live),
  null,
  'its own worktree'
)
assert.equal(
  liveCheckoutEdit('Edit', { file_path: 'src/a.ts' }, wt, live),
  null,
  'relative paths resolve in the worktree'
)
assert.equal(
  liveCheckoutEdit('Edit', { file_path: '/Users/me/app-other/a.ts' }, wt, live),
  null,
  'a sibling is not the live tree'
)
assert.equal(
  liveCheckoutEdit('Read', { file_path: `${live}/a.ts` }, wt, live),
  null,
  'reads are fine'
)
assert.equal(
  liveCheckoutEdit('Edit', { file_path: `${live}/a.ts` }, live, live),
  null,
  'a non-isolated chat is the live tree'
)
assert.equal(liveCheckoutEdit('Edit', null, wt, live), null)

// A picked element's absolute source reaches the prompt relative to the project.
const element = {
  tag: 'div',
  id: '',
  classes: ['bar'],
  selector: 'div.bar',
  text: '',
  source: `${live}/src/top-app-bar.tsx:81:5`
}
assert.match(describeSelectionForPrompt(element, live), / in src\/top-app-bar\.tsx:81:5\./)
assert.ok(!describeSelectionForPrompt(element, live).includes(live))
assert.match(
  describeSelectionForPrompt(element),
  /\/Users\/me\/app\/src/,
  'without a root the source is unchanged'
)
assert.match(
  describeSelectionForPrompt({ ...element, source: 'src/x.tsx:1' }, live),
  / in src\/x\.tsx:1\./
)

// The dev-server error reader: Vite/esbuild, Babel, Rolldown PARSE_ERROR (file on a
// later line), Next.js; a rebuild recovers; dependency files are never blamed.
const read = (lines) => {
  const reader = new DevErrorReader()
  return lines.map((line) => reader.read(line)).filter(Boolean)
}
assert.deepEqual(
  read([
    `\u001b[31m12:00:00 PM [vite] Pre-transform error: Transform failed with 1 error:\u001b[39m`,
    `${live}/src/top-app-bar.tsx:507:2: ERROR: Unexpected closing "div" tag does not match opening fragment tag`
  ]),
  [
    {
      file: `${live}/src/top-app-bar.tsx`,
      message: `${live}/src/top-app-bar.tsx:507:2: ERROR: Unexpected closing "div" tag does not match opening fragment tag`
    }
  ]
)
assert.equal(
  read([`[vite] Internal server error: ${live}/src/a.tsx: Unexpected token (81:5)`])[0].file,
  `${live}/src/a.tsx`
)
assert.deepEqual(
  read([
    '[PARSE_ERROR] Error: Expected corresponding JSX closing tag for <>',
    '   ╭─[ src/themer-admin/top-app-bar.tsx:508:3 ]'
  ]),
  [
    {
      file: 'src/themer-admin/top-app-bar.tsx',
      message: '[PARSE_ERROR] Error: Expected corresponding JSX closing tag for <>'
    }
  ]
)
assert.equal(
  read(['⨯ ./src/app/page.tsx:10:5', 'Parsing ecmascript source code failed'])[0],
  undefined,
  'a path alone is no error'
)
assert.equal(
  read(['Failed to compile.', '', './src/app/page.tsx:10:5'])[0].file,
  './src/app/page.tsx'
)
assert.deepEqual(read(['12:01:00 PM [vite] (client) hmr update /src/a.tsx']), [
  { recovered: '/src/a.tsx' }
])
assert.equal(
  read(['[vite] Internal server error: x', '  at node_modules/vite/dist/index.js:1:1'])[0],
  undefined
)
assert.equal(
  read(['ERROR: something', ...Array(8).fill('noise'), 'src/late.ts'])[0],
  undefined,
  'a file too late is not blamed'
)
assert.equal(projectRelative(`${live}/src/a.tsx`, live, { served: true }), 'src/a.tsx')
assert.equal(projectRelative('/src/a.tsx', live, { served: true }), 'src/a.tsx')
assert.equal(
  touchedFile({ file: './src/a.tsx', message: '' }, live, ['src/b.tsx', 'src/a.tsx']),
  'src/a.tsx'
)
assert.equal(touchedFile({ file: 'src/c.tsx', message: '' }, live, ['src/a.tsx']), null)

// The controller: a stopped turn's card, its actions, the queue, the preview error.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const calls = [],
  renders = []
const answers = {
  'agent:revert-stopped': { ok: true, files: ['src/a.tsx'] },
  'agent:undo-revert-stopped': { ok: true, files: ['src/a.tsx'] },
  'agent:keep-stopped': { ok: true, files: ['src/a.tsx'], group: 'chat:w:2' },
  'edit:revert': { ok: true }
}
const controller = new NativeChatController({
  invoke: async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'agent:workspace-snapshot')
      return {
        projects: [
          {
            root: live,
            chats: [
              {
                sessionKey: 'a',
                record: { transcript: [] },
                isRunning: false,
                options: { provider: 'claude' }
              }
            ]
          }
        ]
      }
    if (channel === 'providers:choices') return []
    return answers[channel] ?? { ok: true }
  },
  render: (state) => renders.push(structuredClone(state)),
  effect: () => {}
})
await controller.command({
  type: 'context',
  context: {
    chat: 'a',
    root: live,
    selection: null,
    turn: {},
    setup: { needed: false, dismissed: false, status: null },
    tokens: { needed: false, dismissed: false },
    notes: [],
    spawns: []
  }
})
const chat = controller.get('a')
const emit = (event) => controller.event({ projectKey: 'a', ...event })
const sent = () => calls.filter((c) => c[0] === 'agent:send')
const card = (id) => renders.at(-1).cards.find((c) => c.id === id)
const act = (action, id) => controller.action({ chat: 'a', action, ...(id ? { id } : {}) })

await controller.composer({
  chat: 'a',
  action: 'input',
  text: 'Wrap the bar',
  caret: 12,
  revision: 1
})
await controller.composer({ chat: 'a', action: 'send' })
await tick()
emit({ type: 'delta', text: 'Opening a fragment…' })
await controller.composer({
  chat: 'a',
  action: 'input',
  text: 'Then make it blue',
  caret: 17,
  revision: 2
})
await controller.composer({ chat: 'a', action: 'send' })
await act('stop')
emit({ type: 'done' })
emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'], reason: 'interrupted' })
await tick()
assert.equal(chat.stopped, 'held')
assert.equal(card('conflict'), undefined, 'a stopped turn is not a conflict')
emit({
  type: 'isolation',
  state: 'parked',
  files: ['src/a.tsx'],
  reason: 'failed',
  error: 'late check failure'
})
assert.equal(chat.stopped, 'held', 'a late failed park cannot replace the settled Stop')
assert.equal(card('conflict'), undefined, 'late failed park cannot revive a Problem')
emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'], decision: 'Keep ours?' })
assert.equal(chat.stopped, 'held', 'a late decision cannot replace the settled Stop')
assert.equal(card('conflict'), undefined, 'late decision cannot revive the stopped incident')
controller.event({ projectKey: 'a', type: 'error', turn: 'stale-turn', message: 'late failure' })
assert.equal(card('conflict'), undefined, 'a late terminal callback cannot revive a Problem')
assert.ok(card('stopped'), 'Stop retains its settled action after a late callback')
assert.deepEqual(
  card('stopped').actions.map((a) => a.label),
  ['Revert this turn’s changes', 'Keep changes', 'Ask agent to finish']
)
assert.match(card('stopped').detail, /Nothing was applied[\s\S]*src\/a\.tsx/)
const stoppedMessage = renders.at(-1).messages.at(-1)
assert.equal(stoppedMessage.revertGroup, 'stopped:a', 'the stopped message keeps its hover Revert')
// The queue says it will not send, and can be sent now.
assert.equal(sent().length, 1)
assert.equal(renders.at(-1).composer.queuePaused, true)
assert.match(renders.at(-1).composer.queueNote, /Paused after Stop — not sent/)
assert.equal(renders.at(-1).composer.queueCanSend, true)

// Hover Revert on the stopped message reverts the held work; Undo puts it back.
await act('revert', stoppedMessage.id)
assert.deepEqual(calls.at(-1), ['agent:revert-stopped', 'a'])
assert.equal(calls.filter((c) => c[0] === 'edit:revert').length, 0)
emit({ type: 'isolation', state: 'isolated', files: ['src/a.tsx'], reason: 'reverted' })
assert.equal(card('stopped'), undefined)
assert.deepEqual(
  card('stopped-reverted').actions.map((a) => a.label),
  ['Dismiss', 'Undo']
)
assert.equal(renders.at(-1).messages.at(-1).revertGroup, undefined)
await act('stopped-undo')
assert.deepEqual(calls.at(-1), ['agent:undo-revert-stopped', 'a'])
emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'], reason: 'interrupted' })
assert.ok(card('stopped'))
await act('stopped-revert')
assert.deepEqual(calls.at(-1), ['agent:revert-stopped', 'a'])

// Keep: the landed turn's group goes on the message, so its Revert is the real one.
emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'], reason: 'interrupted' })
await act('stopped-keep')
assert.deepEqual(calls.at(-1), ['agent:keep-stopped', 'a'])
emit({
  type: 'isolation',
  state: 'merged',
  files: ['src/a.tsx'],
  group: 'chat:w:2',
  revertable: true
})
assert.equal(chat.stopped, undefined)
assert.equal(card('stopped'), undefined)
assert.equal(renders.at(-1).messages.at(-1).revertGroup, 'chat:w:2')
assert.deepEqual(chat.landed, { files: ['src/a.tsx'], group: 'chat:w:2' })

// A parse error in the landed file: Trezi's own card, with Revert last turn and Fix with agent.
controller.devServerLog(
  '/elsewhere',
  `[vite] Internal server error: /elsewhere/src/a.tsx: Unexpected token (1:1)`
)
assert.equal(chat.previewError, undefined, 'another project’s error is not this chat’s')
controller.devServerLog(
  live,
  `[vite] Internal server error: ${live}/src/other.tsx: Unexpected token (1:1)`
)
assert.equal(chat.previewError, undefined, 'an error in a file the turn did not touch')
controller.devServerLog(
  live,
  `12:00:00 PM [vite] Pre-transform error: Transform failed with 1 error:\n${live}/src/a.tsx:507:2: ERROR: Unexpected closing "div" tag does not match opening fragment tag`
)
assert.deepEqual(
  card('preview-error').actions.map((a) => [a.label, !!a.disabled]),
  [
    ['Dismiss', false],
    ['Revert last turn', false],
    ['Fix with agent', false]
  ]
)
assert.equal(card('preview-error').title, 'Preview error in src/a.tsx')
controller.devServerLog(live, '[vite] (client) hmr update /src/a.tsx')
assert.equal(card('preview-error'), undefined, 'a rebuild of the file clears the card')
controller.devServerLog(
  live,
  `[vite] Internal server error: ${live}/src/a.tsx: Unexpected token (1:1)`
)
await act('preview-revert')
assert.deepEqual(calls.at(-1), ['edit:revert', live, 'chat:w:2'])
assert.equal(card('preview-error'), undefined)
assert.equal(renders.at(-1).messages.at(-1).revertGroup, undefined)

// Fix with agent runs a turn that names the file and the error.
emit({
  type: 'isolation',
  state: 'merged',
  files: ['src/a.tsx'],
  group: 'chat:w:3',
  revertable: true
})
controller.devServerLog(
  live,
  `[vite] Internal server error: ${live}/src/a.tsx: Unexpected token (81:5)`
)
await act('preview-fix')
await tick()
assert.match(sent().at(-1)[1], /src\/a\.tsx[\s\S]*Unexpected token \(81:5\)/)
assert.equal(card('preview-error'), undefined)
emit({ type: 'done' })
await tick()
assert.equal(
  sent().at(-1)[1],
  'Then make it blue',
  'the queue resumes behind a chosen recovery turn'
)
emit({ type: 'done' })
await tick()

// Ask agent to finish is a turn on top of the held work; the queue then follows it.
await controller.composer({
  chat: 'a',
  action: 'input',
  text: 'And round it',
  caret: 12,
  revision: 3
})
chat.isRunning = true
await controller.composer({ chat: 'a', action: 'send' })
chat.isRunning = false
emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'], reason: 'interrupted' })
chat.paused = true
const before = sent().length
await act('stopped-finish')
await tick()
assert.equal(sent().length, before + 1)
assert.match(sent().at(-1)[1], /pressed Stop[\s\S]*parses/)
emit({ type: 'done' })
await tick()
assert.equal(sent().length, before + 2, 'the queued message follows once the held work continues')
assert.equal(sent().at(-1)[1], 'And round it')
emit({ type: 'done' })
await tick()

// Send now on a queue paused after Stop sends it on top of the held work.
await controller.composer({ chat: 'a', action: 'input', text: 'Now', caret: 3, revision: 4 })
chat.isRunning = true
await controller.composer({ chat: 'a', action: 'send' })
chat.isRunning = false
emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'], reason: 'interrupted' })
chat.paused = true
await act('queue-resume')
await tick()
assert.equal(sent().at(-1)[1], 'Now')
emit({ type: 'done' })
await tick()

// A conflict still blocks the queue, and says so.
await controller.composer({ chat: 'a', action: 'input', text: 'Later', caret: 5, revision: 3 })
chat.isRunning = true
await controller.composer({ chat: 'a', action: 'send' })
chat.isRunning = false
emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
assert.ok(card('conflict'))
assert.equal(renders.at(-1).composer.queueCanSend, false)
assert.match(renders.at(-1).composer.queueNote, /^Waiting for Resolve/)
assert.equal(card('conflict').title, 'Problem')
await tick()
assert.ok(card('conflict').actions.some((action) => action.action === 'recovery-report'))
assert.match(readableRecoveryReport('a'), /turn-end landing/)
assert.equal(card('error'), undefined, 'one card owns the turn-end problem')
assert.deepEqual(
  card('conflict').actions.map((a) => a.action),
  ['discard', 'landing-retry', 'resolve', 'recovery-report']
)

// LKM-165: a landing that failed says why and offers Retry; never "pending".
emit({
  type: 'isolation',
  state: 'parked',
  files: ['src/a.tsx'],
  reason: 'failed',
  error: 'index.lock exists'
})
assert.match(card('conflict').detail, /Problem: index\.lock exists/)
assert.doesNotMatch(card('conflict').detail, /couldn’t apply them to the project/)
assert.match(card('conflict').fullDetail, /src\/a\.tsx/)
await tick()
const terminalReport = chat.recoveryReport
assert.ok(terminalReport, 'the failed park has an actual report before the later turn')
await controller.run(chat, {
  id: crypto.randomUUID(),
  text: 'Unrelated follow-up',
  attachments: [],
  selection: null,
  turn: {}
})
assert.equal(card('conflict').title, 'Problem', 'a later turn does not own the failed park')
assert.equal(chat.recoveryReport, terminalReport, 'the earlier report remains available')
assert.ok(card('conflict').actions.some((action) => action.action === 'recovery-report'))
emit({ type: 'done' })
let finishRetry
answers['agent:retry-landing'] = new Promise((resolve) => {
  finishRetry = resolve
})
const pendingRetry = act('landing-retry', 'conflict')
await tick()
assert.equal(card('conflict').title, 'Retrying the check…')
assert.equal(card('conflict').detail, 'Trezi is working on the held changes.')
assert.equal(card('conflict').actions[1].label, 'Retrying…', 'busy before IPC settles')
assert.equal(
  card('conflict').actions.every((action) => action.disabled),
  true
)
await act('landing-retry', 'conflict')
await act('discard', 'conflict')
assert.equal(calls.filter((call) => call[0] === 'agent:retry-landing').length, 1)
assert.equal(calls.filter((call) => call[0] === 'agent:discard-conflict').length, 0)
finishRetry({ ok: true, state: 'parked' })
await pendingRetry
assert.equal(card('conflict').actions[1].label, 'Retry')
await act('landing-retry', 'conflict')
await tick()
assert.deepEqual(calls.at(-1), ['agent:retry-landing', 'a'])
emit({ type: 'isolation', state: 'merged', files: ['src/a.tsx'], group: 'chat:w:3' })
assert.equal(card('conflict'), undefined, 'a landed retry clears the card')
assert.equal(chat.landingError, undefined)
emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
let finishLanding
answers['agent:retry-landing'] = new Promise((resolve) => {
  finishLanding = resolve
})
const settledRetry = act('landing-retry', 'conflict')
await tick()
assert.equal(card('conflict').title, 'Retrying the check…')
emit({ type: 'isolation', state: 'merged', files: ['src/a.tsx'] })
finishLanding({ ok: true, state: 'isolated' })
await settledRetry
assert.equal(card('recovery-outcome').detail, 'Changes applied to the project.')
assert.equal(card('conflict'), undefined, 'matching recovery leaves no held Problem')
await act('recovery-outcome-dismiss', 'recovery-outcome')
assert.equal(card('recovery-outcome'), undefined)
emit({
  type: 'isolation',
  state: 'parked',
  files: ['src/a.tsx'],
  reason: 'failed',
  error: 'checked source changed'
})
answers['agent:resolve-conflict'] = { ok: false, error: 'The checked source changed.' }
await act('resolve', 'conflict')
assert.match(card('conflict').detail, /Problem: The checked source changed/)
assert.equal(card('error'), undefined, 'one recovery outcome stays on its own card')
assert.ok(card('conflict').actions.some((action) => action.action === 'recovery-report'))
await act('recovery-report', 'conflict')
assert.deepEqual(calls.at(-1), ['recovery:copy-report', 'a'])
setRecoveryRequestDeadlineForTests(1)
let finishTimedOut
answers['agent:retry-landing'] = new Promise((resolve) => {
  finishTimedOut = resolve
})
await act('landing-retry', 'conflict')
assert.equal(card('conflict').busy, false, 'a timed-out request clears the native activity')
assert.match(card('conflict').detail, /Problem: The recovery request did not answer/)
assert.ok(card('conflict').actions.some((action) => action.action === 'recovery-report'))
await act('discard', 'conflict')
assert.equal(calls.filter((call) => call[0] === 'agent:discard-conflict').length, 0)
assert.ok(card('conflict').actions.find((action) => action.action === 'discard').disabled)
finishTimedOut({ ok: true, state: 'parked' })
await tick()
assert.equal(chat.recovery, undefined, 'the original IPC release unlocks mutations')

// A Resolve handover to an agent turn is not a request in flight: the deadline covers
// only the IPC, so a long agent turn is never timed out or reported as a Problem.
emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
const reportsBefore = calls.filter((call) => call[0] === 'recovery:copy-report').length
answers['agent:resolve-conflict'] = {
  ok: true,
  conflicted: ['src/a.tsx'],
  prompt: 'Fix the conflict markers'
}
let admitTurn
answers['agent:send'] = new Promise((resolve) => {
  admitTurn = resolve
})
const handover = act('resolve', 'conflict')
await new Promise((resolve) => setTimeout(resolve, 30)) // far past the 1 ms deadline
assert.equal(chat.recoveryTimedOut, false, 'the handed-over turn never trips the request deadline')
assert.equal(chat.recoveryProblem, undefined, 'a running agent turn is not a Problem')
assert.equal(chat.recoveryReport, undefined, 'no support report for a legitimately running turn')
assert.equal(chat.recovery, undefined, 'the recovery request ended at the handover')
assert.equal(chat.isRunning, true, 'the agent turn owns the lock now')
assert.equal(card('conflict')?.title, 'Working on held changes…')
assert.equal(card('conflict')?.busy ?? false, false, 'no request spinner while the agent runs')
assert.equal(
  card('conflict')?.actions?.find((action) => action.action === 'landing-retry')?.disabled ?? true,
  true,
  'mutations stay locked by the running agent turn'
)
assert.equal(calls.filter((call) => call[0] === 'agent:send').at(-1)[1], 'Fix the conflict markers')
admitTurn({ ok: true })
await handover
emit({ type: 'done' })
await tick()
assert.equal(chat.recoveryProblem, undefined)
assert.equal(calls.filter((call) => call[0] === 'recovery:copy-report').length, reportsBefore)
delete answers['agent:send']
setRecoveryRequestDeadlineForTests(null)

// Two chats held at once: each shows one concise Problem line on its own card and no
// separate error card, and a terminal event clears only its own chat.
await controller.command({
  type: 'context',
  context: {
    chat: 'b',
    root: live,
    selection: null,
    turn: {},
    setup: { needed: false, dismissed: false, status: null },
    tokens: { needed: false, dismissed: false },
    notes: [],
    spawns: []
  }
})
const other = controller.get('b')
const cardsOf = (target) => snapshot(target, []).cards
const heldCard = (target) => cardsOf(target).find((c) => c.id === 'conflict')
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
emit({ type: 'isolation', state: 'merged', files: [] })
for (const key of ['a', 'b'])
  controller.event({
    projectKey: key,
    type: 'isolation',
    state: 'parked',
    files: ['src/a.tsx'],
    reason: 'failed',
    error: `${key} is still held`
  })
await settle()
for (const target of [chat, other]) {
  assert.equal(heldCard(target).title, 'Problem')
  assert.equal(heldCard(target).detail, `Problem: ${target.chat} is still held`, 'one concise line')
  assert.equal(
    cardsOf(target).filter((c) => c.id === 'error').length,
    0,
    'a still-held chat shows no duplicate error card'
  )
  assert.ok(target.recoveryReport, 'the report exists for this chat')
}
assert.notEqual(chat.recoveryReport, other.recoveryReport, 'each report is scoped to its chat')
controller.event({ projectKey: 'a', type: 'isolation', state: 'merged', files: ['src/a.tsx'] })
assert.equal(heldCard(chat), undefined, 'the landed chat clears')
assert.equal(chat.recoveryProblem, undefined)
assert.equal(chat.recoveryReport, undefined)
assert.equal(heldCard(other)?.title, 'Problem', 'another chat keeps its own held problem')
assert.ok(other.recoveryReport)
controller.event({ projectKey: 'b', type: 'isolation', state: 'isolated' })
assert.equal(heldCard(other), undefined, 'a discarded chat clears too')
assert.equal(other.recoveryProblem, undefined)
assert.equal(other.recoveryReport, undefined)
console.log(
  'STOP RECOVERY UI OK — guard, relative sources, dev-server errors, post-Stop and preview-error cards, queue'
)
