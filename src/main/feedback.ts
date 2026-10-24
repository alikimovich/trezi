import { appVersion } from '../native/app-version'
import { ipcMain } from '../native/platform'
import type { FeedbackAccount, FeedbackInput, FeedbackResult } from '../shared/api'
import {
  buildFeedbackRequest,
  FEEDBACK_LIMITS,
  FeedbackInputError,
  type ScreenshotType
} from '../shared/feedback-body'
import { feedbackCode } from './feedback-code'
import { captureConsole, gatherDiagnostics, redact } from './feedback-diagnostics'
import { type EndpointOptions, feedbackTester, sendFeedback } from './feedback-endpoint'
import { productLog } from './product-log'
import { macOSVersion } from './verification-receipts'

/**
 * In-app feedback (LKM-27), sent privately to the Trezi developer since LKM-336: the report
 * goes to the Trezi feedback endpoint (`feedback-endpoint.ts`) as the tester named by their
 * beta invite code, and becomes a private Linear issue. Nothing is posted to a public page
 * and no `gh` command runs.
 *
 * The invite code is kept encrypted by the service (`feedback-code.ts`). Opted-in
 * diagnostics (LKM-165) are gathered and redacted by `feedback-diagnostics.ts`; an opted-in
 * screenshot is sent as the host's real PNG (a JPEG when the PNG is over the limit).
 */

/** The host's pid and a main-thread round trip, for the diagnostics' busy check. */
export interface FeedbackHost {
  pid: number | null
  ping(): Promise<unknown>
}

export const BAD_CODE =
  'That does not look like an invite code: paste the code from your Trezi beta invite.'
export const NO_CODE = 'Enter the invite code from your Trezi beta invite first.'
export const SCREENSHOT_TOO_LARGE =
  'The feedback was sent without the screenshot: it was too large.'

/** The same rule the service applies before it stores a code. */
export const validInviteCode = (code: string): boolean => /^[\x21-\x7e]{1,512}$/.test(code)

export interface FeedbackDeps {
  /** Where the code lives: the service's encrypted store, or a smoke's memory. */
  code: Pick<typeof feedbackCode, 'has' | 'read' | 'save' | 'remove'>
  host?: () => FeedbackHost | null
  /** The endpoint's origin and fetch; the default is `feedbackOrigin()`. */
  endpoint?: EndpointOptions
  /** Stamped into every report. */
  appVersion?: () => string
  macOS?: () => string
}

function screenshotBytes(
  input: FeedbackInput['screenshot']
): { contentType: ScreenshotType; bytes: Uint8Array } | null {
  if (!input || typeof input.data !== 'string') return null
  if (input.contentType !== 'image/png' && input.contentType !== 'image/jpeg') return null
  const bytes = Buffer.from(input.data, 'base64')
  return bytes.length ? { contentType: input.contentType, bytes } : null
}

/** Longest the "Sending as <name>" lookup may hold the sheet closed. */
const LOOKUP_TIMEOUT = 5_000

/** The three feedback operations behind the IPC; the native smoke runs them on a mock endpoint. */
export function feedbackHandlers(deps: FeedbackDeps) {
  const endpoint = deps.endpoint ?? {}
  return {
    /** Whether a code is saved, and whose it is. */
    async account(): Promise<FeedbackAccount> {
      const code = await deps.code.read()
      if (!code) return { hasCode: false }
      // The sheet waits for this, so a slow network must not hold Send Feedback closed: past
      // the short limit the form opens without a name (a network failure is not `invalid`).
      const tester = await feedbackTester(code, {
        ...endpoint,
        timeoutMs: Math.min(endpoint.timeoutMs ?? LOOKUP_TIMEOUT, LOOKUP_TIMEOUT)
      })
      if (tester.ok) return { hasCode: true, name: tester.name }
      return {
        hasCode: true,
        name: null,
        error: tester.error,
        ...(tester.code ? { invalid: true } : {})
      }
    },

    /** Checks a new code with the endpoint before saving it; '' removes the saved one. */
    async saveCode(
      raw: unknown
    ): Promise<{ ok: true; name: string | null } | { ok: false; error: string }> {
      const code = typeof raw === 'string' ? raw.trim() : ''
      try {
        if (!code) {
          await deps.code.remove()
          return { ok: true, name: null }
        }
        if (!validInviteCode(code)) return { ok: false, error: BAD_CODE }
        const tester = await feedbackTester(code, endpoint)
        if (!tester.ok) return { ok: false, error: tester.error }
        await deps.code.save(code)
        return { ok: true, name: tester.name }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    async submit(input: FeedbackInput): Promise<FeedbackResult> {
      const code = await deps.code.read()
      if (!code) return { ok: false, error: NO_CODE, retry: false, code: true }
      const host = deps.host?.() ?? null
      const shot = screenshotBytes(input.screenshot)
      const diagnostics = input.diagnostics
        ? await gatherDiagnostics({
            chat: input.chat ?? null,
            ping: host ? () => host.ping() : undefined,
            hostPid: host?.pid ?? null
          }).catch((error) => `Diagnostics could not be gathered: ${redact(String(error))}`)
        : null
      let request: ReturnType<typeof buildFeedbackRequest>
      try {
        request = buildFeedbackRequest({
          body: input.body ?? '',
          conversation: input.conversation ?? null,
          diagnostics,
          appVersion: (deps.appVersion ?? appVersion)(),
          macOS: (deps.macOS ?? macOSVersion)(),
          screenshot: shot ? { contentType: shot.contentType, size: shot.bytes.length } : null
        })
      } catch (error) {
        if (error instanceof FeedbackInputError)
          return { ok: false, error: error.message, retry: false }
        throw error
      }
      const bytes = request.screenshot && shot ? shot.bytes : null
      const result = await sendFeedback(code, request, bytes, endpoint)
      if (!result.ok)
        return {
          ok: false,
          error: result.error,
          retry: result.retry,
          ...(result.code ? { code: true } : {})
        }
      // LKM-202: counted by the Dreamer; never the feedback's text or the code.
      productLog.info('feedback', 'Feedback posted')
      const dropped = shot && shot.bytes.length > FEEDBACK_LIMITS.screenshot
      const warning = result.warning ?? (dropped ? SCREENSHOT_TOO_LARGE : undefined)
      return warning
        ? { ok: true, issue: result.issue, warning }
        : { ok: true, issue: result.issue }
    }
  }
}

/** Register the feedback IPC. `getHost` yields the host for the diagnostics' busy check. */
export function registerFeedbackIpc(getHost: () => FeedbackHost | null = () => null): void {
  captureConsole()
  const feedback = feedbackHandlers({ code: feedbackCode, host: getHost })
  ipcMain.handle('feedback:account', () => feedback.account())
  // Settings: no network, only whether a code is saved.
  ipcMain.handle('feedback:code-status', async () => ({ hasCode: await feedbackCode.has() }))
  ipcMain.handle('feedback:code', (_e, code: unknown) => feedback.saveCode(code))
  ipcMain.handle('feedback:submit', (_e, input: FeedbackInput) => feedback.submit(input))
}
