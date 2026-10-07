import { homedir } from 'node:os'
import { ipcMain } from '../native/platform'
import type { SessionRecord } from '../shared/api'
import {
  DREAMER_LIMITS,
  DREAMER_VERSION,
  type DreamerFile,
  type DreamerProposal,
  type DreamerScope,
  dreamerErrors,
  normalizeProposal,
  uniqueIds
} from '../shared/dreamer'
import {
  buildDigest,
  type DreamerDigest,
  dreamerRedact,
  quote,
  turnEvidence
} from './dreamer-digest'
import { productLog, productLogDirectory, readLogs } from './product-log'

/**
 * LKM-202, stage (b) of a Dreamer run: the digest goes to the user's selected
 * provider as one tool-free completion (it never edits code) and the answer is
 * checked against the version 1 format. When the model is unavailable or answers
 * nothing usable, the digest's own findings become the proposals.
 */

const DAY = 24 * 60 * 60_000
const RUN_TIMEOUT_MS = 5 * 60_000
/** Allowance for the model's answer in the estimate shown before a run. */
const ANSWER_TOKENS = 4000
const MAX_PROPOSALS = 10

export interface DreamerCompletion {
  label: string
  complete: (prompt: string, signal: AbortSignal) => Promise<string | null>
}
export interface DreamerDeps {
  sessions: () => SessionRecord[]
  completion: () => DreamerCompletion | null
  logLines?: (since: number, now: number) => string[]
  now?: () => number
  home?: string
}
export interface DreamerEstimate {
  sessions: number
  turns: number
  tokens: number
  model: string | null
}
export interface DreamerRun {
  file: DreamerFile
  digest: DreamerDigest
  model: string | null
  /** Why the proposals came from the digest alone. */
  fallback?: string
}

export function dreamerPrompt(digest: DreamerDigest) {
  return [
    'You are the Dreamer of Trezi, a macOS app where an AI chat edits a repository.',
    'Below is a redacted digest of past chat sessions: slow tools, repeated failures,',
    'retried or corrected turns, repeated request patterns, turn times, landings and parks.',
    `Group what you see into at most ${MAX_PROPOSALS} concrete proposals that would improve the`,
    'app or the user’s workflow. Use only the digest; do not invent sessions or numbers.',
    '',
    'Answer with one JSON object and nothing else:',
    '{"summary": "2-4 sentences of Markdown on what stood out",',
    ' "proposals": [{"id": "kebab-case-id", "title": "...",',
    '   "category": "improvement|template|tool|speed|bug", "problem": "...",',
    '   "evidence": [{"session": "<session id from the digest>", "turn": 3,',
    '     "quote": "<short quote from the digest>", "numbers": {"count": 4}}],',
    '   "proposal": "...", "impact": "...", "effort": "S|M|L",',
    '   "acceptance": ["..."], "areas": ["..."]}]}',
    '',
    'Digest:',
    JSON.stringify(digest)
  ].join('\n')
}

/** The proposals and summary in a model's answer (fenced or bare JSON), or null. */
export function parseDreamerAnswer(
  text: string
): { summary?: string; proposals: DreamerProposal[] } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  const start = text.search(/[{[]/)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  const body = fenced ?? (start < 0 ? '' : text.slice(start, end + 1))
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  const record = Array.isArray(value) ? { proposals: value } : (value as Record<string, unknown>)
  if (!record || !Array.isArray(record.proposals)) return null
  const proposals = uniqueIds(
    record.proposals
      .slice(0, DREAMER_LIMITS.proposals)
      .map((raw, index) => normalizeProposal(raw, index))
      .filter((p): p is DreamerProposal => !!p)
  )
  if (!proposals.length) return null
  return { summary: typeof record.summary === 'string' ? record.summary : undefined, proposals }
}

/** Redacts every text a model wrote and drops evidence pointing at unknown sessions. */
export function sanitizeProposal(
  p: DreamerProposal,
  known: Set<string>,
  home?: string
): DreamerProposal {
  const clean = (text: string) => dreamerRedact(text, home)
  return {
    ...p,
    title: clean(p.title).slice(0, DREAMER_LIMITS.title),
    problem: clean(p.problem),
    proposal: clean(p.proposal),
    impact: clean(p.impact),
    acceptance: p.acceptance.map(clean),
    areas: p.areas.map(clean),
    evidence: p.evidence.map((e) => {
      if (typeof e === 'string') return quote(e, home).slice(0, DREAMER_LIMITS.item)
      const out = { ...e }
      if (out.session && !known.has(out.session)) {
        delete out.session
        delete out.turn
      }
      if (out.quote) out.quote = quote(out.quote, home).slice(0, DREAMER_LIMITS.quote)
      if (out.note) out.note = clean(out.note)
      return out
    })
  }
}

const seconds = (ms: number) => Math.round(ms / 100) / 10

/** The digest's strongest findings as proposals, for a run without a usable model answer. */
export function digestProposals(digest: DreamerDigest): DreamerProposal[] {
  const out: DreamerProposal[] = []
  const tool = digest.tools[0]
  if (tool && tool.count >= 3)
    out.push({
      id: `speed-${tool.tool.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      title: `Speed up ${tool.tool} steps`,
      category: 'speed',
      problem: `${tool.tool} took the most tool time: ${tool.count} steps, ${seconds(tool.totalMs)} s in total, ${seconds(tool.p90Ms)} s at the 90th percentile.`,
      evidence: [
        {
          numbers: {
            steps: tool.count,
            totalMs: tool.totalMs,
            p90Ms: tool.p90Ms,
            maxMs: tool.maxMs
          }
        }
      ],
      proposal: `Find why ${tool.tool} steps are slow (inputs, repeated calls, missing cache) and shorten them.`,
      impact: 'Shorter turns.',
      effort: 'M',
      acceptance: [`${tool.tool}'s 90th-percentile step time drops in the next Dreamer digest.`],
      areas: ['tools']
    })
  const failure = digest.failures.find((f) => f.count >= 2)
  if (failure)
    out.push({
      id: 'repeated-failure',
      title: `Fix a repeated ${failure.kind}: ${failure.message}`.slice(0, DREAMER_LIMITS.title),
      category: 'bug',
      problem: `“${failure.message}” happened ${failure.count} times in ${failure.sessions.length || 'no saved'} chats.`,
      evidence: [
        {
          numbers: { count: failure.count },
          ...(failure.example ? { note: failure.example } : {})
        },
        ...failure.sessions.slice(0, 3).map((session) => ({ session }))
      ],
      proposal:
        'Find the cause of this failure and fix it, or explain it to the user with a way forward.',
      impact: 'Fewer failed turns.',
      effort: 'M',
      acceptance: ['The failure no longer appears in the product log for the same steps.'],
      areas: [failure.message.split(':')[0]]
    })
  if (digest.retries.length >= 2)
    out.push({
      id: 'repeated-corrections',
      title: 'Reduce turns the user had to repeat or correct',
      category: 'improvement',
      problem: `${digest.totals.retries} turns repeated the previous request or corrected the agent.`,
      evidence: digest.retries.slice(0, 5).map((r) => turnEvidence(r)),
      proposal:
        'Review these turns for what the agent missed and add guidance, a check or a template that prevents it.',
      impact: 'Fewer wasted turns.',
      effort: 'M',
      acceptance: ['Fewer corrected or repeated turns in the next Dreamer digest.'],
      areas: ['chat']
    })
  const pattern = digest.patterns.find((p) => p.count >= 3)
  if (pattern)
    out.push({
      id: 'request-template',
      title: `Add a template for “${pattern.pattern}…”`,
      category: 'template',
      problem: `The request “${pattern.pattern}…” was written ${pattern.count} times in ${pattern.sessions} chats.`,
      evidence: pattern.examples.map((e) => turnEvidence(e)),
      proposal: 'Offer this request as a one-click template or a slash command.',
      impact: 'Less typing for a frequent request.',
      effort: 'S',
      acceptance: ['The template exists and fills in the request.'],
      areas: ['composer']
    })
  const parks = Object.values(digest.parks).reduce((sum, n) => sum + n, 0)
  if (parks + digest.conflicts >= 2)
    out.push({
      id: 'landing-parks',
      title: 'Land more turns without parking or conflicts',
      category: 'improvement',
      problem: `${parks} parking events and ${digest.conflicts} conflicts in the window.`,
      evidence: [{ numbers: { parks, conflicts: digest.conflicts, ...digest.landings } }],
      proposal: 'Look at why work was parked and make landing resolve the common cases.',
      impact: 'Less manual merging.',
      effort: 'L',
      acceptance: ['Fewer parked landings in the next Dreamer digest.'],
      areas: ['landing']
    })
  const slow = digest.slowTurns[0]
  if (slow && digest.totals.medianTurnMs > 120_000)
    out.push({
      id: 'slow-turns',
      title: 'Shorten long turns',
      category: 'speed',
      problem: `The median turn took ${seconds(digest.totals.medianTurnMs)} s.`,
      evidence: digest.slowTurns.slice(0, 3).map((t) => turnEvidence(t, { ms: t.ms })),
      proposal: 'Find where these turns spend their time and cut it.',
      impact: 'Faster answers.',
      effort: 'M',
      acceptance: ['The median turn time drops in the next Dreamer digest.'],
      areas: ['chat']
    })
  return out
}

export function createDreamer(deps: DreamerDeps) {
  const now = deps.now ?? Date.now
  const home = deps.home ?? homedir()
  const lines = deps.logLines ?? ((since, at) => readLogs(productLogDirectory(), since, at))
  const digest = (
    scope: DreamerScope,
    at = now(),
    sessions = deps.sessions(),
    logLines?: string[]
  ) =>
    buildDigest({
      sessions,
      logLines: logLines ?? lines(scope.days * DAY, at),
      now: at,
      days: scope.days,
      project: scope.project,
      home
    })
  /** The size of each scope's run, shown before it starts; the files are read once. */
  const estimates = (scopes: DreamerScope[]): DreamerEstimate[] => {
    const at = now()
    const sessions = deps.sessions()
    const logLines = lines(Math.max(0, ...scopes.map((s) => s.days)) * DAY, at)
    const model = deps.completion()?.label ?? null
    return scopes.map((scope) => {
      const d = digest(scope, at, sessions, logLines)
      return {
        sessions: d.totals.sessions,
        turns: d.totals.turns,
        tokens: Math.ceil(dreamerPrompt(d).length / 4) + ANSWER_TOKENS,
        model
      }
    })
  }
  const run = async (scope: DreamerScope, signal?: AbortSignal): Promise<DreamerRun> => {
    const started = now()
    const d = digest(scope, started)
    const known = new Set(deps.sessions().map((s) => s.id))
    const completion = deps.completion()
    let answer: ReturnType<typeof parseDreamerAnswer> = null
    let fallback: string | undefined
    if (!d.totals.turns) fallback = 'No chat turns in this range.'
    else if (!completion) fallback = 'The selected provider cannot run a one-shot completion.'
    else {
      const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS)
      const both = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        const text = await completion.complete(dreamerPrompt(d), both)
        answer = text ? parseDreamerAnswer(text) : null
        if (!answer) fallback = 'The model’s answer had no valid proposals.'
      } catch (error) {
        if (signal?.aborted) throw error
        fallback = `The model could not be reached (${error instanceof Error ? error.message : String(error)}).`
      }
    }
    const proposals = answer
      ? answer.proposals.slice(0, MAX_PROPOSALS).map((p) => sanitizeProposal(p, known, home))
      : digestProposals(d)
    const totals = `${d.totals.sessions} chats, ${d.totals.turns} turns, ${d.totals.toolSteps} timed tool steps and ${d.totals.failures} failures`
    const summary = answer?.summary
      ? `${dreamerRedact(answer.summary, home)}\n\nLooked at ${totals}.`
      : `Looked at ${totals}.${fallback ? ` ${dreamerRedact(fallback, home)} These proposals come from the digest alone.` : ''}`
    const file: DreamerFile = {
      version: DREAMER_VERSION,
      generatedAt: new Date(started).toISOString(),
      scope,
      summary,
      proposals
    }
    productLog.info('dreamer', 'Dreamer run', {
      sessions: d.totals.sessions,
      turns: d.totals.turns,
      proposals: proposals.length,
      fallback: !!fallback,
      ms: now() - started
    })
    // An empty run is a valid answer to show, not a file to send.
    if (proposals.length && dreamerErrors(file).length)
      throw new Error(`The Dreamer produced an invalid file: ${dreamerErrors(file)[0]}`)
    return { file, digest: d, model: completion?.label ?? null, fallback }
  }
  return { digest, estimates, run }
}

export function registerDreamerIpc(deps: DreamerDeps) {
  const dreamer = createDreamer(deps)
  let running: AbortController | null = null
  ipcMain.handle('dreamer:estimates', (_e, scopes: DreamerScope[]) => dreamer.estimates(scopes))
  ipcMain.handle('dreamer:run', async (_e, scope: DreamerScope) => {
    if (running) throw new Error('The Dreamer is already running.')
    running = new AbortController()
    try {
      return await dreamer.run(scope, running.signal)
    } finally {
      running = null
    }
  })
  ipcMain.handle('dreamer:cancel', () => running?.abort())
}
