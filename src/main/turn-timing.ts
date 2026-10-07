import { productLog } from './product-log'

/**
 * LKM-200: how long a chat turn took and where the time went. Each chat keeps its
 * current turn and its last finished one: when Trezi received the message, when the
 * provider got it, every Trezi tool call (start and duration), the landing and the
 * end. The product log gets one summary line per turn ("Turn timing"), and the agent
 * reads the same numbers through `workspace_state` (`report`), so it can answer "how
 * long did this take" from facts. Only names and milliseconds; never tool arguments.
 */

export interface ToolCallTiming {
  tool: string
  startedAt: number
  /** Null while the call runs. */
  ms: number | null
  ok?: boolean
}

export interface ToolSummary {
  tool: string
  count: number
  ms: number
}

export interface TurnTiming {
  turn: string
  receivedAt: number
  sentAt?: number
  providerEndedAt?: number
  providerOutcome?: 'done' | 'error'
  landing?: { at: number; outcome: string; files: number }
  completedAt?: number
  /** The first `TOOL_LIMIT` calls in order; `summary` counts every call. */
  tools: ToolCallTiming[]
  summary: Map<string, ToolSummary>
}

/** Tool calls kept per turn for `report`; the summary still counts the rest. */
export const TOOL_LIMIT = 200

/** Count and total milliseconds per tool, slowest first. */
export function summarizeTools(calls: Iterable<{ tool: string; ms: number | null }>) {
  const byTool = new Map<string, ToolSummary>()
  for (const call of calls) addToSummary(byTool, call.tool, call.ms ?? 0)
  return sortSummary(byTool)
}

const addToSummary = (byTool: Map<string, ToolSummary>, tool: string, ms: number) => {
  const entry = byTool.get(tool) ?? { tool, count: 0, ms: 0 }
  entry.count++
  entry.ms += Math.max(0, Math.round(ms))
  byTool.set(tool, entry)
}

const sortSummary = (byTool: Map<string, ToolSummary>) =>
  [...byTool.values()].sort((a, b) => b.ms - a.ms || a.tool.localeCompare(b.tool))

/** `preview_screenshot:3/1200ms,open_preview:1/310ms`; `-` without calls. */
export function formatToolSummary(summary: readonly ToolSummary[]): string {
  return summary.map((s) => `${s.tool}:${s.count}/${s.ms}ms`).join(',') || '-'
}

const since = (from: number, at: number | undefined) =>
  at === undefined ? null : Math.max(0, at - from)

export class TurnTimings {
  private readonly current = new Map<string, TurnTiming>()
  private readonly last = new Map<string, TurnTiming>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly log: (message: string, fields: Record<string, unknown>) => void = (
      message,
      fields
    ) => productLog.info('chat', message, fields as never)
  ) {}

  /** Trezi received the user's message (`at`: when the request arrived, before admission). */
  received(chat: string, turn: string, at = this.now()): void {
    const open = this.current.get(chat)
    if (open && open.turn !== turn) this.finish(chat, open, 'superseded')
    if (open?.turn === turn) return
    this.current.set(chat, {
      turn,
      receivedAt: at,
      tools: [],
      summary: new Map()
    })
    this.log('Turn received', { chat, turn })
  }

  /** The provider got the prompt. */
  sent(chat: string, turn: string): void {
    const timing = this.current.get(chat)
    if (timing?.turn === turn) timing.sentAt ??= this.now()
  }

  /** A Trezi tool call began; call `end` on the returned handle when it returns. */
  toolStarted(
    chat: string,
    tool: string
  ): { turn: string | undefined; end: (ms: number, ok: boolean) => void } {
    const timing = this.current.get(chat)
    const call: ToolCallTiming = { tool, startedAt: this.now(), ms: null }
    if (timing && timing.tools.length < TOOL_LIMIT) timing.tools.push(call)
    return {
      turn: timing?.turn,
      end: (ms, ok) => {
        call.ms = Math.max(0, Math.round(ms))
        call.ok = ok
        if (timing) addToSummary(timing.summary, tool, call.ms)
      }
    }
  }

  /** The provider's terminal event for the turn. */
  providerEnded(chat: string, turn: string | undefined, outcome: 'done' | 'error'): void {
    const timing = this.current.get(chat)
    if (!timing || (turn && timing.turn !== turn)) return
    timing.providerEndedAt ??= this.now()
    timing.providerOutcome ??= outcome
  }

  /** The landing's result (merged, parked, nothing). */
  landed(chat: string, outcome: string, files: number): void {
    const timing = this.current.get(chat)
    if (timing) timing.landing = { at: this.now(), outcome, files }
  }

  /** The turn is over for the user (landing finished or the chat settled). */
  completed(chat: string, turn?: string): void {
    const timing = this.current.get(chat)
    if (!timing || (turn && timing.turn !== turn)) return
    this.finish(chat, timing, 'completed')
  }

  /** What `workspace_state` shows the agent: the running turn and the last finished one. */
  report(chat: string) {
    const current = this.current.get(chat)
    const last = this.last.get(chat)
    return {
      note: 'Milliseconds from when Trezi received the message. Tool calls are Trezi tools only; the provider’s own tools (Read, Edit, Bash) are part of the gaps between them.',
      current: current ? this.view(current) : null,
      last: last ? this.view(last) : null
    }
  }

  private view(timing: TurnTiming) {
    const at = timing.completedAt ?? this.now()
    const from = timing.receivedAt
    return {
      turn: timing.turn,
      receivedAt: new Date(from).toISOString(),
      running: timing.completedAt === undefined,
      totalMs: at - from,
      sentAfterMs: since(from, timing.sentAt),
      providerEndedAfterMs: since(from, timing.providerEndedAt),
      providerOutcome: timing.providerOutcome ?? null,
      landing: timing.landing
        ? {
            outcome: timing.landing.outcome,
            files: timing.landing.files,
            afterMs: since(from, timing.landing.at)
          }
        : null,
      completedAfterMs: since(from, timing.completedAt),
      tools: timing.tools.map((call) => ({
        tool: call.tool,
        startedAfterMs: since(from, call.startedAt),
        ms: call.ms,
        ...(call.ok === false ? { ok: false } : {})
      })),
      toolSummary: sortSummary(timing.summary)
    }
  }

  private finish(chat: string, timing: TurnTiming, how: 'completed' | 'superseded') {
    timing.completedAt = this.now()
    this.current.delete(chat)
    this.last.set(chat, timing)
    const summary = sortSummary(timing.summary)
    const from = timing.receivedAt
    this.log('Turn timing', {
      chat,
      turn: timing.turn,
      end: how,
      ms: timing.completedAt - from,
      sentMs: since(from, timing.sentAt),
      providerMs: since(from, timing.providerEndedAt),
      landingMs: since(from, timing.landing?.at),
      calls: summary.reduce((n, s) => n + s.count, 0),
      toolMs: summary.reduce((n, s) => n + s.ms, 0),
      perTool: formatToolSummary(summary)
    })
  }
}

/** Every chat's turn timings in this process. */
export const turnTimings = new TurnTimings()
