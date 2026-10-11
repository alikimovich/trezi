import type { QuestionRequest } from './api'
export interface NativeChatMessage {
  at?: number
  workedMs?: number
  id: string
  role: 'user' | 'assistant'
  text: string
  // `labels`: the statuses' collapsed form (`display-path.ts`), added by the snapshot.
  segments: (
    | { kind: 'text'; text: string; at?: number }
    | { kind: 'tools'; statuses: string[]; labels?: string[] }
    | { kind: 'island'; island: import('./chat-islands').IslandView }
    /** LKM-208: an answer component (`chat_ui`) where the agent showed it. */
    | { kind: 'ui'; ui: import('./chat-ui').ChatUiRecord }
  )[]
  attachments?: {
    id: string
    kind?: 'image' | 'file'
    name?: string
    path?: string
    url?: string
  }[]
  selection?: { tag: string; ident: string; source: string | null }
  revertGroup?: string
  /** A comment agent's result (LKM-178): shown collapsed as "<title>: <line>", where
   *  `line` names the comment; `detail` (partial-changes note and summary) on expand. */
  comment?: { title: string; line: string; detail: string }
  /** A problem Trezi's own check of the preview found after a turn landed (LKM-195,
   *  LKM-210: a passing check adds no row), one compact warning row. */
  landingCheck?: NativeLandingCheck
  /** LKM-215: the live checkout changed outside this chat during the turn, one compact
   *  warning row with Details. */
  liveChange?: NativeLiveChange
  /** Tokens this assistant turn's model calls reported (cached is part of input). */
  usage?: { input: number; output: number; cached: number }
}

/** What the post-landing check found wrong (LKM-210): the page did not load, the dev
 *  server answered with an error, the preview serves another revision than the landed
 *  one, the page is blank, or console errors were logged since the landing. */
export type NativeLandingProblem = 'not-loaded' | 'server-error' | 'stale' | 'blank' | 'errors'
export interface NativeLandingCheck {
  problem: NativeLandingProblem
  /** The reason, one line ("2 new console errors after landing"). */
  line: string
  /** The first console errors or the dev server's message (page text, untrusted). */
  errors: string[]
}

/** What changed in the live checkout during a turn that Trezi did not do (LKM-215). */
export interface NativeLiveChange {
  /** One line: what changed, with repo-relative paths. */
  line: string
  /** Markdown shown under Details: the files, the commits and what they mean. */
  detail: string
  /** The agent's own commands named the live checkout; otherwise the user or a tool. */
  agent: boolean
}

export interface NativeChatCard {
  id: string
  title: string
  detail?: string
  /** The detail with full paths, for the tooltip and Copy, when `detail` is collapsed. */
  fullDetail?: string
  actions: { label: string; action: string; value?: string; disabled?: boolean }[]
  /** A background agent's card (LKM-193). */
  agent?: NativeAgentCard
}
export interface NativeAgentCard {
  status: 'queued' | 'running' | 'waiting'
  statusLabel: string
  /** The whole request, and its collapsed form cut at a word (equal when short). */
  request: string
  preview: string
  /** The file:line the request targets; Open shows it in the editor. */
  target?: { label: string; source: string }
  /** The question the agent waits on, shown and answered like a chat question. */
  question?: QuestionRequest
}
export interface NativeChatActivity {
  label: string
  /** The label with full paths, for the tooltip, when `label` is collapsed. */
  detail?: string
  kind: 'thinking' | 'writing' | 'working' | 'applying' | 'waiting' | 'stopping'
  animated: boolean
  /** Epoch ms the current step began: the host ticks "· m:ss" after the label (LKM-147). */
  since?: number
  /** Epoch ms of the turn's last event or heartbeat: the host shows "No activity for
   *  N min" once it is a minute old. Absent while the turn waits for the user. */
  aliveAt?: number
  /** The running turn's counter and its tooltip, on its own line under the status. */
  tokens?: { label: string; detail: string }
}
/** LKM-232: the centered start composer. Derived from the chat on every snapshot, never
 *  a one-shot flag: `centered` while a new chat is empty and a provider can answer.
 *  `home` is the no-project chat (key ''), whose draft waits for a destination. */
export interface NativeChatStart {
  centered: boolean
  home: boolean
  /** The selected provider can answer now; Send waits for it (the draft never does). */
  ready: boolean
  heading: string
  /** One line under the composer (a destination to choose, a lost provider, progress). */
  notice?: {
    text: string
    progress?: boolean
    actions: { label: string; action: string; value?: string; disabled?: boolean }[]
  }
  /** The composer's project menu: the chosen project (null: none yet) and recents. */
  project: { title: string | null; recents: { root: string; name: string }[] }
}
export interface NativeChatState {
  activity: NativeChatActivity | null
  streamingId: string | null
  chat: string
  messages: NativeChatMessage[]
  running: boolean
  cards: NativeChatCard[]
  questions: QuestionRequest[]
  start?: NativeChatStart
  composer: {
    /** The no-project draft (LKM-232): the composer takes input without a chat key. */
    home?: boolean
    queue: { id: string; text: string; attachments: number }[]
    queuePaused: boolean
    /** LKM-151: why a paused queue will not send on its own, and whether "Send now" can. */
    queueNote: string
    queueCanSend: boolean
    ready: boolean
    running: boolean
    thinking: boolean
    text: string
    caret: number
    revision: number
    stop: boolean
    enabled: boolean
    sendLabel: string
    context: string
    attachments: { id: string; name: string; type: string; data: string }[]
    suggestions: { title: string; description: string; active: boolean }[]
    /** LKM-181: island references (`#island-shadow-2`) added by Copy reference. */
    references: string[]
    choices: {
      label: string
      value: string
      disabled: boolean
      options: { value: string; label: string }[]
    }[]
  }
}
export type NativeChatAction = {
  chat: string
  action: string
  id?: string
  value?: string
  answers?: Record<string, string> | null
}
export interface NativeChatBridge {
  focusComposer: () => void
  command: (command: import('./native-chat-controller').NativeChatCommand) => void
  onEffect: (
    callback: (effect: import('./native-chat-controller').NativeChatEffect) => void
  ) => () => void
}
declare global {
  interface Window {
    treziNativeChat?: NativeChatBridge
  }
}
