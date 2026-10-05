import assert from 'node:assert/strict'
import { NativeSettingsController } from '../src/native/settings-controller.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'

const values = new Map(),
  sent = [],
  calls = []
let connections = [],
  catalogWait
let failNext = null,
  gate = null,
  applyBlocked = false,
  applies = 0
const preferences = {
  get: (key) => values.get(key) ?? null,
  snapshot: () => Object.fromEntries(values),
  async apply(batch) {
    applies++
    const entries = typeof batch === 'function' ? batch(Object.fromEntries(values)) : batch
    if (gate) {
      applyBlocked = true
      await gate
      applyBlocked = false
    }
    if (failNext) {
      const error = failNext
      failNext = null
      throw error
    }
    for (const [key, value] of entries) values.set(key, value)
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
    if (channel === 'providers:list') return connections
    if (channel === 'providers:catalog')
      return catalogWait ? await catalogWait : { ok: true, models: ['a', 'b'] }
    if (channel === 'providers:save') {
      connections = [{ ...args[0], apiKey: undefined, id: 'connection-1', hasKey: true }]
      return { ok: true, connection: connections[0] }
    }
    if (channel === 'providers:remove') connections = []
    if (channel === 'chat-workspaces:usage') return { bytes: (3 * 1024 ** 3) / 2, workspaces: 3 }
    if (channel === 'chat-workspaces:clean-up')
      return {
        removed: 2,
        keptDirty: 1,
        skipped: 0,
        legacyRemoved: 0,
        usage: { bytes: 512 * 1024, workspaces: 1 }
      }
    return {}
  }
)
let notified = 0
const settings = new NativeSettingsController(sheets, preferences, () => notified++)
const action = (name, values = {}) =>
  sheets.action({ id: sheets.current.state.id, action: name, values })
const field = (id) => sheets.current.state.fields.find((f) => f.id === id)
await settings.open()
// One sidebar window: General, AI Providers (inline, no separate sheet) and Experimental.
assert.deepEqual(
  sheets.current.state.sections.map((s) => [s.id, s.label, s.symbol]),
  [
    ['general', 'General', 'gearshape'],
    ['providers', 'AI Providers', 'sparkles'],
    ['experimental', 'Experimental', 'testtube.2']
  ]
)
assert.equal(sheets.current.state.section, 'general', 'first open shows General')
assert.deepEqual(
  sheets.current.state.fields.map((f) => [f.id, f.section]),
  [
    ['default', 'general'],
    ['claudePlugins', 'general'],
    ['agentFileAccess', 'general'],
    ['workspaceIdle', 'general'],
    ['activityAutoOpen', 'general'],
    ['workspaceUsage', 'general'],
    ['version', 'general'],
    ['projectUi', 'experimental'],
    ['engine', 'experimental'],
    ['connections', 'providers']
  ]
)
// LKM-152: Show Activity automatically, default "For problems that need me", persists.
assert.equal(field('activityAutoOpen').label, 'Show Activity automatically')
assert.equal(field('activityAutoOpen').value, 'problems')
assert.deepEqual(
  field('activityAutoOpen').choices.map((c) => [c.value, c.label]),
  [
    ['never', 'Never'],
    ['problems', 'For problems that need me'],
    ['always', 'Always']
  ]
)
await action('change', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  activityAutoOpen: 'never'
})
assert.equal(values.get('trezi:activity-auto-open:v1'), 'never')
await action('change', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  activityAutoOpen: 'sometimes'
})
assert.match(sheets.current.state.message, /Invalid setting/)
await action('change', { default: 'last-used', projectUi: 'false', engine: 'agent' })
assert.equal(
  values.get('trezi:activity-auto-open:v1'),
  'never',
  'a caller without the field leaves it unchanged'
)
await settings.open()
assert.equal(field('activityAutoOpen').value, 'never', 'reopen shows the saved choice')
await action('change', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  activityAutoOpen: 'always'
})
assert.equal(values.get('trezi:activity-auto-open:v1'), 'always')
values.delete('trezi:activity-auto-open:v1')
await settings.open()
// LKM-163: Agent file access defaults to Full access, persists, and rejects other values.
assert.equal(field('agentFileAccess').label, 'Agent file access')
assert.equal(field('agentFileAccess').value, 'full', 'Full access is the default')
assert.deepEqual(
  field('agentFileAccess').choices.map((c) => [c.value, c.label]),
  [
    ['full', 'Full access'],
    ['project', 'Project only']
  ]
)
await action('change', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  agentFileAccess: 'project'
})
assert.equal(values.get('trezi:agent-file-access:v1'), 'project')
await action('change', { default: 'last-used', projectUi: 'false', engine: 'agent' })
assert.equal(
  values.get('trezi:agent-file-access:v1'),
  'project',
  'a caller without the field leaves it unchanged'
)
await action('change', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  agentFileAccess: 'sandboxed'
})
assert.match(sheets.current.state.message, /Invalid setting/)
assert.equal(values.get('trezi:agent-file-access:v1'), 'project')
await settings.open()
assert.equal(field('agentFileAccess').value, 'project', 'reopen shows the saved choice')
await action('change', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  agentFileAccess: 'full'
})
assert.equal(values.get('trezi:agent-file-access:v1'), 'full')
values.set('trezi:agent-file-access:v1', 'bogus')
await settings.open()
assert.equal(field('agentFileAccess').value, 'full', 'an unknown stored value reads as Full access')
values.delete('trezi:agent-file-access:v1')
await settings.open()
// LKM-143: General shows the version as a read-only row (the build stamps the label; unbuilt source says so).
assert.equal(field('version').kind, 'readonly')
assert.equal(field('version').value, 'Trezi (unbuilt development source)')
// LKM-138: "Allow my Claude Code plugins in Trezi chats" defaults to off and persists.
assert.equal(field('claudePlugins').label, 'Allow my Claude Code plugins in Trezi chats')
assert.equal(field('claudePlugins').value, 'false')
assert.deepEqual(
  field('claudePlugins').choices.map((c) => c.value),
  ['false', 'true']
)
await action('change', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  claudePlugins: 'true'
})
assert.equal(values.get('trezi:claude-user-plugins:v1'), 'true')
await action('change', { default: 'last-used', projectUi: 'false', engine: 'agent' })
assert.equal(
  values.get('trezi:claude-user-plugins:v1'),
  'true',
  'a caller without the field leaves it unchanged'
)
await settings.open()
assert.equal(field('claudePlugins').value, 'true', 'reopen shows the saved choice')
await action('change', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  claudePlugins: 'yes'
})
assert.match(sheets.current.state.message, /Invalid setting/)
assert.equal(values.get('trezi:claude-user-plugins:v1'), 'true')
await action('change', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  claudePlugins: 'false'
})
assert.equal(values.get('trezi:claude-user-plugins:v1'), 'false')
notified = 0
await settings.open()
assert.equal(
  sheets.current.state.actions.some(
    (a) => a.id === 'save' || a.id === 'cancel' || a.id === 'connections'
  ),
  false
)
assert.deepEqual(
  sheets.current.state.actions.map((a) => [a.id, a.section]),
  [
    ['clean-workspaces', 'general'],
    ['add', 'providers']
  ]
)
// LKM-136: idle cleanup period (default 7 days), the disk use of chat workspaces
// (read after the window opens, never autosaved) and "Clean up now".
assert.equal(field('workspaceIdle').value, '7')
assert.deepEqual(
  field('workspaceIdle').choices.map((c) => c.value),
  ['1', '3', '7', '14', '30', 'never']
)
assert.equal(field('workspaceUsage').draft, true)
while (field('workspaceUsage').value === 'Calculating…') await new Promise((r) => setTimeout(r, 5))
assert.equal(field('workspaceUsage').value, '1.5 GB in 3 workspaces')
await action('clean-workspaces', {
  default: 'last-used',
  projectUi: 'false',
  engine: 'agent',
  workspaceIdle: '7'
})
assert.ok(
  calls.some((c) => c[0] === 'chat-workspaces:clean-up'),
  'Clean up now runs the cleanup'
)
assert.equal(field('workspaceUsage').value, '512 KB in 1 workspace')
assert.equal(sheets.current.state.message, 'Removed 2 idle chat workspaces.')
await action('change', {
  default: 'codex:default',
  projectUi: 'false',
  engine: 'agent',
  workspaceIdle: 'never'
})
assert.equal(values.get('trezi:chat-workspace-idle-days:v1'), 'never')
await action('change', {
  default: 'codex:default',
  projectUi: 'false',
  engine: 'agent',
  workspaceIdle: '2'
})
assert.match(sheets.current.state.message, /Invalid setting/)
await action('change', {
  default: 'codex:default',
  projectUi: 'false',
  engine: 'agent',
  workspaceIdle: '14'
})
assert.equal(values.get('trezi:chat-workspace-idle-days:v1'), '14')
assert.equal(JSON.parse(values.get('trezi:preferred-model')).fixed.provider, 'codex')
assert.equal(notified, 2, 'every saved change notifies; the rejected one does not')
await settings.open()
assert.equal(field('workspaceIdle').value, '14')
const fields = sheets.current.state.fields
assert.equal(fields.find((f) => f.id === 'projectUi').label, 'Gen UI')
assert.match(
  fields.find((f) => f.id === 'projectUi').help,
  /existing components and styles.*React and Svelte/
)
assert.deepEqual(fields.find((f) => f.id === 'engine').visibleWhen, {
  field: 'projectUi',
  value: 'true'
})
assert.match(fields.find((f) => f.id === 'engine').help, /Chat model.*Jev.*Gateway/)
assert.equal(fields.find((f) => f.id === 'projectUi').value, 'false')
await action('change', { default: 'codex:default', projectUi: 'true', engine: 'jev' })
await action('change', { default: 'codex:default', projectUi: 'false', engine: 'jev' })
await settings.open()
assert.equal(sheets.current.state.fields.find((f) => f.id === 'projectUi').value, 'false')
assert.equal(sheets.current.state.fields.find((f) => f.id === 'engine').value, 'jev')
await action('change', { default: 'codex:default', projectUi: 'true', engine: 'jev' })
assert.equal(values.get('trezi:project-ui:v1'), 'true')
assert.equal(values.get('trezi:project-ui-engine:v1'), 'jev')

// The last selected section is remembered across reopen; unknown sections are ignored.
const settingsId = sheets.current.state.id
await sheets.action({ id: settingsId, action: 'section', values: {}, section: 'providers' })
await sheets.action({ id: settingsId, action: 'section', values: {}, section: 'bogus' })
assert.equal(values.get('trezi:settings-section:v1'), 'providers')
assert.equal(sheets.current.state.section, 'providers')
await settings.open()
assert.equal(sheets.current.state.section, 'providers', 'reopen restores the last section')
assert.equal(field('projectUi').value, 'true')

// AI Providers is edited in place: the Settings window (same ID) stays open.
const inPlace = sheets.current.state.id
const saves = () => calls.length
await action('add')
assert.equal(sheets.current.state.id, inPlace)
assert.deepEqual(
  sheets.current.state.fields.filter((f) => f.section === 'providers').map((f) => [f.id, f.draft]),
  [
    ['label', true],
    ['url', true],
    ['key', true],
    ['models', true]
  ]
)
assert.equal(field('default').section, 'general', 'other panes survive the editor')
const draft = {
  label: 'Test',
  url: 'https://provider.example/v1',
  key: 'fake-test-key',
  models: 'a,b'
}
// Typing in the provider form never autosaves the draft or its key.
const applied = applies
await action('change', { default: 'codex:default', projectUi: 'true', engine: 'jev', ...draft })
assert.equal(applies, applied, 'draft provider fields are not autosaved')
await action('connect', draft)
assert.equal(field('models').kind, 'multichoice')
assert.ok(!JSON.stringify(sent).includes('fake-test-key'), 'keys must not return in form snapshots')
const before = saves()
await action('save-provider', draft)
assert.ok(
  calls.slice(before).some((c) => c[0] === 'providers:choices'),
  'saving a provider refreshes the default-model choices'
)
assert.equal(connections.length, 1)
assert.deepEqual(connections[0].models, ['a', 'b'])
assert.equal(sheets.current.state.id, inPlace)
assert.equal(field('connection').value, 'connection-1')
await action('edit', { connection: 'connection-1' })
assert.equal(field('key').help, 'Leave blank to keep the current key.')
await action('save-provider', { ...draft, url: 'https://different.example/v1', key: '' })
assert.match(sheets.current.state.message, /API key/)
await action('save-provider', { ...draft, key: '' })
assert.ok(
  !('apiKey' in calls.filter((c) => c[0] === 'providers:save').at(-1)[1]),
  'blank key preserves same-origin credentials'
)
await action('delete', { connection: 'connection-1' })
assert.equal(connections.length, 1, 'deletion requires confirmation screen')
assert.match(field('remove-confirm').label, /Remove Test\?/)
await action('remove')
assert.equal(connections.length, 0)
assert.equal(field('connections').value, 'None')
assert.equal(sheets.current.state.id, inPlace)
await action('add')
let resolve
catalogWait = new Promise((r) => (resolve = r))
const old = sheets.current.state.id
const pending = action('connect', draft)
await sheets.action({ id: old, action: 'cancel', values: {} })
resolve({ ok: true, models: ['late'] })
await pending
assert.equal(sheets.current, null, 'late catalog must not reopen canceled sheet')

// A failed save keeps the draft; closing waits for the retried save to settle.
await settings.open()
values.set('trezi:project-ui:v1', 'false')
failNext = new Error('disk full')
await action('change', { default: 'last-used', projectUi: 'true', engine: 'agent' })
assert.match(sheets.current.state.message, /Could not save: disk full.*draft is still here/)
assert.equal(values.get('trezi:project-ui:v1'), 'false', 'nothing was written by the failed batch')
let release
gate = new Promise((r) => (release = r))
const closing = action('cancel')
while (!applyBlocked) await new Promise((r) => setTimeout(r, 10))
assert.ok(sheets.current, 'close waits for the pending save')
release()
gate = null
await closing
assert.equal(sheets.current, null)
assert.equal(values.get('trezi:project-ui:v1'), 'true', 'the retained draft was saved on close')
assert.equal(JSON.parse(values.get('trezi:preferred-model')).mode, 'last-used')
console.log(
  'Native settings: sidebar sections and remembered section, defaults, inline provider catalog/save/delete without autosaving drafts, key handling, cancellation, failed-draft retention and close-waits-for-save passed'
)
