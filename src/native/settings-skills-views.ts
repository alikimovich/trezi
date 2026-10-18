import type { NativeSheetField, NativeSheetState } from '../shared/native-sheet'
import {
  recommendationUrl,
  SKILL_RECOMMENDATIONS,
  type SkillRecommendation
} from '../shared/skills-catalog'
import { SKILL_RECOMMENDATION_IMPORTS } from '../shared/skills-recommendations'
import {
  type SkillBody,
  type SkillSummary,
  type SkillsList,
  skillLicenseStatus
} from '../shared/skills-registry'

/**
 * The rows and buttons of Settings → Skills (LKM-288, LKM-286): what each view shows,
 * built from the registry's metadata list and, for an opened skill, its SKILL.md.
 * `settings-skills.ts` owns the state and every registry call.
 */

export type Action = NativeSheetState['actions'][number]
export type View =
  | { kind: 'overview' }
  | { kind: 'detail'; skill: string; body: SkillBody | null }
  | { kind: 'add' }
  | { kind: 'github' }
  | { kind: 'recommendation'; id: string }
/** A GitHub import running in the service; at most one at a time from this pane. */
export interface Importing {
  /** `owner/repo/folder`, as shown while it runs. */
  label: string
  controller: AbortController
  /** The recommendation being installed, when it came from one. */
  recommendation?: string
}
export interface GitHubForm {
  url: string
  ref: string
  subpath: string
}
export interface Pane {
  view: View
  list: SkillsList | null
  /** Why the list could not be loaded, shown instead of it. */
  error: string | null
  importing: Importing | null
  /** The GitHub form's last submitted values, shown again after a failure. */
  github: GitHubForm
}

export const SKILLS_SECTION = 'skills'
/** The manual-add editor's row; the detail editor's ID carries the skill and revision. */
export const NEW_SKILL_FIELD = 'skill-new'
export const GITHUB_FIELDS = {
  url: 'skill-github-url',
  ref: 'skill-github-ref',
  subpath: 'skill-github-subpath'
} as const
export const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when an agent should use it.
---

# My skill

Steps and rules the agent follows.
`
export const short = (revision: string) => revision.slice(0, 8)
const clip = (text: string, limit = 160) =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
/** The editor row of a skill at a revision: a new revision gets a fresh draft. */
export const bodyField = (skill: string, revision: string) => `skill-body:${skill}@${revision}`
const NEXT_SESSION =
  'A chat keeps the revision it started with; a saved edit reaches only chats started after it.'
/** LKM-287: what each provider actually gets, stated without a parity claim. */
const AVAILABILITY =
  'Claude loads it natively as the trezi-library plugin. Codex (including custom endpoints) gets Trezi’s compatibility catalog, not Codex’s native skills, and reads the instructions only when a task matches. Gemini is experimental and may not reach the file. Titles, completions, memory updates and a provider’s own sub-agents don’t get skills. A conversation resumed in an outside CLI keeps only what its history already says.'

/** The library's skill taken from a recommendation's folder, removed or not. */
export function installedFrom(list: SkillsList | null, entry: SkillRecommendation) {
  const repository = entry.repository.toLowerCase()
  const found = (list?.skills ?? []).filter(
    (s) =>
      s.source.kind === 'github' &&
      s.source.repository.toLowerCase() === repository &&
      s.source.subpath === entry.path
  )
  return found.find((s) => !s.removed) ?? found[0]
}

function sourceText(skill: SkillSummary) {
  if (skill.source.kind === 'manual')
    return skill.history[0]?.kind === 'import' ? 'Imported from a folder' : 'Added manually'
  const { repository, subpath } = skill.source
  return `GitHub: ${repository}${subpath ? `/${subpath}` : ''}`
}
/** The license row of a GitHub skill: shown as found, never inferred. */
function licenseRow(source: Extract<SkillSummary['source'], { kind: 'github' }>) {
  const where = source.licenseFile ? ` Found in ${source.licenseFile}.` : ''
  const status = skillLicenseStatus(source.license)
  const help = {
    permissive: `Permissive: use and share it with attribution.${where}`,
    copyleft: `Copyleft: sharing changed copies has conditions.${where}`,
    restricted: `Restricted: read the license before using it.${where}`,
    unknown: source.license
      ? `A license was found but not recognised. Read it before using the skill.${where}`
      : 'No license was found. Check the repository before using or sharing it.'
  }[status]
  return {
    value:
      source.license === null
        ? 'None found'
        : source.license === 'NOASSERTION'
          ? 'Unrecognised'
          : source.license,
    help
  }
}
function providersText(skill: SkillSummary) {
  const names = (['claude', 'codex', 'gemini'] as const).filter((p) => skill.providers[p])
  const label = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }
  return names.length ? names.map((p) => label[p]).join(', ') : 'none'
}
/** The Chats row: the providers that offer the skill in new chats, and how. */
export function chatsText(skill: Pick<SkillSummary, 'enabled' | 'providers'>) {
  if (!skill.enabled) return 'Off: not in new chats'
  const label = {
    claude: 'Claude: native',
    codex: 'Codex: compatibility',
    gemini: 'Gemini: experimental'
  }
  const names = (['claude', 'codex', 'gemini'] as const).filter((p) => skill.providers[p])
  return names.length ? names.map((p) => label[p]).join(' · ') : 'No provider'
}
function status(skill: SkillSummary) {
  return [
    skill.enabled ? 'On' : 'Off',
    skill.source.kind === 'manual' ? 'Manual' : 'GitHub',
    ...(skill.modified ? ['Edited'] : [])
  ].join(' · ')
}

export function overview(pane: Pane) {
  const fields: NativeSheetField[] = []
  const actions: Action[] = [
    { id: 'skill-add', label: 'Add Skill…', section: SKILLS_SECTION },
    { id: 'skill-folder', label: 'Import Folder…', section: SKILLS_SECTION },
    { id: 'skill-github', label: 'Import from GitHub…', section: SKILLS_SECTION }
  ]
  const row = (field: Omit<NativeSheetField, 'kind'>) => fields.push({ kind: 'readonly', ...field })
  const skills = pane.list?.skills ?? []
  const installed = skills.filter((s) => !s.removed),
    removed = skills.filter((s) => s.removed)
  // One row ID while loading, failed or empty: the window's values stay the same either way.
  if (pane.error) {
    row({
      id: 'skills-status',
      group: 'Installed',
      label: 'Skills are unavailable',
      help: pane.error,
      value: ''
    })
  } else if (!pane.list) {
    row({ id: 'skills-status', group: 'Installed', label: 'Loading skills…', value: '' })
  } else if (!installed.length) {
    row({
      id: 'skills-status',
      group: 'Installed',
      label: 'No skills yet',
      help: 'Add Skill pastes a SKILL.md; you can also import a folder or a GitHub repository. Skills stay in Trezi until you remove them.',
      value: ''
    })
  }
  if (pane.importing)
    row({
      id: 'skills-importing',
      group: 'Installed',
      label: `Importing ${pane.importing.label}…`,
      help: 'It is added once every file has been checked.',
      value: ''
    })
  for (const skill of installed) {
    row({
      id: `skill:${skill.id}`,
      group: 'Installed',
      label: skill.name,
      help: clip(skill.description),
      value: status(skill),
      action: `skill-open:${skill.id}`,
      actionLabel: 'Edit…'
    })
    actions.push({ id: `skill-open:${skill.id}`, label: `Edit ${skill.name}` })
  }
  row({
    id: 'recommendations-note',
    group: 'Recommended',
    label: 'Not installed until you choose Install',
    help: 'Each recommendation names a GitHub folder and its license. Install adds it to the library.',
    value: ''
  })
  for (const entry of SKILL_RECOMMENDATIONS) {
    const taken = installedFrom(pane.list, entry)
    row({
      id: `recommendation:${entry.id}`,
      group: 'Recommended',
      label: entry.title,
      help: entry.summary,
      value: taken
        ? taken.removed
          ? 'Removed'
          : 'Installed'
        : entry.importable
          ? `${entry.publisher} · ${entry.license}`
          : 'Not importable',
      action: `skill-recommendation:${entry.id}`,
      actionLabel: 'Details…'
    })
    actions.push({ id: `skill-recommendation:${entry.id}`, label: `Details ${entry.title}` })
  }
  for (const skill of removed) {
    row({
      id: `removed:${skill.id}`,
      group: 'Removed',
      label: skill.name,
      help: skill.removedAt ? `Removed ${day(skill.removedAt)}.` : 'Removed.',
      value: '',
      action: `skill-open:${skill.id}`,
      actionLabel: 'Restore…'
    })
    actions.push({ id: `skill-open:${skill.id}`, label: `Open ${skill.name}` })
  }
  return { fields, actions }
}

export function detail(skill: SkillSummary, body: SkillBody | null) {
  const saved = count(skill.history.length, 'saved revision')
  const fields: NativeSheetField[] = [
    {
      id: 'skill-status',
      label: 'Status',
      help: skill.removed
        ? 'A removed skill keeps its files and revisions. Restore brings it back as it was.'
        : undefined,
      kind: 'readonly',
      value: skill.removed
        ? skill.removedAt
          ? `Removed ${day(skill.removedAt)}`
          : 'Removed'
        : skill.enabled
          ? 'On'
          : 'Off'
    },
    { id: 'skill-source', label: 'Source', kind: 'readonly', value: sourceText(skill) }
  ]
  if (skill.source.kind === 'github') {
    const { commit, ref } = skill.source
    fields.push(
      {
        id: 'skill-commit',
        label: 'Pinned commit',
        help: `${ref ? `Asked for “${ref}”. ` : ''}Trezi never updates it by itself.`,
        kind: 'readonly',
        value: commit
      },
      { id: 'skill-license', label: 'License', kind: 'readonly', ...licenseRow(skill.source) }
    )
  }
  fields.push(
    {
      id: 'skill-revision',
      label: 'Revision',
      help: skill.modified
        ? `Edited since it was added (${short(skill.installedRevision)}). ${saved}.`
        : `As added. ${saved}.`,
      kind: 'readonly',
      value: short(skill.revision)
    },
    {
      id: 'skill-chats',
      label: 'Chats',
      help: `Offered to new chats with: ${providersText(skill)}. ${AVAILABILITY} ${NEXT_SESSION}`,
      kind: 'readonly',
      value: chatsText(skill)
    }
  )
  const grouped = fields.map((field) => ({ ...field, group: skill.name }) as NativeSheetField)
  if (body) {
    grouped.push({
      id: bodyField(skill.id, body.revision),
      group: 'SKILL.md',
      label: 'SKILL.md',
      help: 'Save Revision keeps the previous revision and marks the skill Edited. Saving runs nothing and grants no tool permissions; the instructions still guide what an agent does with its existing tools.',
      kind: 'multiline',
      value: body.body,
      height: 220
    })
    grouped.push({
      id: 'skill-files',
      group: 'SKILL.md',
      label: 'Other files',
      help: body.references.length
        ? clip(body.references.map((file) => file.path).join(', '))
        : 'This skill is only its SKILL.md.',
      kind: 'readonly',
      value: body.references.length ? count(body.references.length, 'file') : 'None'
    })
  }
  const actions: Action[] = skill.removed
    ? [
        { id: 'skill-back', label: 'Back', section: SKILLS_SECTION },
        { id: 'skill-restore', label: 'Restore', primary: true, section: SKILLS_SECTION }
      ]
    : [
        { id: 'skill-back', label: 'Back', section: SKILLS_SECTION },
        {
          id: 'skill-toggle',
          label: skill.enabled ? 'Turn Off' : 'Turn On',
          section: SKILLS_SECTION
        },
        { id: 'skill-remove', label: 'Remove', destructive: true, section: SKILLS_SECTION },
        { id: 'skill-save', label: 'Save Revision', primary: true, section: SKILLS_SECTION }
      ]
  return { fields: grouped, actions }
}

export function add() {
  const fields: NativeSheetField[] = [
    {
      id: NEW_SKILL_FIELD,
      group: 'Add a Skill',
      label: 'SKILL.md',
      help: 'Paste a SKILL.md: front matter with a lowercase `name` and a `description`, then the instructions.',
      kind: 'multiline',
      value: NEW_SKILL_TEMPLATE,
      height: 300
    }
  ]
  const actions: Action[] = [
    { id: 'skill-back', label: 'Back', section: SKILLS_SECTION },
    { id: 'skill-create', label: 'Add Skill', primary: true, section: SKILLS_SECTION }
  ]
  return { fields, actions }
}

const CHECKS =
  'Trezi resolves the ref to one commit, downloads only that commit and keeps instructions only: scripts, hooks, tool permissions and manifests are refused. Import and discovery run no package scripts and grant no tool permissions.'

export function github(pane: Pane) {
  const group = 'Import from GitHub'
  const back: Action = { id: 'skill-back', label: 'Back', section: SKILLS_SECTION }
  if (pane.importing) {
    const fields: NativeSheetField[] = [
      {
        id: 'skill-github-status',
        group,
        label: `Importing ${pane.importing.label}…`,
        help: `${CHECKS} Nothing is added until every check passes.`,
        kind: 'readonly',
        value: ''
      }
    ]
    return {
      fields,
      actions: [
        back,
        { id: 'skill-github-cancel', label: 'Cancel Import', section: SKILLS_SECTION }
      ] as Action[]
    }
  }
  const fields: NativeSheetField[] = [
    {
      id: GITHUB_FIELDS.url,
      group,
      label: 'Repository or folder',
      help: 'A github.com address: the repository, or a folder in it (…/tree/<ref>/<folder>).',
      kind: 'text',
      value: pane.github.url,
      placeholder: 'https://github.com/owner/repo'
    },
    {
      id: GITHUB_FIELDS.ref,
      group,
      label: 'Branch, tag or commit',
      help: 'Optional. Empty uses the default branch, or the ref in the address.',
      kind: 'text',
      value: pane.github.ref,
      placeholder: 'main'
    },
    {
      id: GITHUB_FIELDS.subpath,
      group,
      label: 'Folder',
      help: 'Optional. The folder that holds SKILL.md, when the address does not name it.',
      kind: 'text',
      value: pane.github.subpath,
      placeholder: 'skills/name'
    },
    { id: 'skill-github-checks', group, label: 'Checks', help: CHECKS, kind: 'readonly', value: '' }
  ]
  return {
    fields,
    actions: [
      back,
      { id: 'skill-github-import', label: 'Import', primary: true, section: SKILLS_SECTION }
    ] as Action[]
  }
}

export function recommendation(pane: Pane, entry: SkillRecommendation) {
  const taken = installedFrom(pane.list, entry)
  const running = pane.importing?.recommendation === entry.id
  const ref = SKILL_RECOMMENDATION_IMPORTS[entry.id]?.ref ?? 'main'
  const install = taken
    ? taken.removed
      ? {
          value: 'Removed',
          help: 'It is in Removed with its files and revisions. Restore it from there.'
        }
      : {
          value: 'Installed',
          help: 'It is in your library. Open it from Installed to edit or turn it off.'
        }
    : running
      ? { value: 'Installing…', help: CHECKS }
      : entry.importable
        ? {
            value: 'Not installed',
            help: `Install downloads ${entry.repository}/${entry.path} at the commit “${ref}” points to now, checks every file and adds it to your library. Installing runs none of its files and grants no tool permissions.`
          }
        : { value: 'Can’t be installed', help: entry.unavailableReason }
  const fields: NativeSheetField[] = [
    {
      id: 'recommendation-publisher',
      label: 'Publisher',
      kind: 'readonly',
      value: entry.publisher
    },
    {
      id: 'recommendation-source',
      label: 'Source',
      help: entry.pathVerified ? undefined : 'Its folder is not confirmed yet.',
      kind: 'readonly',
      value: entry.pathVerified ? `${entry.repository}/${entry.path}` : entry.repository
    },
    {
      id: 'recommendation-license',
      label: 'License',
      help: `Found in ${entry.licenseSource}.`,
      kind: 'readonly',
      value: entry.license
    },
    { id: 'recommendation-link', label: 'Link', kind: 'readonly', value: recommendationUrl(entry) },
    { id: 'recommendation-status', label: 'Install', kind: 'readonly', ...install }
  ].map((field) => ({ ...field, group: entry.title }) as NativeSheetField)
  const actions: Action[] = [{ id: 'skill-back', label: 'Back', section: SKILLS_SECTION }]
  if (running)
    actions.push({ id: 'skill-github-cancel', label: 'Cancel Install', section: SKILLS_SECTION })
  else if (!taken)
    actions.push({
      id: 'skill-install',
      label: 'Install',
      primary: true,
      section: SKILLS_SECTION,
      // Shown but unavailable while another import runs or when the folder cannot be imported.
      ...(entry.importable && entry.pathVerified && !pane.importing ? {} : { disabled: true })
    })
  return { fields, actions }
}
