import { splitLessons, withLessons } from './project-lessons'
import type { ProjectMemoryUpdateOutcome } from './project-memory'
import { refineProjectMemory } from './project-memory-evaluation'
import {
  isMemoryItem,
  itemKey,
  MAX_PROJECT_MEMORY_CHARS,
  MEMORY_HEADINGS
} from './project-memory-format'

/**
 * LKM-556: the agent's explicit "remember this" (`remember_rule`). When the user asks
 * for a durable rule or guide, the agent saves it through the same per-project update
 * queue as every automatic update, so the Swift owner's compare-and-swap protects a
 * concurrent manual save, the note with View and Undo appears, and new chats get it.
 * The rule is placed under one fixed heading; everything else in memory is kept byte
 * for byte. Equal rules are never added twice; a near-equal one is reported back so
 * the agent updates it (`replaces`) or confirms it is different (`distinct`). The
 * answer says `saved: true` only when the owner's committed record holds the rule.
 */

export type MemorySection = (typeof MEMORY_HEADINGS)[number]

export interface RememberRuleArgs {
  rule: string
  section: MemorySection
  /** The exact text of an existing rule this one updates. */
  replaces?: string
  /** The agent checked a similar rule and this one is different. */
  distinct: boolean
}

export interface RememberRuleResult {
  saved: boolean
  /** Memory already held the rule; nothing was written. */
  unchanged?: boolean
  /** The write may or may not have committed: never report it as saved. */
  uncertain?: boolean
  rule?: string
  section?: MemorySection
  similar?: string[]
  message: string
}

export type MemoryUpdateRunner = (
  root: string,
  evaluate: (current: string) => Promise<string | null>
) => Promise<ProjectMemoryUpdateOutcome>

/** One rule: a single line, short enough to stay a rule rather than a document. */
export const MAX_RULE_CHARS = 400

const NOT_SAVED = 'Do not tell the user it was saved.'
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
/** Text that would forge a source tag, a lesson or the injected memory block. */
const FORGED = /<!--|-->|project-memory>|trezi-lessons-data/i
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/
const LESSON = /<!--\s*lesson\b/i

const one = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Validate the tool's arguments; an answer with `error` is the tool's refusal. */
export function parseRememberRule(args: unknown): RememberRuleArgs | { error: string } {
  const input = (args ?? {}) as Record<string, unknown>
  if (typeof input.rule !== 'string') return { error: 'rule must be a string.' }
  const rule = one(input.rule.replace(ITEM, ''))
  if (!rule) return { error: 'rule is empty.' }
  if (rule.length > MAX_RULE_CHARS)
    return { error: `Keep one rule under ${MAX_RULE_CHARS} characters; split longer guidance.` }
  if (FORGED.test(rule) || /^#{1,6}\s/.test(rule))
    return { error: 'rule cannot contain HTML comments, headings or memory markers.' }
  const named = input.section === undefined ? 'Preferences' : input.section
  const section = MEMORY_HEADINGS.find(
    (heading) => typeof named === 'string' && heading.toLowerCase() === one(named).toLowerCase()
  )
  if (!section) return { error: `section must be one of: ${MEMORY_HEADINGS.join(', ')}.` }
  if (input.replaces !== undefined && typeof input.replaces !== 'string')
    return { error: 'replaces must be the text of an existing rule.' }
  const replaces = typeof input.replaces === 'string' ? one(input.replaces) : ''
  return {
    rule,
    section,
    ...(replaces ? { replaces } : {}),
    distinct: input.distinct === true
  }
}

/** Equal rules (a memory line or bare rule text): case, spacing, tag and a final `.` aside. */
const ruleKey = (text: string) => itemKey(`- ${text.replace(ITEM, '')}`)
/** Near-equal comparison only: the key without punctuation. */
const looseKey = (text: string) =>
  ruleKey(text)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const STOP = new Set(
  'a an the and or of to in on for with is are be by it this that we our you your if as at from when then than so use'.split(
    ' '
  )
)
const words = (text: string) =>
  new Set(
    looseKey(text)
      .split(' ')
      .filter((w) => !STOP.has(w))
  )
const NEGATION = /\b(not|never|no|don t|dont|avoid|without|stop)\b/

/** Near-equal wording that does not flip between a rule and its negation. */
function similar(a: string, b: string): boolean {
  if (NEGATION.test(looseKey(a)) !== NEGATION.test(looseKey(b))) return false
  const x = words(a),
    y = words(b)
  if (x.size < 3 || y.size < 3) return false
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / (x.size + y.size - shared) >= 0.6
}

/** The rule lines of memory, lessons excluded (they are data, not rules). */
const ruleLines = (content: string) =>
  content.split('\n').filter((line) => isMemoryItem(line) && !LESSON.test(line))

/**
 * Memory with the rule added at the end of its section (a new section is appended),
 * or with `replaces` reworded in place. Every other line is kept as it was.
 */
export function withRule(content: string, args: RememberRuleArgs): string {
  const lines = content.split('\n')
  const bullet = `- ${args.rule}`
  if (args.replaces) {
    const key = ruleKey(args.replaces)
    const at = lines.findIndex(
      (line) => isMemoryItem(line) && !LESSON.test(line) && ruleKey(line) === key
    )
    if (at >= 0) {
      lines[at] = bullet
      return lines.join('\n')
    }
  }
  const wanted = args.section.toLowerCase()
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1].toLowerCase() === wanted)
  if (start < 0) return [content.trimEnd(), `## ${args.section}`, bullet].join('\n\n').trim()
  let end = lines.findIndex((line, index) => index > start && HEADING.test(line))
  if (end < 0) end = lines.length
  let last = start
  for (let i = start + 1; i < end; i++) if (lines[i].trim()) last = i
  lines.splice(last + 1, 0, bullet)
  return lines.join('\n')
}

/** The heading above the rule `key` in `content`, if any. */
function sectionOf(content: string, key: string): string | null {
  let heading: string | null = null
  for (const line of content.split('\n')) {
    const match = HEADING.exec(line)
    if (match) heading = match[1]
    else if (isMemoryItem(line) && ruleKey(line) === key) return heading
  }
  return null
}

const BUSY = `Not saved: project memory was busy with other updates, so nothing was written. ${NOT_SAVED} Call remember_rule again.`

/**
 * Save one rule to `root`'s project memory through `update` (the per-project queue
 * over the memory owner). `roots` are searched for a design token the rule names, as
 * for every new rule (memory never stands in for the change itself). With `deadlineMs`
 * the answer comes before the tool call itself would time out: a job still waiting
 * in the queue is cancelled (not saved); one already running is `uncertain`.
 */
export async function rememberProjectRule(
  root: string,
  args: RememberRuleArgs,
  update: MemoryUpdateRunner,
  opts: {
    roots: string[]
    date?: string
    exists?: (token: string) => Promise<boolean>
    deadlineMs?: number
  }
): Promise<RememberRuleResult> {
  const key = ruleKey(args.rule)
  const replacing = args.replaces ? ruleKey(args.replaces) : null
  let refusal = null as RememberRuleResult | null
  let started = false,
    cancelled = false,
    proposing = false
  const job = update(root, async (current) => {
    refusal = null
    proposing = false
    if (cancelled) return null
    started = true
    const { rules: body, lessons } = splitLessons(current)
    const rules = ruleLines(body)
    if (replacing && !rules.some((line) => ruleKey(line) === replacing)) {
      refusal = {
        saved: false,
        message: `No saved rule matches replaces. ${NOT_SAVED} Call again with the exact text of the rule to update, or without replaces.`
      }
      return null
    }
    const same = rules.find((line) => ruleKey(line) === key)
    let draft: string
    if (same && (!replacing || replacing === key)) {
      refusal = {
        saved: true,
        unchanged: true,
        rule: one(same.replace(ITEM, '').replace(/<!--.*?-->/g, '')),
        message: 'Project memory already has this rule; nothing changed.'
      }
      return null
    } else if (same) {
      // The new wording is already saved: the rule it replaces goes.
      const lines = body.split('\n')
      const at = lines.findIndex(
        (line) => isMemoryItem(line) && !LESSON.test(line) && ruleKey(line) === replacing
      )
      lines.splice(at, 1)
      draft = lines.join('\n')
    } else {
      const near = replacing || args.distinct ? [] : rules.filter((l) => similar(l, args.rule))
      if (near.length) {
        refusal = {
          saved: false,
          similar: near.map((line) => one(line.replace(ITEM, '').replace(/<!--.*?-->/g, ''))),
          message: `Project memory has a similar rule, so nothing was written. ${NOT_SAVED} If it says the same thing, tell the user it is already saved. If the user's rule updates it, call again with replaces set to that rule's text; if it is a different rule, call again with distinct: true.`
        }
        return null
      }
      draft = withRule(body, args)
    }
    const refined = await refineProjectMemory(body, draft, opts)
    if (refined === null || !ruleLines(refined).some((line) => ruleKey(line) === key)) {
      refusal = {
        saved: false,
        message: `Not saved: the rule names a design token this project's code does not have yet. Make the change first; memory never stands in for it. ${NOT_SAVED}`
      }
      return null
    }
    // Lessons are what gives way to a rule, as in every automatic update.
    const next = withLessons(refined, lessons)
    if (next.trim().length > MAX_PROJECT_MEMORY_CHARS) {
      refusal = {
        saved: false,
        message: `Not saved: project memory is full (${MAX_PROJECT_MEMORY_CHARS.toLocaleString('en-US')} characters). Ask the user to tidy it in Project memory. ${NOT_SAVED}`
      }
      return null
    }
    proposing = true
    return next
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = opts.deadlineMs
    ? await Promise.race([
        job,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), opts.deadlineMs)
        })
      ])
    : await job
  clearTimeout(timer)
  if (outcome === null) {
    if (!started) {
      cancelled = true
      return { saved: false, message: BUSY }
    }
    return {
      saved: false,
      uncertain: true,
      message: `The save is still running, so it is unknown whether the rule was saved. ${NOT_SAVED} Ask the user to check Project memory.`
    }
  }
  if (outcome.kind === 'committed') {
    const section = sectionOf(outcome.after.content, key)
    return ruleLines(outcome.after.content).some((line) => ruleKey(line) === key)
      ? {
          saved: true,
          rule: args.rule,
          ...(section && MEMORY_HEADINGS.includes(section as MemorySection)
            ? { section: section as MemorySection }
            : {}),
          message: `Saved to this project's memory${section ? ` under ${section}` : ''}. New chats in this project will follow it, and the user can see, edit or undo it in Project memory.`
        }
      : {
          saved: false,
          uncertain: true,
          message: `Project memory changed, but its committed version does not hold the rule. ${NOT_SAVED} Ask the user to check Project memory.`
        }
  }
  if (outcome.kind === 'unchanged')
    return refusal ?? { saved: false, message: `Project memory did not change. ${NOT_SAVED}` }
  if (outcome.kind === 'stale') return { saved: false, message: BUSY }
  const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
  const code = (outcome.error as { code?: unknown } | null)?.code
  // Only a write that was sent can have committed without an answer.
  return proposing && code === 'deadlineExceeded'
    ? {
        saved: false,
        uncertain: true,
        message: `Trezi's service did not answer, so it is unknown whether the rule was saved. ${NOT_SAVED} Ask the user to check Project memory.`
      }
    : { saved: false, message: `Not saved: ${reason} ${NOT_SAVED}` }
}

/** Answer within this, behind peer chats' queued evaluations. */
export const REMEMBER_DEADLINE_MS = 90_000

/** The per-project update queue over the memory owner, set by the agent module. */
let runner: MemoryUpdateRunner | null = null
export function setProjectMemoryRuleRunner(next: MemoryUpdateRunner | null): void {
  runner = next
}

/**
 * The `remember_rule` session tool: an interactive chat saves to its own project's
 * memory, keyed by the live checkout (`liveRoot`), never a path the agent names.
 */
export async function rememberRuleTool(
  args: unknown,
  scope: { root: string; liveRoot: string; background: boolean }
): Promise<RememberRuleResult | { saved: false; error: string }> {
  if (scope.background)
    return {
      saved: false,
      error:
        'Background agents cannot save project memory. Name the rule in your final message so the user can save it.'
    }
  const parsed = parseRememberRule(args)
  if ('error' in parsed) return { saved: false, error: `${parsed.error} ${NOT_SAVED}` }
  if (!runner)
    return { saved: false, error: `Project memory is unavailable in this session. ${NOT_SAVED}` }
  return rememberProjectRule(scope.liveRoot, parsed, runner, {
    roots: [scope.root, scope.liveRoot],
    // Below the owner's 120 s tool limit, so the agent never reads a bare timeout.
    deadlineMs: REMEMBER_DEADLINE_MS
  })
}
