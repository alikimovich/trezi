import assert from 'node:assert/strict'
import { NativePreviewRecovery } from '../src/native/preview-recovery.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'

// Discovery and the identity-checked stop run in the platform owner (test/platform-owner.mjs).
const entry = { key: 'a', root: '/a' },
  calls = []
const workspace = {
  state: { projects: [entry], activeKey: 'a' },
  command: async (c) => calls.push(c)
}
const sheets = new NativeSheetController({ send() {} }, workspace, {})
const server = {
  pid: 456,
  root: '/a',
  command: 'next-server',
  started: 'now',
  addresses: ['127.0.0.1:7784']
}
const recovery = new NativePreviewRecovery(
  sheets,
  async () => [server],
  async (s) => calls.push(s)
)
const settled = async () => {
  for (let i = 0; i < 100 && sheets.current?.state.busy; i++)
    await new Promise((r) => setTimeout(r, 5))
}
const act = (action, values = {}) => sheets.action({ id: sheets.current.state.id, action, values })
recovery.open('a')
await settled()
assert.equal(sheets.current.state.title, 'Running servers')
await act('stop', { server: '999' })
assert.match(sheets.current.state.message, /Select a server/)
await act('stop', { server: '456' })
assert.equal(sheets.current.state.title, 'Stop and restart the preview?')
assert.equal(calls.length, 0)
await act('cancel')
assert.equal(calls.length, 0)
recovery.open('a')
await settled()
await act('stop', { server: '456' })
workspace.state.activeKey = 'other'
await act('confirm')
assert.equal(calls.length, 0)
workspace.state.activeKey = 'a'
await act('confirm')
assert.deepEqual(calls, [server, { type: 'restart', key: 'a' }])
assert.equal(sheets.current, null)
const failing = new NativePreviewRecovery(
  sheets,
  async () => {
    throw new Error('Inspection unavailable')
  },
  async () => {}
)
failing.open('a')
await settled()
assert.match(sheets.current.state.message, /Inspection unavailable/)
assert.ok(sheets.current.state.actions.some((a) => a.id === 'refresh'))
sheets.close()

console.log('Native preview recovery: confirmation, stale project protection and restart passed')
