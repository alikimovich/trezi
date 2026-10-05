import assert from 'node:assert/strict'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import { NativeSupportSheets } from '../src/native/support-sheets.ts'

const calls = [],
  seeded = []
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
  { send() {} },
  workspace,
  chat,
  async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'feedback:submit') return { ok: true, url: 'https://example.com/issue' }
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
assert.equal(sheets.current.state.title, 'Feedback sent')
await support.feedback()
await sheets.action({
  id: sheets.current.state.id,
  action: 'send',
  values: { body: 'Slow', screenshot: 'no', conversation: 'no', diagnostics: 'yes' }
})
assert.deepEqual(calls.at(-1)[1].diagnostics, true)
assert.deepEqual(calls.at(-1)[1].chat, { key: 'chat', root: '/a' })
support.diagnose('a')
await sheets.action({ id: sheets.current.state.id, action: 'diagnose', values: {} })
assert.equal(seeded.length, 0, 'diagnosis only proposes a fix')
await sheets.action({ id: sheets.current.state.id, action: 'apply', values: {} })
assert.equal(seeded[0].type, 'seed')
assert.equal(seeded[0].chat, 'chat')
assert.ok(!seeded[0].text.includes('host-command'))
assert.equal(sheets.current, null)
console.log(
  'Native support sheets: feedback attachment opt-outs and proposed repo-only diagnosis passed'
)
