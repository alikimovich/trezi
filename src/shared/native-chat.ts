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
  /** Tokens this assistant turn's model calls reported (cached is part of input). */
  usage?: { input: number; output: number; cached: number }
}

export interface NativeChatCard {
  id: string
  title: string
  detail?: string
  /** The detail with full paths, for the tooltip and Copy, when `detail` is collapsed. */
  fullDetail?: string
  actions: { label: string; action: string; value?: string; disabled?: boolean }[]
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
export interface NativeChatState {
  activity: NativeChatActivity | null
  streamingId: string | null
  chat: string
  messages: NativeChatMessage[]
  running: boolean
  cards: NativeChatCard[]
  questions: QuestionRequest[]
  composer: {
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
