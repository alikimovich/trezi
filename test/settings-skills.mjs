// LKM-288, LKM-286 Settings → Skills: the pane (settings-skills.ts) over the real Swift
// Skills owner in the fixture process, driven through the real sheet runtime and
// Settings controller. Overview and recommendations, lazy SKILL.md reads, manual add,
// save as a new revision, an edit conflict that keeps the draft, on/off,
// remove/restore, folder import, a pinned GitHub import, cancel, recommendation install
// against the loopback GitHub fixture, and the evidence checks the native smoke applies
// to the rendered window (skills-verification.ts).
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { NativeSettingsController } from '../src/native/settings-controller.ts'
import {
  bodyField,
  GITHUB_FIELDS,
  NEW_SKILL_FIELD,
  NEW_SKILL_TEMPLATE,
  nativeSkills,
  withSkillsPane
} from '../src/native/settings-skills.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import {
  SKILLS_FIXTURE_IMPORT,
  SKILLS_FIXTURE_RECOMMENDATION,
  SKILLS_FIXTURE_SLOW,
  startSkillsGitHubFixture
} from '../src/native/skills-github-fixture.ts'
import { serviceSkills } from '../src/native/skills-service.ts'
import { assertSkillsEvidence } from '../src/native/skills-verification.ts'
import { recommendationUrl, SKILL_RECOMMENDATIONS } from '../src/shared/skills-catalog.ts'
import { compileSkills, link, scratchSpace, skillMd } from './helpers/skills-fixture.mjs'

// --- The catalog: metadata only, GitHub sources, allowed licenses, no file content ---
{
  assert.ok(Object.isFrozen(SKILL_RECOMMENDATIONS))
  assert.deepEqual(
    SKILL_RECOMMENDATIONS.map((r) => [r.id, r.repository, r.license, r.importable]),
    [
      ['frontend-design', 'anthropics/skills', 'Apache-2.0', true],
      ['vercel-react-best-practices', 'vercel-labs/agent-skills', 'MIT', false],
      ['vercel-composition-patterns', 'vercel-labs/agent-skills', 'MIT', true],
      ['swiftui-view-refactor', 'steipete/agent-scripts', 'MIT', true],
      ['swiftui-expert-skill', 'AvdLee/SwiftUI-Agent-Skill', 'MIT', false]
    ]
  )
  const keys = [
    'id',
    'importable',
    'license',
    'licenseSource',
    'path',
    'pathVerified',
    'publisher',
    'repository',
    'summary',
    'title'
  ]
  for (const entry of SKILL_RECOMMENDATIONS) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      entry.importable ? keys : [...keys, 'unavailableReason'].sort(),
      'Metadata only: no SKILL.md text, scripts or install commands'
    )
    assert.match(entry.id, /^[a-z0-9]+(-[a-z0-9]+)*$/)
    assert.match(entry.repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
    const url = new URL(recommendationUrl(entry))
    assert.equal(url.protocol, 'https:')
    assert.equal(url.host, 'github.com')
    // Only a confirmed folder is linked; the rest link the repository.
    assert.equal(url.pathname.includes('/tree/'), entry.pathVerified)
  }
  assert.equal(
    recommendationUrl(SKILL_RECOMMENDATIONS[0]),
    'https://github.com/anthropics/skills/tree/main/skills/frontend-design'
  )
}

// --- The pane over the real owner and the loopback GitHub fixture ---
const space = scratchSpace('trezi-settings-skills-')
const github = await startSkillsGitHubFixture()
try {
  compileSkills(space.binary)
  const pipe = link(space.binary, space.profile(), { SKILLS_GITHUB_PORT: String(github.port) })
  await pipe.started
  const registry = serviceSkills(pipe, 5_000)
  const sent = []
  const sheets = new NativeSheetController(
    { send: (method, data) => sent.push([method, structuredClone(data)]) },
    {},
    {},
    async (channel) => (channel === 'providers:choices' || channel === 'providers:list' ? [] : {})
  )
  const prefs = new Map()
  const preferences = {
    get: (key) => prefs.get(key) ?? null,
    snapshot: () => Object.fromEntries(prefs),
    async apply(batch) {
      for (const [key, value] of batch) prefs.set(key, value)
    },
    set(key, value) {
      return this.apply([[key, value]])
    },
    subscribe() {}
  }
  let picked = null
  const picks = []
  const settings = withSkillsPane(
    new NativeSettingsController(sheets, preferences, () => {}),
    registry,
    async () => {
      picks.push(picked)
      return picked
    }
  )
  const state = () => sheets.current.state
  const skillsFields = () => state().fields.filter((f) => f.section === 'skills')
  const ids = () => skillsFields().map((f) => f.id)
  const field = (id) => state().fields.find((f) => f.id === id)
  const footer = () =>
    state()
      .actions.filter((a) => a.section === 'skills')
      .map((a) => a.id)
  const disabled = () =>
    state()
      .actions.filter((a) => a.section === 'skills' && a.disabled)
      .map((a) => a.id)
  const act = (action, values = {}) =>
    sheets.action({ id: state().id, action, values, section: 'skills' })
  const OVERVIEW = ['skill-add', 'skill-folder', 'skill-github']

  await settings.open()
  assert.ok(
    state().sections.some((s) => s.id === 'skills' && s.symbol === 'book.closed'),
    'Skills is a Settings section'
  )
  // The window opens at once; the list arrives after.
  assert.equal(field('skills-status').label, 'Loading skills…')
  await nativeSkills.loading
  assert.equal(field('skills-status').label, 'No skills yet')
  assert.ok(
    skillsFields().every((f) => f.draft && f.kind === 'readonly'),
    'Nothing in the overview autosaves or is editable'
  )
  assert.deepEqual(footer(), OVERVIEW)
  assert.equal(field('recommendations-note').label, 'Not installed until you choose Install')
  for (const entry of SKILL_RECOMMENDATIONS) {
    const row = field(`recommendation:${entry.id}`)
    assert.equal(row.group, 'Recommended')
    assert.equal(
      row.value,
      entry.importable ? `${entry.publisher} · ${entry.license}` : 'Not importable'
    )
    assert.equal(row.action, `skill-recommendation:${entry.id}`)
    assert.ok(
      state().actions.some((a) => a.id === row.action && !a.section),
      'Row actions are registered without a footer button'
    )
  }
  // The other panes keep their rows and actions.
  assert.ok(state().actions.some((a) => a.id === 'clean-workspaces'))
  assert.ok(state().fields.some((f) => f.id === 'default'))

  // Swapping the AI Providers pane keeps the Skills pane's actions (and the reverse).
  const providers = (action) =>
    sheets.action({ id: state().id, action, values: {}, section: 'providers' })
  await providers('add')
  assert.ok(state().actions.some((a) => a.id === 'save-provider'))
  assert.deepEqual(footer(), OVERVIEW)
  assert.ok(state().actions.some((a) => a.id === 'skill-recommendation:frontend-design'))
  await providers('back')
  assert.deepEqual(footer(), OVERVIEW)
  assert.ok(state().actions.some((a) => a.id === 'add' && a.section === 'providers'))

  // A recommendation: catalog metadata and an explicit Install. The first action from
  // the Skills section selects it, which reloads the list.
  await act('skill-recommendation:frontend-design')
  assert.equal(state().section, 'skills')
  await nativeSkills.loading
  assert.equal(field('recommendation-source').value, 'anthropics/skills/skills/frontend-design')
  assert.equal(field('recommendation-license').value, 'Apache-2.0')
  assert.equal(field('recommendation-status').value, 'Not installed')
  assert.deepEqual(footer(), ['skill-back', 'skill-install'])
  assert.deepEqual(disabled(), [])
  await act('skill-back')
  // One that cannot be imported: Install is shown disabled and refused if sent anyway.
  await act('skill-recommendation:swiftui-expert-skill')
  assert.equal(field('recommendation-status').value, 'Can’t be installed')
  assert.ok(field('recommendation-status').help, 'It says why')
  assert.equal(field('recommendation-link').value, recommendationUrl(SKILL_RECOMMENDATIONS[4]))
  assert.deepEqual(disabled(), ['skill-install'])
  await act('skill-install')
  assert.equal(state().message, undefined, 'A disabled action is not handled')
  await act('skill-back')
  assert.equal((await registry.list()).skills.length, 0, 'Viewing recommendations installs nothing')
  assert.deepEqual(github.requests, [], 'Nothing was fetched before Install')

  // Manual add: a template, a refused SKILL.md keeps the draft, then the real one.
  await act('skill-add')
  assert.deepEqual(footer(), ['skill-back', 'skill-create'])
  assert.equal(field(NEW_SKILL_FIELD).value, NEW_SKILL_TEMPLATE)
  assert.equal(field(NEW_SKILL_FIELD).kind, 'multiline')
  await act('skill-create', { [NEW_SKILL_FIELD]: '# no front matter\n' })
  assert.match(state().message, /SKILL\.md/, 'The service explains the refusal')
  assert.ok(ids().includes(NEW_SKILL_FIELD), 'A refused add stays on the editor')
  await act('skill-create', { [NEW_SKILL_FIELD]: '  ' })
  assert.equal(state().message, 'Paste a SKILL.md first.')
  const text = skillMd('ui-notes', 'Notes for UI work.', 'Use semantic HTML.\n')
  await act('skill-create', { [NEW_SKILL_FIELD]: text })
  assert.equal(state().message, 'Added ui-notes.')
  const [created] = (await registry.list()).skills
  assert.equal(created.name, 'ui-notes')
  assert.deepEqual(created.source, { kind: 'manual' })
  assert.equal(field(`skill:${created.id}`).value, 'On · Manual')
  assert.equal(field(`skill:${created.id}`).actionLabel, 'Edit…')
  assert.ok(!ids().includes('skills-status'))
  // Adding the same name again is the service's conflict, shown as is.
  await act('skill-add')
  await act('skill-create', { [NEW_SKILL_FIELD]: text })
  assert.equal(state().message, 'A skill named ui-notes already exists.')
  await act('skill-back')

  // Opening reads SKILL.md lazily (the list has metadata only).
  assert.ok(!('body' in created))
  await act(`skill-open:${created.id}`)
  const editor = bodyField(created.id, created.revision)
  assert.equal(field(editor).value, text)
  assert.equal(field(editor).kind, 'multiline')
  assert.equal(field('skill-chats').value, 'Not offered yet', 'Provider injection is not claimed')
  assert.match(field('skill-chats').help, /keeps the revision it started with/)
  assert.equal(field('skill-source').value, 'Added manually')
  assert.ok(!ids().includes('skill-commit'), 'A local skill has no pinned commit')
  assert.deepEqual(footer(), ['skill-back', 'skill-toggle', 'skill-remove', 'skill-save'])

  // Save: unchanged text is not a revision; an edit is.
  await act('skill-save', { [editor]: text })
  assert.equal(state().message, 'No changes to save.')
  const edit = `${text}- Keep focus visible.\n`
  await act('skill-save', { [editor]: edit })
  const edited = (await registry.list()).skills[0]
  assert.notEqual(edited.revision, created.revision)
  assert.equal(edited.modified, true)
  assert.equal(
    state().message,
    `Saved revision ${edited.revision.slice(0, 8)} of ui-notes. Chats started from now on use it.`
  )
  assert.equal(
    field(bodyField(edited.id, edited.revision)).value,
    edit,
    'A fresh draft per revision'
  )
  assert.ok(!ids().includes(editor))
  assert.match(field('skill-revision').help, /^Edited since it was added/)

  // A change made elsewhere since the editor opened is a conflict; the view stays.
  const opened = bodyField(edited.id, edited.revision)
  const elsewhere = await registry.edit(edited.id, edited.revision, [
    { path: 'SKILL.md', text: `${edit}- Changed elsewhere.\n` }
  ])
  assert.ok(elsewhere.changed)
  await act('skill-save', { [opened]: `${edit}- Mine.\n` })
  assert.match(state().message, /changed since it was opened/)
  assert.ok(ids().includes(opened), 'The draft stays open after a conflict')

  // On/off and recoverable removal.
  await act('skill-back')
  await act(`skill-open:${created.id}`)
  await act('skill-toggle')
  assert.equal(state().message, 'ui-notes is off.')
  assert.equal((await registry.list()).skills[0].enabled, false)
  assert.equal(field('skill-status').value, 'Off')
  await act('skill-toggle')
  assert.equal((await registry.list()).skills[0].enabled, true)
  await act('skill-remove')
  assert.equal(state().message, 'Removed ui-notes. Restore it from Removed.')
  assert.equal((await registry.list()).skills[0].removed, true)
  assert.equal(field(`removed:${created.id}`).group, 'Removed')
  assert.equal(field('skills-status').label, 'No skills yet')
  await act(`skill-open:${created.id}`)
  assert.deepEqual(footer(), ['skill-back', 'skill-restore'])
  assert.ok(!ids().some((id) => id.startsWith('skill-body:')), 'A removed skill is not edited')
  await act('skill-restore')
  assert.equal(state().message, 'Restored ui-notes.')
  assert.equal((await registry.list()).skills[0].removed, false)
  assert.ok(ids().some((id) => id.startsWith('skill-body:')))
  await act('skill-back')

  // Folder import: the picker names a folder, the service reads and checks it.
  await act('skill-folder')
  assert.deepEqual(picks, [null])
  assert.equal(state().message, undefined, 'A cancelled picker changes nothing')
  const folder = realpathSync(
    space.folder({
      'SKILL.md': skillMd('folder-notes', 'From a folder.'),
      'references/a.md': '# A\n',
      '.DS_Store': 'x'
    })
  )
  picked = folder
  await act('skill-folder')
  assert.equal(state().message, 'Imported folder-notes. Skipped .DS_Store.')
  const fromFolder = (await registry.list()).skills.find((s) => s.name === 'folder-notes')
  assert.deepEqual(fromFolder.source, { kind: 'manual' })
  assert.deepEqual(
    fromFolder.history.map((h) => h.kind),
    ['import']
  )
  assert.deepEqual(OVERVIEW, footer())
  await act(`skill-open:${fromFolder.id}`)
  assert.equal(field('skill-source').value, 'Imported from a folder')
  assert.equal(field('skill-files').value, '1 file')
  await act('skill-back')
  picked = join(folder, 'references', 'a.md')
  await act('skill-folder')
  assert.match(state().message, /folder/i, 'A file is refused with the service’s reason')

  // GitHub import: a form, then a background import pinned to the resolved commit.
  await act('skill-github')
  assert.deepEqual(footer(), ['skill-back', 'skill-github-import'])
  assert.deepEqual(
    ids().filter((id) => id.startsWith('skill-github-')),
    [GITHUB_FIELDS.url, GITHUB_FIELDS.ref, GITHUB_FIELDS.subpath, 'skill-github-checks']
  )
  assert.equal(field(GITHUB_FIELDS.url).kind, 'text')
  await act('skill-github-import', { [GITHUB_FIELDS.url]: ' ' })
  assert.equal(state().message, 'Enter a github.com repository or folder address.')
  await act('skill-github-import', { [GITHUB_FIELDS.url]: SKILLS_FIXTURE_IMPORT.url })
  assert.equal(state().busy, false, 'The window stays usable while it imports')
  assert.deepEqual(footer(), ['skill-back', 'skill-github-cancel'])
  await nativeSkills.importing
  const short = SKILLS_FIXTURE_IMPORT.commit.slice(0, 7)
  assert.equal(
    state().message,
    `Added ${SKILLS_FIXTURE_IMPORT.name} from ${SKILLS_FIXTURE_IMPORT.repository} at ${short} (“v1”).`
  )
  const pinned = (await registry.list()).skills.find((s) => s.name === SKILLS_FIXTURE_IMPORT.name)
  assert.deepEqual(pinned.source, {
    kind: 'github',
    repository: SKILLS_FIXTURE_IMPORT.repository,
    subpath: SKILLS_FIXTURE_IMPORT.subpath,
    commit: SKILLS_FIXTURE_IMPORT.commit,
    license: 'MIT',
    ref: 'v1',
    licenseFile: SKILLS_FIXTURE_IMPORT.licenseFile
  })
  assert.ok(ids().includes(bodyField(pinned.id, pinned.revision)), 'It opens the imported skill')
  assert.equal(
    field('skill-source').value,
    `GitHub: trezi-fixtures/skills/skills/trezi-smoke-github`
  )
  assert.equal(field('skill-commit').value, SKILLS_FIXTURE_IMPORT.commit)
  assert.match(field('skill-commit').help, /“v1”.*never updates/)
  assert.equal(field('skill-license').value, 'MIT')
  assert.match(field('skill-license').help, /^Permissive/)
  // A failed import keeps the form and its values and says why.
  await act('skill-back')
  await act('skill-github')
  const missing = 'https://github.com/trezi-fixtures/skills'
  await act('skill-github-import', {
    [GITHUB_FIELDS.url]: missing,
    [GITHUB_FIELDS.ref]: 'no-such-tag'
  })
  await nativeSkills.importing
  assert.match(state().message, /^Nothing was installed: /)
  assert.equal(field(GITHUB_FIELDS.url).value, missing)
  assert.equal(field(GITHUB_FIELDS.ref).value, 'no-such-tag')
  // Cancel: an import still waiting for GitHub ends with nothing installed.
  const before = (await registry.list()).skills.length
  await act('skill-github-import', {
    [GITHUB_FIELDS.url]: `https://github.com/${SKILLS_FIXTURE_SLOW}`,
    [GITHUB_FIELDS.ref]: ''
  })
  assert.deepEqual(footer(), ['skill-back', 'skill-github-cancel'])
  await act('skill-back')
  assert.equal(field('skills-importing').label, `Importing ${SKILLS_FIXTURE_SLOW}…`)
  await act('skill-github')
  await act('skill-github-cancel')
  await nativeSkills.importing
  assert.equal(state().message, 'Import cancelled. Nothing was installed.')
  assert.equal((await registry.list()).skills.length, before)
  assert.deepEqual(footer(), ['skill-back', 'skill-github-import'])
  await act('skill-back')

  // Install a recommendation: the same importer, checked against the catalog.
  await act('skill-recommendation:frontend-design')
  await act('skill-install')
  assert.equal(field('recommendation-status').value, 'Installing…')
  assert.deepEqual(footer(), ['skill-back', 'skill-github-cancel'])
  await nativeSkills.importing
  const fixture = SKILLS_FIXTURE_RECOMMENDATION
  assert.equal(
    state().message,
    `Added frontend-design from ${fixture.repository} at ${fixture.commit.slice(0, 7)} (“main”).`,
    'The installed folder matches its recommendation'
  )
  const installed = (await registry.list()).skills.find((s) => s.name === 'frontend-design')
  assert.equal(installed.source.commit, fixture.commit)
  assert.equal(installed.source.license, 'Apache-2.0')
  assert.equal(field('skill-license').value, 'Apache-2.0')
  await act('skill-back')
  assert.equal(field('recommendation:frontend-design').value, 'Installed')
  await act('skill-recommendation:frontend-design')
  assert.equal(field('recommendation-status').value, 'Installed')
  assert.deepEqual(footer(), ['skill-back'], 'No second install')
  await act('skill-back')

  // The service unavailable: the overview says so instead of an empty library.
  const quiet = new NativeSheetController({ send() {} }, {}, {}, async () => [])
  const offline = withSkillsPane(
    new NativeSettingsController(quiet, preferences, () => {}),
    serviceSkills({ sendService() {}, on() {} }, 50)
  )
  await offline.open()
  await nativeSkills.loading
  const status = quiet.current.state.fields.find((f) => f.id === 'skills-status')
  assert.equal(status.label, 'Skills are unavailable')
  assert.match(status.help, /did not answer/)
  await pipe.close()
} finally {
  await github.close()
  space.cleanup()
}

await import('./helpers/settings-skills-evidence.mjs')
console.log(
  'Settings Skills: catalog metadata, overview, lazy read, manual add, revisions, conflict, on/off, remove/restore, folder and pinned GitHub import, cancel, recommendation install, offline and rendered evidence passed'
)
