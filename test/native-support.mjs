import assert from 'node:assert/strict'
import { NativeActivityController } from '../src/native/activity-controller.ts'
import { NativeReviewController } from '../src/native/review-controller.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'

const messages = [],
  calls = []
const log = new NativeActivityController((method, state) =>
  messages.push([method, structuredClone(state)])
)
for (let i = 0; i < 800; i++) log.append('x'.repeat(30000))
assert.ok(log.lines.length <= 500)
assert.ok(log.lines.reduce((sum, line) => sum + line.text.length, 0) <= 500000)
assert.equal(messages.length, 0, 'hidden output does not repaint')
log.append('failure', 'error')
assert.equal(log.visible, false, 'an ordinary error is logged without opening Activity (LKM-152)')
log.append('failure', 'needs-action', { event: 'fixture' })
assert.equal(log.visible, true)
log.action('clear')
assert.equal(log.lines.length, 0)
log.action('hide')
assert.equal(log.visible, false)
const record = {
  id: 'run',
  projectName: 'Repo',
  projectRoot: '/repo',
  title: 'Edit',
  startedAt: Date.now(),
  kind: 'comment',
  branch: 'trezi/run',
  sdkSessionId: 'sdk',
  filesTouched: ['app.ts'],
  transcript: [{ role: 'user', text: 'Change spacing' }]
}
let fail = true,
  pending
const workspace = {
  state: { projects: [{ key: 'repo', root: '/repo' }], history: {} },
  changed() {},
  command: async (value) => calls.push(['workspace', value])
}
const sheets = new NativeSheetController({ send() {} }, workspace, {}, async (channel, ...args) => {
  calls.push([channel, ...args])
  if (channel === 'sessions:get') return pending ? await pending : structuredClone(record)
  if (channel === 'sessions:list') return []
  if (channel === 'agent:spawn-apply')
    return fail ? { ok: false, error: 'Conflict in app.ts' } : { ok: true }
  return { ok: true }
})
const review = new NativeReviewController(sheets, async (url) => calls.push(['external', url]))
await review.open('run')
assert.ok(sheets.current.state.fields.every((f) => f.kind === 'readonly'))
let id = sheets.current.state.id
await sheets.action({ id, action: 'apply', values: {} })
assert.match(sheets.current.state.message, /Conflict/)
fail = false
await sheets.action({ id, action: 'apply', values: {} })
assert.match(sheets.current.state.message, /Applied/)
await sheets.action({ id, action: 'resume', values: {} })
assert.equal(sheets.current, null)
assert.deepEqual(calls.at(-1), ['workspace', { type: 'resume', key: 'repo', record: 'run' }])
await review.open('run')
id = sheets.current.state.id
await sheets.action({ id, action: 'discard', values: {} })
assert.ok(!calls.some((c) => c[0] === 'agent:spawn-discard'))
await sheets.action({ id: sheets.current.state.id, action: 'discard', values: {} })
assert.ok(calls.some((c) => c[0] === 'sessions:remove'))
assert.equal(sheets.current, null)
let resolve
pending = new Promise((r) => {
  resolve = r
})
const opening = review.open('run')
sheets.close()
resolve(record)
await opening
assert.equal(sheets.current, null, 'dismissed review fetch does not reopen')
console.log(
  'Native support: bounded activity buffer, error presentation, review conflict/resume/discard and cancellation passed'
)
