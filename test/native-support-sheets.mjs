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
  chats: new Map([['chat', { messages: [{ role: 'user', text: 'Private conversation' }] }]]),
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
const id = sheets.current.state.id
await sheets.action({
  id,
  action: 'send',
  values: { body: 'Bug', screenshot: 'no', conversation: 'no' }
})
assert.deepEqual(calls.at(-1), [
  'feedback:submit',
  { body: 'Bug', screenshot: null, conversation: null }
])
assert.equal(sheets.current.state.title, 'Feedback sent')
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
