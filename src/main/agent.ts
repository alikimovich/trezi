import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { app, type NativeView, ipcMain as nativeIpcMain } from '../native/platform'
import { nativeSessionPath } from '../native/profile-path'
import type {
  AgentEvent,
  AgentOptions,
  AgentTurnOptions,
  BackgroundSpawnOrigin,
  ImageAttachment,
  LiveProjectSnapshot,
  OpenProjectResult,
  PermissionMode,
  QuestionAnswers,
  SessionRecord,
  SessionTranscriptEntry,
  WorkspaceSnapshot
} from '../shared/api'
import { backgroundAgentOptions, describeAgentOptions } from '../shared/background-model'
import { CHAT_BUSY, isChatBusy, STUCK_NOTE } from '../shared/chat-busy'
import type { ChatRecordLookup } from '../shared/chat-islands'
import { dependencyNotice } from '../shared/dependency-issue'
import { projectKey } from '../shared/projectKey'
import { oneLine } from '../shared/selection-context'
import { type ProviderSession, pickProvider } from './backends'
import { resumeSummary } from './backends/claude-resume'
import { handoffPrompt } from './backends/conversation-handoff'
import { seedFromRecord } from './backends/record'
import type { SpawnContext } from './backends/types'
import { chatIslandContext } from './chat-islands'
import {
  abandonLanding,
  adoptSession,
  afterTurn,
  applyParkedBranch,
  beforeTurn,
  discardParkedBranch,
  discardParkedChat,
  dropAll,
  handleReclaimed,
  hasParkRecord,
  initChatIsolation,
  isolatedCwd,
  isolationSnapshot,
  landingInFlight,
  liveChatWorktreeIds,
  reconcileIdleParks,
  releaseChat,
  resolveParkedChat,
  retryLanding,
  sendRefusal,
  showParkedChat
} from './chat-isolation'
import { type PendingChat, PendingChats } from './chat-pending'
import { chatRecordLookup } from './chat-record'
import { dropSpares, prewarmSpare, releaseSpare } from './chat-spare'
import { TurnTracker } from './chat-turns'
import { answerChatUi, chatUiContext, forgetChatUi, setChatUiHost } from './chat-ui'
import { STALE_SEND_MS, STALE_STOP_MS, TurnWatchdog, WATCHDOG_INTERVAL_MS } from './chat-watchdog'
import {
  cleanUpWorkspacesNow,
  initChatWorkspaces,
  legacyWorkspaceDirs,
  workspaceUsage
} from './chat-workspaces'
import type { DescribeChange } from './commit-message'
import { conflictResolutionPrompt, ReconciliationCoordinator } from './conflict-resolution'
import {
  ConversationError,
  type ConversationOwner,
  type Persist,
  swiftConversationOwner
} from './conversation-owner'
import { clearHistory, recordEdit } from './edit-history'
import { isRepoRoot } from './git'
import { commitLiveTurn } from './live-commit'
import { platformOwner } from './platform-owner'
import { productLog } from './product-log'
import {
  createProjectMemoryInjection,
  createProjectMemoryUpdateQueue,
  ProjectMemoryError,
  type ProjectMemoryStore,
  type ProjectMemoryUpdate,
  type ProjectMemoryUpdateQueue
} from './project-memory'
import { refineProjectMemory } from './project-memory-evaluation'
import { cancelProjectUi, projectUiInstructions, setProjectUiEnabled } from './project-ui'
import { providerOwner } from './provider-owner'
import { startProviderSession } from './provider-sessions'
import { registerProviderIpc } from './providers'
import { generatePublishDescription } from './publish-description'
import { answerAsked } from './question-tool'
import { enqueueRepoWrite } from './repo-write-queue'
import type { RpcHandlerRegistry } from './rpc-router'
import { createSessionStore, type SessionStore } from './sessions-store'
import { keepStoppedTurn, revertStoppedTurn, undoStoppedRevert } from './stopped-turn'
import { logTurnEvent, logTurnNotSent, logTurnStart } from './turn-log'
import { turnTimings } from './turn-timing'
import { workflowOwner } from './workflow-owner'
import { dependenciesInstalling } from './worktree-dependencies'
import {
  applyBranchToWorkingTree,
  autoApplyWorktree,
  branchExists,
  commitWorktree,
  createWorktree,
  deleteBranch,
  pruneIntegratedChatBranches,
  pruneOrphans,
  removeWorktree,
  type Worktree
} from './worktrees'

let ipcMain: RpcHandlerRegistry = nativeIpcMain

// On-disk agent-session history (v5-D). Lazy so it resolves userData after the
// app is ready; under the app's userData dir, out of any user repo.
// Alias legacy stores in place so saved absolute Git/worktree paths remain valid.
let _dataDir: string | null = null
function dataDir(): string {
  if (_dataDir) return _dataDir
  const dir = nativeSessionPath(app.getPath('userData'))
  _dataDir = dir
  return dir
}
let _store: SessionStore | null = null
const store = (): SessionStore => (_store ??= createSessionStore(dataDir()))
// The conversation owner (S11): the Swift service's coordinator, the only one since
// LKM-111 removed the in-process twin. Every chat transition — a turn's start, its
// terminal event, landing, titles, handoff, approvals, spawn admission — is decided
// there; this module performs the effects.
function conversation(): ConversationOwner {
  const swift = swiftConversationOwner()
  if (!swift)
    throw new ConversationError(
      'unavailable',
      'Trezi’s service is not running, so chats cannot start.'
    )
  return swift
}
// The memory owner: the Swift service, set by the native entry point (LKM-111 removed
// the Bun writer). `dataDir()` is resolved first: it creates the session store's
// alias before the service is asked to write in it.
const noMemoryOwner = async (): Promise<never> => {
  throw new ProjectMemoryError(
    'unavailable',
    'Trezi’s service is not running, so project memory is unavailable.'
  )
}
let memoryOwner: (dir: string) => ProjectMemoryStore = () => ({
  get: noMemoryOwner,
  save: noMemoryOwner,
  propose: noMemoryOwner,
  restore: noMemoryOwner
})
export function setProjectMemoryOwner(owner: (dir: string) => ProjectMemoryStore): void {
  memoryOwner = owner
  _memoryStore = null
  _memoryUpdateQueue = null
}
let _memoryStore: ProjectMemoryStore | null = null
const memoryStore = (): ProjectMemoryStore => (_memoryStore ??= memoryOwner(dataDir()))
let _memoryUpdateQueue: ProjectMemoryUpdateQueue | null = null
const memoryUpdateQueue = (): ProjectMemoryUpdateQueue =>
  (_memoryUpdateQueue ??= createProjectMemoryUpdateQueue(memoryStore(), (update) => {
    for (const listener of memoryUpdateListeners) listener(update)
  }))
const memoryUpdateListeners = new Set<(update: ProjectMemoryUpdate) => void>()
/** Hears every automatic memory update the owner committed (the native note). */
export function onProjectMemoryUpdated(
  listener: (update: ProjectMemoryUpdate) => void
): () => void {
  memoryUpdateListeners.add(listener)
  return () => memoryUpdateListeners.delete(listener)
}
/** Undo an automatic update; `null` when memory changed since, so nothing was undone. */
export const undoProjectMemoryUpdate = (update: ProjectMemoryUpdate) =>
  memoryStore().restore(update.root, update.after, update.before.content)

/** The memory version already present in each live provider's context. */
const memoryInjection = createProjectMemoryInjection(memoryStore)
const contextWithMemory = async (
  root: string,
  sessionKey: string | null,
  ctx: SpawnContext
): Promise<SpawnContext> => ({
  ...ctx,
  projectMemory: await memoryInjection.context(root, sessionKey)
})

/**
 * Agent sessions — one persistent multi-turn session per open project (keyed by
 * projectKey), each running a `ModelProvider` backend (Claude Agent SDK by
 * default; Codex/etc. behind the v7 seam). This module is backend-agnostic: it
 * owns the per-project `sessions` map, `activeKey`, teardown, the permission-card
 * settle loop, and every `agent:*` IPC handler — all in terms of `ProviderSession`
 * + `AgentEvent`. The provider-specific streaming/tooling lives under `./backends`.
 *
 * Auth: per-user subscription login for every backend (Claude `setup-token` /
 * `login`, Codex sign-in-with-ChatGPT, …) — never API keys committed in-repo.
 */

// v5 (extended v9): one or more persistent sessions per open project, keyed by
// `sessionKey` — `projectKey` itself for the first live chat, and
// `` `${projectKey}#${sdkSessionId or a generated id}` `` for additional chats
// started via `agent:new-chat` or past sessions revived via `agent:resume-session`.
// Only the ACTIVE session (across the whole app, at most one at a time — the one
// the renderer is currently showing) streams events the renderer will actually
// render into a visible chat; the dispose guard keeps backgrounded/replaced
// sessions from leaking events into a chat the renderer isn't showing.
const sessions = new Map<string, ProviderSession>()
/**
 * Hard cap on how long `agent:interrupt` waits for a backend's cancel before
 * resolving anyway. Deliberately longer than any backend's own grace window (see
 * claude.ts's INTERRUPT_GRACE_MS) so a backend that IS handling it properly gets
 * to finish and report `hardStopped`; this only catches one that never answers.
 */
const INTERRUPT_IPC_CAP_MS = 5_000
let activeKey: string | null = null
const activeSession = (): ProviderSession | null =>
  activeKey ? (sessions.get(activeKey) ?? null) : null
// Per-project memory of which of ITS OWN sessionKeys was last active — so
// switching back to a project (agent:set-active) restores whichever peer chat the
// user was last looking at. Untouched by projects with only one chat.
const activeSessionKeyByProject = new Map<string, string>()
// LKM-182: new chats shown before their worktree and provider are ready
// (`chat-pending.ts`); `prepareChat` is set by registerAgentIpc.
let prepareChat = async (_chat: PendingChat): Promise<void> => {}
const pending = new PendingChats((chat) => prepareChat(chat))
/** New chats with no send yet, and when they were created (the first send is timed). */
const firstSends = new Map<string, number>()
/** All live sessionKeys belonging to a project, including chats still being prepared. */
const sessionKeysForProject = (key: string): string[] =>
  [
    ...sessions.keys(),
    ...pending
      .list()
      .map((chat) => chat.sessionKey)
      .filter((k) => !sessions.has(k))
  ].filter((k) => k === key || k.startsWith(`${key}#`))
// The project the renderer LAST asked to make active (via open-project or
// set-active), recorded synchronously. A slow first-time open (the ESM SDK
// `import()`) must not claim `activeKey` if the user has since switched away —
// otherwise `agent:send` (which routes to the active session) would run the next
// turn in the wrong repo. Every open re-checks this before taking `activeKey`.
let intendedKey: string | null = null
// In-flight open-project promises, keyed by projectKey, so two rapid opens of the
// SAME project serialize (the second waits for the first, then replaces it) rather
// than both creating a session and leaking the loser's subprocess.
const opening = new Map<string, Promise<OpenProjectResult>>()

// sessionKeys with a turn in flight: this process's mirror of the owner's turn state
// (the owner decides; this answers synchronous questions like
// `projectHasRunningAgents`). Added on `agent:send`, retained through
// landing/reconciliation, and swept wherever a sessionKey leaves the `sessions` map
// so it can't outlive its session.
const runningKeys = new Set<string>()
const preparingTurns = new Map<string, { cancelled: boolean }>()
// LKM-165: when each running chat last made progress, and the turn the owner admitted
// last, so a turn that stops making progress can be ended in both places.
const watchdog = new TurnWatchdog()
const turnIds = new Map<string, string>()
// Each provider session's sends in order: which turn (and run of it) an event belongs to.
const trackers = new WeakMap<ProviderSession, TurnTracker>()
// A model switch's recorded conversation, sent once with the next turn when the owner
// says the handoff is due.
const handoffHistory = new Map<string, SessionTranscriptEntry[]>()
const reconciliation = new ReconciliationCoordinator({
  running: runningKeys,
  preparations: preparingTurns,
  currentSession: (key) => sessions.get(key),
  begin: () => {},
  land: afterTurn,
  showParked: showParkedChat,
  continued: (key, turn, run) => conversation().continueTurn(key, turn, run),
  landed: async (key, turn) => (await conversation().landed(key, turn, Date.now())).completedAt,
  dispatch: (session, prompt, turn, run) => {
    trackers.get(session)?.push(turn, run)
    session.send(prompt)
  }
})

/** A throttled checkpoint of a streaming chat's record (tool boundaries flush its text). */
const checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleCheckpoint(sessionKey: string): void {
  if (checkpointTimers.has(sessionKey)) return
  const timer = setTimeout(() => {
    checkpointTimers.delete(sessionKey)
    const s = sessions.get(sessionKey)
    if (s)
      void conversation()
        .checkpoint(sessionKey, s.record)
        .catch(() => {})
  }, 1000)
  timer.unref?.()
  checkpointTimers.set(sessionKey, timer)
}

/**
 * Give a chat a meaningful name once it has real content: after a turn finishes,
 * ask the backend to summarise the conversation into a short title (see
 * `ModelProvider.generateTitle`) and push it to the renderer, instead of the rail
 * standing in the opening words of the first prompt. Runs once per chat (guarded
 * by `record.title`), only when both sides have spoken, and never throws — a
 * backend without title support or any failure just leaves the heuristic name.
 */
async function maybeGenerateTitle(sessionKey: string): Promise<void> {
  // The owner already decided this chat wants a name (untitled, both sides spoke,
  // no other generation running); it also decides whether the answer is used.
  const session = sessions.get(sessionKey)
  let title: string | null = null
  try {
    if (!session) return
    session.finalize() // flush the just-finished turn into the transcript
    const generate = pickProvider(session.options).generateTitle
    if (generate) title = await generate(session.record.transcript, session.options)
  } catch {
    /* best-effort — the rail keeps the first-message heuristic */
  } finally {
    // A name chosen meanwhile (a rename) wins; an empty answer just ends titling.
    const result = await conversation()
      .title(sessionKey, title ?? '', 'generated')
      .catch(() => ({ ok: false, title: undefined }))
    const live = sessions.get(sessionKey)
    if (result.ok && result.title && live && live === session) {
      live.record.title = result.title
      live.emit({ type: 'title', title: result.title })
    }
  }
}

/** The chat's provider and background model as a one-shot completion for its landing
 * commit message (LKM-189); null without a live session or a `complete` primitive. */
function describeChangeWith(sessionKey: string): DescribeChange | null {
  const session = sessions.get(sessionKey)
  const complete = session && pickProvider(session.options).complete
  if (!session || !complete) return null
  const options = describeAgentOptions(session.options)
  return (prompt, signal) => complete(prompt, options, signal)
}

/** LKM-202: every chat record for the Dreamer, saved ones overlaid by the open chats. */
export function dreamerSessions(): SessionRecord[] {
  const byId = new Map(
    store()
      .all()
      .map((record) => [record.id, record])
  )
  for (const session of sessions.values()) byId.set(session.record.id, session.record)
  return [...byId.values()]
}

/** LKM-202: the active chat's provider and model (else the default) as a one-shot, tool-free completion. */
export function dreamerCompletion(): {
  label: string
  complete: (prompt: string, signal: AbortSignal) => Promise<string | null>
} | null {
  const options = activeSession()?.options ?? {}
  const complete = pickProvider(options).complete
  if (!complete) return null
  const label = `${options.provider ?? (options.connectionId ? 'connection' : 'claude')} · ${options.model || 'default model'}`
  return { label, complete: (prompt, signal) => complete(prompt, options, signal) }
}

/**
 * After each successful interactive turn, conservatively merge durable decisions
 * into the project's one shared memory. The queue re-reads memory between peer
 * chats and protects a concurrent manual editor save; provider/model failures are
 * intentionally invisible to the completed chat.
 */
function evaluateProjectMemory(sessionKey: string): void {
  const session = sessions.get(sessionKey)
  if (!session) return
  session.finalize()
  const transcript = session.record.transcript.map((entry) => ({ ...entry }))
  const hasUser = transcript.some((entry) => entry.role === 'user')
  const hasAssistant = transcript.some((entry) => entry.role === 'assistant')
  if (!hasUser || !hasAssistant) return
  const evaluate = pickProvider(session.options).updateProjectMemory
  if (!evaluate) return
  const root = session.record.projectRoot
  const options = { ...session.options }
  // The chat's worktree and the live checkout: a token the turn added is in one of them.
  const roots = [session.root, root]
  void memoryUpdateQueue().enqueue(root, async (currentMemory) =>
    refineProjectMemory(currentMemory, await evaluate(currentMemory, transcript, options), {
      roots
    })
  )
}

/**
 * Interactive-session event hook: the provider adapter's typed events for the owner.
 * Each event is tagged with the turn it belongs to (the tracker's oldest unfinished
 * send). Providers disagree about terminal sequences (Codex can emit error→done while
 * Claude may emit only error), so the owner claims one terminal per run of a turn and
 * refuses a late one; a claimed success may auto-land, name the chat and teach memory,
 * a failure persists partial work on the chat branch but never writes it into the
 * project. Approval requests are registered with the owner, which settles answers.
 */
const interactiveEvents =
  (sessionKey: string, tracker: TurnTracker) =>
  (e: AgentEvent): void => {
    watchdog.touch(sessionKey)
    if (e.type === 'permission-request')
      void conversation()
        .register(sessionKey, e.request.id, 'permission', e.request.toolName)
        .catch(() => {})
    else if (e.type === 'question-request')
      void conversation()
        .register(sessionKey, e.request.id, 'question', '')
        .catch(() => {})
    const at = e.turn ? null : tracker.attribute(e)
    if (at) e.turn = at.turn
    if (e.type === 'model' || e.type === 'status' || e.type === 'delta') logTurnEvent(sessionKey, e)
    if (e.type === 'status') scheduleCheckpoint(sessionKey)
    if (e.type !== 'done' && e.type !== 'error') return
    // Backends forward this same tagged event after the hook. Keep the UI busy
    // until landing (or the automatic continuation) finishes. A `done` no send
    // accounts for is late: it completes nothing, here or in the chat.
    if (e.type === 'done') {
      if (!at) {
        e.stale = true
        e.landingPending = false
        return
      }
      e.landingPending = at.first || runningKeys.has(sessionKey)
    }
    logTurnEvent(sessionKey, e)
    const session = sessions.get(sessionKey)
    if (!at || !session || trackers.get(session) !== tracker) return
    session.finalize()
    const record = session.record
    void conversation()
      .terminal(sessionKey, at.turn, at.run, e.type, record)
      .then((claim) => {
        if (!claim.claimed) return
        const last = [...record.transcript].reverse().find((t) => t.role === 'user')?.text
        void reconciliation.finish(
          sessionKey,
          firstLine(last ?? 'trezi chat edit'),
          claim.outcome,
          at.turn,
          at.run
        )
        if (claim.title) void maybeGenerateTitle(sessionKey)
        if (claim.memory) evaluateProjectMemory(sessionKey)
      })
      .catch((error) => {
        // Never leave the chat busy because the owner could not answer.
        console.error('The conversation owner could not record the end of a turn:', error)
        if (sessions.get(sessionKey) !== session) return
        runningKeys.delete(sessionKey)
        preparingTurns.delete(sessionKey)
        turnTimings.completed(sessionKey, at.turn)
        session.emit({ type: 'landing-finished', turn: at.turn })
      })
  }

// v8 F1: detached comment spawns — background agents each in their OWN git worktree,
// keyed by spawn id. Kept SEPARATE from `sessions` so they never touch `activeKey`
// or the interactive chat stream.
interface Spawn {
  session: ProviderSession
  wt: Worktree
  parentKey: string
  parentSessionKey: string
  parentRoot: string
  text: string
  origin: BackgroundSpawnOrigin
  label?: string
  cancelled?: boolean
  finalizing?: boolean
  error?: string
}
const spawns = new Map<string, Spawn>()
// v8 F1 Phase 3: bound concurrent spawns per project; the rest queue (FIFO) and start
// as slots free, so firing many comments can't fork unbounded worktrees/subprocesses.
// The conversation owner admits them (3 per project) and keeps the queue's order;
// Bun keeps each queued spawn's request until the owner admits it.
interface QueuedSpawn {
  id: string
  root: string
  parentKey: string
  parentSessionKey: string
  text: string
  options: AgentOptions
  origin: BackgroundSpawnOrigin
  /** The comment's own text, one line, for the parent chat's result row (LKM-178). */
  label?: string
}
const queuedSpawns = new Map<string, QueuedSpawn>()
// Admitted by the owner but still creating their worktree + session (not yet in `spawns`).
const startingSpawns = new Map<string, string>()
// A cancel that arrived while its spawn was still starting: interrupted once it runs.
const cancelOnStart = new Set<string>()
/** Git updates must not move the live branch beneath an active project turn. */
/** The turn the chat's provider is working on now (islands and navigation bind to it). */
export function currentTurn(sessionKey: string): string | null {
  const session = sessions.get(sessionKey)
  return (session && trackers.get(session)?.current?.turn) ?? null
}

export function projectHasRunningAgents(root: string): boolean {
  const key = projectKey(root)
  return (
    [...runningKeys].some((sessionKey) => {
      const record = sessions.get(sessionKey)?.record
      return record && projectKey(record.projectRoot) === key
    }) ||
    [...spawns.values()].some((spawn) => projectKey(spawn.parentRoot) === key) ||
    [...queuedSpawns.values()].some((spawn) => projectKey(spawn.root) === key) ||
    [...startingSpawns.values()].includes(key)
  )
}
const worktreesDir = (): string => join(dataDir(), 'worktrees')
const firstLine = (t: string): string => (t.split('\n')[0] || 'Trezi comment edit').slice(0, 72)

/** Provider teardown: stop it emitting, deny its prompts, abort the run. */
function stopProvider(s: ProviderSession): void {
  s.dispose()
  for (const id of [...s.pending.keys()]) resolvePending(s, id, 'deny')
  // Release any unanswered questions so their SDK callbacks unblock (dismiss).
  for (const id of [...(s.pendingQuestions?.keys() ?? [])]) resolveQuestion(s, id, null)
  s.shutdown()
}

/** Close an interactive chat: provider teardown, then the owner persists its record.
 * `current` keeps it as the project's last-active chat (restored in place on the next
 * open); `history` archives it as a previous agent; `none` forgets it. Only chats the
 * user engaged (≥1 prompt) are kept. Never throws — History is non-critical. */
async function closeChat(sessionKey: string, s: ProviderSession, persist: Persist): Promise<void> {
  stopProvider(s)
  clearTimeout(checkpointTimers.get(sessionKey))
  checkpointTimers.delete(sessionKey)
  handoffHistory.delete(sessionKey)
  forgetChatUi(sessionKey)
  try {
    s.finalize()
    if (persist !== 'none' && s.record.transcript.some((t) => t.role === 'user'))
      s.record.endedAt = Date.now()
    await conversation().close(sessionKey, persist, s.record)
  } catch (error) {
    console.error(
      'Trezi could not save a closed chat:',
      error instanceof Error ? error.message : error
    )
  }
}

/** Tear down a detached spawn's session, then persist its record in History (through
 * the store, whose writer is the conversation owner under the Swift launch). */
function closeSession(s: ProviderSession): void {
  stopProvider(s)
  // Only persist sessions the user actually engaged (≥1 prompt) — skip opened-then
  // -closed empties. Best-effort: a disk hiccup must not break teardown.
  try {
    s.finalize()
    if (s.record.transcript.some((t) => t.role === 'user')) {
      s.record.endedAt = Date.now()
      delete s.record.slot
      store().save(s.record)
    }
  } catch {
    // history is non-critical; never let it interfere with session lifecycle
  }
}

/**
 * A detached background spawn reached its terminal event. By default we now
 * AUTO-APPLY its change straight onto the working branch the user is on — no
 * separate `trezi/comment-*` branch, no PR, no manual Apply (that was "too many
 * approvals") — and record it in the undo history so Cmd+Z reverts the whole
 * task atomically. The branch + checkout are deleted and the record is NOT
 * persisted, so the finished spawn vanishes from the rail instead of lingering as
 * a "previous agent".
 *
 * Only when auto-apply is UNSAFE (the user edited a touched file concurrently,
 * or a binary/delete change) do we fall back to the old behaviour: keep the
 * branch + persist the record so the user can resolve it via the review modal.
 * Best-effort throughout — a finalizer must never throw.
 */
async function finalizeSpawn(id: string, status: 'done' | 'error'): Promise<void> {
  const spawn = spawns.get(id)
  if (!spawn || spawn.finalizing) return
  spawn.finalizing = true
  const { session, wt, parentSessionKey, parentRoot, text, origin } = spawn
  const label = spawn.label ? { label: spawn.label } : {}
  await enqueueRepoWrite(parentRoot, async () => {
    try {
      closeSession(session) // finalize + persist the record (removed below if we auto-apply)
      // The agent's closing message → a chat notification the user can reply to.
      const summary =
        spawn.error ??
        [...session.record.transcript].reverse().find((t) => t.role === 'assistant')?.text
      const { committed, files } = await commitWorktree(wt, firstLine(text))
      let auto: { applied: boolean; edits: { file: string; before: string; after: string }[] } = {
        applied: false,
        edits: []
      }
      if (status === 'done' && !spawn.cancelled && committed && files.length) {
        try {
          auto = await autoApplyWorktree(parentRoot, wt, files)
        } catch {
          auto = { applied: false, edits: [] }
        }
      }
      if (auto.applied) {
        // Land it on the working branch + make the whole task ONE Cmd+Z (shared
        // group). Then drop the branch and un-persist the record so the rail clears.
        const group = `${origin}:${id}`
        for (const e of auto.edits)
          recordEdit(parentRoot, e.file, e.before, e.after, undefined, group)
        // …and as one commit on the live checkout, like an interactive chat's turn, so
        // the spawn shows up in `git log` and can be reverted on its own.
        await commitLiveTurn(parentRoot, files, {
          title: firstLine(text),
          body: origin === 'text-edit' ? 'Trezi background text edit.' : 'Trezi comment spawn.'
        })
        await removeWorktree(parentRoot, wt, { keepBranch: false, intent: 'landed' })
        try {
          store().remove(session.record.id)
        } catch {
          /* history is non-critical */
        }
        safeSend(getWindow_, 'agent:event', {
          type: 'spawn-finished',
          projectKey: parentSessionKey,
          sessionId: id,
          branch: null,
          origin,
          ...(summary ? { summary } : {}),
          ...label,
          outcome: 'applied',
          files: auto.edits.map((e) => basename(e.file))
        } satisfies AgentEvent)
      } else {
        // Fallback: keep the branch + record for the manual review modal.
        if (committed) {
          session.record.filesTouched = files // git's staged list beats the heuristic
          session.record.endedAt = session.record.endedAt ?? Date.now()
          store().save(session.record)
        }
        await removeWorktree(parentRoot, wt, {
          keepBranch: committed,
          intent: committed ? 'release' : 'abandon'
        })
        safeSend(getWindow_, 'agent:event', {
          type: 'spawn-finished',
          projectKey: parentSessionKey,
          sessionId: id,
          branch: committed ? wt.branch : null,
          origin,
          ...(summary ? { summary } : {}),
          ...label,
          outcome: spawn.cancelled
            ? 'cancelled'
            : status === 'error'
              ? 'failed'
              : committed
                ? 'review'
                : 'no-change',
          files: committed ? files.map((f) => basename(f)) : []
        } satisfies AgentEvent)
      }
    } catch (error) {
      // Keep the checkout for recovery, but always retire the running card.
      console.error('Background agent finalization failed:', error)
      safeSend(getWindow_, 'agent:event', {
        type: 'spawn-finished',
        projectKey: parentSessionKey,
        sessionId: id,
        branch: wt.branch,
        origin,
        ...label,
        outcome: 'failed',
        summary:
          'Could not finish saving the background edit. Its worktree has been kept for recovery.'
      } satisfies AgentEvent)
    }
  })
  spawns.delete(id)
  void admitNext(id) // a slot just freed — start the next queued spawn
}

let quitting: Promise<void> = Promise.resolve()
/** Settles once every chat closed at quit has been saved by the owner (bounded by the caller). */
export function conversationsClosed(): Promise<void> {
  return quitting
}

// finalizeSpawn runs outside registerAgentIpc's closure, so it needs the window
// accessor. Captured when IPC is registered.
let getWindow_: () => NativeView | null = () => null

// Agent events stream from async SDK callbacks that keep firing after the
// renderer process is killed (OS display sleep / GPU loss): the window outlives
// its webContents, so a bare `.send()` throws an uncaught "Object has been
// destroyed". Guard isDestroyed() to make a late emit a safe no-op.
function safeSend(get: () => NativeView | null, channel: string, payload: unknown): void {
  const wc = get()?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, payload)
}

/**
 * Create the worktree + start a detached session for one spawn. Shared by the
 * immediate path and the queue. On a setup failure it reclaims the worktree and
 * emits `spawn-finished` so the renderer drops the row, then pumps the queue.
 * Returns the branch (immediate path needs it) or null on failure.
 */
async function startSpawn(q: QueuedSpawn): Promise<string | null> {
  // The owner admitted it (its slot is counted there until `spawnDone`).
  startingSpawns.set(q.id, q.parentKey)
  const releaseSlot = () => startingSpawns.delete(q.id)
  let wt: Worktree
  try {
    wt = await enqueueRepoWrite(q.root, () =>
      createWorktree(q.root, worktreesDir(), { label: q.text, id: q.id })
    )
  } catch {
    releaseSlot()
    safeSend(getWindow_, 'agent:event', {
      type: 'spawn-finished',
      projectKey: q.parentSessionKey,
      sessionId: q.id,
      branch: null,
      origin: q.origin,
      ...(q.label ? { label: q.label } : {}),
      outcome: 'failed'
    } satisfies AgentEvent)
    void admitNext(q.id)
    return null
  }
  const opts: AgentOptions = { ...q.options, permissionMode: 'bypassPermissions' }
  try {
    const s = await startProviderSession(
      pickProvider(opts),
      wt.path,
      opts,
      getWindow_,
      await contextWithMemory(q.root, null, {
        sessionId: wt.id,
        emitKey: q.parentSessionKey,
        liveRoot: q.root,
        onEvent: (e) => {
          if (e.type === 'done') void finalizeSpawn(wt.id, 'done')
          else if (e.type === 'error') {
            const spawn = spawns.get(wt.id)
            if (spawn) spawn.error = e.message
            void finalizeSpawn(wt.id, 'error')
          }
        }
      })
    )
    s.record.kind = 'comment'
    s.record.branch = wt.branch
    // The spawn's cwd is its worktree, so createRecordCapture keyed the record to
    // projectKey(wt.path); stamp it back to the parent project (like projectRoot/Name
    // below) so parked spawn records are visible to sessions:list.
    s.record.projectKey = q.parentKey
    s.record.projectRoot = q.root
    s.record.projectName = basename(q.root) || q.root
    s.record.transcript.push({ role: 'user', text: q.text, at: Date.now() })
    spawns.set(wt.id, {
      session: s,
      wt,
      parentKey: q.parentKey,
      parentSessionKey: q.parentSessionKey,
      parentRoot: q.root,
      text: q.text,
      origin: q.origin,
      label: q.label
    })
    releaseSlot()
    s.send(q.text)
    if (cancelOnStart.delete(q.id)) {
      spawns.get(wt.id)!.cancelled = true
      void s.interrupt?.().catch(() => {})
    }
    return wt.branch
  } catch {
    spawns.delete(wt.id)
    releaseSlot()
    await removeWorktree(q.root, wt, { keepBranch: false, intent: 'abandon' })
    safeSend(getWindow_, 'agent:event', {
      type: 'spawn-finished',
      projectKey: q.parentSessionKey,
      sessionId: q.id,
      branch: null,
      origin: q.origin,
      ...(q.label ? { label: q.label } : {}),
      outcome: 'failed'
    } satisfies AgentEvent)
    void admitNext(q.id)
    return null
  }
}

/** A spawn's slot freed: start what the owner admits next, in its queue order. Each
 *  dequeued spawn emits `spawn-started` so the rail flips its row from queued → running. */
async function admitNext(id: string): Promise<void> {
  const next = await conversation()
    .spawnDone(id)
    .catch(() => [] as string[])
  for (const nextId of next) {
    const q = queuedSpawns.get(nextId)
    queuedSpawns.delete(nextId)
    // Cancelled here while the owner admitted it: give its slot straight back.
    if (!q) {
      void admitNext(nextId)
      continue
    }
    const branch = await startSpawn(q)
    if (branch) {
      safeSend(getWindow_, 'agent:event', {
        type: 'spawn-started',
        projectKey: q.parentSessionKey,
        sessionId: q.id,
        branch,
        origin: q.origin
      } satisfies AgentEvent)
    }
  }
}

/** Which live session (any project, active or backgrounded) is holding this
 *  pending permission id? A backgrounded chat keeps streaming/prompting while
 *  the renderer shows a different project, so the id can't be assumed to
 *  belong to `activeSession()`. */
function findSessionWithPending(id: string): ProviderSession | undefined {
  for (const s of sessions.values()) {
    if (s.pending.has(id)) return s
  }
  return undefined
}

/** Same lookup, for a pending AskUserQuestion id. */
function findSessionWithQuestion(id: string): ProviderSession | undefined {
  for (const s of sessions.values()) {
    if (s.pendingQuestions?.has(id)) return s
  }
  return undefined
}

/** A background agent's pending question (LKM-193). The owner registers only interactive
 *  chats' questions, so a spawn's is settled here, by its own session. */
function findSpawnWithQuestion(id: string): ProviderSession | undefined {
  for (const { session } of spawns.values()) {
    if (session.pendingQuestions?.has(id)) return session
  }
  return undefined
}

/** Settle a pending prompt and tell the renderer to drop its card. */
function resolvePending(s: ProviderSession, id: string, behavior: 'allow' | 'deny'): void {
  const p = s.pending.get(id)
  if (!p) return
  p.settle(behavior)
  s.emit({ type: 'permission-resolved', id })
}

/** Settle a pending agent question and tell the renderer to drop its card. */
function resolveQuestion(s: ProviderSession, id: string, answers: QuestionAnswers | null): void {
  const q = s.pendingQuestions?.get(id)
  if (!q) return
  q.settle(answers)
  s.emit({ type: 'question-resolved', id })
}

export function registerAgentIpc(
  getWindow: () => NativeView | null,
  router: RpcHandlerRegistry = nativeIpcMain
): void {
  ipcMain = router
  getWindow_ = getWindow // share with finalizeSpawn (runs outside this closure)
  // v9 per-chat worktree isolation — deps-injected so this module barely grows.
  initChatIsolation({ worktreesDir, store, getWindow, describe: describeChangeWith })
  // LKM-136: idle and old-name chat workspace cleanup; Settings shows the usage.
  initChatWorkspaces({
    worktreesDir,
    busy: (key) => runningKeys.has(key) || preparingTurns.has(key),
    legacyDirs: () => legacyWorkspaceDirs(app.getPath('userData'))
  })
  ipcMain.handle('chat-workspaces:usage', () => workspaceUsage())
  ipcMain.handle('chat-workspaces:clean-up', () => cleanUpWorkspacesNow())
  /** Starts an interactive chat's provider session with its turn tracker and event hook. */
  const startChat = async (
    root: string,
    sessionKey: string,
    options: AgentOptions,
    cwd: string,
    resumeSessionId?: string,
    prior?: Parameters<typeof resumeSummary>[0] & { sdkCwd?: string }
  ): Promise<ProviderSession> => {
    // If the resume fails the new session starts from what the chat showed (LKM-165).
    const summary = resumeSessionId ? resumeSummary(prior) : ''
    const tracker = new TurnTracker()
    const s = await startProviderSession(
      pickProvider(options),
      cwd,
      options,
      getWindow,
      await contextWithMemory(root, sessionKey, {
        emitKey: sessionKey,
        liveRoot: root,
        onEvent: interactiveEvents(sessionKey, tracker),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(summary ? { resumeSummary: summary } : {}),
        ...(resumeSessionId && prior?.sdkCwd ? { resumeCwd: prior.sdkCwd } : {})
      })
    )
    trackers.set(s, tracker)
    return s
  }

  /** Registers a started chat with the owner, then makes it live here. A chat the
   *  owner cannot record is torn down: it would accept no turn. */
  const installChat = async (
    sessionKey: string,
    key: string,
    s: ProviderSession,
    options: AgentOptions,
    active: boolean
  ): Promise<void> => {
    try {
      await conversation().open(sessionKey, key, s.record, options, active)
    } catch (error) {
      stopProvider(s)
      throw error
    }
    sessions.set(sessionKey, s)
  }

  /** Forget a chat's local turn state (its owner record was closed or replaced). */
  const forgetChat = (sessionKey: string): void => {
    memoryInjection.forget(sessionKey)
    firstSends.delete(sessionKey)
    setProjectUiEnabled(sessionKey, false)
    runningKeys.delete(sessionKey)
    preparingTurns.delete(sessionKey)
    reconciliation.begin(sessionKey)
  }

  ipcMain.handle('agent:open-project', async (_e, root: string, options: AgentOptions = {}) => {
    const key = projectKey(root)
    // This is the renderer's latest intent — record it synchronously, before any await.
    intendedKey = key
    // Serialize opens of the SAME project: wait for any in-flight open to settle so
    // we don't create two sessions and strand the first (a leaked subprocess whose
    // events keep streaming under the same key).
    const prior = opening.get(key)
    const run = (async (): Promise<OpenProjectResult> => {
      if (prior) await prior.catch(() => {})
      // Reopening a live project replaces all of its peer chats. Preserve whichever
      // one was last active as the current continuation; the others become History.
      // Tear every worktree down before forking the replacement so its captureBase
      // includes all safely landed output.
      const existingKeys = sessionKeysForProject(key)
      const currentKey = activeSessionKeyByProject.get(key) ?? existingKeys[0]
      pending.cancelAll(key)
      for (const sessionKey of existingKeys) {
        const existing = sessions.get(sessionKey)
        if (!existing) continue
        const terminal = runningKeys.has(sessionKey) ? 'failed' : 'success'
        sessions.delete(sessionKey)
        await closeChat(sessionKey, existing, sessionKey === currentKey ? 'current' : 'history')
        forgetChat(sessionKey)
        await releaseChat(sessionKey, terminal)
      }
      activeSessionKeyByProject.delete(key)
      if (activeKey && (activeKey === key || activeKey.startsWith(`${key}#`))) activeKey = null
      const priorCurrent = store().current(key)
      // A thread id the provider reported after the record was last saved (a crash in
      // between) is kept by the provider owner.
      const resumeSessionId =
        priorCurrent?.sdkSessionId ??
        (priorCurrent
          ? (
              await providerOwner()
                .recover(priorCurrent.id)
                .catch(() => null)
            )?.resume
          : undefined)
      // Isolated chats run in a private `trezi/chat-<id>` worktree (repo roots only);
      // isolatedCwd returns the live root otherwise. adoptSession re-stamps the record
      // back to the live project so history/reattach see it under the real root.
      const cwd = await isolatedCwd(root, key)
      let s: ProviderSession
      try {
        s = await startChat(root, key, options, cwd, resumeSessionId, priorCurrent ?? undefined)
      } catch (err) {
        // A stale Claude resume id shouldn't block opening the project — fall
        // back to a fresh provider thread and still paint the saved transcript.
        if (!resumeSessionId) throw err
        s = await startChat(root, key, options, cwd)
      }
      adoptSession(key, s.record, root)
      if (priorCurrent) seedFromRecord(s.record, priorCurrent, { reuseId: true })
      s.record.endedAt = null
      if (priorCurrent?.title) s.emit({ type: 'title', title: priorCurrent.title })
      // Only claim the active slot if the renderer still wants this project active.
      // A later open/set-active for a different project moved `intendedKey` on, and
      // that project's own turn is what should stream.
      await installChat(key, key, s, options, intendedKey === key)
      if (intendedKey === key) {
        activeKey = key
        activeSessionKeyByProject.set(key, key)
      }
      // v8 F1: reclaim any comment-spawn worktrees orphaned by a prior crash/quit —
      // pruneOrphans commits dirty leftovers to their branch (recovering the work)
      // before removing the checkout. Skip ids of spawns live THIS session (their
      // checkouts are under the same dir). Best-effort, fire-and-forget.
      if (await isRepoRoot(root)) {
        // LKM-182: the next "New chat" takes this prewarmed checkout. Started first so
        // the recovery sweep below skips it.
        if (sessionKeysForProject(key).length) prewarmSpare(root, worktreesDir())
        // Skip live spawns AND live chat worktrees (the worktrees dir is global across
        // projects) so a recovery sweep never reclaims a chat's live checkout.
        // handleReclaimed then surfaces any crashed-mid-turn chat's work as a recovery
        // park record (keyed to the orphan's OWN repo) and deletes cleanly-merged
        // leftover chat branches; comment-spawn orphans keep their prior behavior.
        void pruneOrphans(
          root,
          worktreesDir(),
          new Set([...spawns.keys(), ...startingSpawns.keys(), ...liveChatWorktreeIds()]),
          hasParkRecord
        )
          .then(async (reclaimed) => {
            await handleReclaimed(reclaimed)
            // `pruneOrphans` can only see directories. A prior/interrupting teardown
            // may already have removed its checkout while leaving the local ref, so
            // sweep branch-only residue too. Patch-equivalence (not ancestry alone)
            // recognizes turns already committed to the live branch; parked or unique
            // work is preserved.
            await pruneIntegratedChatBranches(root, hasParkRecord)
          })
          .catch(() => {})
      }
      return {
        transcript: s.record.transcript,
        ...(s.record.title ? { title: s.record.title } : {})
      }
    })()
    opening.set(key, run)
    void run.finally(() => {
      if (opening.get(key) === run) opening.delete(key)
    })
    return run
  })

  // Close a project's session(s) (renderer single-active teardown; the rail uses
  // this when a project is closed, not merely switched away from). Tears down
  // EVERY sessionKey belonging to this project, so closing a project never leaks
  // a live subprocess the renderer no longer shows anywhere.
  ipcMain.handle('agent:close-project', async (_e, root: string) => {
    const key = projectKey(root)
    const projectSessionKeys = sessionKeysForProject(key)
    const currentSessionKey = activeSessionKeyByProject.get(key) ?? projectSessionKeys[0]
    activeSessionKeyByProject.delete(key)
    // Closing the active project clears `active` — never auto-promote an arbitrary
    // backgrounded session (it would start emitting into a chat the renderer isn't
    // showing). The renderer re-activates explicitly via open-project.
    if (activeKey && (activeKey === key || activeKey.startsWith(`${key}#`))) activeKey = null
    // Clear intent too, so an open of this project still in flight can't claim the
    // active slot for a project the user just closed.
    if (intendedKey === key) intendedKey = null
    const closing: Promise<void>[] = []
    // LKM-182: chats still being prepared tear down what they made; the unused spare goes.
    pending.cancelAll(key)
    void releaseSpare(root)
    for (const sk of projectSessionKeys) {
      const s = sessions.get(sk)
      if (s) {
        const terminal = runningKeys.has(sk) ? 'failed' : 'success'
        sessions.delete(sk)
        closing.push(closeChat(sk, s, sk === currentSessionKey ? 'current' : 'history'))
        forgetChat(sk)
        void releaseChat(sk, terminal) // running partial work parks; idle work tears down
      } else {
        // LKM-182: a chat whose preparation failed may hold a worktree.
        firstSends.delete(sk)
        void releaseChat(sk)
      }
    }
    await Promise.all(closing)
    // v8 F3b: drop the project's undo/redo history — a reopened project starts fresh.
    clearHistory(root)
  })

  // Switch the active project to an already-open (warm) session, without
  // recreating it — used by the rail when switching between open projects.
  // Without `sessionKey`, restores whichever of the project's OWN sessionKeys
  // was last active for it, defaulting to its first live chat. With `sessionKey`
  // (v9 multi-chat
  // switcher), selects that SPECIFIC one of the project's already-live sessions —
  // a no-op if it isn't actually live (e.g. it was closed elsewhere meanwhile).
  ipcMain.handle('agent:set-active', async (_e, root: string, sessionKey?: string) => {
    const key = projectKey(root)
    // Record intent regardless, so a slow in-flight open of a DIFFERENT project
    // won't steal `activeKey` back after this switch.
    intendedKey = key
    const remembered = activeSessionKeyByProject.get(key)
    const target =
      sessionKey && sessionKeysForProject(key).includes(sessionKey)
        ? sessionKey
        : remembered && (sessions.has(remembered) || pending.has(remembered))
          ? remembered
          : (sessionKeysForProject(key)[0] ?? key)
    // A chat still being prepared becomes active here; the owner hears when it opens.
    if (sessions.has(target) || pending.has(target)) {
      activeKey = target
      activeSessionKeyByProject.set(key, target)
    }
    if (sessions.has(target))
      await conversation()
        .activate(target)
        .catch(() => {})
  })

  // v9 resume/multi-chat — start an ADDITIONAL fresh session for a project that
  // already has one open. Unlike agent:open-project, the existing session(s) are
  // left running: this registers the new session under its own sessionKey
  // (`${projectKey}#<id>`), so the renderer's per-key chat store gives it its own
  // slice and the rail can list it as a second, independently-switchable chat.
  ipcMain.handle(
    'agent:new-chat',
    async (
      _e,
      root: string,
      options: AgentOptions = {}
    ): Promise<{ ok: boolean; sessionKey?: string; error?: string }> => {
      const key = projectKey(root)
      if (sessionKeysForProject(key).length === 0) {
        return { ok: false, error: 'Open the project before starting another chat.' }
      }
      intendedKey = key
      const sessionKey = `${key}#${randomUUID()}`
      // LKM-182: the chat exists from here; its workspace and provider follow.
      firstSends.set(sessionKey, pending.begin(sessionKey, key, root, options).createdAt)
      activeSessionKeyByProject.set(key, sessionKey)
      activeKey = sessionKey
      productLog.info('chat', 'New chat created', { chat: sessionKey })
      return { ok: true, sessionKey }
    }
  )

  /** LKM-182: a new chat's worktree, provider session and owner record, prepared in the
   *  background with each step timed. A chat closed meanwhile tears down what was made. */
  prepareChat = async (chat: PendingChat): Promise<void> => {
    const { sessionKey, root, options } = chat
    const step = (name: string, since: number) =>
      productLog.info('chat', `New chat ${name}`, { chat: sessionKey, ms: Date.now() - since })
    let since = Date.now()
    const cwd = await isolatedCwd(root, sessionKey)
    step('workspace ready', since)
    if (chat.closed) return void (await releaseChat(sessionKey))
    since = Date.now()
    const s = await startChat(root, sessionKey, options, cwd)
    step('provider started', since)
    if (chat.closed) {
      stopProvider(s)
      return void (await releaseChat(sessionKey))
    }
    adoptSession(sessionKey, s.record, root)
    since = Date.now()
    await installChat(sessionKey, chat.projectKey, s, options, activeKey === sessionKey)
    step('registered', since)
    if (chat.closed) {
      sessions.delete(sessionKey)
      await closeChat(sessionKey, s, 'history')
      forgetChat(sessionKey)
      return void (await releaseChat(sessionKey))
    }
    step('ready', chat.createdAt)
    // The next new chat of this project takes a fresh spare.
    prewarmSpare(root, worktreesDir())
  }

  // Codex fixes its model/backend when a thread is created. Restart exactly the
  // selected chat (not the project's default session) so a picker change never
  // alters a sibling chat or leaves an additional chat on its old model.
  //
  // Extracted from the IPC handler because a force-stop needs it too: when Stop has
  // to hard-abort a wedged backend (see `agent:interrupt`), that kills the whole
  // query, not just the turn — so the chat must be rebuilt or it would look alive
  // while silently swallowing every later message.
  //
  // The chat itself (record, title, approvals, turn state) stays with the owner; only
  // its provider session is replaced. The owner records the handoff: the next turn
  // carries the conversation so far, once. A model change is refused mid-turn; a
  // restart after a force-stop abandons the dead session's turn.
  const restartChatSession = async (
    root: string,
    sessionKey: string,
    options: AgentOptions = {},
    reason: 'model' | 'restart' = 'model'
  ): Promise<{ ok: boolean; error?: string }> => {
    const key = projectKey(root)
    if (!sessionKeysForProject(key).includes(sessionKey)) {
      return { ok: false, error: 'That chat is no longer open.' }
    }
    const existing = sessions.get(sessionKey)
    if (!existing) return { ok: false, error: 'That chat is no longer open.' }
    const previous = existing.record
    existing.finalize()
    try {
      // Reuse the chat's EXISTING worktree (isolatedCwd is idempotent for a known
      // sessionKey) so a model/backend restart keeps its isolation instead of
      // silently dropping to the live root and leaking the worktree.
      const cwd = await isolatedCwd(root, sessionKey)
      const s = await startChat(root, sessionKey, options, cwd)
      adoptSession(sessionKey, s.record, root)
      const sdkSessionId = s.record.sdkSessionId
      seedFromRecord(s.record, previous, { reuseId: true })
      // A new provider session has no SDK history, even though the UI keeps it.
      if (sdkSessionId) s.record.sdkSessionId = sdkSessionId
      else {
        delete s.record.sdkSessionId
        delete s.record.sdkCwd
      }
      s.record.endedAt = null
      try {
        await conversation().handoff(sessionKey, options, s.record, reason)
      } catch (error) {
        stopProvider(s)
        throw error
      }
      if (sessions.get(sessionKey) !== existing) {
        stopProvider(s)
        return { ok: false, error: 'That chat is no longer open.' }
      }
      stopProvider(existing)
      void conversation()
        .release(sessionKey)
        .catch(() => {})
      forgetChat(sessionKey)
      handoffHistory.set(
        sessionKey,
        previous.transcript.map((entry) => ({ ...entry }))
      )
      sessions.set(sessionKey, s)
      if (activeKey === sessionKey) activeSessionKeyByProject.set(key, sessionKey)
      return { ok: true }
    } catch (err) {
      if (err instanceof ConversationError && err.code === 'busy')
        return { ok: false, error: err.message }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  ipcMain.handle(
    'agent:restart-chat',
    async (
      _e,
      root: string,
      sessionKey: string,
      options: AgentOptions = {}
    ): Promise<{ ok: boolean; error?: string }> => {
      if (runningKeys.has(sessionKey))
        return {
          ok: false,
          error: 'Wait for the current response to finish before switching models.'
        }
      await pending.wait(sessionKey).catch(() => {})
      return restartChatSession(root, sessionKey, options, 'model')
    }
  )

  // LKM-199: a chat's owner record once its workspace is ready, for its island session,
  // or why it has none. A new chat has none until its preparation ends; `wait` (default)
  // waits for it without retrying, otherwise a pending chat answers `workspace_pending`.
  ipcMain.handle(
    'agent:chat-record',
    (_e, sessionKey: string, wait = true): Promise<ChatRecordLookup> =>
      chatRecordLookup(sessionKey, wait !== false, {
        settled: (key) => pending.settled(key),
        pending: (key) => pending.status(key),
        pendingRoot: (key) => pending.list().find((chat) => chat.sessionKey === key)?.root,
        session: (key) => {
          const live = sessions.get(key)
          return live
            ? {
                recordId: live.record.id ?? '',
                root: live.record.projectRoot,
                worktree: live.root
              }
            : undefined
        },
        isRepo: isRepoRoot
      })
  )

  // v9 resume — hand a past ("previous agent") SessionRecord back to a LIVE SDK
  // query via `options.resume` (Claude-only: the record's `sdkSessionId` doubles
  // as the "this backend supports resume" marker, since only claude.ts sets it).
  // Registered under a sessionKey derived from the SDK's OWN session id, so a
  // repeat resume of the same record reattaches to the same slot instead of
  // spawning a second live query against it.
  ipcMain.handle(
    'agent:resume-session',
    async (
      _e,
      root: string,
      recordId: string,
      options: AgentOptions = {}
    ): Promise<{ ok: boolean; sessionKey?: string; error?: string }> => {
      const key = projectKey(root)
      const rec = store().get(recordId)
      if (!rec) return { ok: false, error: 'That session record no longer exists.' }
      if (!rec.sdkSessionId) {
        return { ok: false, error: 'This session has no resumable id and can’t be resumed.' }
      }
      intendedKey = key
      const sessionKey = `${key}#${rec.sdkSessionId}`
      if (sessions.has(sessionKey)) {
        // Already resumed and still live — just switch to it.
        activeSessionKeyByProject.set(key, sessionKey)
        if (intendedKey === key) activeKey = sessionKey
        await conversation()
          .activate(sessionKey)
          .catch(() => {})
        return { ok: true, sessionKey }
      }
      try {
        // Resumed chats get a FRESH worktree (their past edits already live in the
        // repo); isolatedCwd falls back to the live root for non-repo projects.
        const cwd = await isolatedCwd(root, sessionKey)
        // Resume is Claude-only (`sdkSessionId` is both the resume id and the
        // "this was Claude" marker), so pin the backend — but keep the caller's
        // model/effort/permission posture. Starting with `{}` here silently ran the
        // resumed chat under main's defaults ('default' = ask for every edit) while
        // the renderer's toolbar still showed the chat's own mode.
        const opts: AgentOptions = { ...options, provider: 'claude' }
        const s = await startChat(root, sessionKey, opts, cwd, rec.sdkSessionId, rec)
        adoptSession(sessionKey, s.record, root)
        // Seed the fresh live record with the resumed chat's on-disk history. The
        // SDK resumes the conversation context and the renderer paints the past
        // messages from the record it resumed, but `s.record.transcript` starts
        // empty and only accrues NEW turns — so without this a later reattach
        // (agent:workspace-snapshot, after a window close+reopen) would repaint an
        // empty chat. The History record stays on its own id.
        seedFromRecord(s.record, rec)
        if (rec.title) s.emit({ type: 'title', title: rec.title })
        await installChat(sessionKey, key, s, opts, true)
        activeSessionKeyByProject.set(key, sessionKey)
        if (intendedKey === key) activeKey = sessionKey
        return { ok: true, sessionKey }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // v9 multi-chat — close ONE of a project's live chats (its rail × ), leaving the
  // project and its other chats alive. Tears down just that sessionKey's session
  // (closeChat persists it to history, so a closed chat becomes a resumable
  // "previous agent" like any other teardown), then re-points the project's active
  // chat to a survivor. Returns the remaining live sessionKeys + the new active one
  // (null when none remain, so the renderer closes the project instead).
  ipcMain.handle(
    'agent:close-chat',
    async (
      _e,
      root: string,
      sessionKey: string
    ): Promise<{ ok: boolean; remaining: string[]; activeSessionKey: string | null }> => {
      const key = projectKey(root)
      const s = sessions.get(sessionKey)
      let closing: Promise<void> = Promise.resolve()
      if (s) {
        const terminal = runningKeys.has(sessionKey) ? 'failed' : 'success'
        sessions.delete(sessionKey)
        closing = closeChat(sessionKey, s, 'history')
        forgetChat(sessionKey)
        void releaseChat(sessionKey, terminal) // running partial work parks; idle work tears down
      } else if (pending.cancel(sessionKey)) {
        firstSends.delete(sessionKey)
        void releaseChat(sessionKey) // LKM-182
      }
      const remaining = sessionKeysForProject(key)
      // Every chat is a peer; keep the first remaining session as the fallback.
      let nextActive = activeSessionKeyByProject.get(key) ?? null
      if (
        !nextActive ||
        nextActive === sessionKey ||
        !(sessions.has(nextActive) || pending.has(nextActive))
      ) {
        nextActive = remaining[0] ?? null
        if (nextActive) activeSessionKeyByProject.set(key, nextActive)
        else activeSessionKeyByProject.delete(key)
      }
      // If the closed chat was the globally active one, re-point activeKey to the
      // survivor (only while this project is still the intended one — never resurrect
      // a backgrounded session into a chat the renderer isn't showing).
      if (activeKey === sessionKey) activeKey = intendedKey === key ? nextActive : null
      await closing
      if (nextActive && sessions.has(nextActive))
        await conversation()
          .activate(nextActive)
          .catch(() => {})
      return { ok: true, remaining, activeSessionKey: nextActive }
    }
  )

  // Rename a live chat (rail inline rename). Writing the name onto the session's
  // record is what makes it stick: the record is persisted on teardown, the
  // workspace snapshot replays it after a reload, and `maybeGenerateTitle` skips
  // any chat whose record already carries a name — so a user-chosen name can never
  // be overwritten by the auto-namer. The `title` event keeps every other renderer
  // view (and this window's own store) in step.
  ipcMain.handle('agent:rename-chat', async (_e, sessionKey: string, title: string) => {
    await pending.wait(sessionKey).catch(() => {})
    const session = sessions.get(sessionKey)
    if (!session) return { ok: false, error: 'no live chat' }
    // The owner cleans the name, keeps it over any generated one, and updates a
    // copy already in History (a resumed/parked chat). A never-persisted live
    // record stays out of `sessions:list`.
    const result = await conversation()
      .title(sessionKey, title, 'user')
      .catch(() => ({ ok: false, error: 'no live chat', title: undefined }))
    if (!result.ok || !result.title) return { ok: false, error: result.error ?? 'empty name' }
    session.record.title = result.title
    session.emit({ type: 'title', title: result.title })
    return { ok: true, title: result.title }
  })

  // Does this project still have a live session? (LRU eviction can suspend a
  // backgrounded project's session; the renderer reopens it on switch-back.)
  ipcMain.handle(
    'agent:is-open',
    (_e, root: string) => sessionKeysForProject(projectKey(root)).length > 0
  )

  ipcMain.handle('agent:set-model', async (_e, model: string) => {
    const session = activeSession()
    if (!session || !activeKey) return
    await session.setModel?.(model)
    session.options.model = model
    await conversation()
      .configure(activeKey, session.options)
      .catch(() => {})
  })

  ipcMain.handle(
    'agent:set-permission-mode',
    async (_e, mode: PermissionMode, sessionKey?: string) => {
      const key = sessionKey === undefined ? activeKey : sessionKey
      if (key) await pending.wait(key).catch(() => {})
      const session = key ? sessions.get(key) : undefined
      if (!session || !key) return
      // Apply to the backend first; only commit our copy if it took (keeps the
      // toolbar and the live agent in agreement).
      await session.setPermissionMode?.(mode)
      session.options.permissionMode = mode
      // Switching to a more permissive posture should also release prompts already
      // on screen — otherwise the user picks "Auto" but the pending card stays. The
      // owner records the mode and answers which open prompts it no longer asks.
      for (const id of await conversation().mode(key, mode)) {
        if (session.pending.has(id)) resolvePending(session, id, 'allow')
      }
    }
  )

  // A permission card can belong to a BACKGROUNDED chat (its turn kept running
  // while the user switched away) — the renderer now shows every live session's
  // cards, not just the active one's, so the id must be looked up across ALL
  // sessions rather than just `activeSession()`. Falling back to the active
  // session first is a cheap common-case shortcut; the full scan below is the
  // actual fix (a session backing a stale id silently no-ops in resolvePending).
  // The owner knows which chat holds each approval and answers null for a late or
  // repeated answer, which then settles nothing. Only if the owner cannot answer at
  // all is the card settled by lookup, so the user is never left blocked.
  ipcMain.handle('agent:respond-permission', async (_e, id: string, behavior: 'allow' | 'deny') => {
    const chat = await conversation()
      .resolve(id, 'permission')
      .catch(() => undefined)
    const session =
      chat === undefined ? findSessionWithPending(id) : chat ? sessions.get(chat) : undefined
    if (session?.pending.has(id)) resolvePending(session, id, behavior)
  })

  // Answer a pending agent question (AskUserQuestion) — settles the awaiting
  // canUseTool callback with the user's picks (or null = dismissed).
  ipcMain.handle(
    'agent:respond-question',
    async (
      _e,
      id: string,
      answers: QuestionAnswers | null
    ): Promise<{ message?: string } | void> => {
      // An ask_user question (LKM-199): the chat sends the answer as the user's next message.
      const asked = answerAsked(id, answers)
      if (asked) return asked
      const background = findSpawnWithQuestion(id)
      if (background) return resolveQuestion(background, id, answers)
      const chat = await conversation()
        .resolve(id, 'question')
        .catch(() => undefined)
      const session =
        chat === undefined ? findSessionWithQuestion(id) : chat ? sessions.get(chat) : undefined
      if (session?.pendingQuestions?.has(id)) resolveQuestion(session, id, answers)
    }
  )

  // LKM-208: answer components live in the chat's transcript, which the conversation
  // owner persists with the record; a pick or submit is checked and saved there.
  setChatUiHost({
    persist: (key, record) => {
      const transcript = sessions.get(key)?.record.transcript
      if (!transcript) return
      const entry = transcript.find((e) => e.ui?.id === record.id)
      if (entry) entry.ui = record
      else
        transcript.push({
          role: 'status',
          text: `Showed ${record.component.kind}: ${record.component.title}`,
          at: record.at,
          ui: record
        })
    },
    find: (key, id) => sessions.get(key)?.record.transcript.find((e) => e.ui?.id === id)?.ui
  })
  ipcMain.handle('agent:chat-ui-answer', (_e, key: string, id: string, answer: unknown) =>
    answerChatUi(key, id, answer)
  )

  /** LKM-182: a send to a chat still being prepared waits for what is missing. Stop
   *  cancels the wait; after 300 ms the chat says it is preparing its workspace. */
  const waitForChat = async (key: string): Promise<void> => {
    const started = Date.now()
    // Stop sets `cancelled` (interruptChat), which ends the wait at once.
    let cancelled = false
    let stop = () => {}
    const stopped = new Promise<void>((resolve) => {
      stop = resolve
    })
    const preparation = {
      get cancelled() {
        return cancelled
      },
      set cancelled(value: boolean) {
        cancelled = value
        if (value) stop()
      }
    }
    preparingTurns.set(key, preparation)
    let shown = false
    const progress = (step: string) =>
      safeSend(getWindow, 'agent:event', {
        type: 'progress',
        step,
        projectKey: key
      } satisfies AgentEvent)
    const slow = setTimeout(() => {
      shown = true
      progress('Preparing workspace…')
    }, 300)
    try {
      await Promise.race([pending.wait(key), stopped])
    } finally {
      clearTimeout(slow)
      if (preparingTurns.get(key) === preparation) preparingTurns.delete(key)
    }
    const created = firstSends.get(key)
    firstSends.delete(key)
    if (created !== undefined)
      productLog.info('chat', 'New chat first send', {
        chat: key,
        waitMs: Date.now() - started,
        sinceCreatedMs: started - created
      })
    if (preparation.cancelled) throw new Error('Message cancelled before sending.')
    if (shown) progress('Thinking…')
  }

  // One user turn. The owner admits it (one turn per chat: a second is refused as
  // busy), records the user entry when the provider is about to get it, and hands
  // the model-switch history over once. `turnId` names the turn (the composer's
  // submission id), so its events, and no other turn's, complete it in the chat.
  ipcMain.handle(
    'agent:send',
    async (
      _e,
      text: string,
      images?: ImageAttachment[],
      requestedKey?: string,
      turn?: AgentTurnOptions,
      turnId?: string
    ) => {
      const receivedAt = Date.now()
      const key = requestedKey ?? activeKey
      if (key && (pending.has(key) || firstSends.has(key))) await waitForChat(key)
      const session = key ? sessions.get(key) : null
      if (requestedKey && !session) throw new Error('This chat is closed.')
      // The chat is busy: the caller queues the message (and the watchdog bounds the wait).
      if (key && staleChat(key, STALE_SEND_MS)) await settleChat(key, STUCK_NOTE)
      if (key && runningKeys.has(key)) throw new Error(CHAT_BUSY)
      if (!session || !key) {
        safeSend(getWindow, 'agent:event', {
          type: 'error',
          message: 'Open a project first — the agent works inside a repo.'
        } satisfies AgentEvent)
        return
      }
      const id =
        typeof turnId === 'string' && turnId && turnId.length <= 128 ? turnId : randomUUID()
      const admit = () => conversation().begin(key, id)
      try {
        await admit().catch(async (error) => {
          // The owner still holds a turn this process no longer runs (a landing that
          // ended without its release): free it once, then admit the message (LKM-165).
          if (!(error instanceof ConversationError && error.code === 'busy')) throw error
          if (runningKeys.has(key) || preparingTurns.has(key) || !(await releaseOwnerTurn(key)))
            throw error
          await admit()
        })
      } catch (error) {
        if (error instanceof ConversationError && error.code === 'busy') throw new Error(CHAT_BUSY)
        if (error instanceof ConversationError && error.code === 'notFound')
          throw new Error('This chat is closed.')
        throw error
      }
      turnIds.set(key, id)
      turnTimings.received(key, id, receivedAt)
      watchdog.touch(key)
      const preparation = { cancelled: false }
      preparingTurns.set(key, preparation)
      const note = images?.length ? `${text} [${images.length} image(s) attached]`.trim() : text
      // Capture the destination before any await; queued background messages must
      // never follow a subsequent project or chat switch.
      runningKeys.add(key)
      reconciliation.begin(key)
      // Turn-start: sync the user's between-turn live edits into this chat's worktree
      // (serialized behind the chat's chain — waits out any in-flight merge). No-op for
      // a non-isolated chat.
      try {
        // LKM-194: dependencies that cannot install are reported, never a refusal.
        const dependencies = await beforeTurn(key, text)
        if (preparation.cancelled) throw new Error('Message cancelled before sending.')
        if (sessions.get(key) !== session) throw new Error('This chat is closed.')
        // Only an unresolved drift park refuses; a stopped or failed-landing hold and
        // the Resolve card's own turn continue on top of it (LKM-165).
        const refusal = requestedKey ? sendRefusal(requestedKey) : null
        if (refusal) throw new Error(refusal)
        const entry = { role: 'user' as const, text: note, at: Date.now() }
        const { handoff } = await conversation()
          .send(key, id, entry)
          .catch((error) => {
            if (error instanceof ConversationError && error.code === 'cancelled')
              throw new Error('Message cancelled before sending.')
            throw error
          })
        if (preparation.cancelled || sessions.get(key) !== session)
          throw new Error('Message cancelled before sending.')
        session.record.transcript.push(entry)
        // Memory is part of the provider's initial instructions. If the user edited it
        // while this session remained open, inject the new snapshot exactly once on the
        // next turn (not every turn, which would needlessly inflate context).
        const root = session.record.projectRoot
        const prompt = await memoryInjection.prompt(root, key, text)
        const supportsUi =
          !session.options.provider || ['claude', 'codex'].includes(session.options.provider)
        const useUi = turn?.projectUi === true && supportsUi
        const uiEngine = turn?.projectUiEngine === 'jev' ? 'jev' : 'agent'
        setProjectUiEnabled(key, useUi, uiEngine)
        const uiNotice =
          turn?.projectUi === true && !supportsUi
            ? 'The requested project component composition mode requires Claude or Codex. Explain this limitation for UI requests.\n\n'
            : ''
        const islandContext = (await chatIslandContext(key, text)) + chatUiContext(key)
        if (preparation.cancelled || sessions.get(key) !== session)
          throw new Error('Message cancelled before sending.')
        // A model switch: the fresh provider gets the recorded conversation, once.
        const history = handoff ? (handoffHistory.get(key) ?? []) : []
        if (handoff) handoffHistory.delete(key)
        // LKM-182: a new chat's dependency install may still be running.
        const installNotice = dependencies
          ? dependencyNotice(dependencies)
          : dependenciesInstalling(session.root)
            ? 'Dependencies are still installing in this workspace: read and edit files, but do not run commands that need node_modules until it finishes.\n\n'
            : ''
        safeSend(getWindow, 'agent:event', {
          type: 'dependencies',
          issue: dependencies,
          projectKey: key
        } satisfies AgentEvent)
        trackers.get(session)?.push(id, 0)
        watchdog.touch(key)
        logTurnStart(key, id, session.options)
        session.send(
          handoffPrompt(
            history,
            projectUiInstructions(useUi, uiEngine) +
              uiNotice +
              installNotice +
              islandContext +
              prompt
          ),
          images
        )
      } catch (error) {
        logTurnNotSent(key, id, error)
        runningKeys.delete(key)
        preparingTurns.delete(key)
        await conversation()
          .abort(key, id)
          .catch(() => false)
        throw error
      }
    }
  )

  // Give a PASTED image a path. A dropped image already has one (the renderer
  // recovers it via webUtils), but clipboard bytes exist nowhere on disk, so the
  // agent could see the screenshot and still have no file to copy or point at.
  // The renderer calls this as it sends, then names the path in the prompt.
  ipcMain.handle(
    'attachments:save',
    async (_e, image: ImageAttachment, name?: string): Promise<string> => {
      // Uploaded in bounded chunks and written by the platform owner.
      return platformOwner().saveAttachment(image, name)
    }
  )

  // Tag the live session with branch / PR metadata for its history record (the
  // renderer knows these; main captures transcript + files). No-op if no session.
  ipcMain.handle(
    'agent:tag-session',
    async (_e, root: string, tag: { branch?: string; prUrl?: string }) => {
      const key = projectKey(root)
      // Prefer whichever of the project's sessions is currently active (an
      // additional/resumed chat, if that's what's live) — falls back to the
      // default session, matching pre-v9 behavior when there's only one.
      const s =
        activeKey && sessionKeysForProject(key).includes(activeKey)
          ? sessions.get(activeKey)
          : sessions.get(key)
      if (!s) return
      if (typeof tag.branch === 'string') s.record.branch = tag.branch
      if (typeof tag.prUrl === 'string') s.record.prUrl = tag.prUrl
    }
  )

  // v8 F1: spawn a detached background agent in its own git worktree. It runs in the
  // background (bypassPermissions — a headless run has no card UI), edits its private
  // checkout (zero cross-writes with the main agent or other spawns), and on finish
  // commits to a `trezi/comment-<id>` branch + lands in this project's history. Over the
  // per-repo cap (Phase 3) it QUEUES and starts when a slot frees.
  ipcMain.handle(
    'agent:spawn-comment',
    async (
      _e,
      root: string,
      text: string,
      requestedParentSessionKey: string,
      options: AgentOptions = {},
      requestedOrigin: BackgroundSpawnOrigin = 'comment',
      requestedLabel?: string
    ) => {
      // Worktrees need a repo TOP LEVEL — a non-repo (or subdir) falls back to chat.
      if (!(await isRepoRoot(root))) return { ok: false, reason: 'not-a-repo' }
      // Only backends that honor SpawnContext can run a detached spawn; on the
      // others a spawn would never finalize (worktree + rail row leak forever),
      // so refuse and let the renderer run the comment in the main chat instead.
      if (!pickProvider(options).supportsSpawn) {
        return { ok: false, reason: 'unsupported-backend' }
      }
      const parentKey = projectKey(root)
      const parentSessionKey = sessionKeysForProject(parentKey).includes(requestedParentSessionKey)
        ? requestedParentSessionKey
        : (activeSessionKeyByProject.get(parentKey) ?? parentKey)
      // IPC values are renderer-controlled. Unknown future/malformed values retain
      // the established comment UX instead of creating an unhandled event variant.
      const origin: BackgroundSpawnOrigin =
        requestedOrigin === 'text-edit' ? 'text-edit' : 'comment'
      const label =
        typeof requestedLabel === 'string' ? oneLine(requestedLabel, 300) || undefined : undefined
      // Stable id assigned up front so the rail row survives a queued→running flip.
      const id = randomUUID().slice(0, 8)
      const q: QueuedSpawn = {
        id,
        root,
        parentKey,
        parentSessionKey,
        text,
        options: backgroundAgentOptions(options, origin),
        origin,
        label
      }
      // Held before the owner answers, so a slot freed meanwhile can start it.
      queuedSpawns.set(id, q)
      if (
        !(await conversation()
          .spawn(id, parentKey)
          .catch(() => false))
      ) {
        // Queued (or the owner cannot admit it now): a slot freeing starts it.
        return { ok: true, spawnId: id, queued: true }
      }
      // Cancelled while the owner admitted it: give the slot back.
      if (!queuedSpawns.delete(id)) {
        void admitNext(id)
        return { ok: false, reason: 'Cancelled.' }
      }
      const branch = await startSpawn(q)
      if (!branch) return { ok: false, reason: 'Could not start the agent (is it logged in?).' }
      return { ok: true, spawnId: id, branch }
    }
  )

  // v8 F1 Phase 3 — cancel a running OR queued comment spawn (the rail row's ×).
  ipcMain.handle('agent:spawn-interrupt', async (_e, id: string) => {
    const waiting = queuedSpawns.get(id)
    // Still queued with the owner — or admitted but not yet started here.
    if (
      waiting &&
      ((await conversation()
        .spawnCancel(id)
        .catch(() => false)) ||
        queuedSpawns.has(id))
    ) {
      const q = waiting
      queuedSpawns.delete(id)
      safeSend(getWindow, 'agent:event', {
        type: 'spawn-finished',
        projectKey: q.parentSessionKey,
        sessionId: id,
        branch: null,
        origin: q.origin,
        ...(q.label ? { label: q.label } : {}),
        outcome: 'cancelled'
      } satisfies AgentEvent)
      return
    }
    const spawn = spawns.get(id)
    if (!spawn) {
      if (startingSpawns.has(id)) cancelOnStart.add(id)
      return
    }
    spawn.cancelled = true
    // A question still waiting for the user is dismissed, so the turn can stop (LKM-193).
    for (const qid of [...(spawn.session.pendingQuestions?.keys() ?? [])])
      resolveQuestion(spawn.session, qid, null)
    // → emits done → finalizeSpawn commits any work. Interrupting a turn that
    // already finished/aborted makes the SDK throw "Operation aborted" — a stop
    // that arrives late is a no-op, not an error.
    await spawn.session.interrupt?.().catch(() => {})
  })

  // v8 F1 Phase 2 — close the loop from a finished comment spawn to a visible result.
  // APPLY: patch the spawn's branch diff onto the LIVE working tree (the dev server
  // HMRs it). Not `git merge` — patch-apply tolerates the main agent's WIP; on textual
  // overlap it surfaces conflict markers for the user to resolve.
  ipcMain.handle('agent:spawn-apply', async (_e, root: string, branch: string) => {
    // v9: if this branch belongs to a LIVE parked chat, apply it through the isolation
    // path (advance the fork point + unpark) rather than the stock spawn-branch apply.
    // A crash-recovered (dead) chat's branch is not owned by any live chat → falls
    // through to the stock path below unchanged.
    const parked = await applyParkedBranch(root, branch)
    if (parked.handled) {
      if (parked.ok) return { ok: true }
      return {
        ok: false,
        conflict: parked.conflict,
        error: parked.conflict
          ? 'Applied with conflicts — resolve the markers in your editor, then keep going.'
          : (parked.error ?? 'Could not apply the changes.')
      }
    }
    if (!(await isRepoRoot(root))) return { ok: false, error: 'Not a git repository.' }
    if (!(await branchExists(root, branch)))
      return { ok: false, error: 'That branch no longer exists.' }
    const res = await applyBranchToWorkingTree(root, branch)
    if (res.empty) return { ok: false, error: 'That run made no changes to apply.' }
    if (res.ok) return { ok: true }
    return {
      ok: false,
      conflict: res.conflict,
      error: res.conflict
        ? 'Applied with conflicts — resolve the markers in your editor, then keep going.'
        : (res.error ?? 'Could not apply the changes.')
    }
  })

  // DISCARD: drop the spawn's branch (the renderer also removes the history record).
  ipcMain.handle('agent:spawn-discard', async (_e, root: string, branch: string) => {
    // v9: a LIVE parked chat's branch is reset in place (its worktree still checks it
    // out, so `git branch -D` would fail); only a real/dead spawn branch is deleted.
    const parked = await discardParkedBranch(root, branch)
    if (parked.handled) return { ok: true }
    if (branch) await deleteBranch(root, branch)
    return { ok: true }
  })

  // v9 conflict card — "Resolve it". Stage the active parked chat's worktree so it holds
  // BOTH the user's live edits and the chat's changes (3-way merged). If they overlap,
  // return the conflicted files + a resolution PROMPT for the renderer to run as a normal
  // turn (its `afterTurn` merges + unparks). If they merged cleanly, `resolveParkedChat`
  // already committed + merged + unparked — nothing more to send (`conflicted: []`).
  ipcMain.handle('agent:resolve-conflict', async (_e, sessionKey = activeKey) => {
    if (!sessionKey) return { ok: false, conflicted: [] as string[], error: 'no-session' }
    const res = await resolveParkedChat(sessionKey)
    if (!res.ok || res.conflicted.length === 0) return { ...res, conflicted: res.conflicted }
    const prompt = conflictResolutionPrompt(res.conflicted)
    return { ok: true, conflicted: res.conflicted, prompt }
  })

  // v9 conflict card — "Discard changes". Drop the active parked chat's unmerged work.
  ipcMain.handle('agent:discard-conflict', async (_e, sessionKey = activeKey) => {
    if (!sessionKey) return { ok: false }
    return discardParkedChat(sessionKey)
  })

  // LKM-165 landing card — "Retry": land the held batch again; the outcome reaches the
  // chat as the usual isolation event.
  ipcMain.handle('agent:retry-landing', async (_e, sessionKey = activeKey) =>
    sessionKey
      ? retryLanding(sessionKey)
      : { ok: false, state: 'isolated' as const, error: 'no-session' }
  )

  // LKM-151 post-Stop card: revert (undoable), undo that revert, or keep the stopped
  // turn's held work. "Ask agent to finish" is an ordinary turn from the renderer.
  ipcMain.handle('agent:revert-stopped', async (_e, sessionKey = activeKey) =>
    sessionKey ? revertStoppedTurn(sessionKey) : { ok: false, files: [] }
  )
  ipcMain.handle('agent:undo-revert-stopped', async (_e, sessionKey = activeKey) =>
    sessionKey ? undoStoppedRevert(sessionKey) : { ok: false, files: [] }
  )
  ipcMain.handle('agent:keep-stopped', async (_e, sessionKey = activeKey) =>
    sessionKey ? keepStoppedTurn(sessionKey) : { ok: false, files: [] }
  )

  // PR: push the spawn's branch + open a PR from it (no checkout — the work is already
  // committed on the branch). Persists prUrl back onto the history record.
  ipcMain.handle(
    'agent:spawn-pr',
    async (_e, root: string, branch: string, _title: string, recordId: string) => {
      const result = await workflowOwner().branchPr(root, branch, (base, head) =>
        generatePublishDescription(root, base, head)
      )
      if (result.ok && result.prUrl) {
        // Persist prUrl onto the history record (overwrite by id).
        const rec = store().get(recordId)
        if (rec) {
          rec.prUrl = result.prUrl
          store().save(rec)
        }
      }
      return result
    }
  )

  // Persisted history ("previous agents", v5-D). Lists past runs (the live session
  // is persisted only on teardown, so it isn't here).
  ipcMain.handle('sessions:list', (_e, root: string) =>
    store()
      .list(projectKey(root))
      .filter((r) => r.slot !== 'current' && r.slot !== 'main')
  )
  ipcMain.handle('sessions:get', (_e, id: string) => store().get(id))
  ipcMain.handle('sessions:rename', async (_e, id: string, title: string) => {
    const result = await conversation().rename(id, title)
    // The next read must see it, like every other write through the store.
    if (result.ok) await store().flush()
    return result
  })
  ipcMain.handle('sessions:remove', (_e, id: string) => store().remove(id))

  // The editor's read and manual save. A failure (damaged file, service unavailable)
  // rejects, so the sheet keeps its draft and reports it; nothing falls back to Bun.
  ipcMain.handle('project-memory:get', (_e, root: string) => memoryStore().get(root))
  ipcMain.handle('project-memory:set', (_e, root: string, content: string) =>
    memoryStore().save(root, typeof content === 'string' ? content : '')
  )

  // User-added model endpoints (v10, `providers:*`). Registered from here, next to
  // the other userData-backed stores, and handed THIS module's `dataDir` so both
  // stores share one directory — and so providers.ts can't create it ahead of the
  // legacy session-store alias above and quietly skip it.
  registerProviderIpc(dataDir, router)

  // v9 reattach: everything still live in main, for a fresh renderer (after a
  // reload) to repaint without tearing anything down. Groups every live
  // sessionKey by its record's canonical projectKey (not by string-parsing the
  // sessionKey) — `record.projectKey` is always the plain projectKey(root) even
  // for an additional/resumed chat (see the comment on `emitKey` above), and
  // `record.projectRoot` recovers the absolute root alongside it.
  // Turn state (running, the turn in flight) comes from the owner, so a reattach sees
  // what the coordinator decided; the transcript is the provider's live capture.
  ipcMain.handle('agent:workspace-snapshot', async (): Promise<WorkspaceSnapshot> => {
    // LKM-196: an idle chat never opens parked with nothing to land.
    await reconcileIdleParks(
      (key) => runningKeys.has(key) || preparingTurns.has(key) || landingInFlight(key)
    )
    const owned = new Map(
      (
        await conversation()
          .snapshot()
          .catch(() => ({ chats: [] }))
      ).chats.map((chat) => [chat.chat, chat])
    )
    const byProject = new Map<string, LiveProjectSnapshot>()
    const project = (pKey: string, root: string): LiveProjectSnapshot => {
      let proj = byProject.get(pKey)
      if (!proj) {
        proj = {
          projectKey: pKey,
          root,
          chats: [],
          activeSessionKey: activeSessionKeyByProject.get(pKey) ?? null
        }
        byProject.set(pKey, proj)
      }
      return proj
    }
    for (const [sessionKey, s] of sessions) {
      const proj = project(s.record.projectKey, s.record.projectRoot)
      const chat = owned.get(sessionKey)
      proj.chats.push({
        sessionKey,
        record: s.record,
        isRunning: chat ? chat.phase !== 'idle' : runningKeys.has(sessionKey),
        turn: chat?.turn ?? null,
        isolation: isolationSnapshot(sessionKey),
        // The posture this chat is really running under (updated in place by
        // set-model / set-permission-mode) — the renderer repoints its pickers at
        // it on reattach rather than trusting its own persisted copy.
        options: { ...s.options }
      })
    }
    // LKM-182: a chat still being prepared is shown empty and idle.
    for (const chat of pending.list()) {
      if (sessions.has(chat.sessionKey)) continue
      project(chat.projectKey, chat.root).chats.push({
        sessionKey: chat.sessionKey,
        record: {
          id: '',
          projectKey: chat.projectKey,
          projectRoot: chat.root,
          projectName: basename(chat.root),
          startedAt: chat.createdAt,
          endedAt: null,
          filesTouched: [],
          transcript: []
        },
        isRunning: false,
        turn: null,
        options: { ...chat.options }
      })
    }
    const activeRoot =
      (activeKey &&
        (sessions.get(activeKey)?.record.projectRoot ??
          pending.list().find((chat) => chat.sessionKey === activeKey)?.root)) ||
      null
    return { projects: [...byProject.values()], activeRoot }
  })

  // The owner's turn for a chat this process no longer runs: end it so the chat takes
  // the next message. Safe when the owner already moved on (a stale turn changes nothing).
  const releaseOwnerTurn = async (key: string): Promise<boolean> => {
    const turn = turnIds.get(key)
    if (!turn) return false
    const aborted = await conversation()
      .abort(key, turn)
      .catch(() => false)
    const landed = await conversation()
      .landed(key, turn, Date.now())
      .then((result) => result.landed)
      .catch(() => false)
    return aborted || landed
  }
  // A chat that shows running with nothing in flight: no provider turn, no landing, and
  // no progress for `quietMs`. Nothing will ever end its running state by itself.
  const staleChat = (sessionKey: string, quietMs: number): boolean => {
    const live = sessions.get(sessionKey)
    return (
      !!live &&
      runningKeys.has(sessionKey) &&
      !trackers.get(live)?.current &&
      !landingInFlight(sessionKey) &&
      watchdog.quietFor(sessionKey) >= quietMs
    )
  }
  // Both halves of the running state end together: this process's mirror and the owner's
  // phase. The chat is told in its own transcript and its UI leaves "running" (LKM-165).
  const settleChat = async (sessionKey: string, note: string): Promise<void> => {
    await releaseOwnerTurn(sessionKey)
    runningKeys.delete(sessionKey)
    preparingTurns.delete(sessionKey)
    watchdog.forget(sessionKey)
    const session = sessions.get(sessionKey)
    const turn = turnIds.get(sessionKey)
    session?.emit({ type: 'status', text: note })
    turnTimings.completed(sessionKey, turn)
    session?.emit({ type: 'landing-finished', ...(turn ? { turn } : {}) })
  }
  // A running chat with no progress for the limit: stop its provider turn and its
  // landing the way Stop does, then settle whatever those left behind.
  const endStuckTurns = async (): Promise<void> => {
    for (const sessionKey of watchdog.stuck([...runningKeys])) {
      if (!sessions.has(sessionKey)) continue
      await interruptChat(sessionKey).catch(() => {})
      if (runningKeys.has(sessionKey)) await settleChat(sessionKey, STUCK_NOTE)
    }
  }
  const stuckTimer = setInterval(() => void endStuckTurns(), WATCHDOG_INTERVAL_MS)
  stuckTimer.unref?.()
  app.on('before-quit', () => clearInterval(stuckTimer))
  ipcMain.handle('agent:interrupt', (_e, requestedKey?: string) => interruptChat(requestedKey))
  const interruptChat = async (requestedKey?: string): Promise<void> => {
    const sessionKey = requestedKey === undefined ? activeKey : requestedKey
    if (sessionKey) cancelProjectUi(sessionKey)
    // A landing in flight ends here: its work stays held (Retry) and the chat is free.
    if (sessionKey) abandonLanding(sessionKey, 'Stopped before the landing finished.')
    const preparation = sessionKey ? preparingTurns.get(sessionKey) : undefined
    if (preparation) preparation.cancelled = true
    // The owner marks the turn cancelled: it lands as failed and never continues.
    if (sessionKey)
      await conversation()
        .cancel(sessionKey)
        .catch(() => {})
    const session = sessionKey ? sessions.get(sessionKey) : undefined
    if (!session || !sessionKey) return // Release any open prompts (interrupt may not abort their per-call signal),
    // so cards don't orphan and the backend callbacks unblock.
    void conversation()
      .release(sessionKey)
      .catch(() => {})
    for (const id of [...session.pending.keys()]) resolvePending(session, id, 'deny')
    if (session.pendingQuestions)
      for (const id of [...session.pendingQuestions.keys()]) resolveQuestion(session, id, null)
    const root = session.root
    // A stop that lands after the turn already finished/aborted makes the SDK
    // throw "Operation aborted" — treat it as the no-op it is.
    //
    // The outer race is belt-and-braces for the whole seam: a backend is REQUIRED
    // to bound its own cancel, but if a future one forgets, this handler must still
    // resolve or the renderer's Stop sits on a promise that never settles and the
    // button reads as broken — which is exactly how the Claude deadlock presented.
    const outcome = await Promise.race([
      session.interrupt?.().catch(() => undefined) ?? Promise.resolve(undefined),
      new Promise<undefined>((r) => setTimeout(r, INTERRUPT_IPC_CAP_MS, undefined))
    ])
    // The backend killed its query to escape a wedge, so this session is dead:
    // rebuild the chat in place, or it would keep accepting messages into nothing.
    if (outcome && typeof outcome === 'object' && outcome.hardStopped) {
      await restartChatSession(root, sessionKey, session.options, 'restart')
    }
    // Stop on a chat that shows running with nothing in flight (no provider turn, no
    // landing, quiet for a while): settle it, so Stop is never a dead end (LKM-165).
    if (staleChat(sessionKey, STALE_STOP_MS)) await settleChat(sessionKey, STUCK_NOTE)
  }

  // Don't leave any backend subprocess running after trezi quits. Each chat is closed
  // through the owner (its record saved, its checkpoint dropped); `conversationsClosed`
  // lets the entry point wait for that. A chat the quit cuts short keeps its
  // checkpoint, which the next Swift launch recovers.
  app.on('before-quit', () => {
    const currentByProject = new Map(activeSessionKeyByProject)
    for (const sessionKey of sessions.keys()) {
      const project = sessions.get(sessionKey)?.record.projectKey
      if (project && !currentByProject.has(project)) currentByProject.set(project, sessionKey)
    }
    const closing: Promise<unknown>[] = []
    for (const [sessionKey, s] of sessions) {
      closing.push(
        closeChat(
          sessionKey,
          s,
          sessionKey === currentByProject.get(s.record.projectKey) ? 'current' : 'history'
        )
      )
    }
    sessions.clear()
    pending.cancelAll()
    memoryInjection.clear()
    runningKeys.clear()
    preparingTurns.clear()
    activeKey = null
    // v8 F1: stop any in-flight spawns' subprocesses, but LEAVE their checkouts on
    // disk — committing/removing here would race the process exit (work lost, or a
    // half-removed worktree). The next launch's pruneOrphans commits each dirty
    // leftover to its branch (recovering the work) and reclaims the checkout.
    for (const { session } of spawns.values()) closeSession(session)
    spawns.clear()
    queuedSpawns.clear()
    closing.push(store().flush())
    quitting = Promise.all(closing).then(() => {})
    // v9: forget chat-isolation state (mirror of spawns) — checkouts stay on disk for
    // the next launch's crash recovery, never committed/removed during the quit race.
    dropAll()
    dropSpares()
  })
}

/** Native smoke only: replace the provider's send while keeping the real agent:send
 * RPC, turn tracker and provider event hook. No subscription call is made. */
export function stubAgentSendForSmoke(chat: string, send: ProviderSession['send']) {
  if (!process.argv.includes('--test'))
    throw new Error('Provider stub is only available in native tests.')
  const session = sessions.get(chat)
  if (!session) throw new Error('Native smoke chat has no provider session.')
  const original = session.send
  session.send = send
  return {
    emit: (event: AgentEvent) => session.emit(event),
    restore: () => {
      session.send = original
    }
  }
}
