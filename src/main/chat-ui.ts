import { randomUUID } from 'node:crypto'
import { CHAT_UI_LIMITS, chatUiCatalog, chatUiComponentSchema } from '../../bin/chat-ui-schema.mjs'
import type { AgentEvent } from '../shared/api'
import {
  type ChatUiAnswer,
  type ChatUiComponentInput,
  type ChatUiRecord,
  chatUiAnswerProblems,
  chatUiAnswerText,
  chatUiSummary
} from '../shared/chat-ui'
import { captureChatUiImage } from './chat-ui-capture'

/**
 * LKM-208: the agent's `chat_ui` tool (catalog, show, update) and the answers the user
 * gives in it. A component lives in the assistant message that showed it; the
 * conversation owns it as a transcript status entry carrying `ui` (the host hook below,
 * installed by `agent.ts`). Answers become the user's next message and a summary in the
 * next turn's context (`chatUiContext`).
 */
export interface ChatUiHost {
  /** Save the record into the chat's transcript (add its entry, or replace its `ui`). */
  persist: (chat: string, record: ChatUiRecord) => void
  /** A record from the chat's transcript (a resumed chat's component). */
  find: (chat: string, id: string) => ChatUiRecord | undefined
}

interface Scope {
  emitKey: string
  background: boolean
  notify: (channel: string, payload: unknown) => void
}

let host: ChatUiHost | null = null
export function setChatUiHost(next: ChatUiHost | null) {
  host = next
}

const records = new Map<string, Map<string, ChatUiRecord>>()
/** The summary each record last reported to the agent, so a turn repeats nothing. */
const reported = new Map<string, string>()

function chatRecords(chat: string) {
  const map = records.get(chat) ?? new Map<string, ChatUiRecord>()
  records.set(chat, map)
  return map
}

function lookup(chat: string, id: string) {
  const found = records.get(chat)?.get(id) ?? host?.find(chat, id)
  if (found) chatRecords(chat).set(id, found)
  return found
}

/** Every problem of a component, as `path: message` lines; [] when it is valid. */
export function chatUiProblems(component: unknown): string[] {
  const parsed = chatUiComponentSchema.safeParse(component)
  if (parsed.success) return []
  return parsed.error.issues.map(
    (issue) => `${issue.path.length ? issue.path.join('.') : 'component'}: ${issue.message}`
  )
}

function invalid(problems: string[], verb: string) {
  return {
    error: `The component is invalid; nothing was ${verb}. Fix every problem and call again: ${problems.join(' | ')}`,
    code: 'invalid_component',
    problems
  }
}

/** The component as shown: capture requests are instructions, not content. */
function stored(component: ChatUiComponentInput): ChatUiComponentInput {
  if (component.kind !== 'options') return component
  return { ...component, options: component.options.map(({ capture: _, ...option }) => option) }
}

function publish(chat: string, record: ChatUiRecord, scope: Pick<Scope, 'notify'>) {
  chatRecords(chat).set(record.id, record)
  host?.persist(chat, record)
  // A copy: later captures must reach the chat as events, not as shared mutations.
  scope.notify('agent:event', {
    type: 'chat-ui',
    projectKey: chat,
    ui: { ...record }
  } satisfies AgentEvent)
}

async function captureAll(
  chat: string,
  record: ChatUiRecord,
  component: ChatUiComponentInput,
  scope: Scope
) {
  if (component.kind !== 'options') return
  for (const option of component.options) {
    if (!option.capture) continue
    await capture(record, option.id, option.capture)
    publish(chat, record, scope)
  }
}

async function capture(record: ChatUiRecord, option: string, request: true | { selector: string }) {
  const result = await captureChatUiImage(request).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error)
  }))
  const missing = { ...record.missing }
  if ('error' in result) {
    missing[option] = result.error
    record.missing = missing
    return result.error
  }
  delete missing[option]
  record.missing = Object.keys(missing).length ? missing : undefined
  record.images = { ...record.images, [option]: result }
  return null
}

function answer(record: ChatUiRecord) {
  return {
    id: record.id,
    kind: record.component.kind,
    images: Object.keys(record.images),
    ...(record.missing ? { missing: record.missing } : {})
  }
}

const GUIDANCE =
  'The component is on screen in this message. Add or replace option images with update {id, option, capture} after showing each variant in the preview. Then end your turn now and wait: the user’s pick or form values arrive as their next message.'

export async function chatUiTool(raw: any, scope: Scope): Promise<unknown> {
  const action = raw?.action
  if (action === 'catalog')
    return {
      version: 1,
      actions: ['catalog', 'show', 'update'],
      components: chatUiCatalog,
      limits: CHAT_UI_LIMITS
    }
  if (scope.background)
    return {
      error: 'Background edits cannot show answer components; they have no chat to answer in.'
    }
  const chat = scope.emitKey
  if (action === 'show') {
    const problems = chatUiProblems(raw?.component)
    if (problems.length) return invalid(problems, 'shown')
    const component = chatUiComponentSchema.parse(raw.component)
    const record: ChatUiRecord = {
      id: `ui-${randomUUID().slice(0, 8)}`,
      component: stored(component),
      images: {},
      at: Date.now()
    }
    publish(chat, record, scope)
    await captureAll(chat, record, component, scope)
    return { shown: true, ...answer(record), guidance: GUIDANCE }
  }
  if (action !== 'update') return { error: 'Unknown chat_ui action: use catalog, show or update.' }
  const record = typeof raw?.id === 'string' ? lookup(chat, raw.id) : undefined
  if (!record) return { error: `No chat_ui component ${JSON.stringify(raw?.id)} in this chat.` }
  if (record.answer)
    return { error: 'The user already answered this component; show a new one instead.' }
  if (raw.component !== undefined) {
    const problems = chatUiProblems(raw.component)
    if (problems.length) return invalid(problems, 'updated')
    const component = chatUiComponentSchema.parse(raw.component)
    if (component.kind !== record.component.kind)
      return {
        error: `Component ${record.id} is ${record.component.kind}; show a new one to change the kind.`
      }
    const kept =
      component.kind === 'options' ? new Set(component.options.map((o) => o.id)) : new Set()
    record.component = stored(component)
    record.images = Object.fromEntries(Object.entries(record.images).filter(([id]) => kept.has(id)))
    publish(chat, record, scope)
    await captureAll(chat, record, component, scope)
  }
  if (raw.option !== undefined) {
    const options = record.component.kind === 'options' ? record.component.options : []
    if (!options.some((o) => o.id === raw.option))
      return { error: `Component ${record.id} has no option ${JSON.stringify(raw.option)}.` }
    const error = await capture(record, raw.option, raw.capture ?? true)
    publish(chat, record, scope)
    if (error) return { error: `No image for option ${raw.option}: ${error}`, ...answer(record) }
  }
  return { updated: true, ...answer(record), guidance: GUIDANCE }
}

/**
 * The user's pick or form values: checked against the component, saved with it, and
 * returned as the user's next message. A component is answered once.
 */
export function answerChatUi(
  chat: string,
  id: string,
  given: unknown
): { record: ChatUiRecord; message: string } | { error: string } {
  const record = lookup(chat, id)
  if (!record) return { error: 'This component is no longer available.' }
  if (record.answer) return { error: 'This component was already answered.' }
  const problems = chatUiAnswerProblems(record.component, given)
  if (problems.length) return { error: problems.join(' ') }
  record.answer = given as ChatUiAnswer
  record.answeredAt = Date.now()
  chatRecords(chat).set(id, record)
  host?.persist(chat, record)
  return { record, message: chatUiAnswerText(record) }
}

/** The state of this chat's components that changed since the agent last heard of it. */
export function chatUiContext(chat: string): string {
  const lines: string[] = []
  for (const record of records.get(chat)?.values() ?? []) {
    if (!record.answer) continue
    const summary = chatUiSummary(record)
    const key = `${chat}\n${record.id}`
    if (reported.get(key) === summary) continue
    reported.set(key, summary)
    lines.push(`- ${summary}`)
  }
  return lines.length ? `Answer components in this chat (chat_ui):\n${lines.join('\n')}\n\n` : ''
}

/** A closed chat's components leave memory; the transcript keeps them. */
export function forgetChatUi(chat: string) {
  for (const id of records.get(chat)?.keys() ?? []) reported.delete(`${chat}\n${id}`)
  records.delete(chat)
}
