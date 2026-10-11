import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { AgentOptions, SessionRecord, SessionTranscriptEntry } from '../shared/api'
import type { ChatAgentSettings } from '../shared/chat-settings'
import {
  type ChatUiAnswer,
  type ChatUiRecord,
  chatUiAnswerProblems,
  chatUiAnswerText
} from '../shared/chat-ui'
import { projectKey } from '../shared/projectKey'
import type { ConversationOwner } from './conversation-owner'
import type { SessionStore } from './sessions-store'

/** Tool-free project planning. Only the conversation owner writes the record; the
 * workflow owner is called after an explicit destination confirmation in the chat. */
export const PLANNING_PROJECT = '__trezi_new_project__'
const MAX_TEXT = 32_000
const MAX_REPLY = 12_000

export interface ProjectPlan {
  name: string
  stack: string
  template: 'react' | 'empty'
  destination: string
}
interface PlanningRecord extends SessionRecord {
  planning?: {
    options?: AgentOptions
    settings?: ChatAgentSettings
    plan?: ProjectPlan
    confirmation?: { id: string; name: string; destination: string; stack: string }
    attemptedDestination?: string
    lastTurn?: string
    completedTurn?: string
  }
}
export interface PlanningResult {
  record: PlanningRecord
  createdRoot?: string
  error?: string
}
export interface PlanningDependencies {
  owner: Pick<ConversationOwner, 'save' | 'remove'>
  store: Pick<SessionStore, 'current' | 'get'>
  complete: (prompt: string, options: AgentOptions, signal: AbortSignal) => Promise<string | null>
  create: (
    root: string,
    template: 'react' | 'empty'
  ) => Promise<{ ok: boolean; root?: string; error?: string }>
}
export interface PlanningAttachment {
  name: string
  type: string
  data: string
}

function entry(role: SessionTranscriptEntry['role'], text: string): SessionTranscriptEntry {
  return { role, text: text.slice(0, MAX_TEXT), at: Date.now() }
}
function safeName(value: string): string {
  const name = value.trim().replace(/[/\\]/g, '-').replace(/\s+/g, ' ').slice(0, 80)
  if (!name || name === '.' || name === '..') throw new Error('Choose a project name.')
  return name
}
function defaultDestination(name: string) {
  return join(homedir(), 'Projects', name.replace(/\s+/g, '-'))
}
function parseReply(text: string): {
  reply: string
  plan?: { name: string; stack: string; template?: string }
  choices?: string[]
} {
  try {
    const first = text.indexOf('{'),
      last = text.lastIndexOf('}')
    const value = JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>
    const plan =
      value.plan && typeof value.plan === 'object' ? (value.plan as Record<string, unknown>) : null
    return {
      reply:
        typeof value.reply === 'string'
          ? value.reply.slice(0, MAX_REPLY)
          : text.slice(0, MAX_REPLY),
      ...(plan && typeof plan.name === 'string' && typeof plan.stack === 'string'
        ? {
            plan: {
              name: plan.name,
              stack: plan.stack,
              template: typeof plan.template === 'string' ? plan.template : undefined
            }
          }
        : {}),
      ...(Array.isArray(value.choices)
        ? {
            choices: value.choices
              .filter((v): v is string => typeof v === 'string' && !!v.trim())
              .map((v) => v.trim().slice(0, 60))
              .slice(0, 3)
          }
        : {})
    }
  } catch {
    return { reply: text.slice(0, MAX_REPLY) }
  }
}

function promptFor(record: PlanningRecord): string {
  const history = record.transcript.filter((item) => item.role !== 'status').slice(-16)
  return `You are helping a person plan a new software project in Trezi. You have no file tools and no project directory exists. Read the conversation and ask only for information actually missing. A complete brief may need no questions. If the person has no stack preference or asks for help choosing, recommend a sensible stack with one short reason; never require a technical choice. When you know what to build and a sensible name, propose a plan. Never claim files were created. Respond as JSON only: {"reply":"one conversational message","choices":["optional quick answer",...],"plan":{"name":"short folder-safe project name","stack":"stack and why","template":"react or empty"}}. Omit plan until the brief is sufficient. Use react for a React/Vite starter, empty for any other stack. Do not choose a filesystem path; Trezi shows the destination separately. The user can answer in free text.\n\nConversation:\n${history
    .map(
      (item) =>
        `${item.role}: ${item.text}${
          item.planningAttachments
            ?.map(
              (a) =>
                ` [attached ${a.name}: ${a.type === 'text/plain' ? Buffer.from(a.data, 'base64').toString('utf8').slice(0, 4000) : a.type}]`
            )
            .join('') ?? ''
        }`
    )
    .join('\n')
    .slice(-MAX_TEXT)}`
}

function optionsCard(title: string, options: string[]): ChatUiRecord {
  return {
    id: randomUUID(),
    at: Date.now(),
    images: {},
    component: {
      kind: 'options',
      title,
      options: options.map((label, index) => ({
        id: String(index),
        title: label,
        note: 'Choose this direction'
      }))
    }
  }
}
function planCard(plan: ProjectPlan): ChatUiRecord {
  return {
    id: randomUUID(),
    at: Date.now(),
    images: {},
    component: {
      kind: 'form',
      title: 'Create this project',
      prompt:
        'Review the plan and destination. Nothing is written until you choose Create project.',
      submitLabel: 'Create project',
      fields: [
        { id: 'name', label: 'Project name', type: 'text', default: plan.name },
        { id: 'destination', label: 'Destination', type: 'text', default: plan.destination },
        { id: 'stack', label: 'Stack', type: 'text', default: plan.stack }
      ]
    }
  }
}

export class ProjectPlanning {
  private inflight = new Map<string, Promise<PlanningResult>>()
  private controllers = new Map<string, AbortController>()
  constructor(private readonly deps: PlanningDependencies) {}

  resume(): PlanningRecord | null {
    return this.deps.store.current(PLANNING_PROJECT) as PlanningRecord | null
  }
  async start(settings: ChatAgentSettings): Promise<PlanningRecord> {
    const current = this.resume()
    if (current) return current
    const id = randomUUID()
    const record: PlanningRecord = {
      id,
      projectKey: PLANNING_PROJECT,
      projectRoot: '',
      projectName: 'New Project',
      startedAt: Date.now(),
      endedAt: null,
      filesTouched: [],
      transcript: [],
      slot: 'current',
      planning: { settings }
    }
    await this.deps.owner.save(record, true)
    return record
  }
  async cancel(id: string) {
    this.controllers.get(id)?.abort()
    const record = this.resume()
    if (record?.id !== id) return false
    await this.deps.owner.remove(id)
    return true
  }
  stop(id: string) {
    const controller = this.controllers.get(id)
    controller?.abort()
    return !!controller
  }
  async options(id: string, settings: ChatAgentSettings) {
    const record = this.resume()
    if (!record || record.id !== id) return false
    record.planning ??= {}
    record.planning.settings = settings
    await this.deps.owner.save(record, true)
    return true
  }
  async answer(id: string, card: string, answer: ChatUiAnswer) {
    const record = this.resume()
    if (!record || record.id !== id) return { error: 'This planning chat is no longer active.' }
    const item = [...record.transcript].reverse().find((entry) => entry.ui?.id === card)
    if (!item?.ui) return { error: 'That question is no longer available.' }
    if (item.ui.answer) return { error: 'That question was already answered.' }
    const problems = chatUiAnswerProblems(item.ui.component, answer)
    if (problems.length) return { error: problems[0] }
    item.ui.answer = answer
    item.ui.answeredAt = Date.now()
    const message = chatUiAnswerText(item.ui)
    if (item.ui.component.kind === 'form' && 'values' in answer) {
      const values = answer.values
      if (
        typeof values.name !== 'string' ||
        typeof values.destination !== 'string' ||
        typeof values.stack !== 'string'
      )
        return { error: 'Review the name, destination and stack.' }
      record.planning ??= {}
      record.planning.confirmation = {
        id: card,
        name: values.name,
        destination: values.destination,
        stack: values.stack
      }
      if (record.planning.plan) {
        record.planning.plan.name = values.name
        record.planning.plan.destination = values.destination
        record.planning.plan.stack = values.stack
      }
    }
    await this.deps.owner.save(record, true)
    return { record: item.ui, message }
  }
  send(
    id: string,
    turn: string,
    text: string,
    options: AgentOptions,
    attachments: PlanningAttachment[] = []
  ): Promise<PlanningResult> {
    const key = `${id}:${turn}`
    const existing = this.inflight.get(key)
    if (existing) return existing
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const job = this.perform(id, turn, text, options, attachments, controller.signal)
    this.inflight.set(key, job)
    void job
      .finally(() => {
        if (this.inflight.get(key) === job) this.inflight.delete(key)
        if (this.controllers.get(id) === controller) this.controllers.delete(id)
      })
      .catch(() => {})
    return job
  }
  private async perform(
    id: string,
    turn: string,
    text: string,
    options: AgentOptions,
    attachments: PlanningAttachment[],
    signal: AbortSignal
  ): Promise<PlanningResult> {
    const record = this.resume()
    if (!record || record.id !== id) {
      const bound = this.deps.store.get(id) as PlanningRecord | null
      if (bound?.projectRoot && bound.planning === undefined)
        return { record: bound, createdRoot: bound.projectRoot }
      throw new Error('This planning chat is no longer active.')
    }
    if (record.planning?.completedTurn === turn) return { record }
    if ((!text.trim() && !attachments.length) || text.length > MAX_TEXT)
      throw new Error('Write a project request of up to 32,000 characters.')
    if (
      attachments.length > 8 ||
      attachments.some((a) => !a.name || a.name.length > 240 || a.data.length > 2_000_000)
    )
      throw new Error('Attach up to eight files smaller than 1.5 MB each.')
    record.planning ??= {}
    record.planning.options = options
    if (record.planning.lastTurn !== turn) {
      record.transcript.push({ ...entry('user', text.trim()), planningAttachments: attachments })
      record.planning.lastTurn = turn
      await this.deps.owner.save(record, true)
    }

    const confirmation = record.planning.confirmation
    if (confirmation) {
      record.planning.confirmation = undefined
      try {
        const name = safeName(confirmation.name)
        const destination = confirmation.destination.trim()
        if (!isAbsolute(destination) || resolve(destination) !== destination || destination === '/')
          throw new Error('Choose an absolute destination folder.')
        if (existsSync(destination) && record.planning.attemptedDestination !== destination)
          throw new Error(`${destination} already exists. Choose a different folder.`)
        record.planning.attemptedDestination = destination
        await this.deps.owner.save(record, true)
        const template = record.planning.plan?.template ?? 'react'
        const result = await this.deps.create(destination, template)
        if (!result.ok || !result.root) throw new Error(result.error || 'Could not create project.')
        const bound: PlanningRecord = {
          ...record,
          projectKey: projectKey(result.root),
          projectRoot: result.root,
          projectName: name,
          planning: undefined,
          planningCompleted: true
        }
        bound.transcript.push(
          entry(
            'assistant',
            `Created ${name} at ${result.root}. I’ll build the agreed plan here now.`
          )
        )
        await this.deps.owner.save(bound, true)
        return { record: bound, createdRoot: result.root }
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        record.transcript.push(entry('assistant', `${message} Edit the destination and try again.`))
        if (record.planning.plan)
          record.transcript.push({ ...entry('assistant', ''), ui: planCard(record.planning.plan) })
        record.planning.completedTurn = turn
        await this.deps.owner.save(record, true)
        return { record, error: message }
      }
    }

    const raw = await this.deps.complete(
      promptFor(record),
      options,
      AbortSignal.any([signal, AbortSignal.timeout(90_000)])
    )
    if (signal.aborted || this.resume()?.id !== id) throw new Error('Planning was stopped.')
    if (!raw) {
      const error = 'The provider could not answer. Your request is saved; choose Retry.'
      record.transcript.push(entry('assistant', error))
      record.planning.completedTurn = turn
      await this.deps.owner.save(record, true)
      return { record, error }
    }
    const answer = parseReply(raw)
    record.transcript.push(entry('assistant', answer.reply))
    if (answer.plan) {
      try {
        const name = safeName(answer.plan.name)
        const plan: ProjectPlan = {
          name,
          stack: answer.plan.stack.slice(0, 200),
          template: answer.plan.template === 'empty' ? 'empty' : 'react',
          destination: defaultDestination(name)
        }
        record.planning.plan = plan
        record.transcript.push({
          ...entry(
            'assistant',
            `Plan: ${plan.name} using ${plan.stack}. Destination: ${plan.destination}`
          ),
          ui: planCard(plan)
        })
      } catch {
        /* The assistant's invalid name becomes another conversational question. */
      }
    } else if (answer.choices && answer.choices.length >= 2) {
      record.transcript.push({
        ...entry('assistant', ''),
        ui: optionsCard('A few starting points', answer.choices)
      })
    }
    const result = { record }
    record.planning.completedTurn = turn
    await this.deps.owner.save(record, true)
    return result
  }
}
