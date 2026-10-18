import assert from 'node:assert/strict'
import { SKILL_RECOMMENDATIONS } from '../shared/skills-catalog'
import { assertSidebar, assertUsable, type SettingsEvidence } from './settings-verification'

/**
 * LKM-288, LKM-286: what the Settings → Skills pane must render, checked against the
 * rendered window (`settingsVerification`: its AppKit row buttons and text editors),
 * never against the state Bun sent. Shared by the native smoke and its unit test.
 */

export interface SkillsEvidence extends SettingsEvidence {
  minimumHeight: number
  sidebarFocused: boolean
  /** Rendered navigation-row buttons of the shown pane. */
  rows: {
    action: string
    title: string
    label: string
    enabled: boolean
    contained: boolean
    hitTarget: boolean
  }[]
  /** Rendered editable text views of the shown pane. */
  editors: { text: string; contained: boolean; hitTarget: boolean }[]
  /** The shown pane's field and footer action IDs, and the footer actions shown disabled. */
  fields: string[]
  actions: string[]
  disabledActions: string[]
  message: string
  busy: boolean
}

type Named = readonly { id: string; name: string }[]
export type SkillsExpectation =
  | {
      view: 'overview'
      installed: Named
      removed?: Named
      /** Recommendations whose folder is in the library; every other one must not say so. */
      recommended?: readonly string[]
    }
  | { view: 'add'; text: string }
  | {
      view: 'detail'
      field: string
      text: string
      /** A GitHub skill: the pinned commit and license rows. */
      github?: { commit: string; license: string }
    }
  | { view: 'removed' }
  | { view: 'github' }
  | {
      view: 'recommendation'
      id: string
      status: 'Not installed' | 'Installed' | 'Removed' | 'Can’t be installed'
    }

const ACTIONS = {
  overview: ['skill-add', 'skill-folder', 'skill-github'],
  add: ['skill-back', 'skill-create'],
  detail: ['skill-back', 'skill-toggle', 'skill-remove', 'skill-save'],
  removed: ['skill-back', 'skill-restore'],
  github: ['skill-back', 'skill-github-import']
}

function row(
  evidence: SkillsEvidence,
  action: string,
  title: string,
  label: string,
  visible = false
) {
  const found = evidence.rows.find((r) => r.action === action)
  assert.ok(found, `Rendered row button: ${action}`)
  assert.equal(found.title, title, `Row button title: ${action}`)
  assert.equal(found.label, label, `Row accessibility label names its row: ${action}`)
  assert.ok(found.enabled, `Enabled row button: ${action}`)
  if (visible)
    assert.ok(found.contained && found.hitTarget, `Unclipped, hittable row button: ${action}`)
}

function editor(evidence: SkillsEvidence, text: string) {
  assert.equal(evidence.editors.length, 1, 'One rendered SKILL.md editor')
  const [shown] = evidence.editors
  assert.equal(shown.text, text, 'The rendered editor shows the SKILL.md')
  assert.ok(shown.contained && shown.hitTarget, 'Unclipped, hittable editor')
  assert.equal(evidence.rows.length, 0, 'No row buttons beside the editor')
}

/** The Skills pane at `width`, selected in the sidebar, showing the expected view. */
export function assertSkillsEvidence(
  evidence: SkillsEvidence,
  width: number,
  expect: SkillsExpectation
) {
  assertUsable(evidence, width)
  assertSidebar(evidence, 'skills')
  assert.equal(evidence.busy, false, 'Skills pane settled')
  if (expect.view !== 'recommendation') {
    assert.deepEqual(evidence.actions, ACTIONS[expect.view], `Skills ${expect.view} actions`)
    assert.deepEqual(evidence.disabledActions ?? [], [], `No disabled ${expect.view} actions`)
  }
  if (expect.view === 'overview') {
    const removed = expect.removed ?? []
    // The first installed row (or the empty row) is at the top and must be usable as rendered.
    expect.installed.forEach((skill, i) => {
      row(evidence, `skill-open:${skill.id}`, 'Edit…', `Edit ${skill.name}`, i === 0)
    })
    for (const skill of removed)
      row(evidence, `skill-open:${skill.id}`, 'Restore…', `Restore ${skill.name}`)
    const recommended = new Set(expect.recommended ?? [])
    for (const entry of SKILL_RECOMMENDATIONS) {
      row(evidence, `skill-recommendation:${entry.id}`, 'Details…', `Details ${entry.title}`)
      // A recommendation never reads as installed unless its folder is in the library.
      const value = evidence.values[`recommendation:${entry.id}`]
      if (recommended.has(entry.id)) assert.equal(value, 'Installed', `${entry.id} is installed`)
      else assert.notEqual(value, 'Installed', `${entry.id} is not shown as installed`)
    }
    assert.equal(
      evidence.rows.length,
      expect.installed.length + removed.length + SKILL_RECOMMENDATIONS.length,
      'Only the expected rows'
    )
    assert.equal(
      evidence.fields.includes('skills-status'),
      expect.installed.length === 0,
      'The empty row only without installed skills'
    )
    assert.ok(
      evidence.fields.includes('recommendations-note'),
      'Recommendations say they are not installed'
    )
    assert.equal(evidence.editors.length, 0, 'The overview has no editor')
  } else if (expect.view === 'add') {
    editor(evidence, expect.text)
  } else if (expect.view === 'detail') {
    editor(evidence, expect.text)
    assert.ok(evidence.fields.includes(expect.field), 'The editor of the shown revision')
    for (const id of ['skill-status', 'skill-source', 'skill-revision', 'skill-chats'])
      assert.ok(evidence.fields.includes(id), `Detail row: ${id}`)
    // LKM-287: the providers that offer it, each with its actual support level.
    assert.match(
      evidence.values['skill-chats'] ?? '',
      /^(?:Off: not in new chats|No provider|(?:Claude: native|Codex: compatibility|Gemini: experimental)(?: · (?:Codex: compatibility|Gemini: experimental))*)$/,
      'Provider availability is honest'
    )
    if (expect.github) {
      assert.equal(evidence.values['skill-commit'], expect.github.commit, 'The pinned commit')
      assert.equal(evidence.values['skill-license'], expect.github.license, 'The found license')
    } else {
      assert.ok(!evidence.fields.includes('skill-commit'), 'No commit for a local skill')
    }
  } else if (expect.view === 'removed') {
    assert.equal(evidence.editors.length, 0, 'A removed skill is not editable')
    assert.match(evidence.values['skill-status'] ?? '', /^Removed/, 'Removed status')
  } else if (expect.view === 'github') {
    for (const id of ['skill-github-url', 'skill-github-ref', 'skill-github-subpath'])
      assert.ok(evidence.fields.includes(id), `GitHub field: ${id}`)
    assert.ok(evidence.fields.includes('skill-github-checks'), 'The checks are explained')
    assert.equal(evidence.rows.length, 0, 'The GitHub form has no row buttons')
  } else {
    const entry = SKILL_RECOMMENDATIONS.find((r) => r.id === expect.id)
    assert.ok(entry, `Catalog entry ${expect.id}`)
    assert.equal(
      evidence.values['recommendation-source'],
      entry.pathVerified ? `${entry.repository}/${entry.path}` : entry.repository,
      'Only a verified folder is shown'
    )
    assert.equal(evidence.values['recommendation-license'], entry.license)
    assert.equal(evidence.values['recommendation-status'], expect.status, 'Install status')
    const taken = expect.status === 'Installed' || expect.status === 'Removed'
    assert.deepEqual(
      evidence.actions,
      taken ? ['skill-back'] : ['skill-back', 'skill-install'],
      'Install only when it is not in the library'
    )
    assert.deepEqual(
      evidence.disabledActions ?? [],
      expect.status === 'Can’t be installed' ? ['skill-install'] : [],
      'Install is disabled only when it cannot be imported'
    )
    assert.equal(evidence.rows.length + evidence.editors.length, 0, 'Read-only details')
  }
}
