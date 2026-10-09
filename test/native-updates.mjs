import assert from 'node:assert/strict'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import { NativeUpdateController } from '../src/native/update-controller.ts'

const sheets = new NativeSheetController({ send() {} }, {}, {}, async () => {})
let answer = { ok: true },
  blocked = null,
  restarts = 0
const calls = []
// The workflow owner's update (WorkflowSetup.swift): it refuses local changes itself.
const owner = {
  updateCheck: async (root) => {
    calls.push(['check', root])
    return { status: 'available', behind: 1, subject: 'Fixture update' }
  },
  update: async (root, progress) => {
    calls.push(['update', root])
    progress('pulling')
    return answer
  }
}
const update = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  owner,
  () => blocked
)
const action = async (name) =>
  sheets.action({ id: sheets.current.state.id, action: name, values: {} })
await update.open()
await action('check')
assert.ok(sheets.current.state.actions.some((a) => a.id === 'apply'))
assert.match(sheets.current.state.detail, /1 new change available/)
answer = {
  ok: false,
  error: 'Your Trezi installation has local changes. Commit or stash them before updating.'
}
await action('apply')
assert.match(sheets.current.state.detail, /local changes/)
assert.equal(restarts, 0)
blocked = 'Save source drafts'
await action('retry')
assert.match(sheets.current.state.message, /Save source drafts/)
assert.equal(
  calls.filter((c) => c[0] === 'update').length,
  1,
  'a blocked restart never starts the update'
)
blocked = null
answer = { ok: true }
await action('retry')
assert.equal(restarts, 1)
assert.deepEqual(calls, [
  ['check', '/fixture'],
  ['update', '/fixture'],
  ['update', '/fixture']
])
let checks = 0
const changingDraft = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  owner,
  () => (++checks === 1 ? null : 'New unsaved content draft')
)
await changingDraft.apply()
assert.equal(restarts, 1)
assert.equal(sheets.current.state.title, 'Update could not finish')
assert.match(sheets.current.state.detail, /New unsaved content draft/)
console.log('Native updates: owner-run update, draft guards, failure recovery and restart passed')
