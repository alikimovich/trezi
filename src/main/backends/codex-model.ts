/**
 * The Codex seat's models that the signed-in ChatGPT account cannot use (LKM-126).
 *
 * `codex debug models` lists what the CLI knows, not what the login may run: after a
 * CLI update the table led with `gpt-6.1-sol`, and every seat turn that left the model
 * to the CLI failed with "The 'gpt-6.1-sol' model is not supported when using Codex
 * with a ChatGPT account." The table carries no per-plan field to filter on, so the
 * turn that hits that 400 falls back to the next listed model (`backends/codex.ts`)
 * and says so in a status line; this module remembers the rejection for the process,
 * and main reads the same status line from a helper's session
 * (`provider-sessions.ts`), so later chats and the picker skip the model.
 *
 * Pure apart from the process-wide memory, so it unit-tests without a CLI
 * (`test/codex-model.mjs`).
 */

const SLUG = '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}'
const REJECTED = new RegExp(
  `The ['‘’"](${SLUG})['‘’"] model is not supported when using Codex with a ChatGPT account`,
  'i'
)
const NOTICE = new RegExp(
  `^Codex: (${SLUG}) isn't available with your ChatGPT login, so this chat uses (${SLUG})\\.$`
)

/**
 * The model a Codex error rejected for this login, or null for any other error.
 *
 * The real CLI (0.159.1, LKM-128) reports the rejection in its stream `error` events
 * (and possibly `turn.failed`) as the API's JSON body,
 * `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '…' model is not supported…"}}`,
 * while the exec error says only "Reading prompt from stdin...". So this takes a
 * message, an event or its `error`, and looks through JSON text and nested
 * `message`/`detail`/`error` fields (bounded) as well as the text itself.
 */
export function unsupportedCodexModel(payload: unknown, depth = 0): string | null {
  if (depth > 4 || payload == null) return null
  if (typeof payload === 'string') {
    const found = REJECTED.exec(payload)?.[1]
    if (found) return found
    const start = payload.indexOf('{')
    if (start < 0) return null
    try {
      return unsupportedCodexModel(JSON.parse(payload.slice(start)), depth + 1)
    } catch {
      return null
    }
  }
  if (typeof payload !== 'object') return null
  const fields = payload as Record<string, unknown>
  for (const key of ['message', 'detail', 'error']) {
    const found = unsupportedCodexModel(fields[key], depth + 1)
    if (found) return found
  }
  return null
}

/** The status line a fallback turn shows; main reads it back with `parseCodexFallback`. */
export const codexFallbackNotice = (rejected: string, fallback: string): string =>
  `Codex: ${rejected} isn't available with your ChatGPT login, so this chat uses ${fallback}.`

export function parseCodexFallback(text: string): { rejected: string; fallback: string } | null {
  const match = NOTICE.exec(text)
  return match ? { rejected: match[1], fallback: match[2] } : null
}

/** The error when no listed model is left to fall back to. */
export const codexModelUnavailable = (rejected: string): string =>
  `Codex: ${rejected} isn't available with your ChatGPT login, and no other Codex model was accepted. Choose another model in the model picker.`

/**
 * The model to try after `rejected`: the next listed one that has not been rejected,
 * then the first such one from the top. Null when none is left.
 */
export function nextCodexModel(
  listed: string[],
  rejected: ReadonlySet<string>,
  after?: string
): string | null {
  const start = after ? listed.indexOf(after) + 1 : 0
  const order = [...listed.slice(start), ...listed.slice(0, start)]
  return order.find((id) => !rejected.has(id) && id !== after) ?? null
}

// Process-wide memory: the app run in main, one helper's lifetime in a helper.
const rejected = new Set<string>()
/** What a turn that left the model to the CLI ended up running on. */
let defaultFallback: string | null = null

export function rememberCodexFallback(
  model: string,
  fallback: string | null,
  wasDefault: boolean
): void {
  rejected.add(model)
  if (wasDefault && fallback) defaultFallback = fallback
}

export const rejectedCodexModels = (): ReadonlySet<string> => rejected

/**
 * The model a Codex seat session should ask for, given what was rejected so far:
 * unchanged unless it (or, for the CLI's default, the default's last fallback) was
 * rejected. `listed` is the CLI's own order, used to pick the next model.
 */
export function supportedCodexModel(
  model: string | undefined,
  listed: string[]
): string | undefined {
  if (!model) {
    if (!defaultFallback) return undefined
    if (!rejected.has(defaultFallback)) return defaultFallback
    return nextCodexModel(listed, rejected, defaultFallback) ?? undefined
  }
  return rejected.has(model) ? (nextCodexModel(listed, rejected, model) ?? model) : model
}

/** Tests only: forget every rejection. */
export function resetCodexModelMemory(): void {
  rejected.clear()
  defaultFallback = null
}
