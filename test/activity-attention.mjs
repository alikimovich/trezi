// Activity records events and marks unread attention; only manual actions show the feed.
import assert from 'node:assert/strict'
import { NativeActivityController, severityOf } from '../src/native/activity-controller.ts'
import {
  reportConversationRecovery,
  reportRepositoryRecovery,
  reportSourceRecovery
} from '../src/native/activity-startup.ts'
import { NativePreviewSupervisor, RESTART_DELAYS } from '../src/native/preview-supervisor.ts'

const flush = () => new Promise((resolve) => setTimeout(resolve, 70))
const make = () => {
  const sent = []
  const log = new NativeActivityController(
    (method, value) => sent.push([method, structuredClone(value)]),
    (text) => text
  )
  return {
    log,
    sent,
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

// Startup recovery notices and dev-server output never open the window.
{
  const { log, states } = make()
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
  assert.equal(log.visible, false, 'recovery notices and Vite output do not open Activity')
  assert.equal(states().length, 0, 'nothing is rendered while hidden')
  assert.equal(log.unread, 0, 'info lines are not unread')
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

// Background work, progress, errors, agent requests and startup damage cannot open the feed.
{
  const { log, states, unread } = make()
  log.append('Task started', 'info')
  log.append('Agent is working', 'server')
  log.append('Progress', 'success')
  log.append('Download failed', 'error')
  log.append('Agent needs approval', 'needs-action', { event: 'agent-request' })
  reportSourceRecovery(log, { interrupted: [], journal: 'damaged' })
  await flush()
  assert.equal(log.visible, false, 'incoming events leave Activity closed')
  assert.equal(states().length, 0, 'incoming events cannot raise or focus Activity')
  assert.equal(log.lines.length, 6, 'all events remain recorded')
  assert.deepEqual(unread(), { count: 3, level: 'needs-action' })
  log.action('show')
  assert.equal(log.visible, true, 'manual show opens Activity')
  assert.equal(states().at(-1).focus, true, 'manual show focuses Activity')
  assert.equal(states().at(-1).lines.length, 6, 'manual show presents recorded events')
  assert.deepEqual(unread(), { count: 0, level: 'info' })
  log.append('Another request', 'needs-action', { event: 'agent-request' })
  await flush()
  assert.equal(log.visible, true, 'incoming events leave an open feed open')
  assert.equal(states().at(-1).focus, undefined, 'incoming events do not take focus')
  assert.equal(states().at(-1).raise, undefined, 'incoming events do not raise the feed')
  log.action('hide')
  log.append('Hidden request', 'needs-action', { event: 'agent-request' })
  assert.equal(log.visible, false, 'an event cannot reopen a manually closed feed')
  assert.equal(log.unread, 1)
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

// Verification reset hides and clears the feed and unread status.
{
  const { log, unread } = make()
  const open = () =>
    log.append('Could not open Folder', 'needs-action', { event: 'project-open-failed' })
  open()
  assert.equal(log.visible, false, 'the failed open leaves Activity hidden')
  assert.equal(log.unread, 1)
  log.action('reset')
  assert.deepEqual([log.visible, log.lines.length, log.unread], [false, 0, 0])
  assert.equal(unread().count, 0, 'reset clears the unread marker')
  open()
  assert.equal(log.visible, false, 'after reset the event still leaves Activity hidden')
}

console.log(
  'Activity attention: manual visibility, background events, startup recovery, unread marker and recording passed'
)
