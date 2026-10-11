import { classifyError, incidentDetail } from '../main/self-heal/catalog'
import type {
  AgentEvent,
  DependencyIssue,
  PermissionRequest,
  QuestionRequest,
  SessionTranscriptEntry,
  SlashCommandItem
} from '../shared/api'
import { type ChatAgentSettings, defaultChatAgentSettings } from '../shared/chat-settings'
import { migrateChatTitle } from '../shared/chat-title'
import type { ChatUiRecord } from '../shared/chat-ui'
import type { NativeLiveChange } from '../shared/native-chat'
import type { NativeChatContext, NativeChatMirror } from '../shared/native-chat-controller'
import type { BuiltinProvider } from '../shared/provider-readiness'
import { emptyUsage, type TokenUsage } from '../shared/run-stats'
import type { ChatLogin } from './chat-login'

export interface Attachment {
  id: string
  name: string
  path: string
  type: string
  data: string
  /** Base64 PNG (about 512 px) standing in for an image the provider cannot read, such as an SVG. */
  preview?: string
}
export interface Submission {
  id: string
  text: string
  attachments: Attachment[]
  selection: NativeChatContext['selection']
  turn: NativeChatContext['turn']
}
export interface Chat extends NativeChatMirror {
  phase: 'thinking' | 'writing' | 'working' | 'applying'
  activityDetail: string
  stopping: boolean
  root: string
  ready: boolean
  version: number
  text: string
  caret: number
  revision: number
  attachments: Attachment[]
  commands: SlashCommandItem[]
  menuIndex: number
  dismissed: boolean
  settings: ChatAgentSettings
  pendingModel?: ChatAgentSettings
  switching: boolean
  error?: string
  queue: Submission[]
  paused: boolean
  sending: boolean
  cancellation: number
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  setup: boolean
  awaitingLanding: boolean
  context?: NativeChatContext
  /** LKM-169: the selection of a queued message moved back into the composer by Edit;
   *  the next send uses it when the shell has no newer one. */
  draftSelection?: NativeChatContext['selection']
  /** LKM-181: islands added by Copy reference (`#island-shadow-2`), shown as chips. */
  references?: string[]
  /** The turn this chat last sent (the owner's turn id); terminal events of any other are late. */
  turn?: string
  /** The message that turn sent, for the login card's Retry. */
  last?: Submission
  /** The provider login card (`chat-login.ts`), from an `error` with a code. */
  login?: ChatLogin
  signingIn?: BuiltinProvider
  signInMessage?: string
  /** This turn's usage reported before its response exists (`assistant` attaches it). */
  pendingUsage?: TokenUsage
  /** LKM-147: when the current step (thinking, writing, a tool) began, and when the
   *  running turn last produced an event or heartbeat (epoch ms). */
  stepAt: number
  aliveAt: number
  /** A `progress` event's step ("Still thinking…"): shown until output or a tool status. */
  progressStep?: string
  /** LKM-151: a stopped turn's work is on hold ('held', live never had it) or the user
   *  reverted it ('reverted', undoable until the next turn starts). */
  stopped?: 'held' | 'reverted'
  /** LKM-225: the automatic Resolve of a drift park ran once ('tried'), then gave up ('failed'). */
  autoResolved?: 'tried' | 'failed'
  /** LKM-165: why the last landing failed; its work is held until Retry or Resolve. */
  landingError?: string
  /** LKM-151: the files and undo group of the last turn that landed on the live tree. */
  landed?: { files: string[]; group?: string }
  /** LKM-151: a dev-server compile/parse error in a file the last turn touched. */
  previewError?: { file: string; message: string }
  /** LKM-194: why the checkout's dependencies are not installed, from the turn start. */
  dependencies?: DependencyIssue
  /** LKM-164: the model the session reported running (`claude-opus-5-5`); cleared when
   *  the chat switches model, so it never names the previous one. */
  resolvedModel?: string
  /** LKM-165: what runs while the phase is 'applying', named in the activity row.
   *  'waiting' is a turn the backend still holds that this chat did not start. */
  operation?: 'landing' | 'parking' | 'resolving' | 'waiting'
  /** LKM-215: a turn's outside-change row, held until the turn (and its landing) ends. */
  pendingLiveChange?: NativeLiveChange
  /** Spawned comment agents' reports that arrived while the turn ran; each is a row. */
  pendingSpawnLiveChanges?: NativeLiveChange[]
}
/** The hover Revert of a stopped turn's message: routes to the held-work revert. */
export const STOPPED_GROUP = 'stopped:'
export function newChat(chat: string): Chat {
  return {
    phase: 'thinking',
    activityDetail: '',
    stopping: false,
    chat,
    root: '',
    ready: false,
    version: 0,
    messages: [],
    isRunning: false,
    streamingId: null,
    isolation: 'live',
    usage: { input: 0, output: 0, cached: 0 },
    workedMs: 0,
    turnStartedAt: null,
    needsReview: false,
    text: '',
    caret: 0,
    revision: 0,
    attachments: [],
    commands: [],
    menuIndex: 0,
    dismissed: false,
    settings: defaultChatAgentSettings(),
    switching: false,
    queue: [],
    paused: false,
    sending: false,
    cancellation: 0,
    permissions: [],
    questions: [],
    setup: false,
    awaitingLanding: false,
    stepAt: 0,
    aliveAt: 0
  }
}
/** A turn starts thinking: its step timer and liveness start now. */
export function begin(chat: Chat, now = Date.now()) {
  chat.phase = 'thinking'
  chat.operation = undefined
  chat.activityDetail = ''
  chat.progressStep = undefined
  chat.stepAt = now
  chat.aliveAt = now
}
export function assistant(chat: Chat) {
  let message = chat.messages.find((message) => message.id === chat.streamingId)
  if (!message) {
    message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      at: Date.now(),
      text: '',
      segments: [],
      statuses: []
    }
    if (chat.pendingUsage) {
      message.usage = chat.pendingUsage
      chat.pendingUsage = undefined
    }
    chat.messages.push(message)
    chat.streamingId = message.id
  }
  return message
}
export function append(chat: Chat, text: string, status = false, at = Date.now()) {
  const message = assistant(chat)
  const last = message.segments.at(-1)
  if (status) {
    message.statuses.push(text)
    if (last?.kind === 'tools') last.statuses.push(text)
    else message.segments.push({ kind: 'tools', statuses: [text] })
  } else {
    message.text += text
    if (last?.kind === 'text') last.text += text
    else message.segments.push({ kind: 'text', text, at })
  }
}
/** LKM-208: an answer component replaces its segment wherever it is, or joins the
 *  streaming message where the agent showed it. */
export function placeUi(chat: Chat, ui: ChatUiRecord) {
  for (const message of chat.messages)
    for (const [index, segment] of message.segments.entries())
      if (segment.kind === 'ui' && segment.ui.id === ui.id) {
        message.segments[index] = { kind: 'ui', ui }
        return
      }
  assistant(chat).segments.push({ kind: 'ui', ui })
}
export function hydrate(chat: Chat, transcript: SessionTranscriptEntry[]) {
  chat.messages = []
  chat.streamingId = null
  let turn: SessionTranscriptEntry | undefined
  for (const entry of transcript) {
    if (entry.role === 'user') {
      turn = entry
      chat.streamingId = null
      chat.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        at: entry.at,
        text: entry.text,
        statuses: [],
        segments: [{ kind: 'text', text: entry.text, at: entry.at }]
      })
    } else {
      if (entry.ui) placeUi(chat, entry.ui)
      else append(chat, entry.text, entry.role === 'status', entry.at)
      const message = assistant(chat)
      message.at = message.segments.find((s) => s.kind === 'text')?.at ?? entry.at
      if (turn?.completedAt != null) message.workedMs = Math.max(0, turn.completedAt - turn.at)
    }
  }
  if (!chat.isRunning) chat.streamingId = null
  else if (turn && turn.completedAt == null) chat.turnStartedAt = turn.at
}
export function finish(chat: Chat, landing = false) {
  chat.isRunning = landing
  chat.phase = landing ? 'applying' : 'thinking'
  chat.operation = landing ? 'landing' : undefined
  chat.activityDetail = ''
  if (!landing) chat.stopping = false
  if (!landing) {
    // Usage with no response to show it on stays in the chat total only.
    chat.pendingUsage = undefined
    if (chat.turnStartedAt != null) {
      const elapsed = Math.max(0, Date.now() - chat.turnStartedAt)
      chat.workedMs += elapsed
      const message = chat.messages.find((m) => m.id === chat.streamingId)
      if (message) message.workedMs = elapsed
    }
    chat.turnStartedAt = null
    chat.streamingId = null
    placeLiveChange(chat)
  }
}
/** LKM-215: the outside-change row goes under the finished turn's reply, after its
 *  landing tagged that reply (Revert), never inside a running turn. */
function placeLiveChange(chat: Chat) {
  const changes = [chat.pendingLiveChange, ...(chat.pendingSpawnLiveChanges ?? [])]
  chat.pendingLiveChange = undefined
  chat.pendingSpawnLiveChanges = undefined
  for (const change of changes) {
    if (!change) continue
    const text = `${change.line}\n\n${change.detail}`
    chat.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      at: Date.now(),
      text,
      statuses: [],
      segments: [{ kind: 'text', text }],
      liveChange: change
    })
  }
}
/** A terminal event that cannot belong to the turn this chat is running (S11). */
export function late(chat: Chat, event: AgentEvent) {
  if (!['done', 'error', 'landing-finished', 'reconciliation-started'].includes(event.type))
    return false
  if (event.type === 'done' && event.stale) return true
  return !!(event.turn && chat.turn && event.turn !== chat.turn)
}
export function reduce(chat: Chat, event: AgentEvent, now = Date.now()) {
  chat.version++
  if (chat.isRunning) chat.aliveAt = now
  switch (event.type) {
    case 'delta':
      if (chat.phase !== 'writing') chat.stepAt = now
      chat.phase = 'writing'
      chat.activityDetail = ''
      chat.progressStep = undefined
      append(chat, event.text)
      break
    case 'status':
      chat.stepAt = now
      chat.progressStep = undefined
      chat.phase = 'working'
      chat.activityDetail = event.text
      append(chat, event.text, true)
      break
    // Liveness only: the step it names replaces the label (its timer keeps running),
    // and nothing enters the transcript, so there is one status line (LKM-147).
    case 'progress':
      if (event.step) chat.progressStep = event.step
      break
    case 'title':
      chat.title = migrateChatTitle(event.title)
      break
    case 'commands':
      chat.commands = event.commands
      break
    case 'model':
      chat.resolvedModel = event.model
      break
    case 'usage': {
      // The chat total, and the running turn's own count on its response (a
      // late report after `done` belongs to the last response). Usage that
      // arrives before the response exists waits in `pendingUsage`: it never
      // creates an empty message that could outlive a turn without output.
      const message =
        chat.messages.find((m) => m.id === chat.streamingId) ??
        (chat.isRunning
          ? undefined
          : [...chat.messages].reverse().find((m) => m.role === 'assistant'))
      let turn = message ? message.usage : chat.pendingUsage
      if (!turn) {
        turn = emptyUsage()
        if (message) message.usage = turn
        else chat.pendingUsage = turn
      }
      for (const key of ['input', 'output', 'cached'] as const) {
        chat.usage[key] += event[key]
        turn[key] += event[key]
      }
      break
    }
    case 'error':
      if (event.code) {
        // Not signed in, or no answer: the login card, not a warning in the transcript.
        chat.login = { code: event.code, message: event.message }
        const message = chat.messages.find((m) => m.id === chat.streamingId)
        if (message && !message.text && !message.statuses.length)
          chat.messages = chat.messages.filter((m) => m !== message)
      } else {
        const incident = classifyError(event.message)
        const detail = incidentDetail(event.message)
        const lastUser = [...chat.messages].reverse().findIndex((m) => m.role === 'user')
        const turnMessages =
          lastUser < 0 ? chat.messages : chat.messages.slice(chat.messages.length - lastUser)
        const prior = [...turnMessages].reverse().find((m) => m.incident?.class === incident.class)
        if (prior?.incident) {
          if (!prior.incident.detail.includes(detail)) prior.incident.detail += `\n\n${detail}`
          prior.incident.line = incident.line
        } else {
          chat.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            at: now,
            text: incident.line,
            statuses: [],
            segments: [],
            incident: { class: incident.class, line: incident.line, detail }
          })
        }
      }
      chat.paused = true
      finish(chat)
      break
    case 'done':
      finish(chat, event.landingPending)
      break
    case 'landing-finished':
      finish(chat)
      break
    case 'dependencies':
      chat.dependencies = event.issue ?? undefined
      break
    case 'live-change':
      // One per turn: a later report for the same turn replaces a held one. Bun makes it
      // cumulative (a continuation run's report includes the earlier runs'), so nothing is lost.
      // A spawned comment agent's report is its own row, never the turn's: it would
      // replace the turn's held report, or the turn's later one replace it.
      if (event.spawn)
        chat.pendingSpawnLiveChanges = [
          ...(chat.pendingSpawnLiveChanges ?? []),
          { line: event.line, detail: event.detail, agent: event.agent }
        ]
      else chat.pendingLiveChange = { line: event.line, detail: event.detail, agent: event.agent }
      if (!chat.isRunning) placeLiveChange(chat)
      break
    case 'reconciliation-started':
      chat.isolation = 'isolated'
      chat.isRunning = true
      chat.phase = 'applying'
      chat.operation = 'resolving'
      append(chat, 'Combining this chat’s changes with recent project edits…', true)
      break
    case 'isolation': {
      chat.isolation = event.state === 'parked' ? 'parked' : 'isolated'
      chat.isolationFiles = event.files
      const last = [...chat.messages].reverse().find((message) => message.role === 'assistant')
      if (last?.revertGroup?.startsWith(STOPPED_GROUP)) last.revertGroup = undefined
      chat.stopped =
        event.reason === 'interrupted'
          ? 'held'
          : event.reason === 'reverted'
            ? 'reverted'
            : undefined
      chat.landingError =
        event.reason === 'failed' ? (event.error ?? 'The landing failed.') : undefined
      if (event.state === 'merged' && event.group && event.revertable !== false && last)
        last.revertGroup = event.group
      if (event.state === 'merged')
        chat.landed = {
          files: event.files ?? [],
          group: event.revertable === false ? undefined : event.group
        }
      // A stopped turn's message keeps its hover Revert: it drops the held work.
      if (chat.stopped === 'held' && last) last.revertGroup = `${STOPPED_GROUP}${chat.chat}`
      // A park waiting for Resolve blocks the queue by itself and releases it once it
      // clears (`chat-queue.ts`, LKM-169); a stopped or failed one pauses it.
      if (event.state === 'parked' && (chat.stopped || chat.landingError)) chat.paused = true
      if (event.state === 'parked' && chat.isRunning && chat.phase === 'applying')
        chat.operation = 'parking'
      break
    }
    case 'permission-request':
      chat.permissions = [
        ...chat.permissions.filter((p) => p.id !== event.request.id),
        event.request
      ]
      break
    case 'permission-resolved':
      chat.permissions = chat.permissions.filter((p) => p.id !== event.id)
      break
    case 'question-request':
      chat.questions = [...chat.questions.filter((q) => q.id !== event.request.id), event.request]
      break
    case 'question-resolved':
      chat.questions = chat.questions.filter((q) => q.id !== event.id)
      break
    case 'chat-ui':
      placeUi(chat, event.ui)
      break
  }
}
export function mirror(chat: Chat): NativeChatMirror {
  const {
    chat: key,
    messages,
    isRunning,
    streamingId,
    title,
    isolation,
    isolationFiles,
    usage,
    workedMs,
    turnStartedAt,
    needsReview
  } = chat
  return {
    chat: key,
    messages,
    isRunning,
    streamingId,
    title,
    isolation,
    isolationFiles,
    usage,
    workedMs,
    turnStartedAt,
    needsReview
  }
}
