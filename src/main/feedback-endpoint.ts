import {
  type FeedbackFailure,
  type FeedbackRequest,
  feedbackError,
  NETWORK_ERROR
} from '../shared/feedback-body'

/**
 * The private Trezi feedback endpoint (LKM-336): Send Feedback posts here instead of filing
 * a public GitHub issue. Every request carries the tester's invite code as its Bearer
 * (`feedback-code.ts`); the code is never logged and never sent anywhere but this origin.
 *
 *   GET  /api/feedback/me      → the tester's name (checks the code)
 *   POST /api/feedback         → `{ ok, issue, upload? }`; the report becomes a Linear issue
 *   PUT  <upload.url>          → the screenshot's bytes, with `upload.headers` (no Bearer)
 *   POST /api/feedback/attach  → `{ issue, assetUrl }` links the uploaded screenshot
 *
 * `fetch` is injectable so the unit tier runs without a network or a listening port.
 */
export const FEEDBACK_ORIGIN = 'https://trezi.app'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * The endpoint's origin. `TREZI_FEEDBACK_URL` points the app at a local mock (the native
 * smoke); it is honoured only for a loopback `http(s)` origin, so no environment variable
 * can send an invite code to another host.
 */
export function feedbackOrigin(env: Record<string, string | undefined> = process.env): string {
  const override = env.TREZI_FEEDBACK_URL?.trim()
  if (!override) return FEEDBACK_ORIGIN
  try {
    const url = new URL(override)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname))
      return url.origin
  } catch {}
  return FEEDBACK_ORIGIN
}

export interface EndpointOptions {
  fetch?: typeof fetch
  origin?: string
  /** Per request; the screenshot upload gets twice as long. */
  timeoutMs?: number
  now?: () => number
}

export type TesterResult = { ok: true; name: string | null } | ({ ok: false } & FeedbackFailure)

export type SendResult =
  | { ok: true; issue: string; warning?: string }
  | ({ ok: false } & FeedbackFailure)

const ISSUE = /^[A-Z][A-Z0-9]{0,15}-\d{1,9}$/
const DEFAULT_TIMEOUT = 30_000

export const SCREENSHOT_NOT_ATTACHED =
  'The feedback was sent, but the screenshot could not be attached.'

interface Answer {
  status: number
  payload: unknown
  retryAfter: string | null
}

async function request(
  url: string,
  init: RequestInit,
  options: EndpointOptions,
  timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
): Promise<Answer> {
  const response = await (options.fetch ?? fetch)(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  })
  let payload: unknown = null
  try {
    const text = await response.text()
    payload = text ? JSON.parse(text) : null
  } catch {}
  return { status: response.status, payload, retryAfter: response.headers.get('retry-after') }
}

const bearer = (code: string) => ({ authorization: `Bearer ${code}` })
const json = { 'content-type': 'application/json', accept: 'application/json' }

function failure(answer: Answer, options: EndpointOptions): { ok: false } & FeedbackFailure {
  return {
    ok: false,
    ...feedbackError(answer.status, answer.payload, answer.retryAfter, options.now?.())
  }
}

function field(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)[key]
    : undefined
}

/** The tester's name for "Sending as …"; a 401 means the code is unknown or revoked. */
export async function feedbackTester(
  code: string,
  options: EndpointOptions = {}
): Promise<TesterResult> {
  const origin = options.origin ?? feedbackOrigin()
  let answer: Answer
  try {
    answer = await request(
      `${origin}/api/feedback/me`,
      { method: 'GET', headers: { ...bearer(code), accept: 'application/json' } },
      options
    )
  } catch {
    return { ok: false, ...NETWORK_ERROR }
  }
  if (answer.status !== 200) return failure(answer, options)
  const raw = field(answer.payload, 'name') ?? field(field(answer.payload, 'tester'), 'name')
  const name = typeof raw === 'string' ? raw.trim().slice(0, 120) : ''
  return { ok: true, name: name || null }
}

/** The signed upload target, when the reply carries a usable one. */
function uploadTarget(
  payload: unknown,
  origin: string
): { url: string; headers: Record<string, string>; assetUrl: string } | null {
  const upload = field(payload, 'upload')
  const url = field(upload, 'url')
  const assetUrl = field(upload, 'assetUrl')
  if (typeof url !== 'string' || typeof assetUrl !== 'string') return null
  try {
    const target = new URL(url)
    // A storage host over https; plain http only back to a loopback mock.
    const local = origin.startsWith('http://') && target.origin === origin
    if (target.protocol !== 'https:' && !local) return null
  } catch {
    return null
  }
  const headers: Record<string, string> = {}
  const raw = field(upload, 'headers')
  if (raw && typeof raw === 'object')
    for (const [key, value] of Object.entries(raw))
      if (typeof value === 'string' && !/^authorization$/i.test(key)) headers[key] = value
  return { url, headers, assetUrl }
}

/**
 * Sends one report. Once the endpoint has answered 200 the report exists (its Linear key is
 * the result), so a screenshot that fails to upload or attach is a warning, never a failure
 * a Retry would turn into a duplicate report.
 */
export async function sendFeedback(
  code: string,
  body: FeedbackRequest,
  screenshot: Uint8Array | null,
  options: EndpointOptions = {}
): Promise<SendResult> {
  const origin = options.origin ?? feedbackOrigin()
  let answer: Answer
  try {
    answer = await request(
      `${origin}/api/feedback`,
      { method: 'POST', headers: { ...json, ...bearer(code) }, body: JSON.stringify(body) },
      options
    )
  } catch {
    return { ok: false, ...NETWORK_ERROR }
  }
  if (answer.status !== 200) return failure(answer, options)
  const issue = field(answer.payload, 'issue')
  if (field(answer.payload, 'ok') !== true || typeof issue !== 'string' || !ISSUE.test(issue))
    return {
      ok: false,
      error: 'The feedback service sent an answer Trezi does not understand.',
      retry: false
    }
  if (!body.screenshot || !screenshot?.length) return { ok: true, issue }
  const target = uploadTarget(answer.payload, origin)
  if (!target) return { ok: true, issue, warning: SCREENSHOT_NOT_ATTACHED }
  try {
    const put = await request(
      target.url,
      {
        method: 'PUT',
        headers: { 'content-type': body.screenshot.contentType, ...target.headers },
        body: new Blob([screenshot as Uint8Array<ArrayBuffer>])
      },
      options,
      (options.timeoutMs ?? DEFAULT_TIMEOUT) * 2
    )
    if (put.status < 200 || put.status >= 300)
      return { ok: true, issue, warning: SCREENSHOT_NOT_ATTACHED }
    const attach = await request(
      `${origin}/api/feedback/attach`,
      {
        method: 'POST',
        headers: { ...json, ...bearer(code) },
        body: JSON.stringify({ issue, assetUrl: target.assetUrl })
      },
      options
    )
    if (attach.status !== 200) return { ok: true, issue, warning: SCREENSHOT_NOT_ATTACHED }
  } catch {
    return { ok: true, issue, warning: SCREENSHOT_NOT_ATTACHED }
  }
  return { ok: true, issue }
}
