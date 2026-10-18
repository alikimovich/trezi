import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_RECOMMENDATIONS } from '../shared/skills-catalog'
import type { NativeBridge } from './bridge'
import { bodyField, GITHUB_FIELDS, nativeSkills } from './settings-skills'
import { SETTINGS_DEFAULT_SIZE } from './settings-verification'
import { SKILLS_FIXTURE_IMPORT, SKILLS_FIXTURE_RECOMMENDATION } from './skills-github-fixture'
import type { SkillsRegistry } from './skills-service'
import type { SkillsEvidence, SkillsExpectation } from './skills-verification'

/**
 * LKM-286: the import half of the Settings → Skills smoke. A fixture folder is
 * imported through the folder action (the open panel replaced by
 * `nativeSkills.pickFolder`); a GitHub folder pinned to tag `v1` and the
 * `frontend-design` recommendation are imported from the launcher's loopback GitHub
 * (`skills-github-fixture.ts`) by the real service importer. A recommendation that
 * cannot be imported shows a disabled Install that the runtime refuses.
 */

export const SKILLS_FOLDER_NAME = 'trezi-smoke-folder'
const FOLDER_SKILL = `---
name: ${SKILLS_FOLDER_NAME}
description: Sample folder skill from the Trezi native smoke.
---

# Folder sample

Follow references/checklist.md.
`
const UNIMPORTABLE = SKILL_RECOMMENDATIONS.find((r) => !r.importable)

interface Steps {
  registry: SkillsRegistry
  until(
    label: string,
    check: (state: SkillsEvidence) => boolean,
    timeout?: number
  ): Promise<SkillsEvidence>
  shoot(step: string, expect: SkillsExpectation, only?: number): Promise<void>
}

export async function checkSkillsImports(
  host: NativeBridge,
  artifacts: string,
  { registry, until, shoot }: Steps
) {
  const report: Record<string, unknown>[] = []
  const named = async (name: string) => {
    const found = (await registry.list()).skills.find((s) => s.name === name && !s.removed)
    assert.ok(found, `${name} is in the registry`)
    return found
  }
  const installed = async () =>
    (await registry.list()).skills
      .filter((s) => !s.removed)
      .map((s) => ({ id: s.id, name: s.name }))
  const normal = SETTINGS_DEFAULT_SIZE.width

  // A local folder: the service reads and checks it; Trezi keeps its own copy.
  const folder = join(artifacts, 'skills-folder-fixture', SKILLS_FOLDER_NAME)
  rmSync(join(artifacts, 'skills-folder-fixture'), { recursive: true, force: true })
  mkdirSync(join(folder, 'references'), { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), FOLDER_SKILL)
  writeFileSync(
    join(folder, 'references', 'checklist.md'),
    '# Checklist\n\n- Label every control.\n'
  )
  nativeSkills.pickFolder = async () => realpathSync(folder)
  try {
    await host.request('sheetPerform', { action: 'skill-folder' })
    await until(
      'folder imported',
      (s) => !s.busy && s.message === `Imported ${SKILLS_FOLDER_NAME}.`
    )
  } finally {
    nativeSkills.pickFolder = null
  }
  const imported = await named(SKILLS_FOLDER_NAME)
  assert.deepEqual(imported.source, { kind: 'manual' }, 'A folder import is a local skill')
  assert.deepEqual(
    imported.history.map((h) => h.kind),
    ['import']
  )
  assert.deepEqual(
    (await registry.read(imported.id)).references.map((f) => f.path),
    ['references/checklist.md'],
    'The folder’s other files are kept'
  )
  rmSync(join(artifacts, 'skills-folder-fixture'), { recursive: true, force: true })
  assert.equal(
    (await registry.read(imported.id)).body,
    FOLDER_SKILL,
    'The library keeps its copy after the folder is gone'
  )
  report.push({ action: 'import-folder', skill: imported })

  // GitHub: the address names tag v1 and the folder; the service pins the commit.
  await host.request('sheetPerform', { action: 'skill-github' })
  await until('github form', (s) => s.fields.includes(GITHUB_FIELDS.url))
  await shoot('8-github', { view: 'github' })
  await host.request('sheetPerform', {
    action: 'skill-github-import',
    values: {
      [GITHUB_FIELDS.url]: SKILLS_FIXTURE_IMPORT.url,
      [GITHUB_FIELDS.ref]: '',
      [GITHUB_FIELDS.subpath]: ''
    }
  })
  const pinned = await until(
    'github imported',
    (s) => !s.busy && s.message.startsWith(`Added ${SKILLS_FIXTURE_IMPORT.name} from`),
    60_000
  )
  await nativeSkills.importing
  const github = await named(SKILLS_FIXTURE_IMPORT.name)
  assert.deepEqual(
    github.source,
    {
      kind: 'github',
      repository: SKILLS_FIXTURE_IMPORT.repository,
      subpath: SKILLS_FIXTURE_IMPORT.subpath,
      commit: SKILLS_FIXTURE_IMPORT.commit,
      license: SKILLS_FIXTURE_IMPORT.license,
      ref: SKILLS_FIXTURE_IMPORT.ref,
      licenseFile: SKILLS_FIXTURE_IMPORT.licenseFile
    },
    'The registry pins the resolved commit, the asked ref and the found license'
  )
  assert.ok(
    pinned.message.includes(SKILLS_FIXTURE_IMPORT.commit.slice(0, 7)),
    'The message names the commit'
  )
  const body = await registry.read(github.id)
  await until('github detail', (s) => s.fields.includes(bodyField(github.id, github.revision)))
  await shoot('9-github-detail', {
    view: 'detail',
    field: bodyField(github.id, github.revision),
    text: body.body,
    github: { commit: SKILLS_FIXTURE_IMPORT.commit, license: SKILLS_FIXTURE_IMPORT.license }
  })
  report.push({ action: 'import-github', message: pinned.message, skill: github })

  // A recommendation stays "Not installed" until Install, which imports its folder.
  const entry = SKILLS_FIXTURE_RECOMMENDATION.id
  await host.request('sheetPerform', { action: 'skill-back' })
  await until('library', (s) => s.actions.includes('skill-github'))
  await shoot('10-library', { view: 'overview', installed: await installed() }, normal)
  await host.request('settingsVerification', { press: `skill-recommendation:${entry}` })
  await until('recommendation', (s) => s.fields.includes('recommendation-license'))
  await shoot('11-recommendation', { view: 'recommendation', id: entry, status: 'Not installed' })
  await host.request('sheetPerform', { action: 'skill-install' })
  const added = await until(
    'recommendation installed',
    (s) => !s.busy && s.message.startsWith(`Added ${entry} from`),
    60_000
  )
  await nativeSkills.importing
  assert.ok(!added.message.includes('differs'), 'The installed folder matches its recommendation')
  const recommended = await named(entry)
  assert.equal(recommended.source.kind, 'github')
  if (recommended.source.kind === 'github') {
    assert.equal(recommended.source.repository, SKILLS_FIXTURE_RECOMMENDATION.repository)
    assert.equal(recommended.source.subpath, SKILLS_FIXTURE_RECOMMENDATION.subpath)
    assert.equal(recommended.source.commit, SKILLS_FIXTURE_RECOMMENDATION.commit)
    assert.equal(recommended.source.license, SKILLS_FIXTURE_RECOMMENDATION.license)
  }
  report.push({ action: 'install-recommendation', message: added.message, skill: recommended })
  await host.request('sheetPerform', { action: 'skill-back' })
  await until('library', (s) => s.actions.includes('skill-github'))
  await host.request('settingsVerification', { press: `skill-recommendation:${entry}` })
  await until('installed recommendation', (s) => s.values['recommendation-status'] === 'Installed')
  await shoot(
    '12-recommendation-installed',
    { view: 'recommendation', id: entry, status: 'Installed' },
    normal
  )

  // An entry that cannot be imported: Install is shown disabled, and refused if sent.
  assert.ok(UNIMPORTABLE, 'The catalog has an entry that cannot be imported')
  await host.request('sheetPerform', { action: 'skill-back' })
  await until('library', (s) => s.actions.includes('skill-github'))
  await host.request('settingsVerification', { press: `skill-recommendation:${UNIMPORTABLE.id}` })
  await until('unimportable', (s) => !!s.disabledActions?.includes('skill-install'))
  const before = (await registry.list()).revision
  await host.request('sheetPerform', { action: 'skill-install' })
  const refused = await until('install refused', (s) => !s.busy)
  assert.equal(refused.message, '', 'A disabled Install does nothing')
  assert.deepEqual((await registry.list()).revision, before, 'Nothing was installed')
  await shoot(
    '13-recommendation-unavailable',
    { view: 'recommendation', id: UNIMPORTABLE.id, status: 'Can’t be installed' },
    normal
  )
  await host.request('sheetPerform', { action: 'skill-back' })
  const library = await installed()
  await until('final library', (s) =>
    s.rows.some((r) => r.action === `skill-open:${recommended.id}`)
  )
  await shoot('14-library-imported', {
    view: 'overview',
    installed: library,
    recommended: [entry]
  })
  report.push({ action: 'refuse-unimportable', id: UNIMPORTABLE.id })
  return report
}
