import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  CodexOptions,
  ModelReasoningEffort,
  Thread,
  ThreadItem,
  ThreadOptions
} from '@openai/codex-sdk'
import { app, type NativeView } from '../../native/platform'
import type { AgentEvent, AgentOptions } from '../../shared/api'
import { projectKey } from '../../shared/projectKey'
import {
  addUsage,
  emptyUsage,
  isEmptyUsage,
  readUsage,
  type TokenUsage,
  usageDelta
} from '../../shared/run-stats'
import { agentFileAccess, realPath } from '../agent-file-access'
import { type RolloutUsageWatch, watchRolloutUsage } from '../codex-usage'
import { parseCodexModels } from '../model-catalog'
import { resolveConnection } from '../providers'
import { scrubSecret } from '../providers-store'
import { treziRules } from '../rules'
import { authorizedTool, runTreziTool, sessionTool } from '../session-tools'
import { registerTreziAgentTools, type TreziAgentToolRegistration } from '../trezi-agent-tools'
import { isolatedCodexConfig, treziMcpConfig, verifyTreziMcp } from './codex-mcp'
import {
  codexFallbackNotice,
  codexModelUnavailable,
  nextCodexModel,
  rejectedCodexModels,
  rememberCodexFallback,
  supportedCodexModel,
  unsupportedCodexModel
} from './codex-model'
import { createRetryCause } from './codex-retry'
import { codexSandbox } from './codex-sandbox'
import { codexItemWarning, createItemTracker } from './codex-stream'
import { liveTreeReport, liveTreeSnapshot, liveWriteNote } from './live-tree-watch'
import { parseProjectMemoryEvaluation, projectMemoryEvaluationPrompt } from './memory'
import { createRecordCapture } from './record'
import { describeTool, sendToRenderer } from './tools'
import type { ModelProvider, PendingPrompt, ProviderSession, SpawnContext } from './types'

/**
 * OpenAI Codex backend (v7) via `@openai/codex-sdk`. The SDK shells out to the `codex`
 * CLI, which edits the repo with its OWN sandboxed tools. Trezi adds only its small,
 * session-scoped worktree-control MCP server; everything else here maps Codex's streamed
 * `ThreadEvent`s onto Trezi's `AgentEvent` stream.
 *
 * **Two auth paths (v10), because harness and endpoint are orthogonal.** The harness —
 * the agent loop, the tools, the sandbox — is the same either way; only where the model
 * requests go differs:
 *
 * - **The built-in Codex seat** (no `connectionId`): the user's own **ChatGPT
 *   subscription** ("sign in with ChatGPT": `codex login`) — no API key anywhere.
 *   Unchanged since v7.
 * - **A user connection** (`AgentOptions.connectionId`): requests go to an
 *   OpenAI-compatible endpoint the user added (Vercel AI Gateway, Groq, a custom host)
 *   with the user's own key, so an open model like Kimi or DeepSeek can drive the chat.
 *   The key reaches main through `resolveConnection` (the Swift provider owner's
 *   Keychain helper; see `main/provider-data.ts`),
 *   always in-process, and is handed to this one `Codex` instance — it is never written
 *   to the user's `~/.codex/config.toml`, never put in argv, never emitted, and never
 *   crosses to the renderer.
 *
 * Reached when `AgentOptions.provider === 'codex'` OR whenever a `connectionId` is set
 * (a connection always runs on this harness — see `pickProvider`). ESM-only, so loaded
 * via a dynamic `import()` (like the Claude SDK) in this CJS main bundle. Every startup
 * failure — missing CLI, not logged in, a connection that no longer resolves — fails
 * soft (`error` + `done`); the CLI/login ones are phrased so the renderer's `isAuthError`
 * heuristic maps them to the "sign in with ChatGPT" banner, and the connection ones are
 * deliberately phrased so it does NOT (a broken connection is not a login problem).
 *
 * Tool approvals run headless (`approvalPolicy: 'never'`; `sandboxMode` from Settings →
 * Agent file access, `codex-sandbox.ts`) — mapping Codex approvals → trezi permission cards is a follow-up (the SDK event stream
 * has no approval-request event to bridge).
 */

type CodexModule = typeof import('@openai/codex-sdk')
let codexPromise: Promise<CodexModule> | null = null
const loadCodex = (): Promise<CodexModule> => (codexPromise ??= import('@openai/codex-sdk'))

const execFileP = promisify(execFile)
// Overridable so tests can force the CLI-absent path even where `codex` resolves
// (e.g. `bun run` puts node_modules/.bin — which has the SDK's codex shim — on PATH).
// Read per call: a test may set it after this module was imported.
const codexBin = (): string => process.env.TREZI_CODEX_BIN || 'codex'
/** The SDK shells out to the `codex` CLI; probe it up front so a missing/unauthed CLI
 *  fails soft FAST + clearly, instead of surfacing a slow spawn ENOENT mid-turn. */
async function codexCliPresent(): Promise<boolean> {
  try {
    await execFileP(codexBin(), ['--version'], { timeout: 4000 })
    return true
  } catch {
    return false
  }
}

/** `TREZI_CODEX_BIN` also names the binary for turns, as for the service's model probe. */
const codexPathOverride = (): CodexOptions =>
  process.env.TREZI_CODEX_BIN ? { codexPathOverride: process.env.TREZI_CODEX_BIN } : {}

let listedPromise: Promise<string[]> | null = null
/**
 * The seat's models in the CLI's own order (`codex debug models`, the probe the service
 * runs for the picker), read only once a model was rejected. [] on any failure.
 */
function listedCodexModels(): Promise<string[]> {
  listedPromise ??= (async () => {
    const { Codex } = await loadCodex()
    const bin =
      process.env.TREZI_CODEX_BIN ||
      (new Codex() as unknown as { exec: { executablePath: string } }).exec.executablePath
    const { stdout } = await execFileP(bin, ['debug', 'models'], {
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024
    })
    return parseCodexModels(JSON.parse(stdout)).map((model) => model.id)
  })().catch(() => [])
  const listed = listedPromise
  void listed.then((ids) => {
    if (!ids.length && listedPromise === listed) listedPromise = null
  })
  return listed
}

/** The model a seat run asks for: the requested one unless this login rejected it. */
async function seatModel(model: string | undefined): Promise<string | undefined> {
  return rejectedCodexModels().size
    ? supportedCodexModel(model || undefined, await listedCodexModels())
    : model || undefined
}

/**
 * The `model_providers` entry id trezi registers for a connection run. It must not
 * collide with a built-in provider id: the CLI rejects the ENTIRE config with
 * "model_providers contains reserved built-in provider IDs" if you try to redefine
 * `openai`, so a connection cannot be expressed by patching the built-in provider.
 */
// Stable provider ID keeps saved Codex endpoint sessions resumable.
const CONNECTION_PROVIDER_ID = 'trezi-connection'

/**
 * Point one `Codex` instance at a user connection instead of the ChatGPT seat.
 *
 * The SDK has a `baseUrl` shortcut, but all it does is emit
 * `--config openai_base_url=…`, i.e. re-point the BUILT-IN `openai` provider — which
 * keeps that provider's `supports_websockets = true`. The CLI then opens every turn
 * with `ws://<host>/responses`, burns five reconnect attempts against a host that has
 * no such route, and only then falls back to plain HTTPS. Each of those attempts
 * arrives as an `error` ThreadEvent, so the shortcut would paint five red
 * "Reconnecting…" lines into the chat before every single turn. Registering our own
 * provider entry with websockets off is the only way to say "this endpoint is
 * ordinary HTTPS", since the built-in entry can't be amended (see above).
 *
 * `wire_api` is pinned to `'responses'`: the bundled CLI (`@openai/codex-sdk`
 * v0.146.0) rejects `wire_api = "chat"` at config load — "no longer supported" — so a
 * chat-completions host cannot back a connection at all. That constraint is enforced in
 * the type (`ProviderConnection.wireApi` admits only `'responses'`) and coerced on both
 * read and write in the store, so no runtime branch is needed here. `env_key` names the
 * variable the SDK's `apiKey` option writes into the child env (`CODEX_API_KEY`).
 *
 * `env` is deliberately NOT set. The SDK documents that supplying it stops the CLI
 * process from inheriting `process.env` — which would strip PATH/HOME out from under a
 * CLI that shells out constantly. Passing the key via `apiKey` also keeps it out of
 * argv, which is world-readable through `ps`.
 *
 * Verified end-to-end against a local probe endpoint: requests land on
 * `<baseUrl>/responses` with `Authorization: Bearer <key>`, no websocket attempt, and
 * no ChatGPT token or `chatgpt-account-id` header even while `codex login` is active.
 * NOT yet verified against a live third-party host — if a real gateway misbehaves,
 * this config block is the thing to adjust.
 */
function connectionCodexOptions(conn: { baseUrl: string; apiKey: string }): CodexOptions {
  return {
    apiKey: conn.apiKey,
    config: {
      model_provider: CONNECTION_PROVIDER_ID,
      model_providers: {
        [CONNECTION_PROVIDER_ID]: {
          name: 'Trezi connection',
          base_url: conn.baseUrl,
          env_key: 'CODEX_API_KEY',
          wire_api: 'responses',
          supports_websockets: false
        }
      }
    }
  }
}

const REASONING_EFFORTS = new Set<ModelReasoningEffort>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
])
const isEffort = (e: string | undefined): e is ModelReasoningEffort =>
  !!e && REASONING_EFFORTS.has(e as ModelReasoningEffort)
const oneLine = (s: string, n = 120): string => s.replace(/\s+/g, ' ').trim().slice(0, n)
/** Items that are the model's own output; after one, a failed turn is not retried. */
const OUTPUT_ITEMS = new Set<string>([
  'agent_message',
  'reasoning',
  'command_execution',
  'file_change',
  'web_search',
  'mcp_tool_call',
  'todo_list'
])

async function startSession(
  root: string,
  options: AgentOptions,
  getWindow: () => NativeView | null,
  // v9 resume/multi-chat: Codex has no confirmed resume primitive — accept the
  // context (for the shared ModelProvider signature) and no-op it. `emitKey`
  // (used for an additional live chat) is honored so its events still route to
  // the right renderer chat slice; `resumeSessionId` is ignored.
  ctx?: SpawnContext
): Promise<ProviderSession> {
  const key = projectKey(root)
  // `emitKey` tags live events (so an additional/resumed chat's `${key}#…` sessionKey
  // routes into its own renderer chat slice) — but the PERSISTED record must keep the
  // canonical `key`, since `sessions-store.ts#list`/`agent:sessions-list` always query
  // by the plain projectKey(root); tagging the record with `emitKey` would orphan an
  // additional/resumed chat's history entry (no lookup could ever find it again).
  const emitKey = ctx?.emitKey ?? key
  const cap = createRecordCapture(root, key)
  const access = agentFileAccess(options.agentFileAccess)
  // Full access has no sandbox to keep a worktree chat off the live checkout, so each
  // turn compares the live tree before and after (`live-tree-watch.ts`).
  const liveRoot = ctx?.liveRoot ?? root
  const watchLive = access === 'full' && realPath(root) !== realPath(liveRoot)
  const pending = new Map<string, PendingPrompt>()
  let disposed = false
  let aborted = false // session teardown (permanent)
  let turnAbort: AbortController | null = null // cancels the in-flight turn only
  // trezi rules (v8 R): no system-prompt arg here, so prepend them to the first turn.
  let firstTurn = true

  const emit = (event: AgentEvent): void => {
    if (disposed) return
    const tagged = {
      ...event,
      projectKey: emitKey,
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {})
    }
    // agent.ts's in-process hook — v9 workspace-snapshot isRunning tracking
    // (set for every interactive session: default, new-chat, resumed).
    ctx?.onEvent?.(tagged)
    sendToRenderer(getWindow, 'agent:event', tagged)
  }
  // A connection's key, held only so `emitError` can blank it out (below). Set once
  // the connection resolves; null for the ChatGPT seat, where there is no key.
  let connKey: string | null = null
  // Always attribute errors to the Codex backend (so the user knows which provider
  // failed, and the renderer's login-banner heuristic can key on it).
  //
  // Scrubbed because not every message here is ours: the SDK surfaces a failed run
  // as `Codex Exec exited with <code>: <stderr>` — the child's ENTIRE stderr, from a
  // process whose environment holds CODEX_API_KEY. No CLI path is known to print the
  // key, but this text is both shown to the user and persisted into the session
  // record, so it's the wrong place to rely on that staying true.
  const emitError = (m: string): void => {
    const safe = scrubSecret(m, connKey)
    emit({ type: 'error', message: /codex/i.test(safe) ? safe : `Codex: ${safe}` })
  }

  // Build the thread up front (the SDK spawns the `codex` CLI; auth = `codex login`,
  // or the connection's own key when `options.connectionId` is set).
  let thread: Thread | null = null
  // Mutable: a model this login rejects is swapped for the fallback for later turns.
  let threadOptions: ThreadOptions = {}
  let openThread: ((id: string | null) => Thread) | null = null
  let treziTools: TreziAgentToolRegistration | null = null
  let initErr: Error | null = null
  try {
    // v10: resolve the connection FIRST. A `connectionId` that no longer resolves —
    // the connection was deleted, or safeStorage can't decrypt its key (new machine,
    // rotated keychain) — must fail soft and SAY SO. Falling through to the ChatGPT
    // seat would quietly run the turn on the wrong account, bill the wrong balance,
    // and answer with a different model than the picker says is selected.
    const conn = options.connectionId ? await resolveConnection(options.connectionId) : null
    connKey = conn?.apiKey ?? null
    if (options.connectionId && !conn) {
      throw new Error(
        "that model's connection is missing or its key could not be read — re-add it in Settings."
      )
    }
    // The PATH probe is a proxy for "has the user set Codex up at all", and it only
    // makes sense for the ChatGPT seat. The SDK spawns its OWN vendored `codex` binary
    // (an npm dependency, always present) rather than anything on PATH, and a
    // connection run authenticates with the key we hand it — so requiring a global
    // `codex` + `codex login` here would block a connection that works fine.
    if (!conn && !(await codexCliPresent())) {
      throw new Error(
        'the `codex` CLI was not found. Install it (`npm i -g @openai/codex` or Homebrew) and run `codex login` (sign in with ChatGPT).'
      )
    }
    const { Codex } = await loadCodex()
    // Trezi's tools for this chat, each authorized by the provider owner against the
    // session's grant first (a background edit is not granted the editor or islands).
    // In a provider helper they run in Bun, reached through the owner (`sessionTool`).
    const scope = {
      root,
      liveRoot: ctx?.liveRoot ?? root,
      emitKey,
      background: !!ctx?.sessionId,
      connectionId: options.connectionId,
      notify: (channel: string, payload: unknown): void =>
        sendToRenderer(getWindow, channel, payload)
    }
    treziTools = await registerTreziAgentTools(
      sessionTool(ctx?.tools, (action, args) =>
        authorizedTool(ctx?.grant, action, args, () => runTreziTool(action, args, scope))
      )
    )
    const mcpConfig = treziMcpConfig(app.getAppPath(), treziTools)
    await verifyTreziMcp(mcpConfig)
    // The seat skips a model this login already rejected (`codex-model.ts`).
    const model = conn ? options.model : await seatModel(options.model)
    // Settings → Agent file access (LKM-163, `codex-sandbox.ts`): no sandbox by default,
    // or the worktree as the only writable project tree (LKM-156).
    const sandbox = codexSandbox(root, ctx?.liveRoot ?? root, access)
    threadOptions = {
      ...sandbox.thread,
      ...(model ? { model } : {}),
      ...(isEffort(options.effort) ? { modelReasoningEffort: options.effort } : {})
    }
    // No connection ⇒ a bare `Codex()`, i.e. byte-identical to the pre-v10 seat.
    const codexOptions = conn ? connectionCodexOptions(conn) : {}
    // Each turn spawns the CLI again, so the user's own MCP servers are re-read and
    // switched off per turn (`isolatedCodexConfig`); only Trezi's server runs.
    openThread = (id) => {
      const codex = new Codex({
        ...codexPathOverride(),
        ...codexOptions,
        config: isolatedCodexConfig({ ...codexOptions.config, ...mcpConfig, ...sandbox.config })
      })
      return id ? codex.resumeThread(id, threadOptions) : codex.startThread(threadOptions)
    }
    thread = openThread(null)
  } catch (err) {
    treziTools?.dispose()
    treziTools = null
    initErr = err instanceof Error ? err : new Error(String(err))
  }

  // Codex reports token usage as a CUMULATIVE tally for the whole thread — turn 2's
  // `turn.completed` repeats turn 1's tokens on top of its own — so every reading is
  // diffed against what we've already emitted (the `usage` event carries a delta, and
  // summing the raw readings would have over-counted every turn after the first).
  // Same accumulator serves the live rollout tail below, so whichever readings it
  // missed are simply topped up at `turn.completed`.
  let sentUsage = emptyUsage()
  const noteUsage = (total: TokenUsage | null): void => {
    if (!total) return
    const delta = usageDelta(sentUsage, total)
    if (isEmptyUsage(delta)) return
    sentUsage = addUsage(sentUsage, delta) // = max(sent, total), never claws back
    emit({ type: 'usage', ...delta })
  }

  // The SDK's event stream has no incremental usage member, so the counters would
  // otherwise sit at zero for the whole turn; the CLI's own session rollout does
  // record them as it goes. Runs only while a turn is in flight. See codex-usage.ts.
  let usageWatch: RolloutUsageWatch | null = null
  const startUsageWatch = (threadId: string): void => {
    if (usageWatch || disposed) return
    usageWatch = watchRolloutUsage(threadId, noteUsage)
  }
  const stopUsageWatch = (): void => {
    usageWatch?.stop()
    usageWatch = null
  }

  // Codex streams whole `ThreadItem`s (often started→updated→completed), not raw deltas.
  // Track per-item: how much agent_message text we've emitted (so updates stream as a
  // suffix), and which tool items we've already surfaced (so we emit each step once).
  // Item ids restart every turn, so this tracker is RESET per turn — see
  // codex-stream.ts for what went wrong when it wasn't.
  const items = createItemTracker()

  const handleItem = (item: ThreadItem, terminal: boolean): void => {
    switch (item.type) {
      case 'agent_message': {
        const delta = items.delta(item.id, item.text)
        if (delta) {
          cap.appendAssistant(delta)
          emit({ type: 'delta', text: delta })
        }
        break
      }
      case 'reasoning': {
        if (terminal && item.text?.trim() && items.first(item.id)) {
          emit({ type: 'status', text: `Thinking · ${oneLine(item.text)}` })
        }
        break
      }
      case 'command_execution': {
        if (items.first(item.id)) {
          emit({ type: 'status', text: `$ ${oneLine(item.command, 100)}` })
          cap.noteTool('Bash', { command: item.command })
        }
        break
      }
      case 'file_change': {
        // "Emitted once the patch succeeds or fails" → handle on the terminal event.
        if (terminal && items.first(item.id)) {
          for (const ch of item.changes ?? []) {
            emit({ type: 'status', text: describeTool('Edit', { file_path: ch.path }) })
            cap.noteTool('Edit', { file_path: ch.path }) // → filesTouched in the record
          }
        }
        break
      }
      case 'web_search': {
        if (items.first(item.id)) {
          emit({ type: 'status', text: `Search · ${oneLine(item.query, 80)}` })
        }
        break
      }
      case 'mcp_tool_call': {
        if (items.first(item.id)) {
          emit({ type: 'status', text: `${item.server} · ${item.tool}` })
          cap.noteTool(item.tool, item.arguments)
        }
        break
      }
      case 'error': {
        // A non-fatal item-level error — surface it as a status, not a turn failure.
        const warning = codexItemWarning(item.message)
        if (warning && items.first(item.id)) emit({ type: 'status', text: warning })
        break
      }
    }
  }

  // Serialize turns: each send() runs to completion before the next starts.
  let chain: Promise<void> = Promise.resolve()
  const runTurn = async (text: string): Promise<void> => {
    if (aborted || disposed) return
    if (!thread) {
      // Startup failed. Missing CLI / not logged in is deliberately auth-shaped
      // (isAuthError matches the "codex login" / "sign in" phrasing → the renderer
      // shows the login banner); an unresolvable connection deliberately is NOT, so
      // the user is told to fix the connection rather than to log in again.
      emitError(initErr?.message ?? 'Codex backend unavailable. Run `codex login`.')
      emit({ type: 'done' })
      return
    }
    const resumeId = thread.id
    if (thread.id && openThread) thread = openThread(thread.id)
    turnAbort = new AbortController()
    // On turn 2+ the thread id is already known, so the tail starts with the turn;
    // on turn 1 it starts at `thread.started`, a moment later.
    if (thread.id) startUsageWatch(thread.id)
    const liveBefore = watchLive ? await liveTreeSnapshot(liveRoot) : null
    // A model this ChatGPT login cannot use fails the turn before any output. Try the
    // next listed model on a fresh copy of the thread, say so, and keep it for later
    // turns; main reads the notice (`provider-sessions.ts`). Connections never do this.
    const wasDefault = !threadOptions.model
    let rejected = await attempt(thread, text)
    for (let tries = 0; rejected && openThread && tries < 3; tries++) {
      const fallback = nextCodexModel(
        await listedCodexModels(),
        new Set([...rejectedCodexModels(), rejected]),
        rejected
      )
      rememberCodexFallback(rejected, fallback, wasDefault)
      if (!fallback || disposed || aborted || turnAbort.signal.aborted) break
      emit({ type: 'status', text: codexFallbackNotice(rejected, fallback) })
      threadOptions = { ...threadOptions, model: fallback }
      stopUsageWatch()
      thread = openThread(resumeId)
      if (thread.id) startUsageWatch(thread.id)
      rejected = await attempt(thread, text)
    }
    if (rejected && !aborted && !turnAbort.signal.aborted)
      emitError(codexModelUnavailable(rejected))
    // One last read before the tail stops: an INTERRUPTED turn never reaches
    // `turn.completed`, so the rollout is the only record of what it spent.
    await usageWatch?.poll().catch(() => {})
    stopUsageWatch()
    const liveAfter = liveBefore ? await liveTreeSnapshot(liveRoot) : null
    const liveChanged =
      liveBefore && liveAfter ? await liveTreeReport(liveRoot, liveBefore, liveAfter) : null
    if (liveChanged && (liveChanged.files.length || liveChanged.committed) && !disposed) {
      const note = liveWriteNote(liveChanged.files, root, liveChanged.committed)
      cap.appendAssistant(note)
      emit({ type: 'delta', text: note })
    }
    cap.finalize()
    emit({ type: 'done' })
  }

  /** One run of the turn's prompt: the model this login rejected, or null. */
  const attempt = async (thread: Thread, text: string): Promise<string | null> => {
    const signal = turnAbort?.signal
    // Per turn, not per session: a retry cause from an earlier turn must not be
    // grafted onto a later, unrelated failure.
    const retryCause = createRetryCause()
    // Codex numbers items per TURN, so turn 2's `item_0` is a NEW item. Without
    // this reset the tracker treats it as a continuation of turn 1's and emits
    // only the longer tail — which is why replies arrived starting mid-word.
    items.reset()
    let rejected: string | null = null
    let produced = false
    // The seat's "not supported with a ChatGPT account" 400, before any output: in a
    // stream `error` or `turn.failed` event (the real CLI's JSON body) or the exec error.
    const rejection = (payload: unknown): boolean => {
      const model = options.connectionId || produced ? null : unsupportedCodexModel(payload)
      if (model) rejected = model
      return !!model || !!rejected
    }
    // The real CLI's `error` event text; an event without one is shown as it came.
    const errorText = (ev: { message?: unknown }): string =>
      typeof ev.message === 'string' ? ev.message : JSON.stringify(ev)
    try {
      const { events } = await thread.runStreamed(text, { signal })
      for await (const ev of events) {
        if (disposed || aborted || signal?.aborted) break
        switch (ev.type) {
          case 'thread.started':
            startUsageWatch(ev.thread_id)
            break
          // A warning item (e.g. the skills-budget note the CLI prints before the
          // request) or an item type this adapter does not show is not output: the
          // model may still be rejected after it.
          case 'item.started':
          case 'item.updated':
            if (OUTPUT_ITEMS.has(ev.item.type)) produced = true
            handleItem(ev.item, false)
            break
          case 'item.completed':
            if (OUTPUT_ITEMS.has(ev.item.type)) produced = true
            handleItem(ev.item, true)
            break
          case 'turn.completed':
            // A running thread total, not this turn's own tokens — `noteUsage`
            // emits only the part the rollout tail hasn't already reported.
            noteUsage(readUsage((ev as { usage?: unknown }).usage))
            break
          case 'turn.failed':
            if (!rejection(ev.error)) emitError(retryCause.explain(errorText(ev.error ?? ev)))
            break
          case 'error': {
            if (rejection(ev)) break
            const message = errorText(ev)
            // The CLI retries a failed request up to five times and emits EACH
            // attempt as its own `error` event ("Reconnecting... 3/5 (…)"). Left
            // alone that paints five red lines into the chat before the real
            // failure — and the terminal message is the least informative of the
            // six ("exceeded retry limit, last status: 429"), because the cause
            // is only stated inside the attempts. So: keep the attempts out of the
            // error stream (they're progress, not outcomes) while remembering WHY,
            // and let the terminal error borrow that reason.
            if (retryCause.note(message)) {
              emit({ type: 'status', text: oneLine(message, 100) })
            } else {
              emitError(retryCause.explain(message))
            }
            break
          }
          // turn.started needs no extra handling.
        }
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      if (!aborted && !signal?.aborted && !rejection(raw)) {
        const m = retryCause.explain(raw)
        // A missing/unauthenticated `codex` CLI surfaces here (e.g. spawn ENOENT).
        emitError(
          /codex/i.test(m)
            ? m
            : `turn failed: ${m}. Is the \`codex\` CLI installed and \`codex login\` done?`
        )
      }
    }
    return rejected
  }

  return {
    key,
    root,
    options,
    // Composer image attachments are not wired yet; MCP screenshot results are images.
    send: (text, _images) => {
      const prompt = firstTurn
        ? `${treziRules({ previewObservationTools: true, controlTools: true, workspaceTools: !ctx?.sessionId, projectMemory: ctx?.projectMemory })}\n\n---\n\n${text}`
        : text
      firstTurn = false
      chain = chain.then(() => runTurn(prompt))
    },
    pending,
    emit,
    record: cap.record,
    finalize: cap.finalize,
    dispose: () => {
      disposed = true
      stopUsageWatch()
      treziTools?.dispose()
      treziTools = null
    },
    shutdown: () => {
      aborted = true
      stopUsageWatch()
      turnAbort?.abort()
      treziTools?.dispose()
      treziTools = null
    },
    interrupt: async () => {
      turnAbort?.abort() // cancel the current turn; the session can still take more
      // Local + synchronous, so it can never wedge the way a control-request round
      // trip can — nothing for agent.ts to clean up.
      return undefined
    }
    // setModel/setPermissionMode: Codex sets these per-thread at startThread, so a live
    // change would mean re-threading — a follow-up. Model/effort are honored on open.
  }
}

/**
 * A fresh read-only Codex thread distills the finished chat without adding a
 * hidden turn to the user's live conversation or exposing the project worktree.
 */
async function updateProjectMemory(
  currentMemory: string,
  transcript: import('../../shared/api').SessionTranscriptEntry[],
  options: AgentOptions
): Promise<string | null> {
  const prompt = projectMemoryEvaluationPrompt(currentMemory, transcript)
  if (!prompt) return null

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 25_000)
  try {
    const conn = options.connectionId ? await resolveConnection(options.connectionId) : null
    if (options.connectionId && !conn) return null
    if (!conn && !(await codexCliPresent())) return null
    const { Codex } = await loadCodex()
    const codexOptions = conn ? connectionCodexOptions(conn) : {}
    const model = conn ? options.model : await seatModel(options.model)
    const thread = new Codex({
      ...codexPathOverride(),
      ...codexOptions,
      config: isolatedCodexConfig(codexOptions.config)
    }).startThread({
      workingDirectory: app.getPath('temp'),
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      ...(model ? { model } : {}),
      ...(isEffort(options.effort) ? { modelReasoningEffort: options.effort } : {})
    })
    const result = await thread.run(prompt, { signal: abort.signal })
    return parseProjectMemoryEvaluation(result.finalResponse, currentMemory)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const codexProvider: ModelProvider = {
  id: 'codex',
  supportsSpawn: true,
  startSession,
  updateProjectMemory
}
