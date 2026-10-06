/**
 * The shape of project memory (LKM-177): one-line rules under fixed headings, each
 * carrying a hidden source tag `<!-- added YYYY-MM-DD -->`. The evaluator proposes
 * the text; Trezi, not the model, owns the tags, so a kept rule keeps its date and a
 * new or reworded rule gets today's.
 */

/** The fixed section headings, in order. */
export const MEMORY_HEADINGS = [
  'Preferences',
  'Design rules',
  'Constraints',
  'Project facts',
  'Pitfalls'
] as const

const TAG = /\s*<!--\s*added\s+(\d{4}-\d{2}-\d{2})\s*-->\s*$/i
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/

/** A memory line that is one rule. */
export const isMemoryItem = (line: string): boolean => ITEM.test(line) && !!itemKey(line)

/** The rule's text without its bullet, tag and spacing; how two versions are compared. */
export function itemKey(line: string): string {
  return line
    .replace(ITEM, '')
    .replace(TAG, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;]$/, '')
    .toLowerCase()
}

/** The rule's source date, if it has one. */
export const itemDate = (line: string): string | null => TAG.exec(line)?.[1] ?? null

/** Memory as shown to a chat: the rules without their source tags. */
export const withoutProvenance = (content: string): string =>
  content
    .split('\n')
    .map((line) => (isMemoryItem(line) ? line.replace(TAG, '') : line))
    .join('\n')

/** Local calendar date, YYYY-MM-DD. */
export function memoryDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Give every rule of an evaluated memory its source tag. A rule already in
 * `before` keeps the tag it had there (none if the user wrote it); any other rule is
 * new or reworded and is stamped `date`. Tags the model wrote are ignored.
 */
export function stampProvenance(before: string, next: string, date: string): string {
  const known = new Map<string, string | null>()
  for (const line of before.split('\n'))
    if (isMemoryItem(line)) known.set(itemKey(line), itemDate(line))
  return next
    .split('\n')
    .map((line) => {
      if (!isMemoryItem(line)) return line
      const bare = line.replace(TAG, '').trimEnd()
      const key = itemKey(line)
      const tag = known.has(key) ? known.get(key) : date
      return tag ? `${bare} <!-- added ${tag} -->` : bare
    })
    .join('\n')
}

/** How many rules an update added and removed (a reworded rule counts as both). */
export function memoryChange(before: string, after: string): { added: number; removed: number } {
  const keys = (content: string) => new Set(content.split('\n').filter(isMemoryItem).map(itemKey))
  const was = keys(before)
  const now = keys(after)
  return {
    added: [...now].filter((key) => !was.has(key)).length,
    removed: [...was].filter((key) => !now.has(key)).length
  }
}

/** "Project memory updated: +1 rule, −2 rules". */
export function memoryChangeNote(before: string, after: string): string {
  const { added, removed } = memoryChange(before, after)
  const rules = (n: number) => `${n} ${n === 1 ? 'rule' : 'rules'}`
  const parts = [added ? `+${rules(added)}` : '', removed ? `−${rules(removed)}` : ''].filter(
    Boolean
  )
  return parts.length ? `Project memory updated: ${parts.join(', ')}` : 'Project memory updated'
}

const TOKEN = /--[a-z][a-z0-9-]*[a-z0-9]/gi

/**
 * The design tokens (CSS custom properties) a new rule relies on. Only rules under a
 * design heading or written as `var(--x)` count, so a command-line flag in a
 * preference (`git push --force`) is never mistaken for a token.
 */
function newTokenRules(before: string, next: string): Map<number, string[]> {
  const known = new Set(before.split('\n').filter(isMemoryItem).map(itemKey))
  const found = new Map<number, string[]>()
  let design = false
  next.split('\n').forEach((line, index) => {
    const heading = HEADING.exec(line)
    if (heading) {
      design = /design|token|style/i.test(heading[1])
      return
    }
    if (!isMemoryItem(line) || known.has(itemKey(line))) return
    const text = line.replace(TAG, '')
    const tokens = design
      ? (text.match(TOKEN) ?? [])
      : [...text.matchAll(/var\(\s*(--[a-z][a-z0-9-]*)/gi)].map((m) => m[1])
    if (tokens.length) found.set(index, [...new Set(tokens)])
  })
  return found
}

/**
 * Memory is never a substitute for work (issue #230): a new rule that names a design
 * token becomes memory only once the token exists in the project's code. Rules whose
 * tokens `exists` cannot find are dropped; everything else is kept as proposed.
 */
export async function dropUnbuiltTokenRules(
  before: string,
  next: string,
  exists: (token: string) => Promise<boolean>
): Promise<string> {
  const rules = newTokenRules(before, next)
  if (!rules.size) return next
  const checked = new Map<string, Promise<boolean>>()
  const has = (token: string) => {
    if (!checked.has(token))
      checked.set(
        token,
        exists(token).catch(() => true)
      )
    return checked.get(token) as Promise<boolean>
  }
  const drop = new Set<number>()
  for (const [index, tokens] of rules)
    if (!(await Promise.all(tokens.map(has))).every(Boolean)) drop.add(index)
  if (!drop.size) return next
  const kept = next.split('\n').filter((_, index) => !drop.has(index))
  // A heading whose only rule was dropped goes with it.
  return kept
    .filter((line, index) => {
      if (!HEADING.test(line)) return true
      const following = kept.slice(index + 1).find((l) => l.trim())
      return following !== undefined && !HEADING.test(following)
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
