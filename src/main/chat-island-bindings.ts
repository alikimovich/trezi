import type { ControlParam } from '../shared/api'
import type {
  IslandHealth,
  IslandRecord,
  IslandStatus,
  IslandValue,
  IslandView
} from '../shared/chat-islands'
import { lexLiteral, locateAnchor, resolveLiteralValue } from './control-manifest'
import { shadowOutput } from './shadow-controls'

/**
 * LKM-181: does the code still support each binding? A binding holds while its anchor
 * occurs exactly once in the island's file and a literal of the param's kind follows it.
 * Moves inside the file are followed (the anchor is found wherever it is); a renamed
 * declaration, a second match, a token, a variable or an expression disables the field
 * with one line that says why. Never exception text.
 */

/**
 * A whole-island problem (the file is gone, unreadable, outside the project). `fixable`:
 * a source edit can fix it (the file is missing or does not parse), so a planned island
 * (LKM-201) may still be defined.
 */
export class IslandBindingError extends Error {
  constructor(
    message: string,
    readonly fixable = false
  ) {
    super(message)
  }
}

const KIND_NAMES: Record<ControlParam['kind'], string> = {
  number: 'a number',
  toggle: 'a true/false value',
  text: 'a text literal',
  color: 'a color literal',
  select: 'one of its options',
  bezier: 'a cubic-Bezier curve'
}
const TOKEN = /var\(\s*(--[\w-]+)/
const NAME = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/

/** Why `param` no longer holds a literal of its kind after its anchor (without the tail). */
function cause(code: string, at: number, param: ControlParam, file: string): string {
  const rest = code.slice(at).replace(/^\s*/, '')
  const head = rest
    .slice(0, 120)
    .split(/[\n;,]/)[0]
    .trim()
  const token = head.match(TOKEN)?.[1]
  if (token) return `${param.label} is now set by the token ${token}`
  if (!head || /^[)}\]]/.test(head)) return `${param.label} is no longer in ${file}`
  if (
    /^['"`]/.test(head) ||
    /^-?\.?\d/.test(head) ||
    /^(true|false)\b/.test(head) ||
    /^\[/.test(head)
  )
    return `${param.label} is no longer ${KIND_NAMES[param.kind]}`
  const name = head.match(NAME)?.[0]
  if (name && /^\s*(?:[)}\]]|$)/.test(head.slice(name.length)))
    return `${param.label} is now set by ${name}`
  return `${param.label} is now computed in code`
}
const field = (why: string) => `${why}; this control can't edit it.`

export interface BindingCheck {
  values: Record<string, IslandValue>
  /** param id → one line on why that field cannot be edited. */
  broken: Record<string, string>
  attributes: Map<number, { start: number; end: number; value: string }>
}

/** The island's bound values as `code` holds them, and the bindings that no longer hold. */
export function checkBindings(
  code: string,
  file: string,
  record: IslandRecord,
  attributes: BindingCheck['attributes']
): BindingCheck {
  const shown = record.manifest.file
  const values: Record<string, IslandValue> = {}
  const broken: Record<string, string> = {}
  for (const p of record.manifest.params) {
    const anchor = p.apply.strategy === 'literal' ? p.apply.anchor : ''
    const loc = anchor ? locateAnchor(code, anchor) : ({ error: 'missing' } as const)
    if ('error' in loc) {
      broken[p.id] = field(
        loc.error === 'ambiguous'
          ? `${p.label} now matches more than one place in ${shown}`
          : `${p.label} is no longer in ${shown}`
      )
      continue
    }
    const start = loc.at + (code.slice(loc.at).match(/^\s*/)?.[0].length ?? 0)
    const attribute = attributes.get(start)
    const value =
      attribute && ['text', 'color', 'select'].includes(p.kind)
        ? attribute.value
        : lexLiteral(code, loc.at, p.kind)
          ? resolveLiteralValue(code, p)
          : null
    if (value === null) {
      broken[p.id] = field(cause(code, loc.at, p, shown))
      continue
    }
    // A string literal that became a token reference no longer holds the value it edited.
    const token = typeof value === 'string' ? value.match(/^var\(\s*(--[\w-]+)\s*\)$/)?.[1] : null
    const before = record.initial?.[p.id]
    if (token && !(typeof before === 'string' && before.startsWith('var('))) {
      broken[p.id] = field(`${p.label} is now set by the token ${token}`)
      continue
    }
    values[p.id] = value
  }
  // Compound blocks edit their bindings together: one broken binding disables the block.
  for (const block of record.blocks) {
    if (block.kind === 'group') continue
    const first = block.params.find((id) => id in broken)
    if (first) {
      for (const id of block.params) broken[id] ??= broken[first]
      continue
    }
    if (block.kind !== 'shadow') continue
    try {
      shadowOutput(block, values)
    } catch {
      for (const id of block.params)
        broken[id] = field(`${block.title} no longer has a shadow literal Trezi can update`)
    }
  }
  for (const id of Object.keys(broken)) delete values[id]
  return { values, broken, attributes }
}

/** The island as a whole: every binding works, some, or none (`reason` then says why). */
export function islandHealth(
  record: IslandRecord,
  broken: Record<string, string>
): { health: IslandHealth; reason?: string } {
  const ids = record.manifest.params.map((p) => p.id)
  const failing = ids.filter((id) => id in broken)
  if (!failing.length) return { health: 'ready' }
  if (failing.length < ids.length) return { health: 'partially-disabled' }
  const causes = [...new Set(failing.map((id) => broken[id].replace(/; this control.*$/, '')))]
  if (causes.every((c) => / is no longer in /.test(c)))
    return {
      health: 'disabled',
      reason: `The code these controls edited is no longer in ${record.manifest.file}.`
    }
  return {
    health: 'disabled',
    reason:
      causes.length === 1
        ? `${causes[0]}; these controls can't edit it.`
        : `${causes[0]}, and ${causes.length - 1} more binding${causes.length > 2 ? 's' : ''} changed; these controls can't edit them.`
  }
}

/** A binding line said of a planned island: it never was in the code, it did not leave it. */
export const plannedLine = (line: string) =>
  line.replace(/ no longer exists/, ' does not exist').replace(/ is no longer /g, ' is not ')

/**
 * LKM-201: a landed planned island activates only when every binding resolves; otherwise
 * it is disabled as a whole with the first cause (`problem`: a whole-file problem).
 */
export function plannedFailure(
  record: IslandRecord,
  broken: Record<string, string>,
  problem?: string
): { health: 'disabled'; reason: string } {
  const strip = (line: string) =>
    plannedLine(line)
      .replace(/(, so|;) (these|this) control.*$/, '')
      .replace(/\.$/, '')
  if (problem)
    return { health: 'disabled', reason: `These controls never activated: ${strip(problem)}.` }
  const failing = record.manifest.params.filter((p) => p.id in broken)
  const more = failing.length - 1
  return {
    health: 'disabled',
    reason: `These controls never activated: ${strip(broken[failing[0].id])}${
      more ? `, and ${more} more planned binding${more > 1 ? 's' : ''} did not resolve` : ''
    }.`
  }
}

/**
 * One line for the island UI from anything a step threw. Trezi's own refusals are
 * short sentences and pass; anything else (a stack, a path, an errno) becomes a
 * plain line instead.
 */
export function islandProblem(
  error: unknown,
  fallback = 'This island could not do that. Reload it and try again.'
): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (error instanceof IslandBindingError) return message
  if (
    !message ||
    message.length > 200 ||
    /\n|^\w*Error\b|\bE[A-Z]{3,}\b|\/|\\|\bat \S+ \(|undefined|null|NaN/.test(message) ||
    !/^[A-Z]/.test(message)
  )
    return fallback
  return /[.!?]$/.test(message) ? message : `${message}.`
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((word) => word.length > 1 && !['the', 'and', 'for', 'a', 'an'].includes(word))
    ?.slice(0, 24) ?? 'controls'

/** A new stable short name: `island-<first word of the title>-<n>`, unique in the chat. */
export function newIslandName(title: string, taken: Iterable<string>) {
  const base = `island-${slug(title)}-`
  let n = 0
  for (const name of taken)
    if (name.startsWith(base)) n = Math.max(n, Number(name.slice(base.length)) || 0)
  return `${base}${n + 1}`
}

/** Names every record; one stored before LKM-181 gets a name from its place in the chat. */
export function nameIslands(records: IslandRecord[]): IslandRecord[] {
  const taken: string[] = records.flatMap((r) => (r.name ? [r.name] : []))
  return records.map((record) => {
    if (record.name) return record
    const name = newIslandName(record.manifest.title, taken)
    taken.push(name)
    return { ...record, name }
  })
}

/**
 * What the transcript shows for a record: lifecycle first (waiting, a turn that did not
 * land), then the user's choice, then what the bindings allow.
 */
export function islandStatus(
  record: IslandRecord,
  check: { health: IslandHealth; reason?: string }
): Pick<IslandView, 'status' | 'disabledBy' | 'reason' | 'health'> {
  if (record.status === 'waiting') return { status: 'waiting' }
  if (record.status === 'unavailable')
    return {
      status: 'disabled',
      disabledBy: 'code',
      health: 'disabled',
      reason: 'The turn that made these controls did not land, so they never activated.'
    }
  const health = check.health
  if (record.user === 'hidden') return { status: 'hidden', health, reason: check.reason }
  if (record.user === 'disabled')
    return {
      status: 'disabled',
      disabledBy: 'user',
      health,
      reason: 'Disabled. Enable these controls to edit again.'
    }
  if (health === 'disabled')
    return { status: 'disabled', disabledBy: 'code', health, reason: check.reason }
  return { status: health as IslandStatus, health }
}
