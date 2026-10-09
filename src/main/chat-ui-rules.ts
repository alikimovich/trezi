import { chatUiCatalog } from '../../bin/chat-ui-schema.mjs'

/**
 * LKM-208: the rules for answer components, generated from the catalog so a new
 * component or limit reaches every provider's instructions without hand edits.
 */
export function chatUiRules(): string[] {
  return [
    `## Answer components in chat (chat_ui)`,
    `chat_ui shows a native component inside your message. The catalog:`,
    ...chatUiCatalog.flatMap((entry) => [
      `- ${entry.kind} (${entry.title}). Use when: ${entry.when}`,
      `  ${entry.limits}`,
      ...(entry.images ? [`  ${entry.images}`] : [])
    ]),
    `show returns at once with the component's id and it appears immediately. Then end your`,
    `turn with one short line and wait: the pick or the form's values arrive as the user's next`,
    `message, and the next turn's context summarizes them. A pick means: apply that variant.`,
    `Ask structured questions with a form, never as plain-text or multiple-choice lists in your`,
    `reply. A component that breaks the schema is rejected with every problem: fix them all and`,
    `show again. update {id} changes a component the user has not answered yet.`,
    ``
  ]
}
