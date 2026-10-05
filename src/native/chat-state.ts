import type {
  AgentEvent,
  PermissionRequest,
  QuestionRequest,
  SessionTranscriptEntry,
  SlashCommandItem
} from '../shared/api'
import { type ChatAgentSettings, defaultChatAgentSettings } from '../shared/chat-settings'
import { migrateChatTitle } from '../shared/chat-title'
import type { NativeChatContext, NativeChatMirror } from '../shared/native-chat-controller'
import { emptyUsage, type TokenUsage } from '../shared/run-stats'
import type { ChatLogin } from './chat-login'

export interface Attachment {
  id: string
  name: string
  path: string
  type: string
  data: string
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
  /** The turn this chat last sent (the owner's turn id); terminal events of any other are late. */
  turn?: string
  /** The message that turn sent, for the login card's Retry. */
  last?: Submission
  /** The provider login card (`chat-login.ts`), from an `error` with a code. */
  login?: ChatLogin
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
  /** LKM-151: the files and undo group of the last turn that landed on the live tree. */
  landed?: { files: string[]; group?: string }
  /** LKM-151: a dev-server compile/parse error in a file the last turn touched. */
  previewError?: { file: string; message: string }
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
      append(chat, entry.text, entry.role === 'status', entry.at)
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
      } else append(chat, `\n\n⚠️ ${event.message}`)
      chat.paused = true
      finish(chat)
      break
    case 'done':
      finish(chat, event.landingPending)
      break
    case 'landing-finished':
      finish(chat)
      break
    case 'reconciliation-started':
      chat.isolation = 'isolated'
      chat.isRunning = true
      chat.phase = 'applying'
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
      if (event.state === 'merged' && event.group && event.revertable !== false && last)
        last.revertGroup = event.group
      if (event.state === 'merged')
        chat.landed = {
          files: event.files ?? [],
          group: event.revertable === false ? undefined : event.group
        }
      // A stopped turn's message keeps its hover Revert: it drops the held work.
      if (chat.stopped === 'held' && last) last.revertGroup = `${STOPPED_GROUP}${chat.chat}`
      if (event.state === 'parked') chat.paused = true
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
