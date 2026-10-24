import type { PropInspection, SelectedElement } from './api'
import { projectRelative } from './project-path'
import { describeSelectionForPrompt, oneLine } from './selection-context'

const ownerLine = (element: SelectedElement, root: string | null): string[] =>
  element.componentSource && element.componentSource !== element.source
    ? [
        `Its owning component instance is at ${oneLine(projectRelative(element.componentSource, root), 200)}.`
      ]
    : []

/** How every Inspector Custom tab request starts; the provider rules name it (LKM-323). */
export const CONTROLS_REQUEST_HEADER = 'Inspector Custom tab request'

/** What a Custom tab request is about (LKM-323). */
export interface ControlsRequest {
  /** Echoed in the answer block, so only this request's answer is read. */
  id: string
  /** The selection's repo-relative files; the panel must live in one of them. */
  files: string[]
  /** The panel being commented on, as JSON; absent for a new panel. */
  panel?: string
  /** The commented control's id and label, when the comment is on one control. */
  param?: { id: string; label: string }
}

/**
 * The Custom tab's request turn (LKM-323): the user's words, scoped to the selected
 * element and its source. The agent instruments the source if needed and answers with one
 * `trezi-controls` block, which Trezi validates (control-requests.ts) and shows in the
 * Custom tab — the same manifest shape and literal rules as chat islands. Element-derived
 * fields are page-sourced (semi-trusted) → collapsed through oneLine, as in every other
 * selection-seeded prompt. Sources are relative to `root`, so a worktree chat edits its
 * own checkout (LKM-155).
 */
export function controlsPrompt(
  element: SelectedElement,
  root: string | null,
  inspection: PropInspection | null,
  text: string,
  request: ControlsRequest
): string {
  const lines: string[] = [
    `${CONTROLS_REQUEST_HEADER} ${request.id}.`,
    describeSelectionForPrompt(element, root).trim(),
    ...ownerLine(element, root)
  ]
  if (inspection?.component)
    lines.push(`The inspected component is \`${oneLine(inspection.component, 64)}\`.`)
  const files = request.files.map((f) => `\`${oneLine(f, 200)}\``).join(' or ')
  if (!request.panel)
    lines.push(
      `I want a control panel for this element in the inspector's Custom tab. What I want to control: "${oneLine(text, 1000)}".`
    )
  else
    lines.push(
      request.param
        ? `Change only the control \`${oneLine(request.param.id, 64)}\` ("${oneLine(request.param.label, 80)}") of this Custom tab panel. My comment: "${oneLine(text, 1000)}". Keep its id. The other controls are kept as they are.`
        : `Revise this Custom tab panel. My comment: "${oneLine(text, 1000)}". Keep every control I did not mention, with its id and its source value.`,
      'The current panel:',
      '```json',
      request.panel,
      '```'
    )
  lines.push(
    ``,
    `1. Read the element's source (${files || 'its file'}) and find the values behind those parameters, including magic numbers, config objects and hooks.`,
    `2. If a value is not a tweakable literal yet, extract it to a named top-level constant in that file (e.g. \`const RADIUS_PX = 12\`). Keep runtime behavior identical.`,
    `3. Do not call chat_island: Trezi shows this panel in the inspector, not in the chat. End your answer with exactly one fenced block:`,
    '```trezi-controls',
    // The file is page-sourced: collapsed and JSON-escaped, so it cannot add lines or break the example.
    JSON.stringify({
      request: request.id,
      manifest: {
        file: oneLine(request.files[0] ?? 'src/Card.tsx', 200),
        component: 'Card',
        title: 'Card',
        params: [
          {
            id: 'radius',
            label: 'Corner radius',
            kind: 'number',
            unit: 'px',
            min: 0,
            max: 48,
            step: 1,
            apply: { strategy: 'literal', anchor: 'const RADIUS_PX = ' }
          }
        ]
      }
    }),
    '```',
    `Manifest rules: \`file\` is ${files || 'the element source file'}; 1–12 params; ids match ^[a-z0-9][a-z0-9-]{0,40}$; labels up to 80 characters. Kinds: number, toggle, text, color, select, bezier. \`unit\`/\`min\`/\`max\`/\`step\` only on number; \`options\` (1–20 strings) only on select.`,
    `Strategies: \`literal\` (an \`anchor\` that occurs exactly once in the file and ends immediately before the value, e.g. \`const RADIUS_PX = \`), \`prop\` (\`propName\`, a prop of the inspected component), \`style\` (\`styleProp\`, one CSS longhand such as border-radius, opacity or box-shadow). Prefer literal.`,
    `If you cannot make the controls, answer {"request":"${request.id}","error":"<one line why>"} in the block instead.`,
    `Never create or edit files under \`.trezi/\`.`
  )
  return lines.join('\n')
}

/**
 * The deliberately opt-in animation path. Unlike `controlsPrompt`, this turn
 * is allowed to change runtime behavior: it first creates the requested motion,
 * then opens a selection-independent native tuning panel beside the preview.
 */
export function animationControlsPrompt(
  element: SelectedElement,
  root: string | null,
  inspection: PropInspection | null,
  hint: string | undefined,
  _provider: string
): string {
  const lines: string[] = [
    '/animation-controls',
    describeSelectionForPrompt(element, root).trim(),
    ...ownerLine(element, root)
  ]
  if (inspection?.component) {
    lines.push(`The inspected component is \`${oneLine(inspection.component, 64)}\`.`)
  }
  lines.push(
    hint
      ? `Add this animation to the selected element: "${oneLine(hint, 500)}".`
      : `Add a subtle, appropriate animation to the selected element.`,
    `Then follow the animation-controls skill to surface Trezi native animation controls (manifest.presentation: "animation").`,
    `Use the selection only to identify the animation's source. The panel must remain mounted and`,
    `usable when I select a different object or clear the selection, with controls wired to the`,
    `real animation and Replay for one-shot motion. Preserve unrelated layout and reduced-motion behavior.`,
    `Use define_controls with literal parameters; do not install DialKit or add tuning UI to the app.`,
    `Never create or edit files under \`.trezi/\`.`
  )
  return lines.join('\n')
}
