/**
 * Pure builders for the in-app "Send feedback" report (LKM-27), sent privately to the
 * Trezi feedback endpoint since LKM-336 (`main/feedback-endpoint.ts` does the HTTP). Kept
 * free of Bun and the platform so it unit-tests without a build.
 *
 * The contract: `POST https://trezi.design/api/feedback` with `Authorization: Bearer <invite
 * code>` and `{ body, conversation?, diagnostics?, appVersion, macOS, screenshot? }`; the
 * screenshot's bytes go separately to the signed upload URL the reply carries. The limits
 * below are the endpoint's; this module enforces them before anything is sent, and maps
 * the endpoint's answers (401, 413, 429, 400, 5xx) to a plain message for the tester.
 */

/** The endpoint's limits: characters (UTF-16 units) for text, bytes for the screenshot. */
export const FEEDBACK_LIMITS = {
  body: 20_000,
  conversation: 60_000,
  diagnostics: 60_000,
  screenshot: 10 * 1024 * 1024
} as const

export type ScreenshotType = 'image/png' | 'image/jpeg'

/** The JSON body of `POST /api/feedback`. */
export interface FeedbackRequest {
  body: string
  conversation?: string
  diagnostics?: string
  appVersion: string
  macOS: string
  screenshot?: { contentType: ScreenshotType; size: number }
}

export interface FeedbackRequestParts {
  /** The user's typed feedback (required). */
  body: string
  /** Rendered chat transcript, when the user opted to attach the conversation. */
  conversation?: string | null
  /** Redacted diagnostics (LKM-165), when the user consented to attach them. */
  diagnostics?: string | null
  appVersion: string
  macOS: string
  /** The screenshot's type and byte size, when opted in. */
  screenshot?: { contentType: ScreenshotType; size: number } | null
}

export const CONVERSATION_CUT = '…(earlier messages left out: the conversation was too long)\n\n'
export const DIAGNOSTICS_CUT = '\n\n…(diagnostics cut short: too long)'

/** A report the endpoint could never accept; the message is for the tester. */
export class FeedbackInputError extends Error {}

/**
 * The request body. The feedback text is never cut: a report over the limit is refused
 * with a plain message. A long conversation keeps its latest messages and long diagnostics
 * their start; a screenshot over the limit (or of an unknown type) is left out.
 */
export function buildFeedbackRequest(parts: FeedbackRequestParts): FeedbackRequest {
  const body = parts.body.trim()
  if (!body) throw new FeedbackInputError('Please describe your feedback first.')
  if (body.length > FEEDBACK_LIMITS.body)
    throw new FeedbackInputError(
      `Your feedback is ${body.length.toLocaleString('en-US')} characters long; the limit is ${FEEDBACK_LIMITS.body.toLocaleString('en-US')}. Shorten it and send again.`
    )
  const request: FeedbackRequest = {
    body,
    appVersion: parts.appVersion.slice(0, 200),
    macOS: parts.macOS.slice(0, 100)
  }
  const conversation = parts.conversation?.trim()
  if (conversation)
    request.conversation =
      conversation.length > FEEDBACK_LIMITS.conversation
        ? CONVERSATION_CUT +
          conversation.slice(-(FEEDBACK_LIMITS.conversation - CONVERSATION_CUT.length))
        : conversation
  const diagnostics = parts.diagnostics?.trim()
  if (diagnostics)
    request.diagnostics =
      diagnostics.length > FEEDBACK_LIMITS.diagnostics
        ? diagnostics.slice(0, FEEDBACK_LIMITS.diagnostics - DIAGNOSTICS_CUT.length) +
          DIAGNOSTICS_CUT
        : diagnostics
  const shot = parts.screenshot
  if (
    shot &&
    (shot.contentType === 'image/png' || shot.contentType === 'image/jpeg') &&
    Number.isInteger(shot.size) &&
    shot.size > 0 &&
    shot.size <= FEEDBACK_LIMITS.screenshot
  )
    request.screenshot = { contentType: shot.contentType, size: shot.size }
  return request
}

/** What a failed request means for the tester and the sheet. */
export interface FeedbackFailure {
  error: string
  /** The same report can be sent again (network, server, rate limit). */
  retry: boolean
  /** The invite code was refused: ask for a new one. */
  code?: boolean
}

/** The endpoint's own `error`, bounded and on one paragraph; null when it sent none. */
export function endpointMessage(payload: unknown): string | null {
  const raw =
    payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined
  if (typeof raw !== 'string') return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from a server message
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return text ? (text.length > 500 ? `${text.slice(0, 499)}…` : text) : null
}

/** "in 30 seconds", "in 5 minutes", "in 2 hours", from a `Retry-After` header. */
export function retryWhen(retryAfter: string | null | undefined, now = Date.now()): string | null {
  const raw = retryAfter?.trim()
  if (!raw) return null
  let seconds = /^\d+$/.test(raw) ? Number(raw) : (Date.parse(raw) - now) / 1000
  if (!Number.isFinite(seconds)) return null
  seconds = Math.max(1, Math.ceil(seconds))
  if (seconds < 90) return `in ${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 90) return `in ${minutes} minutes`
  return `in ${Math.ceil(minutes / 60)} hours`
}

/**
 * An HTTP answer that is not a success, as the tester reads it: the endpoint's own plain
 * message when it sent one, else ours; a rate limit says when to try again.
 */
export function feedbackError(
  status: number,
  payload: unknown,
  retryAfter?: string | null,
  now = Date.now()
): FeedbackFailure {
  const own = endpointMessage(payload)
  if (status === 401)
    return {
      error:
        own ??
        'Your invite code was not accepted. Enter the code from your Trezi beta invite again.',
      retry: false,
      code: true
    }
  if (status === 413)
    return {
      error:
        own ??
        'This report is too large to send. Leave out the screenshot or the conversation and try again.',
      retry: false
    }
  if (status === 429) {
    const when = retryWhen(retryAfter, now)
    const base = own ?? 'Too many reports were sent in a short time.'
    return { error: `${base} ${when ? `Try again ${when}.` : 'Try again later.'}`, retry: true }
  }
  if (status === 400)
    return { error: own ?? 'The feedback service did not accept this report.', retry: false }
  if (status >= 500)
    return {
      error:
        own ?? `The feedback service is not working right now (HTTP ${status}). Try again soon.`,
      retry: true
    }
  return { error: own ?? `The feedback service answered HTTP ${status}.`, retry: false }
}

/** No answer at all (offline, DNS, TLS, timeout): the Retry sheet. */
export const NETWORK_ERROR: FeedbackFailure = {
  error: 'Trezi could not reach the feedback service. Check your internet connection, then retry.',
  retry: true
}
