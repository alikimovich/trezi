// LKM-152: Activity opens only when attention is needed. Severity classification,
// once-per-kind automatic opening, collapsed gray recovery notices, the unread marker
// and the Show Activity automatically setting.
import assert from 'node:assert/strict'
import {
  ACTIVITY_AUTO_OPEN_CHOICES,
  activityAutoOpen,
  NativeActivityController,
  severityOf
} from '../src/native/activity-controller.ts'
import {
  reportConversationRecovery,
  reportRepositoryRecovery,
  reportSourceRecovery
} from '../src/native/activity-startup.ts'
import { NativePreviewSupervisor, RESTART_DELAYS } from '../src/native/preview-supervisor.ts'

const flush = () => new Promise((resolve) => setTimeout(resolve, 70))
const make = (mode = 'problems') => {
  const sent = []
  const settings = { mode }
  const log = new NativeActivityController(
    (method, value) => sent.push([method, structuredClone(value)]),
    (text) => text,
    () => activityAutoOpen(settings.mode)
  )
  return {
    log,
    sent,
    settings,
    states: () => sent.filter(([m]) => m === 'activityState').map(([, v]) => v),
    unread: () =>
      sent
        .filter(([m]) => m === 'activityUnread')
        .map(([, v]) => v)
        .at(-1)
  }
}
const VITE = [
  '',
  '  VITE v5.4.0  ready in 312 ms',
  '',
  '  ➜  Local:   http://localhost:5173/',
  '  ➜  Network: use --host to expose'
]
const chat = (id, outcome = 'restored', interrupted = false) => ({
  chat: id,
  id,
  project: '/p',
  interrupted,
  outcome,
  ...(outcome === 'restored' ? {} : { copy: `/c/${id}` })
})

// Severity classification: every kind maps to info, warning or needs-action.
assert.deepEqual(
  ['info', 'notice', 'server', 'success', 'warning', 'error', 'needs-action'].map(severityOf),
  ['info', 'info', 'info', 'info', 'warning', 'warning', 'needs-action']
)

// Settings: default "For problems that need me"; unknown values fall back to it.
assert.deepEqual(
  ACTIVITY_AUTO_OPEN_CHOICES.map((c) => [c.value, c.label]),
  [
    ['never', 'Never'],
    ['problems', 'For problems that need me'],
    ['always', 'Always']
  ]
)
assert.equal(activityAutoOpen(null), 'problems')
assert.equal(activityAutoOpen('bogus'), 'problems')
assert.equal(activityAutoOpen('never'), 'never')

// Startup recovery notices and dev-server output never open the window, in any mode.
for (const mode of ['never', 'problems', 'always']) {
  const { log, states } = make(mode)
  reportConversationRecovery(log, [chat('a'), chat('b', 'restored', true), chat('c'), chat('d')])
  reportSourceRecovery(log, {
    interrupted: [
      {
        operationID: 'o',
        kind: 'write',
        root: '/p',
        started: '',
        restored: [],
        unchanged: [],
        kept: [],
        copies: []
      }
    ]
  })
  reportRepositoryRecovery(log, {
    active: [],
    interrupted: [],
    recovered: [
      { id: 'r', kind: 'merge', root: '/p', refs: ['refs/trezi/recovery/x'], missing: [] }
    ],
    closedEarlier: 2
  })
  for (const line of VITE) log.append(line, 'server')
  await flush()
  assert.equal(log.visible, false, `${mode}: recovery notices and Vite output do not open Activity`)
  assert.equal(states().length, 0, `${mode}: nothing is rendered while hidden`)
  assert.equal(log.unread, 0, `${mode}: info lines are not unread`)
}

// Repeated recovery notices collapse into one gray summary line with the correct count.
{
  const { log, states } = make()
  reportConversationRecovery(log, [chat('a'), chat('b', 'restored', true), chat('c'), chat('d')])
  const restored = log.lines.filter((line) => line.group === 'restored-chats')
  assert.equal(restored.length, 1, 'one line for four restored chats')
  assert.equal(restored[0].count, 4)
  assert.equal(restored[0].kind, 'notice', 'styled as info (gray), not red')
  assert.equal(restored[0].severity, 'info')
  assert.equal(restored[0].text.split('\n').length, 4, 'the tooltip and Copy All keep every notice')
  log.action('show')
  const shown = states()
    .at(-1)
    .lines.find((line) => line.group === 'restored-chats')
  assert.equal(shown.display, 'Restored 4 interrupted chats.')
  assert.equal(shown.kind, 'notice')
  // A single notice reads as itself; a damaged checkpoint or a kept newer copy is not collapsed.
  const single = make()
  reportConversationRecovery(single.log, [chat('a'), chat('b', 'kept'), chat('c', 'damaged')])
  single.log.action('show')
  const lines = single.states().at(-1).lines
  assert.equal(
    lines[0].display,
    'A chat was cut off when Trezi last stopped; its conversation was restored.'
  )
  assert.deepEqual(
    lines.map((line) => [line.kind, line.severity]),
    [
      ['notice', 'info'],
      ['notice', 'info'],
      ['warning', 'warning']
    ]
  )
  // Rolled-back source operations collapse the same way.
  const source = make()
  const op = (id) => ({
    operationID: id,
    kind: 'write',
    root: '/p',
    started: '',
    restored: ['a'],
    unchanged: [],
    kept: [],
    copies: []
  })
  reportSourceRecovery(source.log, { interrupted: [op('1'), op('2'), op('3')] })
  assert.equal(source.log.lines.length, 1)
  assert.equal(source.log.lines[0].summary, 'Rolled back 3 interrupted source changes.')
}

// A needs-action event opens the window exactly once per event kind per session.
{
  const { log, states } = make()
  log.append('The dev server crashed', 'needs-action', { event: 'devserver-crash-loop' })
  assert.equal(log.visible, true, 'needs-action opens Activity')
  await flush()
  assert.equal(states().at(-1).raise, true, 'an automatic open orders the window front')
  assert.equal(states().at(-1).focus, undefined, 'without taking the key window')
  log.action('hide')
  log.append('The dev server crashed again', 'needs-action', { event: 'devserver-crash-loop' })
  assert.equal(log.visible, false, 'a repeat of the same kind does not reopen it')
  assert.equal(log.unread, 1, 'the repeat is unread instead')
  assert.equal(log.unreadLevel, 'needs-action')
  log.append('Could not open Repo', 'needs-action', { event: 'project-open-failed' })
  assert.equal(log.visible, true, 'another kind opens it once')
  log.action('hide')
  log.append('Could not open Repo again', 'needs-action', { event: 'project-open-failed' })
  assert.equal(log.visible, false)
  // Ordinary errors and warnings are logged, never opened, under the default.
  log.append('Download failed', 'error')
  log.append('Recovery ref missing', 'warning')
  assert.equal(log.visible, false)
  assert.deepEqual([...log.opened].sort(), ['devserver-crash-loop', 'project-open-failed'])
  // An open window still comes to front once for a new kind.
  log.action('show')
  const before = states().length
  log.append('Source journal: damaged', 'needs-action', { event: 'source-journal' })
  await flush()
  assert.equal(states().length, before + 1)
  assert.equal(states().at(-1).raise, true, 'a visible window is raised for a new kind')
}

// Unread marker: warnings and needs-action lines while hidden; cleared once viewed.
{
  const { log, unread } = make()
  log.append('server line', 'server')
  log.append('restored', 'notice')
  log.append('done', 'success')
  assert.equal(unread(), undefined, 'info lines do not mark Activity')
  log.append('Download failed', 'error')
  assert.deepEqual(unread(), { count: 1, level: 'warning' })
  log.append('Undo refused', 'error')
  assert.deepEqual(unread(), { count: 2, level: 'warning' })
  log.action('show')
  assert.deepEqual(unread(), { count: 0, level: 'info' }, 'viewing Activity clears the marker')
  assert.equal(log.unread, 0)
  log.append('Another failure', 'error')
  assert.equal(log.unread, 0, 'a line added while Activity is open is already seen')
  log.action('hide')
  log.append('Hidden failure', 'error')
  log.action('toggle')
  assert.equal(log.unread, 0, 'toggling Activity open views it too')
}

// Show Activity automatically: Never suppresses every automatic open; Always keeps the
// pre-LKM-152 behavior (every error opens a hidden window); the setting is read live.
{
  const never = make('never')
  never.log.append('Crash loop', 'needs-action', { event: 'devserver-crash-loop' })
  never.log.append('Failure', 'error')
  assert.equal(never.log.visible, false, 'Never suppresses all automatic opening')
  assert.equal(never.log.unread, 2, 'the marker still shows')
  const always = make('always')
  always.log.append('Failure', 'error')
  assert.equal(always.log.visible, true, 'Always opens for an error')
  always.log.action('hide')
  always.log.append('Failure again', 'error')
  assert.equal(always.log.visible, true, 'Always reopens for each error, as before')
  always.log.action('hide')
  always.log.append('Recovery ref missing', 'warning')
  assert.equal(always.log.visible, false, 'Always keeps warnings closed, as before')
  const live = make('never')
  live.log.append('Crash loop', 'needs-action', { event: 'devserver-crash-loop' })
  live.settings.mode = 'problems'
  live.log.append('Could not open', 'needs-action', { event: 'project-open-failed' })
  assert.equal(live.log.visible, true, 'a changed setting applies at once')
}

// The preview supervisor reports the crash loop it gives up on.
{
  const timers = []
  const clock = {
    now: () => 0,
    set: (run) => {
      timers.push(run)
      return timers.length
    },
    clear() {}
  }
  const workspace = {
    state: { activeKey: '/p', status: { kind: 'running', url: 'http://x' }, projects: [] },
    changed() {},
    async command() {
      workspace.state.status = { kind: 'error', message: 'Exited with code 1' }
    }
  }
  const gaveUp = []
  const supervisor = new NativePreviewSupervisor(workspace, clock, (reason) => gaveUp.push(reason))
  supervisor.exited({ root: '/p', url: 'http://x', reason: 'Exited with code 1' })
  for (let i = 0; i < RESTART_DELAYS.length; i++) {
    await timers.shift()()
    await flush()
  }
  assert.deepEqual(gaveUp, ['Exited with code 1'], 'giving up on a crash loop is reported once')
}

console.log(
  'Activity attention: severity, once-per-kind auto-open, collapsed recovery notices, unread marker and the setting passed'
)
