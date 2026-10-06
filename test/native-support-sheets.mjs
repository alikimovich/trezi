import assert from 'node:assert/strict'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import { NativeSupportSheets } from '../src/native/support-sheets.ts'

const calls = [],
  seeded = [],
  sent = []
let failures = 0
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
    if (channel === 'feedback:submit')
      return failures-- > 0
        ? { ok: false, error: 'gh auth login required' }
        : { ok: true, url: 'https://example.com/issue' }
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
const support = new NativeSupportSheets(
  sheets,
  async () => 'data:image/jpeg;base64,AA==',
  async (url) => calls.push(['external', url])
)
await support.feedback()
assert.ok(sheets.current.state.fields.some((f) => f.kind === 'image'))
// LKM-165: diagnostics need explicit consent, which defaults to off and says what it covers.
const consent = sheets.current.state.fields.find((f) => f.id === 'diagnostics')
assert.equal(consent?.kind, 'choice')
assert.equal(consent.value, 'no')
assert.match(
  sheets.current.state.fields.find((f) => f.id === 'diagnostics-detail').value,
  /logs from the last hour.*landing state.*git status.*3-second sample.*Secrets are removed.*~/s
)
const id = sheets.current.state.id
await sheets.action({
  id,
  action: 'send',
  values: { body: 'Bug', screenshot: 'no', conversation: 'no', diagnostics: 'no' }
})
assert.deepEqual(calls.at(-1), [
  'feedback:submit',
  { body: 'Bug', screenshot: null, conversation: null, diagnostics: false, chat: null }
])
// Success closes the form and shows a toast, not a "Feedback sent" window.
assert.equal(sheets.current, null)
const toast = sent.findLast(([method]) => method === 'toastState')[1].state
assert.equal(toast.message, 'Feedback sent')
assert.equal(toast.action, 'View on GitHub')
assert.ok(toast.seconds > 0)
await sheets.toastAction({ id: 'stale', action: 'run' })
assert.ok(!calls.some((c) => c[0] === 'external'), 'a stale toast id does nothing')
await sheets.toastAction({ id: toast.id })
assert.deepEqual(calls.at(-1), ['external', 'https://example.com/issue'])
await sheets.toastAction({ id: toast.id })
assert.equal(calls.filter((c) => c[0] === 'external').length, 1, 'the action runs once')

// A failed post: the standard error alert, Retry (default) posts the same input again.
failures = 2
await support.feedback()
await sheets.action({ id: sheets.current.state.id, action: 'send', values: { body: ' Again ' } })
let alert = sheets.current.state
assert.equal(alert.alert, true)
assert.equal(alert.title, 'Couldn’t send feedback')
assert.equal(alert.detail, 'gh auth login required')
assert.deepEqual(
  alert.actions.map((a) => [a.id, a.label, !!a.primary]),
  [
    ['copy', 'Copy details', false],
    ['cancel', 'Cancel', false],
    ['retry', 'Retry', true]
  ]
)
assert.match(alert.actions[0].copy, /gh auth login required[\s\S]*Feedback:\nAgain$/)
await sheets.action({ id: alert.id, action: 'copy', values: {} })
assert.match(sheets.current.state.message, /copied/)
await sheets.action({ id: alert.id, action: 'retry', values: {} })
assert.equal(sheets.current.state.id, alert.id, 'a second failure keeps the alert')
assert.equal(sheets.current.state.busy, false)
await sheets.action({ id: alert.id, action: 'retry', values: {} })
assert.equal(sheets.current, null)
const posts = calls.filter((c) => c[0] === 'feedback:submit').slice(-3)
assert.equal(posts.length, 3)
assert.ok(posts.every((c) => JSON.stringify(c) === JSON.stringify(posts[0])))
assert.equal(sent.findLast(([method]) => method === 'toastState')[1].state.message, 'Feedback sent')
failures = 1
await support.feedback()
await sheets.action({ id: sheets.current.state.id, action: 'send', values: { body: 'Bug' } })
alert = sheets.current.state
await sheets.action({ id: alert.id, action: 'cancel', values: {} })
assert.equal(sheets.current, null, 'Esc cancels the error alert')

await support.feedback()
await sheets.action({
  id: sheets.current.state.id,
  action: 'send',
  values: { body: 'Slow', screenshot: 'no', conversation: 'no', diagnostics: 'yes' }
})
assert.deepEqual(calls.at(-1)[1].diagnostics, true)
assert.deepEqual(calls.at(-1)[1].chat, { key: 'chat', root: '/a' })
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
  'Native support sheets: feedback attachment opt-outs and proposed repo-only diagnosis passed'
)
