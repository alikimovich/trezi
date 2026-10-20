/**
 * LOCAL-WEBKIT-2: the explicit assertions `preview_verify` runs. They are declarative
 * and bounded: no expressions, no regular expressions, no page code. The page (or the
 * managed Chromium CLI) only reports raw facts; `judge` here, in the host, decides
 * every pass and fail, so neither page code nor the agent's arguments can supply one.
 * Pure, so the limits and comparisons are unit-tested.
 */

export const CHECK_KINDS = [
  'exists',
  'absent',
  'visible',
  'hidden',
  'text',
  'value',
  'attribute',
  'count',
  'state',
  'style',
  'url',
  'title',
  'noConsoleErrors'
] as const
export type CheckKind = (typeof CHECK_KINDS)[number]
export const CHECK_STATES = [
  'checked',
  'unchecked',
  'enabled',
  'disabled',
  'focused',
  'unfocused'
] as const
export type CheckState = (typeof CHECK_STATES)[number]
export const CHECK_LIMITS = {
  checks: 20,
  text: 1000,
  timeoutMs: 10_000,
  totalMs: 30_000,
  pollMs: 100
} as const

export interface BrowserCheck {
  kind: CheckKind
  selector?: string
  index?: number
  ref?: string
  source?: string
  equals?: string | number
  contains?: string
  min?: number
  max?: number
  /** attribute: its name; style: the computed property. */
  name?: string
  state?: CheckState
  /** A condition wait: re-observe until it holds or this many ms passed (default 0). */
  timeoutMs: number
}

/** What the page (or the CLI) reported for one check's element. */
export interface Observation {
  error?: string
  stale?: boolean
  invalid?: boolean
  count?: number
  found?: boolean
  element?: string
  visible?: boolean
  text?: string
  value?: string
  valueHidden?: boolean
  checked?: boolean
  disabled?: boolean
  focused?: boolean
  attrs?: Record<string, string | null>
  styles?: Record<string, string>
}

export interface PageFacts {
  url: string | null
  title: string | null
  /** Console errors and page errors since the document loaded; null when unreadable. */
  consoleErrors: number | null
}

export interface Verdict {
  pass: boolean
  actual: unknown
  detail?: string
}

const ELEMENT_KINDS = new Set<CheckKind>([
  'exists',
  'absent',
  'visible',
  'hidden',
  'text',
  'value',
  'attribute',
  'count',
  'state',
  'style'
])
const COMPARED = new Set<CheckKind>(['text', 'value', 'url', 'title', 'style'])
const ATTRIBUTE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]{0,100}$/
const PROPERTY = /^-{0,2}[a-zA-Z][-a-zA-Z0-9]{0,100}$/
/** States synthetic events never produce in WebKit. */
const TRUSTED_ONLY = /:(hover|active|focus-visible)\b/i

export const isElementCheck = (check: BrowserCheck) => ELEMENT_KINDS.has(check.kind)

/** The validated checks, or why the list is refused (the first problem, with its index). */
export function parseChecks(
  raw: unknown,
  engine: 'webkit' | 'chromium'
): { checks: BrowserCheck[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: 'checks must be a non-empty list of assertions.' }
  if (raw.length > CHECK_LIMITS.checks)
    return { error: `At most ${CHECK_LIMITS.checks} checks per call.` }
  const checks: BrowserCheck[] = []
  for (const [i, item] of raw.entries()) {
    const parsed = parseCheck(item, engine)
    if ('error' in parsed) return { error: `checks[${i}]: ${parsed.error}` }
    checks.push(parsed)
  }
  return { checks }
}

function parseCheck(
  item: unknown,
  engine: 'webkit' | 'chromium'
): BrowserCheck | { error: string } {
  const a = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
  const kind = a.kind as CheckKind
  if (!CHECK_KINDS.includes(kind))
    return { error: `kind must be one of ${CHECK_KINDS.join(', ')}.` }
  const check: BrowserCheck = { kind, timeoutMs: 0 }
  for (const key of ['selector', 'ref', 'source', 'contains', 'name'] as const) {
    if (a[key] === undefined) continue
    if (
      typeof a[key] !== 'string' ||
      !(a[key] as string).trim() ||
      (a[key] as string).length > CHECK_LIMITS.text
    )
      return {
        error: `${key} must be a non-empty string of at most ${CHECK_LIMITS.text} characters.`
      }
    check[key] = a[key] as string
  }
  if (a.equals !== undefined) {
    if (
      typeof a.equals === 'string'
        ? a.equals.length > CHECK_LIMITS.text
        : typeof a.equals !== 'number'
    )
      return { error: 'equals must be a string (or, for count, a number).' }
    check.equals = a.equals as string | number
  }
  for (const key of ['index', 'min', 'max'] as const) {
    if (a[key] === undefined) continue
    if (!Number.isInteger(a[key]) || (a[key] as number) < 0 || (a[key] as number) > 10_000)
      return { error: `${key} must be a whole number 0–10000.` }
    check[key] = a[key] as number
  }
  if (a.timeoutMs !== undefined) {
    if (
      !Number.isInteger(a.timeoutMs) ||
      (a.timeoutMs as number) < 0 ||
      (a.timeoutMs as number) > CHECK_LIMITS.timeoutMs
    )
      return { error: `timeoutMs must be a whole number 0–${CHECK_LIMITS.timeoutMs}.` }
    check.timeoutMs = a.timeoutMs as number
  }
  if (a.state !== undefined) {
    if (!CHECK_STATES.includes(a.state as CheckState))
      return { error: `state must be one of ${CHECK_STATES.join(', ')}.` }
    check.state = a.state as CheckState
  }
  const targets = [check.selector, check.ref, check.source].filter(Boolean).length
  if (ELEMENT_KINDS.has(kind) && targets !== 1)
    return { error: `${kind} needs exactly one of selector, ref or source.` }
  if (!ELEMENT_KINDS.has(kind) && targets)
    return { error: `${kind} checks the page; give no element.` }
  if ((kind === 'absent' || kind === 'count') && !check.selector)
    return { error: `${kind} takes a selector (a ref names one element of one document).` }
  if (COMPARED.has(kind) && (check.equals === undefined) === (check.contains === undefined))
    return { error: `${kind} needs exactly one of equals or contains.` }
  if (COMPARED.has(kind) && typeof check.equals === 'number')
    return { error: `${kind} compares text: equals must be a string.` }
  if (kind === 'attribute') {
    if (!check.name || !ATTRIBUTE.test(check.name))
      return { error: 'attribute needs a valid attribute name.' }
    if (check.equals !== undefined && check.contains !== undefined)
      return { error: 'attribute takes equals or contains, or neither to check it is present.' }
    if (typeof check.equals === 'number') return { error: 'attribute equals must be a string.' }
  }
  if (kind === 'style' && (!check.name || !PROPERTY.test(check.name)))
    return { error: 'style needs a CSS property name, e.g. "color".' }
  if (kind === 'count') {
    if (
      check.equals !== undefined &&
      (typeof check.equals !== 'number' || !Number.isInteger(check.equals) || check.equals < 0)
    )
      return { error: 'count equals must be a whole number.' }
    if (check.equals === undefined && check.min === undefined && check.max === undefined)
      return { error: 'count needs equals, min or max.' }
  }
  if (kind === 'state' && !check.state)
    return { error: `state needs one of ${CHECK_STATES.join(', ')}.` }
  if (engine === 'webkit' && check.selector && TRUSTED_ONLY.test(check.selector))
    return {
      error: `the selector uses ${check.selector.match(TRUSTED_ONLY)?.[0]}, which the WebKit agent browser's synthetic events never set, so this check could only mislead. Use engine "chromium" (trusted input through Trezi's managed agent-browser).`
    }
  if (engine === 'chromium') {
    if (check.ref || check.source)
      return {
        error:
          'refs and source stamps belong to the WebKit agent page; use a selector with engine "chromium".'
      }
    if (check.state === 'focused' || check.state === 'unfocused')
      return {
        error:
          'focus is not readable through the managed Chromium CLI; check it with engine "webkit".'
      }
    if (check.index)
      return { error: 'index is WebKit-only; use a selector that matches one element.' }
  }
  return check
}

const compare = (actual: string | null | undefined, check: BrowserCheck): boolean =>
  typeof actual === 'string' &&
  (check.equals !== undefined ? actual === check.equals : actual.includes(check.contains as string))

const routeOf = (url: string) => {
  try {
    const u = new URL(url)
    return u.pathname + u.search + u.hash
  } catch {
    return url
  }
}

/** The host's verdict for one check from the facts observed. Nothing else decides it. */
export function judge(check: BrowserCheck, seen: Observation | null, page: PageFacts): Verdict {
  if (!ELEMENT_KINDS.has(check.kind)) {
    if (check.kind === 'noConsoleErrors')
      return page.consoleErrors === null
        ? { pass: false, actual: null, detail: 'console errors could not be read' }
        : { pass: page.consoleErrors === 0, actual: page.consoleErrors }
    if (check.kind === 'title') return { pass: compare(page.title, check), actual: page.title }
    const url = page.url
    const wanted = typeof check.equals === 'string' && check.equals.startsWith('/')
    return {
      pass: url !== null && compare(wanted ? routeOf(url) : url, check),
      actual: url
    }
  }
  if (!seen) return { pass: false, actual: null, detail: 'not observed' }
  if (seen.error) return { pass: false, actual: null, detail: seen.error }
  const count = seen.count ?? (seen.found ? 1 : 0)
  if (check.kind === 'count') {
    const pass =
      (check.equals === undefined || count === check.equals) &&
      (check.min === undefined || count >= check.min) &&
      (check.max === undefined || count <= check.max)
    return { pass, actual: count }
  }
  if (check.kind === 'absent') return { pass: count === 0, actual: count }
  if (check.kind === 'hidden')
    return seen.found && seen.visible === undefined
      ? { pass: false, actual: null, detail: 'visibility could not be read' }
      : { pass: !seen.found || seen.visible === false, actual: seen.found ? 'visible' : 'no match' }
  if (!seen.found) return { pass: false, actual: 'no match', detail: 'no element matches' }
  switch (check.kind) {
    case 'exists':
      return { pass: true, actual: count }
    case 'visible':
      return { pass: seen.visible === true, actual: seen.visible ?? null }
    case 'text':
      return { pass: compare(seen.text, check), actual: seen.text ?? null }
    case 'value':
      return seen.valueHidden
        ? { pass: false, actual: null, detail: 'password values are never read' }
        : { pass: compare(seen.value, check), actual: seen.value ?? null }
    case 'attribute': {
      const value = seen.attrs?.[check.name as string]
      if (value === undefined)
        return { pass: false, actual: null, detail: 'attribute could not be read' }
      if (check.equals === undefined && check.contains === undefined)
        return { pass: value !== null, actual: value }
      return { pass: compare(value, check), actual: value }
    }
    case 'style': {
      const value = seen.styles?.[check.name as string]
      return value === undefined
        ? { pass: false, actual: null, detail: 'computed style could not be read' }
        : { pass: compare(value, check), actual: value }
    }
    default: {
      const facts: Record<CheckState, boolean | undefined> = {
        checked: seen.checked,
        unchecked: seen.checked === undefined ? undefined : !seen.checked,
        disabled: seen.disabled,
        enabled: seen.disabled === undefined ? undefined : !seen.disabled,
        focused: seen.focused,
        unfocused: seen.focused === undefined ? undefined : !seen.focused
      }
      const fact = facts[check.state as CheckState]
      return fact === undefined
        ? { pass: false, actual: null, detail: `${check.state} could not be read` }
        : { pass: fact, actual: fact }
    }
  }
}

export interface CheckResult {
  index: number
  check: string
  pass: boolean
  expected: unknown
  actual: unknown
  detail?: string
  ms: number
}

/**
 * One observation round: each pending check's facts and the page, or why the run stops.
 * `until` is the wall-clock time (ms) by which the round must be over: its reads fit in it.
 */
export type ObserveRound = (
  pending: number[],
  until: number
) => Promise<{ targets: Map<number, Observation>; page: PageFacts } | { abort: string }>

const expectedOf = (check: BrowserCheck): unknown =>
  check.kind === 'count'
    ? { equals: check.equals, min: check.min, max: check.max }
    : (check.equals ?? check.contains ?? check.state ?? true)

const OUT_OF_TIME = { abort: `the checks ran out of time (${CHECK_LIMITS.totalMs} ms)` }

/** `work`'s answer, or the out-of-time abort once `ms` pass (a late answer is dropped). */
async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | typeof OUT_OF_TIME> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<typeof OUT_OF_TIME>((resolve) => {
    timer = setTimeout(() => resolve(OUT_OF_TIME), ms)
  })
  work.catch(() => {})
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Observes until every check holds or its `timeoutMs` ran out (one round when all are 0),
 * within the total budget. A check is fixed the first time it holds; the rest keep the
 * last verdict. `abort` (a navigation, a replaced document) stops the run as failed.
 */
export async function pollChecks(
  checks: BrowserCheck[],
  observe: ObserveRound,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
): Promise<{ results: CheckResult[]; aborted?: string }> {
  const started = clock.now()
  const results: (CheckResult | null)[] = checks.map(() => null)
  const last: CheckResult[] = []
  for (;;) {
    const pending = results.flatMap((r, i) => (r ? [] : [i]))
    // A round that does not finish within the total budget stops the run as failed: a
    // hung page or CLI cannot hold the checks past it.
    const left = Math.max(1, started + CHECK_LIMITS.totalMs - clock.now())
    const round = await withinMs(observe(pending, Date.now() + left), left)
    const elapsed = clock.now() - started
    if ('abort' in round) {
      for (const i of pending)
        results[i] = {
          index: i,
          check: describeCheck(checks[i]),
          expected: expectedOf(checks[i]),
          actual: last[i]?.actual ?? null,
          ms: elapsed,
          pass: false,
          detail: round.abort
        }
      return { results: results as CheckResult[], aborted: round.abort }
    }
    for (const i of pending) {
      const verdict = judge(checks[i], round.targets.get(i) ?? null, round.page)
      const result: CheckResult = {
        index: i,
        check: describeCheck(checks[i]),
        pass: verdict.pass,
        expected: expectedOf(checks[i]),
        actual: verdict.actual,
        ...(verdict.detail ? { detail: verdict.detail } : {}),
        ms: elapsed
      }
      last[i] = result
      if (verdict.pass || elapsed >= checks[i].timeoutMs || elapsed >= CHECK_LIMITS.totalMs)
        results[i] = result
    }
    if (results.every(Boolean)) return { results: results as CheckResult[] }
    await clock.sleep(CHECK_LIMITS.pollMs)
  }
}

/** One line naming what a check asserts, for receipts and answers. */
export function describeCheck(check: BrowserCheck): string {
  const target = check.selector ?? check.ref ?? (check.source ? `source ${check.source}` : 'page')
  const expected =
    check.kind === 'count'
      ? [
          check.equals !== undefined ? `= ${check.equals}` : '',
          check.min !== undefined ? `≥ ${check.min}` : '',
          check.max !== undefined ? `≤ ${check.max}` : ''
        ]
          .filter(Boolean)
          .join(' ')
      : check.equals !== undefined
        ? `= ${JSON.stringify(check.equals)}`
        : check.contains !== undefined
          ? `contains ${JSON.stringify(check.contains)}`
          : (check.state ?? '')
  const name = check.name ? ` ${check.name}` : ''
  return `${check.kind}${name} ${target}${expected ? ` ${expected}` : ''}`.slice(0, 300)
}
