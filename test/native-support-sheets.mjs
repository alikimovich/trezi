import assert from 'node:assert/strict'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import {
  FEEDBACK_PRIVACY,
  INVITE_PROMPT,
  NativeSupportSheets
} from '../src/native/support-sheets.ts'

const calls = [],
  seeded = [],
  sent = [],
  results = []
// LKM-336: the private feedback endpoint, as the main process answers for it.
let account = { hasCode: false }
const entry = { key: 'a', root: '/a', activeSessionKey: 'chat' }
const workspace = {
  state: { projects: [entry], status: { kind: 'error', message: 'Config failed' } },
  command: async (command) => calls.push(['workspace', command])
}
const chat = {
  active: 'chat',
  chats: new Map([
    ['chat', { root: '/a', messages: [{ role: 'user', text: 'Private conversation' }] }]
  ]),
  command: async (command) => seeded.push(command)
}
const sheets = new NativeSheetController(
  { send: (method, data) => sent.push([method, structuredClone(data)]) },
  workspace,
  chat,
  async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'feedback:account') return account
    if (channel === 'feedback:code') {
      if (args[0] !== 'good-code') return { ok: false, error: 'Unknown invite code.' }
      account = { hasCode: true, name: 'Ada' }
      return { ok: true, name: 'Ada' }
    }
    if (channel === 'feedback:submit') return results.shift() ?? { ok: true, issue: 'LKM-123' }
    if (channel === 'diagnose:run')
      return {
        signature: 'error',
        summary: 'Change config',
        steps: [
          { scope: 'host', text: 'Install tools', command: 'host-command' },
          { scope: 'repo', text: 'Edit config' }
        ]
      }
    return {}
  }
)
const screenshot = {
  contentType: 'image/png',
  data: 'iVBORw0KGgo=',
  preview: 'data:image/jpeg;base64,AA=='
}
const support = new NativeSupportSheets(sheets, async () => screenshot)
const lastToast = () => sent.findLast(([method]) => method === 'toastState')[1].state
const submits = () => calls.filter((c) => c[0] === 'feedback:submit')

// --- The first time: the invite code, checked before the form opens. ---
await support.feedback()
let state = sheets.current.state
assert.equal(state.title, 'Enter your invite code')
assert.ok(state.detail.startsWith(INVITE_PROMPT))
assert.match(state.detail, /encrypted with your Keychain.*Settings → General/)
assert.deepEqual(
  state.fields.map((f) => [f.id, f.kind]),
  [['code', 'secure']]
)
await sheets.action({ id: state.id, action: 'continue', values: { code: '  ' } })
assert.equal(sheets.current.state.message, INVITE_PROMPT)
await sheets.action({ id: state.id, action: 'continue', values: { code: 'wrong' } })
assert.equal(sheets.current.state.id, state.id, 'A refused code keeps the prompt')
assert.equal(sheets.current.state.message, 'Unknown invite code.')
await sheets.action({ id: state.id, action: 'continue', values: { code: ' good-code ' } })
assert.deepEqual(
  calls.findLast((c) => c[0] === 'feedback:code'),
  ['feedback:code', 'good-code']
)

// --- The form: who sends it, where it goes, and the opt-ins. ---
state = sheets.current.state
assert.equal(state.title, 'Send feedback')
assert.ok(state.detail.startsWith(`Sending as Ada. ${FEEDBACK_PRIVACY}`))
assert.ok(!/github|public issue/i.test(state.detail), 'Nothing says GitHub')
assert.equal(state.fields.find((f) => f.kind === 'image')?.value, screenshot.preview)
assert.deepEqual(
  state.actions.map((a) => [a.id, a.label]),
  [
    ['cancel', 'Cancel'],
    ['send', 'Send feedback']
  ]
)
// LKM-165: diagnostics need explicit consent, which defaults to off and says what it covers.
const consent = state.fields.find((f) => f.id === 'diagnostics')
assert.equal(consent?.kind, 'choice')
assert.equal(consent.value, 'no')
assert.match(
  state.fields.find((f) => f.id === 'diagnostics-detail').value,
  /logs.*system log from the last hour.*landing state.*git status.*3-second sample.*Secrets are removed.*~/s
)
await sheets.action({
  id: state.id,
  action: 'send',
  values: { body: 'Bug', screenshot: 'no', conversation: 'no', diagnostics: 'no' }
})
assert.deepEqual(calls.at(-1), [
  'feedback:submit',
  { body: 'Bug', screenshot: null, conversation: null, diagnostics: false, chat: null }
])
// Success closes the form and shows a toast with the Linear key; there is no page to open.
assert.equal(sheets.current, null)
const toast = lastToast()
assert.equal(toast.message, 'Feedback sent (LKM-123).')
assert.equal(toast.action, undefined)
assert.ok(toast.seconds > 0)

// --- With a saved code the form opens directly; the screenshot goes as the real image. ---
results.push({
  ok: true,
  issue: 'LKM-124',
  warning: 'The feedback was sent, but the screenshot could not be attached.'
})
await support.feedback()
assert.equal(sheets.current.state.title, 'Send feedback')
await sheets.action({
  id: sheets.current.state.id,
  action: 'send',
  values: { body: 'Look', screenshot: 'yes', conversation: 'yes', diagnostics: 'no' }
})
assert.deepEqual(calls.at(-1)[1].screenshot, { contentType: 'image/png', data: 'iVBORw0KGgo=' })
assert.equal(calls.at(-1)[1].conversation, 'You: Private conversation')
assert.equal(
  lastToast().message,
  'Feedback sent (LKM-124). The feedback was sent, but the screenshot could not be attached.'
)

// --- No network or a server error: the standard error alert; Retry sends the same input. ---
const down = { ok: false, error: 'Feedback is down.', retry: true }
results.push(down, down)
await support.feedback()
await sheets.action({ id: sheets.current.state.id, action: 'send', values: { body: ' Again ' } })
let alert = sheets.current.state
assert.equal(alert.alert, true)
assert.equal(alert.title, 'Couldn’t send feedback')
assert.equal(alert.detail, 'Feedback is down.')
assert.deepEqual(
  alert.actions.map((a) => [a.id, a.label, !!a.primary]),
  [
    ['copy', 'Copy details', false],
    ['cancel', 'Cancel', false],
    ['retry', 'Retry', true]
  ]
)
assert.match(
  alert.actions[0].copy,
  /^Trezi could not send this feedback\.\nError: Feedback is down\.[\s\S]*Feedback:\nAgain$/
)
assert.ok(!/github/i.test(alert.actions[0].copy))
await sheets.action({ id: alert.id, action: 'copy', values: {} })
assert.match(sheets.current.state.message, /copied/)
await sheets.action({ id: alert.id, action: 'retry', values: {} })
assert.equal(sheets.current.state.id, alert.id, 'a second failure keeps the alert')
assert.equal(sheets.current.state.busy, false)
await sheets.action({ id: alert.id, action: 'retry', values: {} })
assert.equal(sheets.current, null)
let posts = submits().slice(-3)
assert.equal(posts.length, 3)
assert.ok(posts.every((c) => JSON.stringify(c) === JSON.stringify(posts[0])))
assert.equal(lastToast().message, 'Feedback sent (LKM-123).')
results.push(down)
await support.feedback()
await sheets.action({ id: sheets.current.state.id, action: 'send', values: { body: 'Bug' } })
alert = sheets.current.state
await sheets.action({ id: alert.id, action: 'cancel', values: {} })
assert.equal(sheets.current, null, 'Esc cancels the error alert')

// --- A report the endpoint refused (too large, bad input): no Retry, only Close. ---
results.push({ ok: false, error: 'Report too large.', retry: false })
await support.feedback()
await sheets.action({ id: sheets.current.state.id, action: 'send', values: { body: 'Big' } })
alert = sheets.current.state
assert.equal(alert.detail, 'Report too large.')
assert.deepEqual(
  alert.actions.map((a) => [a.id, a.label, !!a.primary]),
  [
    ['copy', 'Copy details', false],
    ['cancel', 'Close', false]
  ]
)
await sheets.action({ id: alert.id, action: 'cancel', values: {} })

// --- A 429 says when; it may be retried. ---
results.push({ ok: false, error: 'Slow down. Try again in 30 seconds.', retry: true })
await support.feedback()
await sheets.action({ id: sheets.current.state.id, action: 'send', values: { body: 'Fast' } })
assert.equal(sheets.current.state.detail, 'Slow down. Try again in 30 seconds.')
assert.ok(sheets.current.state.actions.some((a) => a.id === 'retry'))
await sheets.action({ id: sheets.current.state.id, action: 'cancel', values: {} })

// --- A revoked code: enter a new one, and the same report is sent with it. ---
results.push({ ok: false, error: 'This invite code was revoked.', retry: false, code: true })
await support.feedback()
await sheets.action({ id: sheets.current.state.id, action: 'send', values: { body: 'Revoked' } })
alert = sheets.current.state
assert.equal(alert.detail, 'This invite code was revoked.')
assert.deepEqual(
  alert.actions.map((a) => [a.id, !!a.primary]),
  [
    ['copy', false],
    ['cancel', false],
    ['code', true]
  ]
)
await sheets.action({ id: alert.id, action: 'code', values: {} })
state = sheets.current.state
assert.equal(state.title, 'Enter your invite code')
await sheets.action({ id: state.id, action: 'continue', values: { code: 'good-code' } })
assert.equal(sheets.current, null, 'The resent report closes the prompt')
posts = submits().slice(-2)
assert.deepEqual(posts[1], posts[0], 'The same report, once more')
assert.equal(lastToast().message, 'Feedback sent (LKM-123).')

// --- A saved code the endpoint no longer knows asks for a new one before the form. ---
account = { hasCode: true, name: null, invalid: true, error: 'This invite code was revoked.' }
await support.feedback()
assert.equal(sheets.current.state.title, 'Enter your invite code')
assert.equal(sheets.current.state.message, 'This invite code was revoked.')
await sheets.action({
  id: sheets.current.state.id,
  action: 'continue',
  values: { code: 'good-code' }
})
assert.equal(sheets.current.state.title, 'Send feedback')
await sheets.action({ id: sheets.current.state.id, action: 'cancel', values: {} })
// Offline, the saved code still opens the form, without a name.
account = { hasCode: true, name: null, error: 'Trezi could not reach the feedback service.' }
await support.feedback()
assert.ok(sheets.current.state.detail.startsWith(FEEDBACK_PRIVACY))

await sheets.action({
  id: sheets.current.state.id,
  action: 'send',
  values: { body: 'Slow', screenshot: 'no', conversation: 'no', diagnostics: 'yes' }
})
assert.deepEqual(calls.at(-1)[1].diagnostics, true)
assert.deepEqual(calls.at(-1)[1].chat, { key: 'chat', root: '/a' })
assert.ok(!calls.some(([channel]) => /github|gh:|external/.test(channel)), 'No GitHub channel')
support.diagnose('a')
assert.equal(sheets.current.state.alert, true, 'Preview problem is an alert')
assert.deepEqual(
  sheets.current.state.actions.map((a) => a.id),
  ['cancel', 'retry', 'diagnose'],
  'an alert keeps its visible Close'
)
await sheets.action({ id: sheets.current.state.id, action: 'diagnose', values: {} })
assert.equal(sheets.current.state.alert, true, 'Suggested fix is an alert with its steps')
assert.equal(sheets.current.state.actions.find((a) => a.id === 'dismiss').cancel, true)
assert.equal(seeded.length, 0, 'diagnosis only proposes a fix')
await sheets.action({ id: sheets.current.state.id, action: 'apply', values: {} })
assert.equal(seeded[0].type, 'seed')
assert.equal(seeded[0].chat, 'chat')
assert.ok(!seeded[0].text.includes('host-command'))
assert.equal(sheets.current, null)
console.log(
  'Native support sheets: private feedback (invite code, opt-outs, errors) and proposed repo-only diagnosis passed'
)
