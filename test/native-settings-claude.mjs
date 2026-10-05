import assert from 'node:assert/strict'
import { withClaudePane } from '../src/native/settings-claude.ts'
import { NativeSettingsController } from '../src/native/settings-controller.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'

// Claude's sign-in (LKM-119) is a pane of the Settings window: the subscription token is a
// draft, saved or removed only by its own actions and never echoed back into the sheet.
const values = new Map(),
  sent = [],
  calls = []
let seatToken = false
const preferences = {
  get: (key) => values.get(key) ?? null,
  snapshot: () => Object.fromEntries(values),
  async apply(batch) {
    for (const [key, value] of typeof batch === 'function'
      ? batch(Object.fromEntries(values))
      : batch)
      values.set(key, value)
  },
  set(key, value) {
    return this.apply([[key, value]])
  },
  subscribe() {}
}
const sheets = new NativeSheetController(
  { send: (method, data) => sent.push([method, structuredClone(data)]) },
  {},
  {},
  async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'providers:choices')
      return [
        {
          value: 'codex:default',
          provider: 'codex',
          modelId: 'default',
          group: 'Codex',
          label: 'Default'
        }
      ]
    if (channel === 'providers:list') return []
    if (channel === 'providers:seat-token-status') return { hasToken: seatToken }
    if (channel === 'providers:seat-token-save') {
      seatToken = !!args[0]
      return { ok: true, hasToken: seatToken }
    }
    if (channel === 'providers:check-login')
      return {
        provider: 'claude',
        loggedIn: false,
        source: 'bundled',
        token: false,
        detail: 'Bundled Claude CLI: not logged in'
      }
    return {}
  }
)
const settings = withClaudePane(new NativeSettingsController(sheets, preferences, () => {}))
const action = (name, values = {}) =>
  sheets.action({ id: sheets.current.state.id, action: name, values })
const field = (id) => sheets.current.state.fields.find((f) => f.id === id)
await settings.open()
const id = sheets.current.state.id
const providerFields = () => sheets.current.state.fields.filter((f) => f.section === 'providers')
await action('claude')
assert.equal(sheets.current.state.id, id, 'the Claude pane is the same window')
assert.deepEqual(
  providerFields().map((f) => [f.id, f.kind, f.draft]),
  [['token', 'secure', true]]
)
// General's "Clean up now" survives the provider panes.
assert.deepEqual(
  sheets.current.state.actions.map((a) => a.id),
  ['clean-workspaces', 'back', 'claude-check', 'claude-save']
)
// The general fields are unchanged here, so a token edit alone must not write anything.
const unchanged = {
  default: field('default').value,
  projectUi: field('projectUi').value,
  engine: field('engine').value
}
await action('change', { ...unchanged, token: 'sk-ant-test-token' })
assert.ok(
  !JSON.stringify([...values]).includes('sk-ant-test-token'),
  'the token draft is never written as a preference'
)
await action('claude-check')
assert.match(providerFields().find((f) => f.id === 'report').label, /not logged in/i)
assert.match(providerFields().find((f) => f.id === 'report').value, /Bundled Claude CLI/)
assert.equal(
  calls.some((c) => c[0] === 'providers:check-login' && c[1] === 'claude'),
  true
)
await action('claude-save', { token: '  ' })
assert.match(sheets.current.state.message, /Paste the token/)
assert.equal(
  calls.some((c) => c[0] === 'providers:seat-token-save'),
  false,
  'an empty token is refused before the service'
)
await action('claude-save', { token: ' sk-ant-test-token ' })
assert.deepEqual(calls.filter((c) => c[0] === 'providers:seat-token-save').at(-1), [
  'providers:seat-token-save',
  'sk-ant-test-token'
])
assert.equal(sheets.current.state.message, 'Token saved. New Claude chats use it.')
assert.deepEqual(
  sheets.current.state.actions.map((a) => a.id),
  ['clean-workspaces', 'back', 'claude-check', 'claude-remove', 'claude-save']
)
assert.equal(providerFields().find((f) => f.id === 'token').value, '')
assert.ok(
  !JSON.stringify(sent).includes('sk-ant-test-token'),
  'the token must not return in sheet snapshots'
)
await action('claude-remove')
assert.deepEqual(calls.filter((c) => c[0] === 'providers:seat-token-save').at(-1), [
  'providers:seat-token-save',
  ''
])
assert.equal(sheets.current.state.message, 'Token removed.')
await action('back')
assert.deepEqual(
  providerFields().map((f) => f.id),
  ['connections']
)
assert.deepEqual(
  sheets.current.state.actions.map((a) => a.id),
  ['clean-workspaces', 'add', 'claude']
)
assert.equal(field('default').section, 'general', 'other panes survive the Claude pane')
console.log(
  'Native settings Claude pane: token draft, check login report, empty token refused, save/remove without echo and Back passed'
)
