import assert from 'node:assert/strict'
import {
  assertSectionEvidence,
  assertSettingsEvidence,
  assertSidebarParity,
  settingsVerificationWidths
} from '../src/native/settings-verification.ts'

const help =
  'Generate UI using your project’s existing components and styles. Experimental; supports React and Svelte.'
const engineHelp =
  'Chat model uses your selected chat model to arrange components. Jev uses a separate layout model and requires an AI Gateway API key.'
const control = (id, selected) => ({
  id,
  selected,
  enabled: true,
  contained: true,
  hitTarget: true
})
const sections = [
  { id: 'general', label: 'General', symbol: 'gearshape' },
  { id: 'providers', label: 'AI Providers', symbol: 'sparkles' },
  { id: 'experimental', label: 'Experimental', symbol: 'testtube.2' },
  { id: 'dreamer', label: 'Dreamer', symbol: 'moon.stars' }
]
const sidebar = (section) => ({
  section,
  sections: structuredClone(sections),
  sidebarRows: 4,
  sidebarSelected: sections.findIndex((s) => s.id === section),
  windowTitle: sections.find((s) => s.id === section).label,
  sourceList: structuredClone(sourceList),
  fullSizeContent: true,
  trafficLightsOverSidebar: true,
  sidebarFullHeight: true
})
const sourceList = {
  style: 'sourceList',
  behavior: 'sidebar',
  fullHeight: true,
  rowHeight: 28,
  rowSizeStyle: 0,
  indentation: 0,
  highlight: 1,
  transparentScroll: true,
  row: { height: 28, iconWidth: 16, iconHeight: 16, iconLeading: 2, labelGap: 7, fontSize: 13 }
}
assertSidebarParity(structuredClone(sourceList), structuredClone(sourceList))
for (const mutate of [
  (s) => (s.style = 'other'),
  (s) => (s.rowHeight = 24),
  (s) => (s.row.iconWidth = 18),
  (s) => (s.row.iconLeading = 8),
  (s) => delete s.row
]) {
  const bad = structuredClone(sourceList)
  mutate(bad)
  assert.throws(() => assertSidebarParity(bad, structuredClone(sourceList)))
}
assert.deepEqual(settingsVerificationWidths(680), [680, 780, 960])
assert.deepEqual(settingsVerificationWidths(780), [780, 960])
for (const invalid of [0, -1, NaN, Infinity, 781])
  assert.throws(() => settingsVerificationWidths(invalid))
for (const width of settingsVerificationWidths(680))
  for (const enabled of [false, true])
    for (const engine of ['agent', 'jev']) {
      const good = {
        foreground: true,
        width,
        height: 600,
        minimumWidth: 680,
        values: { projectUi: String(enabled), engine },
        ...sidebar('experimental'),
        controls: [
          control('projectUi', enabled ? 'On' : 'Off'),
          ...(enabled
            ? [control('engine', engine === 'agent' ? 'Chat model' : 'Jev layout engine')]
            : [])
        ],
        text: [
          'General',
          'AI Providers',
          'Experimental',
          'Dreamer',
          'Gen UI',
          help,
          ...(enabled ? ['UI layout method', engineHelp] : [])
        ]
      }
      assertSettingsEvidence(good, width, enabled, engine)
      const reject = (mutate) => {
        const bad = structuredClone(good)
        mutate(bad)
        assert.throws(() => assertSettingsEvidence(bad, width, enabled, engine))
      }
      reject((e) => (e.foreground = false))
      reject((e) => (e.width = width - 40))
      reject((e) => (e.minimumWidth = width + 1))
      reject((e) => (e.controls[0].contained = false))
      reject((e) => (e.controls[0].hitTarget = false))
      reject((e) => (e.controls[0].selected = enabled ? 'Off' : 'On'))
      reject((e) => (e.values.engine = engine === 'jev' ? 'agent' : 'jev'))
      reject((e) => (e.text[5] = help.slice(0, -10)))
      // The Experimental pane alone: no General picker, the right row selected.
      reject((e) => e.controls.push(control('default', 'Use last selected model')))
      reject((e) => Object.assign(e, sidebar('general')))
      reject((e) => (e.sidebarSelected = 0))
      reject((e) => (e.sidebarRows = 2))
      reject((e) => (e.sections[2].symbol = 'flask'))
      // The native split-view sidebar, titled by its section.
      reject((e) => (e.windowTitle = 'Settings'))
      reject((e) => (e.sourceList.style = 'other'))
      reject((e) => (e.sourceList.behavior = 'other'))
      reject((e) => (e.trafficLightsOverSidebar = false))
      reject((e) => (e.sidebarFullHeight = false))
      // Vision reads SF Pro's identical I/l glyphs either way; only that pair folds.
      const homoglyphs = (e) => (e.text = e.text.map((line) => line.replace(/I/g, 'l')))
      const ocrRead = structuredClone(good)
      homoglyphs(ocrRead)
      assertSettingsEvidence(ocrRead, width, enabled, engine)
      reject((e) => (e.text[5] = help.replace('Experimental;', 'Experlmental;')))
      reject((e) => (e.text[5] = help.replace(' Svelte', '')))
      if (enabled) {
        reject((e) => e.controls.pop())
        reject((e) => e.text.pop())
      } else {
        reject((e) => e.controls.push(control('engine', 'Chat model')))
        reject((e) => e.text.push('UI layout method', engineHelp))
        reject((e) => {
          e.text.push('UI layout method', engineHelp)
          homoglyphs(e)
        })
      }
    }
// General and AI Providers panes at the minimum and default widths.
for (const width of [680, 780]) {
  const general = {
    foreground: true,
    width,
    height: 540,
    minimumWidth: 680,
    values: { default: 'last-used', projectUi: 'false', engine: 'agent' },
    ...sidebar('general'),
    controls: [
      control('default', 'Use last selected model'),
      control('claudePlugins', 'Don’t allow'),
      control('agentFileAccess', 'Full access'),
      control('agentGitAccess', 'Managed'),
      control('agentMerge', 'On'),
      control('workspaceIdle', '7 days'),
      control('activityAutoOpen', 'For problems that need me')
    ],
    text: [
      'General',
      'Al Providers',
      'Experimental',
      'Dreamer',
      'General',
      'Default model',
      'New chats start with this model.',
      'Use last selected model'
    ]
  }
  assertSectionEvidence(general, width, 'general')
  const providers = {
    ...structuredClone(general),
    ...sidebar('providers'),
    controls: [],
    text: [
      'General',
      'AI Providers',
      'Experimental',
      'Dreamer',
      'Al Providers',
      'Claude and Codex use your existing sign-ins. Add another provider to',
      'use its models in chats.',
      'Added providers',
      'None'
    ]
  }
  assertSectionEvidence(providers, width, 'providers')
  const reject = (evidence, section, mutate) => {
    const bad = structuredClone(evidence)
    mutate(bad)
    assert.throws(() => assertSectionEvidence(bad, width, section))
  }
  reject(general, 'general', (e) => (e.controls = []))
  reject(
    general,
    'general',
    (e) => (e.controls = e.controls.filter((c) => c.id !== 'claudePlugins'))
  )
  reject(general, 'general', (e) => e.controls.push(control('projectUi', 'Off')))
  reject(general, 'general', (e) => (e.text = e.text.filter((line) => line !== 'Experimental')))
  reject(general, 'general', (e) => (e.text[6] = 'New chats start with'))
  reject(general, 'general', (e) => (e.text = e.text.filter((line) => line !== 'Dreamer')))
  reject(general, 'general', (e) => (e.sidebarSelected = 1))
  reject(general, 'general', (e) => (e.foreground = false))
  reject(providers, 'providers', (e) => (e.text = e.text.slice(0, 4)))
  reject(providers, 'providers', (e) =>
    e.controls.push(control('default', 'Use last selected model'))
  )
  reject(providers, 'providers', (e) => (e.section = 'general'))
  // Verbatim OCR from the manager's General capture (settings-visible-680-general): the
  // pixels show "Default model"; Vision returned "Detault model" (f read as t). Must
  // pass, while a missing or different word must still fail.
  const misread = structuredClone(general)
  misread.text = misread.text.map((line) => line.replace('Default model', 'Detault model'))
  assert.ok(misread.text.includes('Detault model'))
  assertSectionEvidence(misread, width, 'general')
  reject(misread, 'general', (e) => (e.text[5] = 'Model'))
  reject(misread, 'general', (e) => (e.text[5] = 'Detault'))
  reject(misread, 'general', (e) => (e.text[5] = 'Detault models'))
}
// Verbatim OCR lines from the manager's earlier foreground Off capture (the pixels
// render "UI"/"AI" correctly; Vision returned "Ul"/"Al"). Must still pass.
assertSettingsEvidence(
  {
    foreground: true,
    width: 680,
    height: 420,
    minimumWidth: 680,
    values: { engine: 'agent', default: 'last-used', projectUi: 'false' },
    ...sidebar('experimental'),
    controls: [control('projectUi', 'Off')],
    text: [
      'General',
      'Al Providers',
      'Experimental',
      'Dreamer',
      'Experimental Gen UI',
      "Generate Ul using your project's existing components and styles. Experimental;",
      'supports React and Svelte.',
      'Off "'
    ]
  },
  680,
  false,
  'agent'
)
// Verbatim OCR from the manager's earlier foreground On/Chat capture: Vision
// returned the wrapped engine help's continuation BEFORE its first line. The
// capture carries text only (no observation boxes). Must pass.
const outOfOrder = {
  foreground: true,
  width: 960,
  height: 600,
  minimumWidth: 680,
  values: { engine: 'agent', default: 'last-used', projectUi: 'true' },
  ...sidebar('experimental'),
  controls: [control('projectUi', 'On'), control('engine', 'Chat model')],
  text: [
    'Changes save automatically. Ul generation options apply to your next message.',
    'Experimental',
    'Gen Ul',
    "Generate Ul using your project's existing components and styles. Experimental; supports React and Svelte.",
    'On :',
    'Ul layout method',
    'Gateway API key.',
    'Chat model uses your selected chat model to arrange components. Jev uses a separate layout model and requires an Al',
    'Chat model',
    'Saved automatically.'
  ]
}
assertSettingsEvidence(outOfOrder, 960, true, 'agent')
const rejectWrapped = (mutate, enabled = true) => {
  const bad = structuredClone(outOfOrder)
  bad.values.projectUi = String(enabled)
  mutate(bad)
  assert.throws(() => assertSettingsEvidence(bad, 960, enabled, 'agent'))
}
// Wrapping never excuses a dropped, misspelled or reordered word.
rejectWrapped((e) => (e.text[6] = 'Gateway key.'))
rejectWrapped((e) => (e.text[6] = 'Gateway APl kay.'))
rejectWrapped((e) => (e.text[7] = e.text[7].replace(' an Al', ' Al')))
rejectWrapped((e) => (e.text[6] = 'API Gateway key.'))
rejectWrapped((e) => (e.text[7] = e.text[7].replace(' requires an Al', '')))
// The fragments must meet at line edges, not float inside other text.
rejectWrapped((e) => (e.text[6] = 'Saved Gateway API key. automatically'))
// Off: out-of-order engine text is still detected as visible.
rejectWrapped((e) => {
  e.controls.pop()
  e.controls[0].selected = 'Off'
  e.text.splice(5, 1)
  e.text.splice(7, 1)
}, false)
console.log(
  'SETTINGS EVIDENCE PASS — rejects unfocused, clipped, occluded, stale, wrong-section and incorrectly visible native evidence'
)
