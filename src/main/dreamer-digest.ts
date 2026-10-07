import { homedir } from 'node:os'
import type { SessionRecord } from '../shared/api'
import { isSystemText } from '../shared/chat-title'
import type { DreamerEvidence } from '../shared/dreamer'
import { redact } from './product-log'

/**
 * LKM-202, stage (a) of a Dreamer run: a deterministic digest of past sessions. It
 * reads saved chat records (transcripts with turn timing) and product-log lines
 * (tool steps, landings, parks, failures, feedback) and computes the statistics the
 * model groups into proposals. Pure: the caller reads the files. Every quote passes
 * through `dreamerRedact` and is cut to `QUOTE` characters; nothing else from a
 * transcript leaves this module.
 */

const DAY = 24 * 60 * 60_000
export const QUOTE = 160
const TOP = 10

/** Secrets and tokens (the product log's rules), emails and home folders. */
export function dreamerRedact(text: string, home = homedir()) {
  return redact(text, home)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\/(?:Users|home)\/[^/\s"'`]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, '~')
}

/** A redacted one-line quote of at most `QUOTE` characters. */
export const quote = (text: string, home?: string) => {
  const line = dreamerRedact(text.replace(/\s+/g, ' ').trim(), home)
  return line.length > QUOTE ? `${line.slice(0, QUOTE - 1)}…` : line
}

export interface LogLine {
  at: number
  level: string
  process: string
  area: string
  chat?: string
  turn?: string
  message: string
  fields: Record<string, string>
}

const FIELD = / ([A-Za-z0-9_.:-]+)=("(?:[^"\\]|\\.)*"|[^\s"=]+)$/
/** One product-log line (`product-log.ts` format), or null. */
export function parseLogLine(line: string): LogLine | null {
  const head = /^(\S+) (debug|info|warn|error) (\S+) (\S+) (.*)$/.exec(line)
  if (!head) return null
  const at = Date.parse(head[1])
  if (Number.isNaN(at)) return null
  let rest = head[5]
  const out: LogLine = {
    at,
    level: head[2],
    process: head[3],
    area: head[4],
    message: '',
    fields: {}
  }
  for (const key of ['chat', 'turn'] as const) {
    const lead = new RegExp(`^${key}=("(?:[^"\\\\]|\\\\.)*"|\\S+) ?`).exec(rest)
    if (!lead) continue
    out[key] = unquote(lead[1])
    rest = rest.slice(lead[0].length)
  }
  for (let match = FIELD.exec(rest); match; match = FIELD.exec(rest)) {
    out.fields[match[1]] = unquote(match[2])
    rest = rest.slice(0, match.index)
  }
  out.message = rest.trim()
  return out
}
function unquote(value: string) {
  if (!value.startsWith('"')) return value
  try {
    return JSON.parse(value) as string
  } catch {
    return value.slice(1, -1)
  }
}

/** A tool name from a provider's status line (`Read · src/a.ts`, `$ bun test`), or null. */
export function toolName(status: string): string | null {
  const text = status.trim()
  if (text.startsWith('$ ')) return 'Bash'
  const name = text.split(' · ')[0].trim()
  if (!/^[A-Za-z][\w.-]{0,80}$/.test(name) || name === 'Thinking') return null
  return name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
}

export interface DigestInput {
  sessions: SessionRecord[]
  logLines: string[]
  now: number
  days: number
  /** A project's key; null for every project. */
  project: string | null
  home?: string
}
interface TurnRef {
  session: string
  turn: number
  quote: string
}
export interface DreamerDigest {
  version: 1
  window: { from: string; to: string; days: number; project: string | null }
  totals: {
    sessions: number
    turns: number
    timedTurns: number
    medianTurnMs: number
    p90TurnMs: number
    toolSteps: number
    retries: number
    failures: number
    refusals: number
    islandSteps: number
    feedback: number
  }
  projects: { name: string; sessions: number; turns: number }[]
  slowTurns: (TurnRef & { ms: number })[]
  tools: {
    tool: string
    count: number
    totalMs: number
    avgMs: number
    p90Ms: number
    maxMs: number
  }[]
  failures: { kind: string; message: string; count: number; sessions: string[]; example?: string }[]
  retries: (TurnRef & { reason: 'correction' | 'repeat' })[]
  patterns: { pattern: string; count: number; sessions: number; examples: TurnRef[] }[]
  landings: Record<string, number>
  parks: Record<string, number>
  conflicts: number
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const CORRECTION =
  /^(?:no\b|nope\b|wrong\b|not (?:that|this|quite|what)|that'?s (?:not|wrong)|still\b|undo\b|revert\b|try again\b|again\b)|\b(?:i meant|i said|not what i (?:asked|wanted|meant)|(?:did ?n[o']t|does ?n[o']t|does not|did not) work|you (?:forgot|missed|ignored)|still (?:broken|not|the same|wrong|there|does ?n[o']t))\b/i
const REFUSAL =
  /^(?:sorry,? )?(?:i can(?:no|')t|i(?:'m| am) (?:not able|unable)|i won'?t be able|i'?m not allowed)\b/i
/** A request's shape: lowercase words, quoted text, paths and numbers replaced. */
export function promptPattern(text: string) {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/`[^`]*`|"[^"]*"|'[^']{2,}'/g, ' x ')
    .replace(/\S*[/\\]\S*/g, ' path ')
    .replace(/\d+(?:\.\d+)?/g, ' n ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return words.length < 2 ? '' : words.slice(0, 6).join(' ')
}
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

/** Builds the digest. Deterministic: the same records, lines and `now` give the same digest. */
export function buildDigest(input: DigestInput): DreamerDigest {
  const { now, days, project, home } = input
  const from = now - days * DAY
  const sessions = input.sessions
    .filter((s) => (project ? s.projectKey === project : true))
    .filter((s) => s.transcript.some((t) => t.at >= from && t.at <= now))
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const ids = new Set(sessions.map((s) => s.id))
  const turnMs: number[] = []
  const slow: (TurnRef & { ms: number })[] = []
  const retries: (TurnRef & { reason: 'correction' | 'repeat' })[] = []
  const patterns = new Map<string, { count: number; sessions: Set<string>; examples: TurnRef[] }>()
  const failures = new Map<
    string,
    { kind: string; message: string; count: number; sessions: Set<string>; example?: string }
  >()
  const fail = (kind: string, message: string, session?: string, example?: string) => {
    const key = `${kind}\n${message}`
    const entry = failures.get(key) ?? { kind, message, count: 0, sessions: new Set<string>() }
    entry.count++
    if (session) entry.sessions.add(session)
    entry.example ??= example
    failures.set(key, entry)
  }
  const projects = new Map<string, { sessions: number; turns: number }>()
  let turns = 0,
    refusals = 0
  for (const session of sessions) {
    const name = session.projectName || 'Project'
    const row = projects.get(name) ?? { sessions: 0, turns: 0 }
    row.sessions++
    let turn = 0,
      previous = ''
    for (const entry of session.transcript) {
      if (entry.at < from || entry.at > now) {
        if (entry.role === 'user') turn++
        continue
      }
      if (entry.role === 'user') {
        turn++
        turns++
        row.turns++
        const ref = { session: session.id, turn, quote: quote(entry.text, home) }
        if (entry.completedAt && entry.completedAt >= entry.at) {
          const ms = entry.completedAt - entry.at
          turnMs.push(ms)
          slow.push({ ...ref, ms })
        }
        const text = normalized(entry.text)
        if (previous && text && text === previous) retries.push({ ...ref, reason: 'repeat' })
        else if (CORRECTION.test(entry.text.trim())) retries.push({ ...ref, reason: 'correction' })
        previous = text
        const shape = promptPattern(entry.text)
        if (shape) {
          const p = patterns.get(shape) ?? { count: 0, sessions: new Set<string>(), examples: [] }
          p.count++
          p.sessions.add(session.id)
          if (p.examples.length < 3) p.examples.push(ref)
          patterns.set(shape, p)
        }
      } else if (entry.role === 'assistant' || entry.role === 'status') {
        const text = entry.text.trim()
        if (entry.role === 'assistant' && REFUSAL.test(text)) {
          refusals++
          fail('refusal', quote(text.split('\n')[0], home), session.id, `turn ${turn}`)
        } else if (text && isSystemText(text))
          fail('error-reply', quote(text.split('\n')[0], home), session.id, `turn ${turn}`)
      }
    }
    projects.set(name, row)
  }

  const tools = new Map<string, number[]>()
  const landings: Record<string, number> = {}
  const parks: Record<string, number> = {}
  let conflicts = 0,
    feedback = 0,
    islandSteps = 0
  for (const raw of input.logLines) {
    const line = parseLogLine(raw)
    if (!line || line.at < from || line.at > now) continue
    // A project's run keeps only lines about its chats; lines without a chat are app-wide.
    if (project && !(line.chat && ids.has(line.chat))) continue
    if (line.area === 'tool' && line.message === 'Tool step') {
      const ms = Number(line.fields.ms)
      const tool = line.fields.tool || 'tool'
      if (Number.isFinite(ms) && ms >= 0) tools.set(tool, [...(tools.get(tool) ?? []), ms])
      if (/island/i.test(tool)) islandSteps++
      continue
    }
    if (line.area === 'landing' && line.message === 'Landing') {
      const outcome = line.fields.outcome || 'unknown'
      landings[outcome] = (landings[outcome] ?? 0) + 1
    }
    if (line.area === 'parking') parks[line.message] = (parks[line.message] ?? 0) + 1
    if (/conflict/i.test(line.message)) conflicts++
    if (line.area === 'feedback' && line.message === 'Feedback posted') feedback++
    if (line.level === 'error' || (line.level === 'warn' && line.area === 'chat')) {
      const code = line.fields.code ? ` (${line.fields.code})` : ''
      fail(
        line.level === 'error' ? 'error' : 'warning',
        dreamerRedact(`${line.area}: ${line.message}${code}`, home),
        line.chat && ids.has(line.chat) ? line.chat : undefined,
        line.fields.error || line.fields.reason
          ? quote(line.fields.error || line.fields.reason, home)
          : undefined
      )
    }
  }

  const toolRows = [...tools]
    .map(([tool, ms]) => {
      const totalMs = ms.reduce((sum, n) => sum + n, 0)
      return {
        tool,
        count: ms.length,
        totalMs,
        avgMs: Math.round(totalMs / ms.length),
        p90Ms: percentile(ms, 90),
        maxMs: Math.max(...ms)
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs || a.tool.localeCompare(b.tool))
  return {
    version: 1,
    window: {
      from: new Date(from).toISOString(),
      to: new Date(now).toISOString(),
      days,
      project
    },
    totals: {
      sessions: sessions.length,
      turns,
      timedTurns: turnMs.length,
      medianTurnMs: percentile(turnMs, 50),
      p90TurnMs: percentile(turnMs, 90),
      toolSteps: toolRows.reduce((sum, row) => sum + row.count, 0),
      retries: retries.length,
      failures: [...failures.values()].reduce((sum, f) => sum + f.count, 0),
      refusals,
      islandSteps,
      feedback
    },
    projects: [...projects]
      .map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.turns - a.turns || a.name.localeCompare(b.name)),
    slowTurns: slow.sort((a, b) => b.ms - a.ms).slice(0, 5),
    tools: toolRows.slice(0, TOP),
    failures: [...failures.values()]
      .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
      .slice(0, TOP)
      .map((f) => ({ ...f, sessions: [...f.sessions].slice(0, 5) })),
    retries: retries.slice(0, 15),
    patterns: [...patterns]
      .filter(([, p]) => p.count >= 2)
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, TOP)
      .map(([pattern, p]) => ({
        pattern,
        count: p.count,
        sessions: p.sessions.size,
        examples: p.examples
      })),
    landings,
    parks,
    conflicts
  }
}

/** The digest's own findings as evidence references (the model cites these). */
export const turnEvidence = (ref: TurnRef, numbers?: Record<string, number>): DreamerEvidence => ({
  session: ref.session,
  turn: ref.turn,
  quote: ref.quote,
  ...(numbers ? { numbers } : {})
})
