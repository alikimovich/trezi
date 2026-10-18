import type { NativeSheetAction } from '../shared/native-sheet'
import { SKILL_RECOMMENDATIONS } from '../shared/skills-catalog'
import { recommendationImport, recommendationMismatch } from '../shared/skills-recommendations'
import type { SkillGitHubInput, SkillsList } from '../shared/skills-registry'
import type { NativeSettingsController } from './settings-controller'
import {
  add,
  bodyField,
  detail,
  GITHUB_FIELDS,
  github,
  installedFrom,
  NEW_SKILL_FIELD,
  overview,
  type Pane,
  recommendation,
  SKILLS_SECTION,
  short
} from './settings-skills-views'
import type { NativeSheetController } from './sheets-runtime'
import { SkillsError, type SkillsRegistry } from './skills-service'

export {
  bodyField,
  GITHUB_FIELDS,
  NEW_SKILL_FIELD,
  NEW_SKILL_TEMPLATE,
  SKILLS_SECTION
} from './settings-skills-views'

/**
 * LKM-288, LKM-286: Settings → Skills. The library the Swift Skills owner keeps in
 * Trezi's profile (LKM-284): installed and removed skills, recommended ones (catalog
 * metadata until Install), a skill's SKILL.md (read only when opened) saved as a new
 * revision, a pasted SKILL.md, a chosen folder, and a GitHub folder pinned to one
 * commit (LKM-285). Every row is a draft: nothing autosaves, and every change is one
 * registry call; the service does every read of a folder and every download. New chats pin
 * the enabled skills (LKM-287, `src/main/session-skills.ts`).
 */

type Sheet = NonNullable<NativeSheetController['current']>
/** Asks the user for a folder (the host's open panel); null when they cancel. */
export type PickFolder = () => Promise<string | null>

/**
 * The app's registry client, for the native smoke (like `nativeDreamer`); the latest
 * list load of the Skills pane, which settles when the pane shows it; the running
 * GitHub import, which settles when the pane shows its result; and a test-only folder
 * choice that replaces the open panel.
 */
export const nativeSkills: {
  current: SkillsRegistry | null
  loading: Promise<void>
  importing: Promise<void>
  pickFolder: PickFolder | null
} = {
  current: null,
  loading: Promise.resolve(),
  importing: Promise.resolve(),
  pickFolder: null
}
const panes = new WeakSet<Sheet>()
const summary = (pane: Pane, id: string) => pane.list?.skills.find((s) => s.id === id)
const owns = (action: string) => action.startsWith('skill-')
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Swap the Skills pane in place: same window and section, the other panes untouched. */
function show(sheets: NativeSheetController, sheet: Sheet, pane: Pane) {
  const { view } = pane
  const skill = view.kind === 'detail' ? summary(pane, view.skill) : undefined
  const entry =
    view.kind === 'recommendation' ? SKILL_RECOMMENDATIONS.find((r) => r.id === view.id) : undefined
  if ((view.kind === 'detail' && !skill) || (view.kind === 'recommendation' && !entry))
    pane.view = { kind: 'overview' }
  const next =
    view.kind === 'detail' && skill
      ? detail(skill, view.body)
      : view.kind === 'add'
        ? add()
        : view.kind === 'github'
          ? github(pane)
          : entry
            ? recommendation(pane, entry)
            : overview(pane)
  sheet.state.fields = [
    ...sheet.state.fields.filter((f) => f.section !== SKILLS_SECTION),
    ...next.fields.map((field) => ({ ...field, section: SKILLS_SECTION, draft: true }))
  ]
  sheet.state.actions = [...sheet.state.actions.filter((a) => !owns(a.id)), ...next.actions]
  if (sheets.current === sheet) sheets.refresh()
}

async function load(registry: SkillsRegistry, pane: Pane) {
  try {
    pane.list = await registry.list()
    pane.error = null
  } catch (error) {
    pane.error = describe(error)
  }
}

/**
 * Runs a GitHub import in the background: the window stays usable and Cancel stays
 * pressable. Its end shows the new skill (when the pane still shows the import) and
 * a message with the pinned commit, or why nothing was installed.
 */
function startImport(
  registry: SkillsRegistry,
  sheets: NativeSheetController,
  sheet: Sheet,
  pane: Pane,
  input: SkillGitHubInput,
  recommendationId?: string
) {
  if (pane.importing) throw new Error('Another import is still running. Wait for it or cancel it.')
  const controller = new AbortController()
  const label = [input.url.replace(/^https?:\/\/(www\.)?github\.com\//i, ''), input.subpath]
    .filter(Boolean)
    .join(' · ')
  pane.importing = { label, controller, recommendation: recommendationId }
  const shown = () =>
    pane.view.kind === 'github' ||
    (pane.view.kind === 'recommendation' && pane.view.id === recommendationId)
  nativeSkills.importing = (async () => {
    let message: string
    try {
      const result = await registry.importGitHub(input, { signal: controller.signal })
      if (result.list) pane.list = result.list
      else await load(registry, pane)
      const entry = SKILL_RECOMMENDATIONS.find((r) => r.id === recommendationId)
      const mismatch = entry ? recommendationMismatch(entry, result) : []
      const { source } = result
      message = [
        `Added ${result.name} from ${source.repository} at ${source.commit.slice(0, 7)}${source.ref ? ` (“${source.ref}”)` : ''}.`,
        ...(mismatch.length ? [`It differs from the recommendation: ${mismatch.join('; ')}.`] : []),
        ...(result.skipped.length ? [`Skipped ${result.skipped.join(', ')}.`] : [])
      ].join(' ')
      pane.importing = null
      if (shown()) {
        pane.github = { url: '', ref: '', subpath: '' }
        pane.view = {
          kind: 'detail',
          skill: result.skill,
          body: await registry.read(result.skill).catch(() => null)
        }
      }
    } catch (error) {
      pane.importing = null
      message =
        error instanceof SkillsError && error.code === 'cancelled'
          ? 'Import cancelled. Nothing was installed.'
          : `Nothing was installed: ${describe(error)}`
    }
    if (sheets.current !== sheet) return
    sheet.state.message = message
    show(sheets, sheet, pane)
  })()
}

async function handle(
  registry: SkillsRegistry,
  sheets: NativeSheetController,
  sheet: Sheet,
  pane: Pane,
  action: NativeSheetAction,
  pick: PickFolder | undefined
) {
  const id = action.action
  const view = pane.view
  const current = view.kind === 'detail' ? summary(pane, view.skill) : undefined
  const changed = (list: SkillsList | null) => {
    if (list) pane.list = list
  }
  const added = (skill: string | undefined, verb: string) => {
    const name = skill ? summary(pane, skill)?.name : undefined
    sheet.state.message = name ? `${verb} ${name}.` : `Skill ${verb.toLowerCase()}.`
  }
  if (id === 'skill-back') pane.view = { kind: 'overview' }
  else if (id === 'skill-add') pane.view = { kind: 'add' }
  else if (id === 'skill-github') pane.view = { kind: 'github' }
  else if (id.startsWith('skill-recommendation:'))
    pane.view = { kind: 'recommendation', id: id.slice('skill-recommendation:'.length) }
  else if (id.startsWith('skill-open:')) {
    const skill = id.slice('skill-open:'.length)
    const found = summary(pane, skill)
    if (!found) throw new Error('This skill is no longer in the library.')
    // The list holds metadata only; SKILL.md is read when a skill is opened.
    pane.view = { kind: 'detail', skill, body: found.removed ? null : await registry.read(skill) }
  } else if (id === 'skill-create') {
    const text = action.values[NEW_SKILL_FIELD] ?? ''
    if (!text.trim()) throw new Error('Paste a SKILL.md first.')
    const change = await registry.create([{ path: 'SKILL.md', text }])
    changed(change.list)
    pane.view = { kind: 'overview' }
    added(change.skill, 'Added')
  } else if (id === 'skill-folder') {
    const folder = await (nativeSkills.pickFolder ?? pick)?.()
    if (!folder) return
    // The service reads and checks the folder; the copy in Trezi never follows it.
    const change = await registry.importFolder(folder)
    changed(change.list)
    pane.view = { kind: 'overview' }
    added(change.skill, 'Imported')
    if (change.skipped?.length) sheet.state.message += ` Skipped ${change.skipped.join(', ')}.`
  } else if (id === 'skill-github-import') {
    const value = (key: keyof typeof GITHUB_FIELDS) =>
      (action.values[GITHUB_FIELDS[key]] ?? '').trim()
    pane.github = { url: value('url'), ref: value('ref'), subpath: value('subpath') }
    if (!pane.github.url) throw new Error('Enter a github.com repository or folder address.')
    const { url, ref, subpath } = pane.github
    startImport(registry, sheets, sheet, pane, {
      url,
      ...(ref ? { ref } : {}),
      ...(subpath ? { subpath } : {})
    })
  } else if (id === 'skill-install' && view.kind === 'recommendation') {
    const entry = SKILL_RECOMMENDATIONS.find((r) => r.id === view.id)
    const input = entry && recommendationImport(entry)
    if (!entry || !input) throw new Error('This recommendation can’t be installed.')
    if (installedFrom(pane.list, entry))
      throw new Error(`${entry.title} is already in the library.`)
    startImport(registry, sheets, sheet, pane, input, entry.id)
  } else if (id === 'skill-github-cancel') {
    pane.importing?.controller.abort()
  } else if (view.kind === 'detail' && current) {
    const name = current.name
    if (id === 'skill-save') {
      const body = view.body
      const text = body ? action.values[bodyField(current.id, body.revision)] : undefined
      if (!body || text === undefined) throw new Error('Open the skill again, then edit.')
      if (text === body.body) {
        sheet.state.message = 'No changes to save.'
        return
      }
      // `base` is the revision on screen: a change made elsewhere since is a conflict.
      const change = await registry.edit(current.id, body.revision, [{ path: 'SKILL.md', text }])
      changed(change.list)
      pane.view = { kind: 'detail', skill: current.id, body: await registry.read(current.id) }
      sheet.state.message = `Saved revision ${short(pane.view.body?.revision ?? '')} of ${name}. Chats started from now on use it.`
    } else if (id === 'skill-toggle') {
      changed((await registry.setEnabled(current.id, !current.enabled)).list)
      sheet.state.message = `${name} is ${current.enabled ? 'off' : 'on'}.`
    } else if (id === 'skill-remove') {
      changed((await registry.remove(current.id)).list)
      pane.view = { kind: 'overview' }
      sheet.state.message = `Removed ${name}. Restore it from Removed.`
    } else if (id === 'skill-restore') {
      changed((await registry.restore(current.id)).list)
      pane.view = { kind: 'detail', skill: current.id, body: await registry.read(current.id) }
      sheet.state.message = `Restored ${name}.`
    }
  }
}

/**
 * Settings → Skills on top of the Settings window, like the Dreamer pane
 * (`settings-dreamer.ts`). `pick` asks for a folder to import.
 */
export function withSkillsPane(
  settings: NativeSettingsController,
  registry: SkillsRegistry,
  pick?: PickFolder
) {
  const open = settings.open.bind(settings)
  settings.open = async () => {
    await open()
    const sheets = settings.sheets,
      sheet = sheets.current
    if (!sheet || panes.has(sheet) || !sheet.state.sections?.some((s) => s.id === SKILLS_SECTION))
      return
    const pane: Pane = {
      view: { kind: 'overview' },
      list: null,
      error: null,
      importing: null,
      github: { url: '', ref: '', subpath: '' }
    }
    panes.add(sheet)
    const reload = () => {
      nativeSkills.loading = load(registry, pane).then(() => {
        if (sheets.current === sheet && pane.view.kind === 'overview') show(sheets, sheet, pane)
      })
    }
    const handleNext = sheet.handle
    sheet.handle = async (action) => {
      if (!owns(action.action)) return handleNext(action)
      try {
        await handle(registry, sheets, sheet, pane, action, pick)
      } finally {
        // A failed call keeps the view, and the window keeps the unsaved draft.
        if (sheets.current === sheet) show(sheets, sheet, pane)
      }
    }
    const select = sheet.select
    sheet.select = (section) => {
      select?.(section)
      if (section === SKILLS_SECTION && pane.view.kind === 'overview') reload()
    }
    show(sheets, sheet, pane)
    // The window is already open with "Loading skills…"; the other panes do not wait.
    reload()
  }
  return settings
}
