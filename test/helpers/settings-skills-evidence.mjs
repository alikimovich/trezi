// The rendered-window evidence checks of Settings → Skills (skills-verification.ts),
// against hand-built evidence: each accepted shape passes and each broken one fails.
// Run by test/settings-skills.mjs.
import assert from 'node:assert/strict'
import { bodyField, NEW_SKILL_FIELD } from '../../src/native/settings-skills.ts'
import { assertSkillsEvidence } from '../../src/native/skills-verification.ts'
import { SKILL_RECOMMENDATIONS } from '../../src/shared/skills-catalog.ts'

const sections = [
  ['general', 'General', 'gearshape'],
  ['providers', 'AI Providers', 'sparkles'],
  ['skills', 'Skills', 'book.closed'],
  ['experimental', 'Experimental', 'testtube.2'],
  ['dreamer', 'Dreamer', 'moon.stars']
].map(([id, label, symbol]) => ({ id, label, symbol }))
const button = (action, title, label, extra = {}) => ({
  action,
  title,
  label,
  enabled: true,
  contained: true,
  hitTarget: true,
  ...extra
})
const base = {
  foreground: true,
  width: 680,
  height: 760,
  minimumWidth: 680,
  minimumHeight: 760,
  values: {},
  section: 'skills',
  sections,
  sidebarRows: 5,
  sidebarSelected: 2,
  sidebarFocused: true,
  windowTitle: 'Skills',
  sourceList: { style: 'sourceList', behavior: 'sidebar' },
  fullSizeContent: true,
  trafficLightsOverSidebar: true,
  sidebarFullHeight: true,
  controls: [],
  text: [],
  message: '',
  busy: false,
  disabledActions: []
}
const reject = (evidence, expect, mutate) => {
  const bad = structuredClone(evidence)
  mutate(bad)
  assert.throws(() => assertSkillsEvidence(bad, 680, expect))
}

// Overview: rows usable as rendered; a recommendation never reads as installed unless it is.
const recommended = SKILL_RECOMMENDATIONS.map((r) =>
  button(`skill-recommendation:${r.id}`, 'Details…', `Details ${r.title}`, { contained: false })
)
const overview = {
  ...base,
  values: Object.fromEntries(
    SKILL_RECOMMENDATIONS.map((r) => [`recommendation:${r.id}`, `${r.publisher} · ${r.license}`])
  ),
  rows: [button('skill-open:a1', 'Edit…', 'Edit ui-notes'), ...recommended],
  editors: [],
  fields: ['skill:a1', 'recommendations-note'],
  actions: ['skill-add', 'skill-folder', 'skill-github']
}
const expectOverview = { view: 'overview', installed: [{ id: 'a1', name: 'ui-notes' }] }
assertSkillsEvidence(overview, 680, expectOverview)
reject(overview, expectOverview, (e) => (e.rows[0].label = 'Edit…'))
reject(overview, expectOverview, (e) => (e.rows[0].contained = false))
reject(overview, expectOverview, (e) => (e.rows[0].hitTarget = false))
reject(overview, expectOverview, (e) => (e.rows[1].enabled = false))
reject(overview, expectOverview, (e) => e.rows.pop())
reject(overview, expectOverview, (e) => e.fields.push('skills-status'))
reject(overview, expectOverview, (e) => (e.fields = ['skill:a1']))
reject(overview, expectOverview, (e) => (e.actions = ['skill-add']))
reject(overview, expectOverview, (e) => (e.disabledActions = ['skill-github']))
reject(overview, expectOverview, (e) => (e.values['recommendation:frontend-design'] = 'Installed'))
reject(overview, expectOverview, (e) => (e.sidebarSelected = 1))
reject(overview, expectOverview, (e) => (e.foreground = false))
reject(overview, expectOverview, (e) => (e.busy = true))
reject(overview, expectOverview, (e) => (e.width = 780))
const withInstalled = {
  ...structuredClone(overview),
  values: { ...overview.values, 'recommendation:frontend-design': 'Installed' }
}
const expectInstalled = { ...expectOverview, recommended: ['frontend-design'] }
assertSkillsEvidence(withInstalled, 680, expectInstalled)
reject(withInstalled, expectInstalled, (e) => {
  e.values['recommendation:frontend-design'] = 'Anthropic · Apache-2.0'
})

// Add and detail: one usable editor showing the SKILL.md.
const sample = 'body\n'
const add = {
  ...base,
  rows: [],
  editors: [{ text: sample, contained: true, hitTarget: true }],
  fields: [NEW_SKILL_FIELD],
  actions: ['skill-back', 'skill-create']
}
assertSkillsEvidence(add, 680, { view: 'add', text: sample })
reject(add, { view: 'add', text: sample }, (e) => (e.editors[0].text = 'other'))
reject(add, { view: 'add', text: sample }, (e) => (e.editors[0].contained = false))
reject(add, { view: 'add', text: sample }, (e) => (e.editors = []))
const detailField = bodyField('a1', 'r1')
const detail = {
  ...add,
  values: { 'skill-chats': 'Not offered yet' },
  fields: ['skill-status', 'skill-source', 'skill-revision', 'skill-chats', detailField],
  actions: ['skill-back', 'skill-toggle', 'skill-remove', 'skill-save']
}
const expectDetail = { view: 'detail', field: detailField, text: sample }
assertSkillsEvidence(detail, 680, expectDetail)
reject(detail, expectDetail, (e) => (e.values['skill-chats'] = 'On'))
reject(detail, expectDetail, (e) => e.actions.pop())
reject(detail, expectDetail, (e) => (e.fields = e.fields.slice(0, 4)))
reject(detail, expectDetail, (e) => e.fields.push('skill-commit'))
const commit = 'a'.repeat(40)
const pinned = {
  ...detail,
  values: { ...detail.values, 'skill-commit': commit, 'skill-license': 'MIT' },
  fields: [...detail.fields, 'skill-commit', 'skill-license']
}
const expectPinned = { ...expectDetail, github: { commit, license: 'MIT' } }
assertSkillsEvidence(pinned, 680, expectPinned)
reject(pinned, expectPinned, (e) => (e.values['skill-commit'] = 'main'))
reject(pinned, expectPinned, (e) => (e.values['skill-license'] = 'None found'))

// The GitHub form.
const form = {
  ...base,
  rows: [],
  editors: [],
  fields: ['skill-github-url', 'skill-github-ref', 'skill-github-subpath', 'skill-github-checks'],
  actions: ['skill-back', 'skill-github-import']
}
assertSkillsEvidence(form, 680, { view: 'github' })
reject(form, { view: 'github' }, (e) => (e.fields = e.fields.slice(1)))
reject(form, { view: 'github' }, (e) => (e.actions = ['skill-back', 'skill-github-cancel']))

// Recommendations: an explicit Install, disabled only when the entry cannot be imported.
const entry = SKILL_RECOMMENDATIONS.find((r) => !r.importable)
const recommendation = {
  ...base,
  rows: [],
  editors: [],
  fields: ['recommendation-source', 'recommendation-license', 'recommendation-status'],
  values: {
    'recommendation-source': `${entry.repository}/${entry.path}`,
    'recommendation-license': entry.license,
    'recommendation-status': 'Can’t be installed'
  },
  actions: ['skill-back', 'skill-install'],
  disabledActions: ['skill-install']
}
const expectUnavailable = { view: 'recommendation', id: entry.id, status: 'Can’t be installed' }
assertSkillsEvidence(recommendation, 680, expectUnavailable)
reject(recommendation, expectUnavailable, (e) => (e.disabledActions = []))
reject(recommendation, expectUnavailable, (e) => (e.values['recommendation-status'] = 'Installed'))
reject(
  recommendation,
  expectUnavailable,
  (e) => (e.values['recommendation-source'] = entry.repository)
)
const importable = SKILL_RECOMMENDATIONS[0]
const available = {
  ...recommendation,
  values: {
    'recommendation-source': `${importable.repository}/${importable.path}`,
    'recommendation-license': importable.license,
    'recommendation-status': 'Not installed'
  },
  disabledActions: []
}
const expectAvailable = { view: 'recommendation', id: importable.id, status: 'Not installed' }
assertSkillsEvidence(available, 680, expectAvailable)
reject(available, expectAvailable, (e) => (e.disabledActions = ['skill-install']))
reject(available, expectAvailable, (e) => (e.actions = ['skill-back']))
const taken = {
  ...available,
  values: { ...available.values, 'recommendation-status': 'Installed' },
  actions: ['skill-back']
}
const expectTaken = { ...expectAvailable, status: 'Installed' }
assertSkillsEvidence(taken, 680, expectTaken)
reject(taken, expectTaken, (e) => (e.actions = ['skill-back', 'skill-install']))
