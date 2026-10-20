import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { InteractArgs } from './agent-interact'
import type { AgentViewport } from './agent-viewport'
import {
  type BrowserCheck,
  type CheckResult,
  type Observation,
  type PageFacts,
  pollChecks
} from './browser-checks'
import {
  CLI_TIMEOUT_MS,
  type CliResult,
  cliDependency,
  cliEntries,
  cliScalar,
  cliStyle,
  parseCliJson,
  pngSize,
  runManagedCli
} from './managed-browser-cli'
import { artifactRecord, type ReceiptArtifact, type ReceiptStep } from './verification-receipts'

/**
 * LOCAL-WEBKIT-2: `preview_verify` engine "chromium". The host itself drives Trezi's
 * managed `agent-browser` wrapper (`bin/managed/agent-browser`): a fresh private session
 * per run, closed at the end, headless shell only, against the session's own dev server.
 * Facts come from the CLI's stdout JSON; `judge` decides every check, so neither the
 * agent nor the page can report a pass. A missing CLI or headless shell is the wrapper's
 * exit 3: it is reported as that dependency, with no WebKit or system-Chrome fallback.
 */

export interface ChromiumRun {
  wrapper: string
  /** The checkout the session works in: the wrapper's cwd. */
  cwd: string
  url: string
  /** The dev server's origin; the page leaving it stops the run. */
  origin: string
  viewport: AgentViewport
  steps: InteractArgs[]
  checks: BrowserCheck[]
  /** Where the PNG goes, or null for no screenshot. */
  screenshotPath: string | null
  /** The whole run's budget (default `RUN_BUDGET_MS`); every CLI call fits inside it. */
  budgetMs?: number
}

export interface ChromiumOutcome {
  steps: ReceiptStep[]
  checks: CheckResult[]
  artifacts: ReceiptArtifact[]
  url: string | null
  /** The URL the checks were pinned to (null when none was read): the document they judge. */
  pinned: string | null
  /** Why the run stopped early (a failed step, a navigation off the server). */
  stopped: string | null
  /** CLI warnings on stderr (never page errors), counted only. */
  warnings: number
  dependency?: { kind: string; message: string }
}

class Dependency extends Error {
  constructor(readonly found: { kind: string; message: string }) {
    super(found.message)
  }
}

/** One run's budget for every CLI call together, and the close that always follows it. */
export const RUN_BUDGET_MS = 150_000
const CLOSE_MS = 15_000

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
const firstLine = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 300) ?? ''

export async function runChromiumChecks(run: ChromiumRun): Promise<ChromiumOutcome> {
  const session = `trezi-v${randomBytes(8).toString('hex')}`
  const outcome: ChromiumOutcome = {
    steps: [],
    checks: [],
    artifacts: [],
    url: null,
    pinned: null,
    stopped: null,
    warnings: 0
  }
  const deadline = Date.now() + (run.budgetMs ?? RUN_BUDGET_MS)
  /** One CLI call, within `cap` and the time left until `until` (the run's deadline). */
  const call = async (args: string[], cap = CLI_TIMEOUT_MS, until = deadline) => {
    const left = Math.min(until, deadline) - Date.now()
    if (left <= 0) return { ok: false as const, error: `${args[0]}: out of time` }
    const result: CliResult = await runManagedCli(
      run.wrapper,
      session,
      run.cwd,
      args,
      Math.min(cap, left)
    )
    const missing = cliDependency(result)
    if (missing) throw new Dependency(missing)
    if (result.stderr.trim()) outcome.warnings++
    if (result.code === 2)
      return {
        ok: false as const,
        error: firstLine(result.stderr) || 'refused by Trezi’s managed browser policy'
      }
    if (result.timedOut) return { ok: false as const, error: `${args[0]} timed out` }
    const json = parseCliJson(result.stdout)
    if (!json)
      return { ok: false as const, error: `${args[0]}: no JSON answer (exit ${result.code})` }
    if (!json.success || result.code !== 0)
      return { ok: false as const, error: json.error ?? `${args[0]} failed (exit ${result.code})` }
    return { ok: true as const, data: json.data }
  }
  const record: Record_ = (action, target, error) => {
    outcome.steps.push({
      action,
      ...(target ? { target: target.slice(0, 300) } : {}),
      ok: !error,
      ...(error ? { detail: error } : {})
    })
    if (error) outcome.stopped = `step-failed: ${action}: ${error}`
    return !error
  }
  const step: Step = async (action, args, target, timeoutMs) => {
    const answer = await call(args, timeoutMs)
    return record(action, target ?? '', answer.ok ? null : answer.error)
  }
  try {
    const { width, height, theme } = run.viewport
    const ready =
      (await step('open', ['open', run.url], run.url, 45_000)) &&
      (await step('viewport', ['set', 'viewport', String(width), String(height)])) &&
      (theme === 'system' || (await step('theme', ['set', 'media', theme]))) &&
      (await step('reload', ['reload']))
    if (ready)
      for (const request of run.steps) if (!(await runStep(request, step, call, record))) break
    if (outcome.stopped) return outcome
    // The document the checks judge: its full URL, so any route change invalidates them.
    const pinned = await readUrl(call)
    if (!pinned || !sameServer(pinned, run.origin)) {
      outcome.stopped = pinned ? ROUTE_ERROR : DOCUMENT_UNREAD
      return outcome
    }
    outcome.pinned = pinned
    const polled = await pollChecks(run.checks, (pending, until) =>
      observeRound(run, pending, (args) => call(args, undefined, until), pinned)
    )
    outcome.checks = polled.results
    if (polled.aborted) outcome.stopped = polled.aborted
    outcome.url = await readUrl(call)
    if (!outcome.stopped && outcome.url !== pinned)
      outcome.stopped = outcome.url ? NAVIGATED : DOCUMENT_UNREAD
    if (run.screenshotPath) {
      const shot = await call(['screenshot', run.screenshotPath])
      if (shot.ok && existsSync(run.screenshotPath)) {
        const bytes = readFileSync(run.screenshotPath)
        outcome.artifacts.push(
          artifactRecord(run.screenshotPath, bytes, 'image/png', pngSize(bytes))
        )
      }
    }
    return outcome
  } catch (error) {
    if (error instanceof Dependency) return { ...outcome, dependency: error.found }
    throw error
  } finally {
    await runManagedCli(run.wrapper, session, run.cwd, ['close'], CLOSE_MS).catch(() => null)
  }
}

type Step = (
  action: string,
  args: string[],
  target?: string,
  timeoutMs?: number
) => Promise<boolean>

/** One setup step with trusted CDP input. */
async function runStep(r: InteractArgs, step: Step, call: Call, record: Record_): Promise<boolean> {
  const sel = r.selector?.trim() ?? ''
  switch (r.action) {
    case 'click':
      return step('click', ['click', sel], sel)
    case 'hover':
      return step('hover', ['hover', sel], sel)
    case 'select':
      return step('select', ['select', sel, r.option ?? ''], sel)
    case 'type':
      return step('type', [r.clear ? 'fill' : 'type', sel, r.text ?? ''], sel)
    case 'press':
      return (
        (!sel || (await step('focus', ['focus', sel], sel))) &&
        step('press', ['press', r.key ?? ''], r.key)
      )
    default:
      if (!sel && !r.text) return step('wait', ['wait', '--load', 'networkidle'], 'networkidle')
      return waitFor(r, call, record)
  }
}

/**
 * A selector or text wait, polled here so it keeps the step's own `timeoutMs` (the
 * CLI's `wait` only has its fixed 25 s default and cannot be cancelled mid-wait).
 */
async function waitFor(r: InteractArgs, outer: Call, record: Record_): Promise<boolean> {
  const sel = r.selector?.trim()
  const target = sel ?? (r.text as string)
  const started = Date.now()
  const timeout = r.timeoutMs ?? 5000
  // Every read of the wait fits inside the step's own timeout (and the run's deadline).
  const until = started + timeout
  const call: Call = (args) => outer(args, undefined, until)
  let last = 'not yet'
  const holds = async (): Promise<boolean> => {
    if (!sel) {
      const answer = await call(['get', 'text', 'body'])
      if (!answer.ok) last = answer.error
      const text = answer.ok ? cliScalar(answer.data, ['text']) : undefined
      return typeof text === 'string' && text.includes(r.text as string)
    }
    const counted = await call(['get', 'count', sel])
    const count = counted.ok ? cliScalar(counted.data, ['count']) : undefined
    if (!counted.ok) last = counted.error
    if (typeof count !== 'number') return false
    if (!r.hidden) return count > 0
    if (count === 0) return true
    const shown = await call(['is', 'visible', sel])
    return shown.ok && cliScalar(shown.data, ['visible', 'value', 'result']) === false
  }
  for (;;) {
    if (await holds()) return record('wait', target, null)
    if (Date.now() - started >= timeout)
      return record(
        'wait',
        target,
        `still ${r.hidden ? 'shown' : 'missing'} after ${timeout} ms (${last})`
      )
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(150, Math.max(1, until - Date.now())))
    )
  }
}

type Call = (
  args: string[],
  cap?: number,
  until?: number
) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>
type Record_ = (action: string, target: string, error: string | null) => boolean

const ROUTE_ERROR = 'the page left the dev server'
const NAVIGATED = 'the page navigated during the checks'
const DOCUMENT_UNREAD = 'the page URL could not be read'

const sameServer = (href: string, origin: string) => {
  try {
    return new URL(href).origin === origin
  } catch {
    return false
  }
}

/** The page's full URL as the CLI reports it, or null. */
async function readUrl(call: Call): Promise<string | null> {
  const answer = await call(['get', 'url'])
  const href = answer.ok ? cliScalar(answer.data, ['url']) : undefined
  return typeof href === 'string' && href ? href : null
}

/** One round of facts for the pending checks, read through the CLI. */
async function observeRound(run: ChromiumRun, pending: number[], call: Call, pinned: string) {
  const page: PageFacts = { url: null, title: null, consoleErrors: null }
  // Every round re-reads the URL: the checks judge the pinned document or nothing.
  const href = await readUrl(call)
  if (!href) return { abort: DOCUMENT_UNREAD }
  if (!sameServer(href, run.origin)) return { abort: ROUTE_ERROR }
  if (href !== pinned) return { abort: NAVIGATED }
  page.url = href
  const kinds = new Set(pending.map((i) => run.checks[i].kind))
  if (kinds.has('title')) {
    const title = await call(['get', 'title'])
    const value = title.ok ? cliScalar(title.data, ['title']) : undefined
    page.title = typeof value === 'string' ? value : null
  }
  if (kinds.has('noConsoleErrors')) page.consoleErrors = await consoleErrors(call)
  const targets = new Map<number, Observation>()
  for (const i of pending) {
    const check = run.checks[i]
    if (check.selector) targets.set(i, await observeSelector(check, call))
  }
  return { targets, page }
}

async function consoleErrors(call: Call): Promise<number | null> {
  const [errors, logs] = await Promise.all([call(['errors']), call(['console'])])
  const pageErrors = errors.ok ? cliEntries(errors.data) : undefined
  const messages = logs.ok ? cliEntries(logs.data) : undefined
  if (!pageErrors || !messages) return null
  const level = (entry: unknown) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    return String(record.type ?? record.level ?? '').toLowerCase()
  }
  return pageErrors.length + messages.filter((entry) => level(entry) === 'error').length
}

const unreadable = (what: string): Observation => ({
  error: `the CLI's ${what} answer could not be read`
})

async function observeSelector(check: BrowserCheck, call: Call): Promise<Observation> {
  const sel = check.selector as string
  const counted = await call(['get', 'count', sel])
  if (!counted.ok) return { error: counted.error }
  const count = cliScalar(counted.data, ['count'])
  if (typeof count !== 'number') return unreadable('count')
  const seen: Observation = { count, found: count > 0 }
  if (!seen.found || ['exists', 'absent', 'count'].includes(check.kind)) return seen
  const read = async (args: string[], keys: string[]) => {
    const answer = await call(args)
    return answer.ok ? cliScalar(answer.data, keys) : undefined
  }
  switch (check.kind) {
    case 'visible':
    case 'hidden': {
      const visible = await read(['is', 'visible', sel], ['visible', 'value', 'result'])
      return typeof visible === 'boolean' ? { ...seen, visible } : unreadable('visibility')
    }
    case 'text': {
      const text = await read(['get', 'text', sel], ['text', 'value'])
      return typeof text === 'string' ? { ...seen, text: squash(text) } : unreadable('text')
    }
    case 'value': {
      const value = await read(['get', 'value', sel], ['value'])
      return typeof value === 'string' ? { ...seen, value } : unreadable('value')
    }
    case 'attribute': {
      const name = check.name as string
      const value = await read(['get', 'attr', sel, name], ['value'])
      return value === null || typeof value === 'string'
        ? { ...seen, attrs: { [name]: value } }
        : unreadable('attribute')
    }
    case 'style': {
      const answer = await call(['get', 'styles', sel])
      const value = answer.ok ? cliStyle(answer.data, check.name as string) : undefined
      return value === undefined
        ? unreadable('styles')
        : { ...seen, styles: { [check.name as string]: value } }
    }
    default: {
      const checking = check.state === 'checked' || check.state === 'unchecked'
      const value = await read(
        ['is', checking ? 'checked' : 'enabled', sel],
        [checking ? 'checked' : 'enabled', 'value', 'result']
      )
      if (typeof value !== 'boolean') return unreadable('state')
      return checking ? { ...seen, checked: value } : { ...seen, disabled: !value }
    }
  }
}
