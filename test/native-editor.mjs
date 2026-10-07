import assert from 'node:assert/strict'
import { NativeEditorController } from '../src/native/editor-controller.ts'

const files = new Map([
  ['a.ts', 'export const a = 1'],
  ['b.ts', 'export const b = 2']
])
const calls = [],
  states = []
let finishSave,
  slow = false
const controller = new NativeEditorController(
  async (channel, root, source, baseline, content) => {
    calls.push([channel, root, source, baseline, content])
    if (channel === 'source:tree') return [...files.keys()]
    if (channel === 'source:read') {
      const file = source.replace(/:\d+(?::\d+)?$/, '')
      return files.has(file) ? { file, code: files.get(file), line: 1 } : null
    }
    if (channel === 'source:write') {
      source = source.replace(/:\d+(?::\d+)?$/, '')
      if (slow)
        await new Promise((resolve) => {
          finishSave = resolve
        })
      if (files.get(source) !== baseline) return { ok: false, conflict: true }
      files.set(source, content)
      return { ok: true }
    }
    if (channel === 'source:rename-file') {
      files.set(baseline, files.get(source))
      files.delete(source)
      return { ok: true, path: baseline }
    }
  },
  (state) => states.push(structuredClone(state))
)
const action = (action, extra = {}) => controller.action({ action, root: '/fixture', ...extra })
await controller.open('/fixture', 'a.ts:1')
assert.equal(states.at(-1).text, 'export const a = 1')
await action('edit', { source: 'a.ts', revision: 2, text: 'draft' })
await action('open', { source: 'b.ts' })
await action('open', { source: 'a.ts' })
assert.equal(states.at(-1).text, 'draft')
assert.equal(states.at(-1).dirty, true)
await action('edit', { source: 'a.ts', revision: 1, text: 'stale' })
assert.equal(states.at(-1).text, 'draft')
files.set('a.ts', 'external')
await action('save')
assert.equal(states.at(-1).conflict, true)
assert.equal(files.get('a.ts'), 'external')
assert.equal(states.at(-1).text, 'draft')
await action('reload')
assert.equal(states.at(-1).text, 'external')
assert.equal(states.at(-1).dirty, false)
await action('edit', { source: 'a.ts', revision: 4, text: 'saved' })
slow = true
const saving = action('save')
await new Promise((resolve) => setTimeout(resolve, 0))
await action('edit', { source: 'a.ts', revision: 5, text: 'newer draft' })
finishSave()
await saving
slow = false
assert.equal(files.get('a.ts'), 'saved')
assert.equal(states.at(-1).text, 'newer draft')
assert.equal(states.at(-1).dirty, true)
await action('rename', { name: 'renamed.ts' })
assert.equal(states.at(-1).source, 'renamed.ts')
assert.equal(states.at(-1).text, 'newer draft')
await action('popout')
await action('hide')
await controller.open('/fixture')
assert.equal(states.at(-1).popped, true)
assert.equal(states.at(-1).text, 'newer draft')
await controller.open('/other', 'b.ts')
assert.equal(controller.session('/fixture').state.text, 'newer draft')
console.log(
  'Native editor: scoped drafts, stale revisions, drift conflicts, in-flight edits, rename and pop-out reuse passed'
)

await controller.open('/other', 'a.ts:1:0')
await action('back')
assert.ok(states.at(-1).canForward)
await action('forward')
assert.ok(states.at(-1).reveal > 0)

// Wrap Lines (LKM-192): on by default, one remembered preference for every editor.
const stored = new Map(),
  wrapped = []
const wrapping = new NativeEditorController(
  async (channel, _root, source) =>
    channel === 'source:tree'
      ? ['a.ts']
      : channel === 'source:read'
        ? { file: source, code: 'x', line: 1 }
        : undefined,
  (state) => wrapped.push(structuredClone(state)),
  { get: (key) => stored.get(key) ?? null, set: async (key, value) => void stored.set(key, value) }
)
await wrapping.open('/one', 'a.ts')
await wrapping.open('/two', 'a.ts')
assert.equal(wrapped.at(-1).wrap, true, 'Wrap Lines is on by default')
await wrapping.action({ root: '/two', action: 'wrap', wrap: false })
assert.equal(stored.get('trezi:source-wrap'), '0')
assert.deepEqual(
  wrapped.slice(-2).map((state) => [state.root, state.wrap]),
  [
    ['/one', false],
    ['/two', false]
  ],
  'Turning it off reaches every open editor'
)
await wrapping.action({ root: '/one', action: 'wrap', wrap: true })
assert.equal(stored.get('trezi:source-wrap'), '1')
assert.equal(wrapped.at(-1).wrap, true)
console.log('Native editor: Wrap Lines defaults on, persists and reaches every editor')
