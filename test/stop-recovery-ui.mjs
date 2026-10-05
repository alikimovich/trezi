// LKM-151, no desktop: the live-checkout write guard, project-relative selection
// sources, the dev-server error reader, and the chat controller's post-Stop card,
// preview-error card and paused-queue "Send now". The Git side (a stopped turn is held,
// reverts byte-exact, keeps, finishes) is test/stop-recovery.mjs.
import assert from 'node:assert/strict'
import { liveCheckoutEdit } from '../src/main/live-write-guard.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
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
assert.match(renders.at(-1).composer.queueNote, /resolve the conflicting edits/)
console.log(
  'STOP RECOVERY UI OK — guard, relative sources, dev-server errors, post-Stop and preview-error cards, queue'
)
