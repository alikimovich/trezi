import type { AgentEvent, AgentTurnOptions, QuestionRequest } from './api'
import type { ChatAgentSettings } from './chat-settings'
import type { NativeChatMessage, NativeChatState } from './native-chat'

/** Transitional shell context. No transcript, draft, queue or streaming state enters here. */
export interface NativeChatContext {
  chat: string
  root: string | null
  selection: {
    label: string
    prompt: string
    bubble: NonNullable<NativeChatMessage['selection']>
  } | null
  turn: AgentTurnOptions
  /** `failed`: the last Set up failed; `status` holds its reason and the card offers a retry. */
  /** `lost` (LKM-157): a connected project stopped stamping, so the card offers Reconnect. */
  setup: {
    needed: boolean
    dismissed: boolean
    status: string | null
    failed?: boolean
    lost?: boolean
  }
  tokens: { needed: boolean; dismissed: boolean }
  notes: { id: string; text: string }[]
  spawns: NativeSpawn[]
}
/** A background agent of the chat. `label` is its whole request; `question` the one it
 *  waits on (LKM-193), answered on its card. */
export interface NativeSpawn {
  id: string
  label: string
  status: string
  activity?: string
  question?: QuestionRequest
}
export interface NativeChatLayout {
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
}
export interface NativeChatMirror {
  chat: string
  messages: (NativeChatMessage & { statuses: string[] })[]
  isRunning: boolean
  streamingId: string | null
  title?: string
  isolation: 'live' | 'isolated' | 'parked'
  isolationFiles?: string[]
  usage: { input: number; output: number; cached: number }
  workedMs: number
  turnStartedAt: number | null
  needsReview: boolean
}
export type NativeChatEffect =
  | { type: 'spawn'; event: AgentEvent }
  | { type: 'mirror'; state: NativeChatMirror }
  | { type: 'settings'; chat: string; root: string; settings: ChatAgentSettings }
  | { type: 'selection-clear'; chat: string; prompt?: string }
  | {
      type: 'setup'
      chat: string
      phase: 'configuring' | 'landed' | 'failed' | 'dismissed'
      status?: string
    }
  | { type: 'tokens'; root: string }
  | { type: 'notes'; root: string }
  /** Show a `file:line[:column]` of the active project in the editor (LKM-193). */
  | { type: 'source'; source: string }
  | { type: 'layers' | 'focus' | 'history' }
export type NativeChatCommand =
  | { type: 'attach' }
  | { type: 'context'; context: NativeChatContext }
  | { type: 'layout'; layout: NativeChatLayout }
  | { type: 'seed' | 'submit'; chat: string; text: string }
export type NativeChatSnapshot = NativeChatState & NativeChatLayout

declare global {
  interface Window {
    treziNativeContext?: { selection(value: import('./api').SelectedElement | null): void }
  }
}
