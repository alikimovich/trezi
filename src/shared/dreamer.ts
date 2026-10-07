/**
 * LKM-202: the Dreamer's proposal file, version 1 (docs/DREAMER.md). Agent OS imports
 * it, so the limits here match its importer: change both together. Pure.
 */
export const DREAMER_VERSION = 1
export const DREAMER_CATEGORIES = ['improvement', 'template', 'tool', 'speed', 'bug'] as const
export type DreamerCategory = (typeof DREAMER_CATEGORIES)[number]
export const DREAMER_EFFORTS = ['S', 'M', 'L'] as const
export type DreamerEffort = (typeof DREAMER_EFFORTS)[number]
export const DREAMER_CATEGORY_LABELS: Record<DreamerCategory, string> = {
  improvement: 'Improvement',
  template: 'Template',
  tool: 'Tool',
  speed: 'Speed',
  bug: 'Bug'
}
/** The limits Agent OS enforces (`src/proposals.ts` there). */
export const DREAMER_LIMITS = {
  proposals: 50,
  id: 100,
  title: 200,
  problem: 5000,
  proposal: 10000,
  impact: 2000,
  list: 30,
  item: 1000,
  area: 200,
  quote: 200
} as const

/** A session/turn reference: a short redacted quote and the numbers behind it. */
export interface DreamerEvidence {
  /** The saved chat's id (`SessionRecord.id`); the review window opens it. */
  session?: string
  /** The 1-based user turn in that chat. */
  turn?: number
  quote?: string
  numbers?: Record<string, number>
  note?: string
}
export interface DreamerProposal {
  id: string
  title: string
  category: DreamerCategory
  problem: string
  evidence: DreamerEvidence[]
  proposal: string
  impact: string
  effort: DreamerEffort
  acceptance: string[]
  areas: string[]
}
export interface DreamerScope {
  /** A project's key, or null for every project. */
  project: string | null
  projectName?: string
  days: number
}
export interface DreamerFile {
  version: 1
  generatedAt: string
  scope?: DreamerScope
  /** The short report: what the run looked at and what stood out. */
  summary?: string
  proposals: DreamerProposal[]
}
/** Agent OS's answer to a send: one task per imported proposal. */
export interface DreamerSendResult {
  ok: boolean
  tasks: string[]
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Every problem with `value` as a version 1 file; empty when it is valid. */
export function dreamerErrors(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['The file is not a JSON object.']
  if (value.version !== DREAMER_VERSION) errors.push('version must be 1')
  if (typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt)))
    errors.push('generatedAt must be an ISO date')
  if (value.summary !== undefined && typeof value.summary !== 'string')
    errors.push('summary must be a string')
  const proposals = value.proposals
  if (!Array.isArray(proposals) || !proposals.length) {
    errors.push('proposals must be a non-empty list')
    return errors
  }
  if (proposals.length > DREAMER_LIMITS.proposals)
    errors.push(`at most ${DREAMER_LIMITS.proposals} proposals`)
  const ids = new Set<string>()
  for (const [index, p] of proposals.entries()) {
    const at = `proposals[${index}]`
    if (!isRecord(p)) {
      errors.push(`${at} must be an object`)
      continue
    }
    const text = (key: string, max: number, required = false) => {
      const v = p[key]
      if (typeof v !== 'string') errors.push(`${at}.${key} must be a string`)
      else if (required && !v.trim()) errors.push(`${at}.${key} must not be empty`)
      else if (v.length > max) errors.push(`${at}.${key} is longer than ${max} characters`)
    }
    const list = (key: string, max: number) => {
      const v = p[key]
      if (!Array.isArray(v) || v.some((item) => typeof item !== 'string'))
        errors.push(`${at}.${key} must be a list of strings`)
      else if (v.length > DREAMER_LIMITS.list)
        errors.push(`${at}.${key} has more than ${DREAMER_LIMITS.list} items`)
      else if (v.some((item: string) => item.length > max))
        errors.push(`${at}.${key} has an item longer than ${max} characters`)
    }
    text('id', DREAMER_LIMITS.id, true)
    if (typeof p.id === 'string') {
      if (ids.has(p.id)) errors.push(`${at}.id ${p.id} is not unique`)
      ids.add(p.id)
    }
    text('title', DREAMER_LIMITS.title, true)
    if (!DREAMER_CATEGORIES.includes(p.category as DreamerCategory))
      errors.push(`${at}.category must be one of ${DREAMER_CATEGORIES.join(', ')}`)
    text('problem', DREAMER_LIMITS.problem)
    text('proposal', DREAMER_LIMITS.proposal)
    text('impact', DREAMER_LIMITS.impact)
    if (!DREAMER_EFFORTS.includes(p.effort as DreamerEffort))
      errors.push(`${at}.effort must be S, M or L`)
    list('acceptance', DREAMER_LIMITS.item)
    list('areas', DREAMER_LIMITS.area)
    const evidence = p.evidence
    if (!Array.isArray(evidence)) errors.push(`${at}.evidence must be a list`)
    else if (evidence.length > DREAMER_LIMITS.list)
      errors.push(`${at}.evidence has more than ${DREAMER_LIMITS.list} items`)
    else
      for (const [n, e] of evidence.entries()) {
        const where = `${at}.evidence[${n}]`
        if (!isRecord(e)) {
          errors.push(`${where} must be an object`)
          continue
        }
        if (e.session !== undefined && typeof e.session !== 'string')
          errors.push(`${where}.session must be a string`)
        if (e.turn !== undefined && !(Number.isInteger(e.turn) && (e.turn as number) > 0))
          errors.push(`${where}.turn must be a positive whole number`)
        if (
          e.quote !== undefined &&
          (typeof e.quote !== 'string' || e.quote.length > DREAMER_LIMITS.quote)
        )
          errors.push(
            `${where}.quote must be a string of at most ${DREAMER_LIMITS.quote} characters`
          )
        if (
          e.note !== undefined &&
          (typeof e.note !== 'string' || e.note.length > DREAMER_LIMITS.item)
        )
          errors.push(`${where}.note must be a string of at most ${DREAMER_LIMITS.item} characters`)
        if (
          e.numbers !== undefined &&
          (!isRecord(e.numbers) ||
            Object.values(e.numbers).some((v) => typeof v !== 'number' || !Number.isFinite(v)))
        )
          errors.push(`${where}.numbers must map names to numbers`)
      }
  }
  return errors
}

const cut = (value: unknown, max: number) =>
  typeof value === 'string' ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : ''
const strings = (value: unknown, max: number) =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [])
    .map((item) => cut(typeof item === 'string' ? item.trim() : '', max))
    .filter(Boolean)
    .slice(0, DREAMER_LIMITS.list)

/**
 * A model's (or an edited) proposal brought into the version 1 shape: unknown fields
 * dropped, text cut to the limits, a missing id numbered. Null without a title.
 */
export function normalizeProposal(raw: unknown, index: number): DreamerProposal | null {
  if (!isRecord(raw)) return null
  const title = cut(String(raw.title ?? '').trim(), DREAMER_LIMITS.title)
  if (!title) return null
  const category = DREAMER_CATEGORIES.includes(raw.category as DreamerCategory)
    ? (raw.category as DreamerCategory)
    : 'improvement'
  const effort = DREAMER_EFFORTS.includes(String(raw.effort).toUpperCase() as DreamerEffort)
    ? (String(raw.effort).toUpperCase() as DreamerEffort)
    : 'M'
  const id =
    cut(String(raw.id ?? '').replace(/[^A-Za-z0-9_.-]/g, '-'), DREAMER_LIMITS.id) || `p${index + 1}`
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .filter(isRecord)
    .slice(0, DREAMER_LIMITS.list)
    .map((e) => {
      const out: DreamerEvidence = {}
      if (typeof e.session === 'string' && e.session) out.session = cut(e.session, 128)
      const turn = Number(e.turn)
      if (Number.isInteger(turn) && turn > 0) out.turn = turn
      if (typeof e.quote === 'string' && e.quote.trim())
        out.quote = cut(e.quote.trim(), DREAMER_LIMITS.quote)
      if (typeof e.note === 'string' && e.note.trim())
        out.note = cut(e.note.trim(), DREAMER_LIMITS.item)
      if (isRecord(e.numbers)) {
        const numbers = Object.entries(e.numbers).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' && Number.isFinite(entry[1])
        )
        if (numbers.length) out.numbers = Object.fromEntries(numbers.slice(0, 12))
      }
      return out
    })
    .filter((e) => Object.keys(e).length)
  return {
    id,
    title,
    category,
    problem: cut(raw.problem, DREAMER_LIMITS.problem),
    evidence,
    proposal: cut(raw.proposal, DREAMER_LIMITS.proposal),
    impact: cut(raw.impact, DREAMER_LIMITS.impact),
    effort,
    acceptance: strings(raw.acceptance, DREAMER_LIMITS.item),
    areas: strings(raw.areas, DREAMER_LIMITS.area)
  }
}

/** Unique ids: a repeated id gets `-2`, `-3`… */
export function uniqueIds(proposals: DreamerProposal[]): DreamerProposal[] {
  const seen = new Set<string>()
  return proposals.map((p) => {
    let id = p.id,
      n = 1
    while (seen.has(id)) id = `${p.id.slice(0, DREAMER_LIMITS.id - 4)}-${++n}`
    seen.add(id)
    return id === p.id ? p : { ...p, id }
  })
}

const evidenceLine = (e: DreamerEvidence) =>
  [
    e.session ? `session ${e.session}${e.turn ? ` turn ${e.turn}` : ''}` : '',
    e.quote ? `“${e.quote}”` : '',
    e.numbers
      ? Object.entries(e.numbers)
          .map(([key, value]) => `${key} ${value}`)
          .join(', ')
      : '',
    e.note ?? ''
  ]
    .filter(Boolean)
    .join(' — ')

/** One line per evidence item, for the review window and the report. */
export const dreamerEvidenceText = (evidence: DreamerEvidence[]) =>
  evidence.map((e) => `• ${evidenceLine(e)}`).join('\n')

/** The short Markdown report saved next to proposals.json. */
export function dreamerMarkdown(file: DreamerFile): string {
  const scope = file.scope
  const lines = [
    '# Dreamer report',
    '',
    `Generated ${file.generatedAt}${scope ? ` · ${scope.projectName ?? (scope.project ? 'one project' : 'all projects')} · last ${scope.days} days` : ''}.`,
    ''
  ]
  if (file.summary?.trim()) lines.push(file.summary.trim(), '')
  lines.push(`## Proposals (${file.proposals.length})`, '')
  for (const p of file.proposals) {
    lines.push(
      `### ${p.title}`,
      '',
      `${DREAMER_CATEGORY_LABELS[p.category]} · effort ${p.effort} · \`${p.id}\``,
      ''
    )
    if (p.problem) lines.push(`**Problem.** ${p.problem}`, '')
    if (p.proposal) lines.push(`**Proposal.** ${p.proposal}`, '')
    if (p.impact) lines.push(`**Expected impact.** ${p.impact}`, '')
    if (p.areas.length) lines.push(`**Areas.** ${p.areas.join(', ')}`, '')
    if (p.evidence.length)
      lines.push('**Evidence.**', '', ...p.evidence.map((e) => `- ${evidenceLine(e)}`), '')
    if (p.acceptance.length)
      lines.push('**Acceptance.**', '', ...p.acceptance.map((a) => `- [ ] ${a}`), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** The task ids in Agent OS's answer: `{created:[{issue}]}`, `{tasks:[{id}]}` or `{taskIds:[]}`. */
export function dreamerTaskIds(body: unknown): string[] {
  if (!isRecord(body)) return []
  const out: string[] = []
  for (const key of ['created', 'tasks', 'issues']) {
    const list = body[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item === 'string') out.push(item)
      else if (isRecord(item))
        for (const field of ['identifier', 'issue', 'taskId', 'id'])
          if (typeof item[field] === 'string') {
            out.push(item[field] as string)
            break
          }
    }
  }
  for (const key of ['taskIds', 'ids'])
    if (Array.isArray(body[key]))
      out.push(...((body[key] as unknown[]).filter((v) => typeof v === 'string') as string[]))
  return [...new Set(out)]
}
