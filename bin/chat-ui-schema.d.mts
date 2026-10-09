import type { ZodType, ZodTypeAny } from 'zod'
export const CHAT_UI_LIMITS: {
  options: { min: number; max: number }
  fields: { min: number; max: number }
  choices: { min: number; max: number }
  tags: number
  colorSuggestions: number
  title: number
  prompt: number
  optionTitle: number
  note: number
  tag: number
  label: number
  help: number
  unit: number
  text: number
  comment: number
  submitLabel: number
}
export const chatUiComponentSchema: ZodType<import('../src/shared/chat-ui').ChatUiComponentInput>
export const chatUiCatalog: {
  kind: 'options' | 'form'
  title: string
  when: string
  limits: string
  images?: string
}[]
export const chatUiShape: Record<string, ZodTypeAny>
export const chatUiDescription: string
