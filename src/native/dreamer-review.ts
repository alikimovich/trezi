import type { DreamerDigest } from '../main/dreamer-digest'
import {
  DREAMER_CATEGORIES,
  DREAMER_CATEGORY_LABELS,
  DREAMER_LIMITS,
  type DreamerCategory,
  type DreamerEvidenceItem,
  type DreamerFile,
  evidenceSession
} from '../shared/dreamer'
import type { NativeSheetField, NativeSheetSection, NativeSheetState } from '../shared/native-sheet'

/**
 * LKM-202: the Dreamer's review window as a sectioned sheet. An Overview pane (filter,
 * report, Send / Copy / Export) and one pane per proposal: editable title, problem,
 * proposal and acceptance criteria, whether it is selected and its evidence, each with
 * Open chat. Pure: the controller presents and persists.
 */

/** The last run as the review window shows it, kept in preferences between launches. */
export interface DreamerResult {
  file: DreamerFile
  digest: DreamerDigest | null
  selected: string[]
  model: string | null
  fallback?: string
  sent?: { at: string; tasks: string[] }
}

const SYMBOLS: Record<DreamerCategory, string> = {
  improvement: 'wand.and.stars',
  template: 'doc.on.doc',
  tool: 'hammer',
  speed: 'gauge.with.dots.needle.67percent',
  bug: 'ladybug'
}
export const OVERVIEW = 'overview'
const MAX_OPEN = 3

const visible = (result: DreamerResult, filter: string) =>
  result.file.proposals.filter((p) => filter === 'all' || p.category === filter)

export function reviewSections(result: DreamerResult, filter: string): NativeSheetSection[] {
  return [
    {
      id: OVERVIEW,
      label: 'Overview',
      symbol: 'moon.stars',
      detail: 'Edit any proposal in the sidebar, then send the selected ones to Agent OS.'
    },
    ...visible(result, filter).map((p) => ({
      id: `p:${p.id}`,
      label: p.title,
      symbol: SYMBOLS[p.category],
      detail: `${DREAMER_CATEGORY_LABELS[p.category]}${p.effort ? ` · effort ${p.effort}` : ''}${result.selected.includes(p.id) ? ' · selected' : ''}`
    }))
  ]
}

const evidenceLines = (evidence: DreamerEvidenceItem[]) =>
  evidence
    .map((e, n) =>
      typeof e === 'string'
        ? `${n + 1}. ${e}`
        : [
            `${n + 1}.`,
            e.session ? `chat ${e.session.slice(0, 8)}${e.turn ? `, turn ${e.turn}` : ''}` : '',
            e.quote ? `“${e.quote}”` : '',
            e.numbers && typeof e.numbers === 'object'
              ? Object.entries(e.numbers)
                  .map(([key, value]) => `${key} ${value}`)
                  .join(', ')
              : '',
            typeof e.note === 'string' ? e.note : ''
          ]
            .filter(Boolean)
            .join(' ')
    )
    .join('\n')

export const selectedText = (result: DreamerResult) =>
  `${result.selected.length} of ${result.file.proposals.length} proposals selected`

/**
 * The selection field's id carries an epoch: Select All / None bump it, so the window
 * seeds the new value instead of keeping the choice the user last made.
 */
const includeField = (id: string, epoch: number) => `include${epoch}:${id}`

export function reviewFields(
  result: DreamerResult,
  filter: string,
  target: string,
  epoch = 0
): NativeSheetField[] {
  const { file } = result
  const counts = (category: DreamerCategory) =>
    file.proposals.filter((p) => p.category === category).length
  const scope = file.scope
  const fields: NativeSheetField[] = [
    {
      id: 'filter',
      section: OVERVIEW,
      label: 'Show',
      help: 'Which proposals the sidebar lists.',
      kind: 'choice',
      value: filter,
      choices: [
        { value: 'all', label: `All categories (${file.proposals.length})` },
        ...DREAMER_CATEGORIES.filter(counts).map((c) => ({
          value: c,
          label: `${DREAMER_CATEGORY_LABELS[c]} (${counts(c)})`
        }))
      ]
    },
    {
      id: 'selected',
      section: OVERVIEW,
      label: 'Selected',
      kind: 'readonly',
      value: selectedText(result)
    },
    {
      id: 'run',
      section: OVERVIEW,
      label: 'Run',
      kind: 'readonly',
      value: [
        scope
          ? `${scope.projectName ?? (scope.project ? 'One project' : 'All projects')}, last ${scope.days} days`
          : '',
        file.generatedAt && !Number.isNaN(Date.parse(file.generatedAt))
          ? new Date(file.generatedAt).toLocaleString()
          : '',
        result.model ?? 'digest only'
      ]
        .filter(Boolean)
        .join(' · ')
    },
    {
      id: 'report',
      section: OVERVIEW,
      label: 'Report',
      kind: 'readonly',
      value: file.summary ?? ''
    },
    { id: 'target', section: OVERVIEW, label: 'Agent OS', kind: 'readonly', value: target }
  ]
  if (result.sent)
    fields.push({
      id: 'sent',
      section: OVERVIEW,
      label: 'Last sent',
      kind: 'readonly',
      value: `${new Date(result.sent.at).toLocaleString()} · ${result.sent.tasks.join(', ') || 'no task ids returned'}`
    })
  for (const p of file.proposals) {
    const section = `p:${p.id}`
    fields.push(
      {
        id: includeField(p.id, epoch),
        section,
        label: 'Send to Agent OS',
        kind: 'choice',
        value: result.selected.includes(p.id) ? 'yes' : 'no',
        choices: [
          { value: 'yes', label: 'Selected' },
          { value: 'no', label: 'Not selected' }
        ]
      },
      { id: `title:${p.id}`, section, label: 'Title', kind: 'text', value: p.title },
      {
        id: `facts:${p.id}`,
        section,
        label: 'Category',
        kind: 'readonly',
        value: [
          DREAMER_CATEGORY_LABELS[p.category],
          p.effort ? `effort ${p.effort}` : '',
          p.areas.length ? `areas: ${p.areas.join(', ')}` : ''
        ]
          .filter(Boolean)
          .join(' · ')
      },
      { id: `problem:${p.id}`, section, label: 'Problem', kind: 'multiline', value: p.problem },
      { id: `proposal:${p.id}`, section, label: 'Proposal', kind: 'multiline', value: p.proposal },
      {
        id: `acceptance:${p.id}`,
        section,
        label: 'Acceptance criteria',
        help: 'One per line.',
        kind: 'multiline',
        value: p.acceptance.join('\n')
      }
    )
    if (p.impact)
      fields.push({
        id: `impact:${p.id}`,
        section,
        label: 'Expected impact',
        kind: 'readonly',
        value: p.impact
      })
    if (p.evidence.length)
      fields.push({
        id: `evidence:${p.id}`,
        section,
        label: 'Evidence',
        kind: 'readonly',
        value: evidenceLines(p.evidence)
      })
  }
  return fields
}

export function reviewActions(result: DreamerResult): NativeSheetState['actions'] {
  const actions: NativeSheetState['actions'] = [
    { id: 'select-all', label: 'Select All', section: OVERVIEW },
    { id: 'select-none', label: 'Select None', section: OVERVIEW },
    { id: 'copy-json', label: 'Copy as JSON', section: OVERVIEW },
    { id: 'export', label: 'Export…', section: OVERVIEW },
    { id: 'send', label: 'Send to Agent OS', primary: true, section: OVERVIEW }
  ]
  for (const p of result.file.proposals)
    p.evidence.forEach((e, n) => {
      if (evidenceSession(e) && actions.filter((a) => a.section === `p:${p.id}`).length < MAX_OPEN)
        actions.push({ id: `open:${p.id}:${n}`, label: `Open Chat ${n + 1}`, section: `p:${p.id}` })
    })
  return actions
}

/** The window's edits applied to the result: text, selection. Returns the filter. */
export function applyReviewValues(
  result: DreamerResult,
  values: Record<string, string>,
  epoch = 0
) {
  const selected = new Set(result.selected)
  for (const p of result.file.proposals) {
    const value = (field: string) => values[`${field}:${p.id}`]
    const title = value('title')?.trim()
    if (title) p.title = title.slice(0, DREAMER_LIMITS.title)
    if (value('problem') !== undefined)
      p.problem = value('problem').slice(0, DREAMER_LIMITS.problem)
    if (value('proposal') !== undefined)
      p.proposal = value('proposal').slice(0, DREAMER_LIMITS.proposal)
    if (value('acceptance') !== undefined)
      p.acceptance = value('acceptance')
        .split('\n')
        .map((line) => line.replace(/^\s*(?:[-*•]|\[ \])\s*/, '').trim())
        .filter(Boolean)
        .slice(0, DREAMER_LIMITS.list)
        .map((line) => line.slice(0, DREAMER_LIMITS.item))
    const include = values[includeField(p.id, epoch)]
    if (include === 'yes') selected.add(p.id)
    else if (include === 'no') selected.delete(p.id)
  }
  result.selected = result.file.proposals.filter((p) => selected.has(p.id)).map((p) => p.id)
  const filter = values.filter
  return filter === 'all' || DREAMER_CATEGORIES.includes(filter as DreamerCategory) ? filter : 'all'
}

/** The selected proposals as a version 1 file (every proposal when none is selected). */
export function selectedFile(result: DreamerResult, all = false): DreamerFile {
  const picked = result.file.proposals.filter((p) => result.selected.includes(p.id))
  return { ...result.file, proposals: all || !picked.length ? result.file.proposals : picked }
}
