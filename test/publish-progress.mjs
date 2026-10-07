import assert from 'node:assert/strict'
import {
  publishCancellable,
  publishedMessage,
  publishFailure,
  publishLabel,
  publishProgress
} from '../src/shared/publish-progress.ts'

// Labels: at once, per step, elapsed after 3 s, cancelling.
assert.equal(publishLabel('merge', {}), 'Publishing…')
assert.equal(publishLabel('pr', {}), 'Creating PR…')
assert.equal(publishLabel('merge', { step: 'sync', since: 1000 }, 3500), 'Syncing with GitHub…')
assert.equal(publishLabel('merge', { step: 'push', since: 1000 }, 5200), 'Pushing… 4s')
assert.equal(publishLabel('merge', { step: 'merge', cancelling: true }), 'Cancelling…')
assert.equal(publishLabel('merge', { step: 'unknown' }), 'Publishing…')
assert.ok(
  publishCancellable(undefined) && publishCancellable('push') && publishCancellable('describe')
)
assert.ok(
  !publishCancellable('pr') && !publishCancellable('merge') && !publishCancellable('cleanup')
)

// The newest publish on the root; the journal's open step when the owner has no live one.
const summary = (id, started, state, extra = {}) => ({
  id,
  kind: 'publish',
  root: '/a',
  params: {},
  state,
  steps: [],
  result: null,
  started,
  updated: started,
  ...extra
})
const workflows = [
  summary('old', '2026-10-01T00:00:00.000Z', 'done', { result: { ok: true } }),
  summary('new', '2026-10-02T00:00:00.000Z', 'running', {
    step: 'push',
    stepSince: '2026-10-02T00:00:01.000Z'
  }),
  { ...summary('other', '2026-10-03T00:00:00.000Z', 'running'), root: '/b' },
  { ...summary('update', '2026-10-04T00:00:00.000Z', 'running'), kind: 'update' }
]
assert.deepEqual(publishProgress(workflows, '/a'), {
  id: 'new',
  state: 'running',
  step: 'push',
  since: Date.parse('2026-10-02T00:00:01.000Z'),
  result: null
})
assert.equal(publishProgress(workflows, '/c'), null)
const relaunched = summary('r', '2026-10-05T00:00:00.000Z', 'running', {
  steps: [
    { name: 'commit', state: 'done' },
    { name: 'push', state: 'intent' }
  ]
})
assert.equal(publishProgress([relaunched], '/a').step, 'push')
assert.equal(publishProgress([summary('d', 'x', 'describe')], '/a').step, 'describe')
assert.deepEqual(
  publishProgress([summary('f', 'x', 'failed', { result: { ok: false, error: 'no' } })], '/a')
    .result,
  { ok: false, error: 'no' }
)

// Result text.
const url = 'https://github.com/o/r/pull/5'
assert.equal(publishedMessage('merge', { ok: true, url }), 'Published — PR #5 merged')
assert.equal(publishedMessage('pr', { ok: true, url }), 'Pull request #5 opened')
assert.equal(publishedMessage('merge', { ok: true }), 'Published')

const conflict = publishFailure('merge', {
  ok: false,
  error: 'Merge conflict',
  conflictFiles: ['src/app.ts', 'README.md'],
  recoveryRefs: ['refs/trezi/recovery/x-local'],
  step: 'push'
})
assert.equal(conflict.title, 'Couldn’t publish')
assert.match(conflict.detail, /^Stopped at: Pushing\./)
assert.match(conflict.detail, /edit the same lines/)
assert.match(conflict.detail, /Conflicting files:\nsrc\/app\.ts\nREADME\.md/)
assert.match(conflict.details, /failed at: Pushing/)
assert.match(conflict.details, /Recovery refs: refs\/trezi\/recovery\/x-local/)
const auth = publishFailure('pr', {
  ok: false,
  error: 'gh: To get started with GitHub CLI, please run: gh auth login',
  step: 'pr'
})
assert.equal(auth.title, 'Couldn’t create the pull request')
assert.match(auth.detail, /Stopped at: Creating pull request\./)
assert.match(auth.detail, /GitHub refused the request/)
assert.match(
  publishFailure('merge', { ok: false, error: 'Could not resolve host: github.com', step: 'sync' })
    .detail,
  /could not be reached/
)
const plain = publishFailure('merge', { ok: false, error: 'Nothing to publish — no changes.' })
assert.equal(plain.detail, 'Nothing to publish — no changes.')

console.log('Publish progress: labels, steps, adoption reads, result and failure text passed')
