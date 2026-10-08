import { z } from 'zod'

/**
 * LKM-208: the answer-component catalog (the OpenUI pattern without its runtime). One
 * source for the tool's input schema (Claude in-process, the Codex MCP bridge), Bun's
 * validation (`src/main/chat-ui.ts`) and the generated rules (`src/main/rules.ts`). Swift
 * decodes and checks the same shapes in `src/native/ChatUiModel.swift`.
 */
export const CHAT_UI_LIMITS = {
  options: { min: 2, max: 4 },
  fields: { min: 1, max: 8 },
  choices: { min: 2, max: 8 },
  tags: 4,
  colorSuggestions: 8,
  title: 80,
  prompt: 400,
  optionTitle: 60,
  note: 160,
  tag: 24,
  label: 60,
  help: 160,
  unit: 12,
  text: 2000,
  comment: 2000,
  submitLabel: 24
}
const L = CHAT_UI_LIMITS

const words = (max) => z.string().trim().min(1, 'must not be empty').max(max)
const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'use 1–32 lowercase letters, digits or dashes')
const finite = z.number().finite()
/** Capture the preview as it is now for this option: the page, or one element. */
const capture = z
  .union([z.literal(true), z.object({ selector: z.string().min(1).max(1000) }).strict()])
  .describe(
    "Capture the user's preview now as this option's image: true for the visible page, {selector} for one element. Open the variant's route or state first."
  )

const option = z
  .object({
    id: id.describe('Short id, e.g. a, b, c'),
    title: words(L.optionTitle),
    note: words(L.note).describe('One short sentence on what sets this variant apart'),
    tags: z.array(words(L.tag)).max(L.tags).optional(),
    capture: capture.optional()
  })
  .strict()

const optionsComponent = z
  .object({
    kind: z.literal('options'),
    title: words(L.title),
    prompt: words(L.prompt).optional(),
    options: z.array(option).min(L.options.min).max(L.options.max)
  })
  .strict()
  .superRefine((value, ctx) => unique(value.options, 'id', ['options'], ctx))

const base = {
  id,
  label: words(L.label),
  help: words(L.help).optional(),
  required: z.boolean().optional().describe('Default true')
}
const choice = z
  .object({
    ...base,
    type: z.literal('choice'),
    multiple: z.boolean().optional(),
    options: z
      .array(z.object({ value: words(L.label), label: words(L.label) }).strict())
      .min(L.choices.min)
      .max(L.choices.max),
    default: z.union([words(L.label), z.array(words(L.label))]).optional()
  })
  .strict()
const text = z
  .object({
    ...base,
    type: z.literal('text'),
    placeholder: words(L.label).optional(),
    multiline: z.boolean().optional(),
    default: z.string().max(L.text).optional()
  })
  .strict()
const number = z
  .object({
    ...base,
    type: z.literal('number'),
    min: finite.optional(),
    max: finite.optional(),
    step: finite.positive().optional(),
    unit: words(L.unit).optional(),
    default: finite.optional()
  })
  .strict()
const slider = z
  .object({
    ...base,
    type: z.literal('slider'),
    min: finite,
    max: finite,
    step: finite.positive().optional(),
    unit: words(L.unit).optional(),
    default: finite.optional()
  })
  .strict()
const color = z
  .object({
    ...base,
    type: z.literal('color'),
    suggestions: z
      .array(
        z
          .object({
            name: words(40).describe('Token name, e.g. --brand-teal'),
            value: z
              .string()
              .regex(
                /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
                'use #rgb, #rrggbb or #rrggbbaa'
              )
          })
          .strict()
      )
      .max(L.colorSuggestions)
      .optional(),
    default: z.string().max(64).optional()
  })
  .strict()
const toggle = z
  .object({ ...base, type: z.literal('toggle'), default: z.boolean().optional() })
  .strict()
const field = z.discriminatedUnion('type', [choice, text, number, slider, color, toggle])

const formComponent = z
  .object({
    kind: z.literal('form'),
    title: words(L.title),
    prompt: words(L.prompt).optional(),
    fields: z.array(field).min(L.fields.min).max(L.fields.max),
    submitLabel: words(L.submitLabel).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    unique(value.fields, 'id', ['fields'], ctx)
    value.fields.forEach((f, at) => fieldProblems(f, ctx, ['fields', at]))
  })

export const chatUiComponentSchema = z.discriminatedUnion('kind', [optionsComponent, formComponent])

function unique(items, key, path, ctx) {
  const seen = new Set()
  items.forEach((item, at) => {
    if (seen.has(item[key]))
      ctx.addIssue({
        code: 'custom',
        path: [...path, at, key],
        message: `duplicate ${key} "${item[key]}"`
      })
    seen.add(item[key])
  })
}

function fieldProblems(f, ctx, path) {
  const issue = (message, key) =>
    ctx.addIssue({ code: 'custom', path: key ? [...path, key] : path, message })
  if ((f.type === 'number' || f.type === 'slider') && f.min !== undefined && f.max !== undefined) {
    if (f.min >= f.max) issue('min must be below max', 'min')
    if (f.default !== undefined && (f.default < f.min || f.default > f.max))
      issue('default is outside min…max', 'default')
  }
  if (f.type === 'choice') {
    unique(f.options, 'value', [...path, 'options'], ctx)
    const values = new Set(f.options.map((o) => o.value))
    const defaults =
      f.default === undefined ? [] : Array.isArray(f.default) ? f.default : [f.default]
    if (Array.isArray(f.default) && !f.multiple)
      issue('a single choice takes one default value', 'default')
    if (defaults.some((d) => !values.has(d)))
      issue('default must be one of the option values', 'default')
  }
}

/** What every component is for, for the catalog action and the rules. */
export const chatUiCatalog = [
  {
    kind: 'options',
    title: 'Design options',
    when: 'The user asks to explore, compare or choose between design directions or variants.',
    limits: `${L.options.min}–${L.options.max} options, each with a title (≤${L.optionTitle}), a one-sentence note (≤${L.note}), up to ${L.tags} tags and a preview image. The user picks one, or "none of these" with a comment.`,
    images:
      'Show the component first (images appear as skeletons), then for each variant open its route or state in the preview and call update {id, option, capture}.'
  },
  {
    kind: 'form',
    title: 'Question form',
    when: 'You need a structured answer from the user: a choice, a value, a color, a toggle or short text. Use it instead of asking in plain text or with multiple-choice lists in your reply.',
    limits: `${L.fields.min}–${L.fields.max} fields: choice (single or multiple, ${L.choices.min}–${L.choices.max} options), text, number (unit, min/max), slider (min/max), color (token suggestions), toggle. Fields are required unless required:false. One Submit sends every value.`
  }
]

export const chatUiShape = {
  action: z.enum(['catalog', 'show', 'update']),
  id: z.string().optional().describe('update: the id show returned'),
  component: chatUiComponentSchema
    .optional()
    .describe(
      'show: the component. update: a full replacement of the same kind (images of kept option ids stay)'
    ),
  option: z
    .string()
    .optional()
    .describe('update: the option id whose preview image to capture now'),
  capture: capture.optional()
}

export const chatUiDescription =
  "Show a native answer component inside this chat message: options (2–4 design variants with preview images; the user picks one or none with a comment) or form (typed fields with Submit). Call catalog for the schemas and when to use each. show returns at once with the component's id and it renders immediately; add option images with update {id, option, capture} after showing each variant in the preview. Then end your turn: the user's pick or form values arrive as their next message. Use form instead of asking structured questions in plain text."
