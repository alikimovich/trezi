import type { SelectedElement } from './api'
import type { NativeChatMessage } from './native-chat'
import { projectRelative } from './project-path'

// A picked element's fields come from the (only semi-trusted) previewed page.
// Collapse to a single line (no control chars / newlines, so an injected value
// can't masquerade as a new instruction paragraph) and cap by code point
// (surrogate-safe). The source is additionally validated to a `path:line` shape.
export const oneLine = (s: string, max: number): string =>
  Array.from(s.replace(new RegExp('[\\u0000-\\u001F\\u007F]+', 'g'), ' '))
    .slice(0, max)
    .join('')
    .trim()

const SOURCE_RE = /^[\w./@-]+:\d+(:\d+)?$/

/** Build the chat prompt prefix that anchors the agent to a picked element. */
export const describeSelectionForPrompt = (el: SelectedElement, root?: string | null): string => {
  const id = el.id ? oneLine(el.id, 64) : ''
  const cls = el.classes[0] ? oneLine(el.classes[0], 64) : ''
  const ident = id ? `#${id}` : cls ? `.${cls}` : ''
  const source = el.source && SOURCE_RE.test(el.source) ? projectRelative(el.source, root) : null
  const where = source ? ` in ${source}` : ` (selector: ${oneLine(el.selector, 200)})`
  const text = el.text ? ` with text “${oneLine(el.text, 40)}”` : ''
  return `In the preview I selected the <${oneLine(el.tag, 32)}${ident}> element${where}${text}. `
}

/**
 * A display-only snapshot of a selection for the sent message bubble — the same
 * tag + `#id`/`.class` identifier the composer's Inspector pill shows, plus the
 * source ref. Kept alongside the message so the bubble can render the pill after
 * the selection is cleared from the composer.
 */
export const selectionForBubble = (
  el: SelectedElement
): NonNullable<NativeChatMessage['selection']> => ({
  tag: el.tag,
  ident: el.id ? `#${el.id}` : el.classes[0] ? `.${el.classes[0]}` : '',
  source: el.source ?? null
})
