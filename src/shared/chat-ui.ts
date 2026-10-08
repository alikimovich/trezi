/**
 * LKM-208: native answer components in chat (options, form). The schemas live in
 * `bin/chat-ui-schema.mjs`; these are the shapes every process shares and the pure text
 * of an answer (the user's visible turn) and its summary (the next turn's context).
 */

export interface ChatUiOption {
  id: string
  title: string
  note: string
  tags?: string[]
  capture?: true | { selector: string }
}

export type ChatUiField =
  | (ChatUiFieldBase & {
      type: 'choice'
      multiple?: boolean
      options: { value: string; label: string }[]
      default?: string | string[]
    })
  | (ChatUiFieldBase & {
      type: 'text'
      placeholder?: string
      multiline?: boolean
      default?: string
    })
  | (ChatUiFieldBase & {
      type: 'number'
      min?: number
      max?: number
      step?: number
      unit?: string
      default?: number
    })
  | (ChatUiFieldBase & {
      type: 'slider'
      min: number
      max: number
      step?: number
      unit?: string
      default?: number
    })
  | (ChatUiFieldBase & {
      type: 'color'
      suggestions?: { name: string; value: string }[]
      default?: string
    })
  | (ChatUiFieldBase & { type: 'toggle'; default?: boolean })

interface ChatUiFieldBase {
  id: string
  label: string
  help?: string
  required?: boolean
}

export type ChatUiComponentInput =
  | { kind: 'options'; title: string; prompt?: string; options: ChatUiOption[] }
  | { kind: 'form'; title: string; prompt?: string; fields: ChatUiField[]; submitLabel?: string }

export type ChatUiValue = string | number | boolean | string[]

export type ChatUiAnswer =
  /** `choice: null` is "none of these"; it always carries the user's comment. */
  { choice: string | null; comment?: string } | { values: Record<string, ChatUiValue> }

/** A preview image of one option, as a JPEG data URI. */
export interface ChatUiImage {
  src: string
  route?: string
}

/** One component in an assistant message; the conversation owns it with the transcript. */
export interface ChatUiRecord {
  id: string
  component: ChatUiComponentInput
  images: Record<string, ChatUiImage>
  /** Image capture failures by option id, shown instead of the skeleton. */
  missing?: Record<string, string>
  answer?: ChatUiAnswer
  answeredAt?: number
  at: number
}

/** The longest text value or comment an answer carries (`CHAT_UI_LIMITS.text`). */
export const CHAT_UI_TEXT_LIMIT = 2000

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= CHAT_UI_TEXT_LIMIT
const filled = (value: unknown) =>
  value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)

/** Why an answer does not fit its component; [] when it does. Swift checks the same. */
export function chatUiAnswerProblems(component: ChatUiComponentInput, answer: unknown): string[] {
  const given = (answer ?? {}) as Record<string, unknown>
  if (component.kind === 'options') {
    const { choice, comment } = given as { choice?: unknown; comment?: unknown }
    const problems: string[] = []
    if (comment !== undefined && !isText(comment)) problems.push('The comment is too long.')
    if (choice === null) {
      if (!isText(comment) || !comment.trim()) problems.push('Say what to change when none fit.')
    } else if (!component.options.some((o) => o.id === choice))
      problems.push(`There is no option ${JSON.stringify(choice)}.`)
    return problems
  }
  const values = given.values
  if (!values || typeof values !== 'object' || Array.isArray(values))
    return ['Send the form values.']
  const problems: string[] = []
  for (const id of Object.keys(values))
    if (!component.fields.some((f) => f.id === id)) problems.push(`There is no field ${id}.`)
  for (const field of component.fields) {
    const value = (values as Record<string, unknown>)[field.id]
    if (!filled(value)) {
      if (field.required !== false && field.type !== 'toggle')
        problems.push(`${field.label} is required.`)
      continue
    }
    const problem = fieldProblem(field, value)
    if (problem) problems.push(`${field.label}: ${problem}`)
  }
  return problems
}

function fieldProblem(field: ChatUiField, value: unknown): string | null {
  switch (field.type) {
    case 'choice': {
      const known = new Set(field.options.map((o) => o.value))
      const picked = field.multiple ? value : [value]
      if (!Array.isArray(picked) || picked.some((v) => typeof v !== 'string' || !known.has(v)))
        return field.multiple ? 'pick from the listed options.' : 'pick one listed option.'
      return null
    }
    case 'text':
      return isText(value) ? null : 'the text is too long.'
    case 'color':
      return typeof value === 'string' && value.length <= 64 ? null : 'enter a color.'
    case 'toggle':
      return typeof value === 'boolean' ? null : 'must be on or off.'
    default:
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'enter a number.'
      if (field.min !== undefined && value < field.min) return `at least ${field.min}.`
      if (field.max !== undefined && value > field.max) return `at most ${field.max}.`
      return null
  }
}

const letter = (index: number) => String.fromCharCode(65 + index)

function optionLabel(record: ChatUiRecord, choice: string) {
  if (record.component.kind !== 'options') return choice
  const index = record.component.options.findIndex((o) => o.id === choice)
  const option = record.component.options[index]
  return option ? `option ${letter(index)}: ${option.title}` : choice
}

function valueText(field: ChatUiField | undefined, value: ChatUiValue) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (typeof value === 'number' && field && 'unit' in field && field.unit)
    return `${value} ${field.unit}`
  return String(value) || '(empty)'
}

/** The structured user turn a pick or a submit sends, as the user sees it. */
export function chatUiAnswerText(record: ChatUiRecord): string {
  const answer = record.answer
  if (!answer) return ''
  if ('choice' in answer) {
    const comment = answer.comment?.trim()
    if (answer.choice === null) return `None of these. ${comment ?? ''}`.trim()
    return `Picked ${optionLabel(record, answer.choice)}${comment ? `. ${comment}` : ''}`
  }
  if (record.component.kind !== 'form') return ''
  const fields = record.component.fields
  const lines = Object.entries(answer.values).map(([id, value]) => {
    const field = fields.find((f) => f.id === id)
    return `- ${field?.label ?? id}: ${valueText(field, value)}`
  })
  return `${record.component.title}\n${lines.join('\n')}`
}

/** The summary of a component's state the agent receives with the next turn. */
export function chatUiSummary(record: ChatUiRecord): string {
  const component = record.component
  const title = `"${component.title}" (chat_ui ${component.kind} ${record.id})`
  const answer = record.answer
  if (!answer) return `${title}: not answered yet.`
  if ('choice' in answer) {
    const comment = answer.comment?.trim()
    if (answer.choice === null)
      return `${title}: the user picked none of these${comment ? ` and commented: ${JSON.stringify(comment)}` : ''}.`
    return `${title}: User picked ${optionLabel(record, answer.choice)} (id ${JSON.stringify(answer.choice)})${comment ? ` and commented: ${JSON.stringify(comment)}` : ''}. Apply this variant.`
  }
  return `${title}: the user submitted ${JSON.stringify(answer.values)}.`
}
