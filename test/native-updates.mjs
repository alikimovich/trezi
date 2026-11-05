import assert from 'node:assert/strict'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import { NativeUpdateController } from '../src/native/update-controller.ts'
import { updatePhaseStatus } from '../src/native/workflow-service.ts'

const verbose =
  'bun run build:native\nCompiler diagnostic: /private/source/file.swift:99\nSigning output'
for (const [steps, expected] of [
  [[{ name: 'pull', state: 'intent' }], 'Downloading changes…'],
  [
    [
      { name: 'pull', state: 'done' },
      { name: 'install', state: 'intent' }
    ],
    'Installing dependencies…'
  ],
  [
    [
      { name: 'pull', state: 'done' },
      { name: 'install', state: 'done' },
      { name: 'build', state: 'intent' }
    ],
    'Building Trezi…'
  ],
  [[{ name: 'pull', state: 'done' }], 'Preparing update…']
]) {
  const displayed = updatePhaseStatus({
    kind: 'update',
    state: 'running',
    steps,
    progress: verbose
  })
  assert.equal(displayed, expected)
  assert.doesNotMatch(displayed, /Compiler|Signing|bun run/)
}

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
  () => blocked,
  () => null
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
assert.match(sheets.current.state.detail, /Save source drafts/)
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
  () => (++checks === 1 ? null : 'New unsaved content draft'),
  () => null
)
await changingDraft.apply()
assert.equal(restarts, 1)
assert.equal(sheets.current.state.title, 'Update could not finish')
assert.match(sheets.current.state.detail, /New unsaved content draft/)
let proofRestarted = false
const invalidArtifact = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    proofRestarted = true
  },
  owner,
  () => null,
  () => 'The built application does not match the updated version and commit.'
)
await invalidArtifact.apply()
assert.equal(proofRestarted, false, 'an unproved build cannot restart')
assert.match(sheets.current.state.detail, /does not match/)
let releaseUpdate
let started = 0
const pending = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  {
    updateCheck: owner.updateCheck,
    update: async (_root, progress) => {
      started++
      progress(
        updatePhaseStatus({
          kind: 'update',
          state: 'running',
          steps: [
            { name: 'pull', state: 'done' },
            { name: 'install', state: 'done' },
            { name: 'build', state: 'intent' }
          ],
          progress: verbose
        })
      )
      return new Promise((resolve) => {
        releaseUpdate = resolve
      })
    }
  },
  () => null,
  () => null
)
const first = pending.apply()
assert.equal(sheets.current.state.title, 'Updating Trezi')
assert.equal(sheets.current.state.message, 'Building Trezi…')
assert.doesNotMatch(sheets.current.state.message, /Compiler|Signing|bun run/)
await pending.apply()
assert.equal(started, 1, 'duplicate Update cannot start another owner workflow')
releaseUpdate({ ok: true })
await first
assert.equal(restarts, 2)
const current = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  { updateCheck: async () => ({ status: 'idle', behind: 0 }), update: owner.update },
  () => null,
  () => null
)
current.open()
await action('check')
assert.equal(sheets.current.state.title, 'No update found')
assert.deepEqual(
  sheets.current.state.actions.map((entry) => entry.id),
  ['cancel']
)
const failedCheck = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  {
    updateCheck: async () => ({ status: 'error', behind: 0, error: 'Network unavailable' }),
    update: owner.update
  },
  () => null,
  () => null
)
failedCheck.open()
await action('check')
assert.match(sheets.current.state.detail, /Network unavailable/)
assert.equal(restarts, 2)
await action('retry')
assert.equal(sheets.current.state.title, 'Trezi updates', 'check retry returns to the check action')
console.log('Native updates: owner-run update, draft guards, failure recovery and restart passed')
