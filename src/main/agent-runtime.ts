import { existsSync } from 'node:fs'
import { type ProjectRuntime, RuntimeServiceError } from '../native/runtime-service'

/**
 * LOCAL-WEBKIT-1: each isolated agent's own dev server, for its private WebKit page.
 * The Swift RuntimeOwner runs it in the agent's worktree under the agent's id (a key
 * apart from the project's visible server, loopback only, supervised like it), so a
 * start, restart, crash or stop here never navigates the visible preview, changes the
 * selected project or stops the user's server. Bun keeps only this registry:
 *  - one runtime per agent id (the private browser's id, which names one worktree);
 *  - its `generation`, the owner's count of starts and stops for that key, so a
 *    restarted server is never mistaken for the one a page loaded from;
 *  - the reason the last one ended, for the agent's next tool answer.
 * Command and framework are the worktree's own detection; a custom command the user
 * set for the visible preview is not reused (it may name the live checkout).
 */
export interface AgentRuntime {
  agent: string
  /** The worktree the server runs in. */
  root: string
  url: string
  pid: number
  generation: number
  startedAt: number
}

/** A start that loses its port to another process is tried once more. */
export const AGENT_RUNTIME_START_ATTEMPTS = 2

let owner: ProjectRuntime | null = null
const runtimes = new Map<string, AgentRuntime>()
/** A start in flight; `token.cancelled` is set by a stop, so a late answer registers nothing. */
const starting = new Map<
  string,
  { promise: Promise<AgentRuntime>; token: { cancelled: boolean } }
>()
const ended = new Map<string, { root: string; generation: number; reason: string; at: number }>()

/**
 * Wires the registry to the runtime owner. A previous Bun's private runtimes are never
 * adopted: they are stopped, and their agents start fresh ones on their next call.
 */
export async function installAgentRuntimes(
  runtime: ProjectRuntime,
  log?: (agent: string, line: string) => void
): Promise<void> {
  owner = runtime
  runtime.onAgentExit((agent, root, _url, reason, generation) => {
    const current = runtimes.get(agent)
    if (!current || current.root !== root || current.generation !== generation) return
    runtimes.delete(agent)
    ended.set(agent, { root, generation, reason, at: Date.now() })
  })
  if (log) runtime.onAgentLog((agent, _root, line) => log(agent, line))
  await runtime.stopAgents().catch(() => 0)
}

/** The agent's running private server, if any. */
export function agentRuntime(agent: string): AgentRuntime | null {
  return runtimes.get(agent) ?? null
}

/** Why the agent's last private server ended by itself, if it did. */
export function agentRuntimeEnded(agent: string): { reason: string; generation: number } | null {
  const last = ended.get(agent)
  return last ? { reason: last.reason, generation: last.generation } : null
}

/**
 * Whether `root` can run a private web server for browser checks (LOCAL-WEBKIT-3's
 * landing gate asks): `web` when the owner detects a web project, `none` when it
 * detects another kind or setup, `unavailable` without an owner or detection.
 */
export async function privateRuntimeKind(root: string): Promise<'web' | 'none' | 'unavailable'> {
  if (!owner) return 'unavailable'
  try {
    const detected = await owner.detect(root)
    if (detected.setupRequired) return 'none'
    return detected.previewKind === 'web' && detected.framework !== 'swift' ? 'web' : 'none'
  } catch {
    return 'unavailable'
  }
}

/** The agent's private server for `root`, started when it has none (concurrent calls share one start). */
export function ensureAgentRuntime(agent: string, root: string): Promise<AgentRuntime> {
  const current = runtimes.get(agent)
  if (current?.root === root) return Promise.resolve(current)
  const inFlight = starting.get(agent)
  if (inFlight) return inFlight.promise
  const token = { cancelled: false }
  const promise: Promise<AgentRuntime> = launch(agent, root, token).finally(() => {
    if (starting.get(agent)?.promise === promise) starting.delete(agent)
  })
  starting.set(agent, { promise, token })
  return promise
}

const CANCELLED = 'The private agent dev server start was cancelled: its page was closed.'

async function launch(
  agent: string,
  root: string,
  token: { cancelled: boolean }
): Promise<AgentRuntime> {
  const runtime = owner
  if (!runtime)
    throw new Error('Private agent dev servers are unavailable: no Trezi runtime owner.')
  if (!existsSync(root)) throw new Error("The agent's worktree no longer exists.")
  // An id names one worktree; a runtime for another root is stopped, never reused.
  const previous = runtimes.get(agent)
  if (previous) {
    runtimes.delete(agent)
    await runtime.stopAgent(agent, previous.root).catch(() => {})
  }
  if (token.cancelled) throw new Error(CANCELLED)
  const detected = await runtime.detect(root)
  if (token.cancelled) throw new Error(CANCELLED)
  if (detected.setupRequired)
    throw new Error("The agent's worktree has no dev server to run yet (setup required).")
  if (detected.previewKind !== 'web' || detected.framework === 'swift')
    throw new Error(
      `A private agent dev server runs web projects only; this one previews as ${detected.framework}.`
    )
  let failure: unknown
  for (let attempt = 1; attempt <= AGENT_RUNTIME_START_ATTEMPTS; attempt++) {
    try {
      const server = await runtime.startAgent({
        agent,
        root,
        command: detected.devCommand,
        framework: detected.framework
      })
      // A stop that came while the owner was starting it: the owner's stop request followed
      // this start on the same pipe, so it already cancelled or stopped that server.
      // Register nothing (a newer start for the same agent is not touched here).
      if (token.cancelled) throw new Error(CANCELLED)
      const started: AgentRuntime = {
        agent,
        root,
        url: server.url,
        pid: server.pid,
        generation: server.generation,
        startedAt: Date.now()
      }
      runtimes.set(agent, started)
      ended.delete(agent)
      return started
    } catch (error) {
      if (token.cancelled) throw new Error(CANCELLED)
      failure = error
      if (!(error instanceof RuntimeServiceError) || error.code !== 'conflict') break
    }
  }
  const message = failure instanceof Error ? failure.message : String(failure)
  throw new Error(`The agent's private dev server did not start: ${message}`)
}

/**
 * Stops the agent's private server and cancels a start still in flight (the owner bumps
 * its generation at once, so the start never launches; a late answer registers nothing).
 * The visible server is never touched.
 */
export async function stopAgentRuntime(agent: string): Promise<void> {
  const pending = starting.get(agent)
  if (pending) pending.token.cancelled = true
  starting.delete(agent)
  runtimes.delete(agent)
  ended.delete(agent)
  if (owner) await owner.stopAgents(agent).catch(() => 0)
}

/** Every private runtime this Bun knows (diagnostics and tests). */
export function agentRuntimes(): AgentRuntime[] {
  return [...runtimes.values()]
}
