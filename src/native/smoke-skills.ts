import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillSummary } from '../shared/skills-registry'
import type { NativeBridge } from './bridge'
import { bodyField, NEW_SKILL_FIELD, NEW_SKILL_TEMPLATE, nativeSkills } from './settings-skills'
import { SETTINGS_DEFAULT_SIZE, SETTINGS_SECTIONS } from './settings-verification'
import { SKILLS_FIXTURE_IMPORT, SKILLS_FIXTURE_RECOMMENDATION } from './skills-github-fixture'
import type { SkillsRegistry } from './skills-service'
import {
  assertSkillsEvidence,
  type SkillsEvidence,
  type SkillsExpectation
} from './skills-verification'
import { checkSkillsImports, SKILLS_FOLDER_NAME } from './smoke-skills-imports'
import { inspectUntil, waitFor } from './smoke-wait'

/**
 * LKM-288, LKM-286: Settings → Skills in the compiled app with the real Swift Skills
 * owner of the disposable profile. A sample skill is typed into the rendered editor,
 * added, opened from its rendered row, edited into a new revision, turned off and on,
 * removed and restored; then a folder, a pinned GitHub folder and a recommendation are
 * imported (`smoke-skills-imports.ts`, against the launcher's loopback GitHub). Each
 * step is checked in the registry and in the rendered window, with foreground
 * captures at the minimum and normal widths (`skills-<step>-<width>.png` and `.json`
 * in the artifacts folder).
 */

export const SKILLS_SAMPLE_NAME = 'trezi-smoke-notes'
export const SKILLS_SAMPLE = `---
name: ${SKILLS_SAMPLE_NAME}
description: Sample manual skill from the Trezi native smoke. Use for UI work in this project.
---

# Smoke notes

- Use semantic HTML elements.
- Keep keyboard focus visible.
`
const SKILLS_EDIT = `${SKILLS_SAMPLE}- Prefer CSS variables for colors.
`
const SKILLS_SAMPLE_NAMES: string[] = [
  SKILLS_SAMPLE_NAME,
  SKILLS_FOLDER_NAME,
  SKILLS_FIXTURE_IMPORT.name,
  SKILLS_FIXTURE_RECOMMENDATION.id
]

/** Removes and permanently deletes the samples from earlier runs; other skills are left alone. */
async function purgeSample(registry: SkillsRegistry) {
  for (const skill of (await registry.list()).skills) {
    if (!SKILLS_SAMPLE_NAMES.includes(skill.name)) continue
    if (!skill.removed) await registry.remove(skill.id)
    await registry.purge(skill.id)
  }
}

export async function checkSkillsSettings(host: NativeBridge, artifacts: string) {
  const registry = nativeSkills.current
  assert.ok(registry, 'Skills registry client')
  await purgeSample(registry)
  const others = (await registry.list()).skills.filter((s) => !s.removed)
  assert.equal(others.length, 0, 'The disposable profile starts without skills')
  const inspect = (): Promise<SkillsEvidence> => host.request('settingsVerification')
  const until = (label: string, check: (state: SkillsEvidence) => boolean, timeout?: number) =>
    waitFor(
      async () => {
        const state = await inspect()
        return check(state) && state
      },
      `Skills: ${label}`,
      timeout
    )
  const sample = async () => {
    const found = (await registry.list()).skills.find((s) => s.name === SKILLS_SAMPLE_NAME)
    assert.ok(found, 'The sample skill is in the registry')
    return found
  }
  const report: Record<string, unknown>[] = []
  const save = () =>
    writeFileSync(join(artifacts, 'skills-settings-report.json'), JSON.stringify(report, null, 2))

  if ((await host.request('sheetInspect')).title !== 'Settings') {
    host.emit('menu', { action: 'settings' })
    await inspectUntil(
      (method) => host.request(method),
      'sheetInspect',
      (s) => s.visible && s.title === 'Settings'
    )
  }
  const initial = await inspect()
  const widths = [initial.minimumWidth, SETTINGS_DEFAULT_SIZE.width]
  const heightFor = (width: number) =>
    width === initial.minimumWidth ? initial.minimumHeight : SETTINGS_DEFAULT_SIZE.height
  /** A foreground capture of the pane plus its rendered state, checked against `expect`. */
  const shoot = async (step: string, expect: SkillsExpectation, only?: number) => {
    for (const width of only ? [only] : widths) {
      await host.request('settingsVerification', { prepare: true, width, height: heightFor(width) })
      await until(`foreground at ${width}`, (s) => s.foreground && Math.abs(s.width - width) <= 1)
      // A pinned GitHub skill's extra rows push SKILL.md below the fold at 760 pt high.
      if (expect.view === 'detail' || expect.view === 'add') {
        await host.request('settingsVerification', { revealEditor: true })
        await until(`editor in view at ${width}`, (s) =>
          s.editors.every((e) => e.contained && e.hitTarget)
        )
      }
      const image = await host.request('captureVisibleSheet')
      const evidence = { ...(await inspect()), text: [] as string[] }
      const stem = join(artifacts, `skills-${step}-${width}`)
      writeFileSync(`${stem}.png`, Buffer.from(image.png, 'base64'))
      writeFileSync(
        `${stem}.json`,
        JSON.stringify(
          { ...evidence, captureWidth: image.width, captureHeight: image.height },
          null,
          2
        )
      )
      assert.ok(image.width >= width && image.height >= evidence.height, 'Nonempty Skills pixels')
      assertSkillsEvidence(evidence, width, expect)
      report.push({ capture: `${stem}.png`, view: expect.view, width, message: evidence.message })
      save()
    }
  }

  // Keyboard: Down from AI Providers in the focused source list selects Skills.
  await host.request('settingsVerification', { section: 'providers' })
  await until('providers selected', (s) => s.section === 'providers')
  await host.request('settingsVerification', { key: 'down' })
  const index = SETTINGS_SECTIONS.findIndex((s) => s.id === 'skills')
  const keyed = await until(
    'arrow key to Skills',
    (s) => s.section === 'skills' && s.sidebarSelected === index && s.windowTitle === 'Skills'
  )
  report.push({
    action: 'arrow-key',
    key: 'down',
    section: keyed.section,
    focused: keyed.sidebarFocused
  })
  await nativeSkills.loading
  await until('empty library', (s) => s.fields.includes('skills-status') && s.rows.length > 0)
  await shoot('1-overview-empty', { view: 'overview', installed: [] }, SETTINGS_DEFAULT_SIZE.width)

  // Manual add: the template, then the sample typed over it in the rendered editor.
  await host.request('sheetPerform', { action: 'skill-add' })
  await until(
    'add view',
    (s) => s.fields.includes(NEW_SKILL_FIELD) && s.editors[0]?.text === NEW_SKILL_TEMPLATE
  )
  await host.request('settingsVerification', { editorText: SKILLS_SAMPLE })
  await until('sample typed', (s) => s.values[NEW_SKILL_FIELD] === SKILLS_SAMPLE)
  await shoot('2-add', { view: 'add', text: SKILLS_SAMPLE })
  await host.request('sheetPerform', { action: 'skill-create' })
  const added = await until('added', (s) => !s.busy && s.message === `Added ${SKILLS_SAMPLE_NAME}.`)
  const created: SkillSummary = await sample()
  assert.deepEqual(
    {
      enabled: created.enabled,
      removed: created.removed,
      modified: created.modified,
      source: created.source,
      history: created.history.map((h) => h.kind),
      providers: created.providers
    },
    {
      enabled: true,
      removed: false,
      modified: false,
      source: { kind: 'manual' },
      history: ['create'],
      providers: { claude: true, codex: true, gemini: true }
    },
    'The registry stored the typed skill as a manual, enabled skill'
  )
  report.push({ action: 'create', message: added.message, skill: created })
  const library = {
    view: 'overview',
    installed: [{ id: created.id, name: SKILLS_SAMPLE_NAME }]
  } as const
  await shoot('3-library', library)

  // Open it from its rendered row: SKILL.md is read now, not with the list.
  await host.request('settingsVerification', { press: `skill-open:${created.id}` })
  const field = bodyField(created.id, created.revision)
  await until('detail', (s) => s.fields.includes(field) && s.editors[0]?.text === SKILLS_SAMPLE)
  await shoot('4-detail', { view: 'detail', field, text: SKILLS_SAMPLE })

  // Edit and save a new local revision.
  await host.request('settingsVerification', { editorText: SKILLS_EDIT })
  await until('edit typed', (s) => s.values[field] === SKILLS_EDIT)
  await host.request('sheetPerform', { action: 'skill-save' })
  const saved = await until('saved', (s) => !s.busy && s.message.startsWith('Saved revision'))
  const edited = await sample()
  assert.notEqual(edited.revision, created.revision, 'Save makes a new revision')
  assert.equal(edited.installedRevision, created.revision, 'The added revision is kept')
  assert.equal(edited.modified, true, 'The skill is marked edited')
  assert.deepEqual(
    edited.history.map((h) => h.kind),
    ['create', 'edit']
  )
  assert.equal((await registry.read(edited.id)).body, SKILLS_EDIT, 'The registry stores the edit')
  report.push({ action: 'save', message: saved.message, skill: edited })
  await shoot(
    '5-detail-edited',
    { view: 'detail', field: bodyField(edited.id, edited.revision), text: SKILLS_EDIT },
    SETTINGS_DEFAULT_SIZE.width
  )

  // Off and on again.
  for (const enabled of [false, true]) {
    await host.request('sheetPerform', { action: 'skill-toggle' })
    // The window keeps a row's first value in `values`; the message reports the change.
    const message = `${SKILLS_SAMPLE_NAME} is ${enabled ? 'on' : 'off'}.`
    await until(`turned ${enabled ? 'on' : 'off'}`, (s) => !s.busy && s.message === message)
    assert.equal((await sample()).enabled, enabled, 'The registry stores on/off')
  }

  // Remove (recoverable), then restore from the Removed group's rendered row.
  await host.request('sheetPerform', { action: 'skill-remove' })
  await until(
    'removed',
    (s) => !s.busy && s.rows.some((r) => r.label === `Restore ${SKILLS_SAMPLE_NAME}`)
  )
  assert.equal((await sample()).removed, true, 'The registry keeps the removed skill')
  const removedState = { view: 'overview', installed: [], removed: library.installed } as const
  await shoot('6-removed', removedState, SETTINGS_DEFAULT_SIZE.width)
  await host.request('settingsVerification', { press: `skill-open:${created.id}` })
  await until('removed detail', (s) => s.actions.includes('skill-restore'))
  await shoot('7-removed-detail', { view: 'removed' }, SETTINGS_DEFAULT_SIZE.width)
  await host.request('sheetPerform', { action: 'skill-restore' })
  await until('restored', (s) => !s.busy && s.message === `Restored ${SKILLS_SAMPLE_NAME}.`)
  const restored = await sample()
  assert.equal(restored.removed, false, 'Restore brings the skill back')
  assert.equal(restored.revision, edited.revision, 'Restore keeps the edited revision')
  report.push({ action: 'remove-restore', skill: restored })

  await host.request('sheetPerform', { action: 'skill-back' })
  await until('library', (s) => s.rows.some((r) => r.action === `skill-open:${created.id}`))
  report.push(...(await checkSkillsImports(host, artifacts, { registry, until, shoot })))
  report.push({ action: 'done' })
  save()
  console.log(
    'Native Settings → Skills: add, open, edit, on/off, remove/restore, folder and pinned GitHub imports and recommendation install passed.'
  )
}

/** Deletes the samples and leaves Settings on General, as the other Settings checks expect. */
export async function restoreSkillsSettings(host: NativeBridge) {
  if (nativeSkills.current) await purgeSample(nativeSkills.current)
  const sheet = await host.request('sheetInspect')
  if (sheet.visible && sheet.title === 'Settings') {
    await host.request('settingsVerification', { section: 'general' })
    await host.request('sheetPerform', { action: 'closeWindow' })
  }
}
