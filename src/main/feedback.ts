import { app, ipcMain, type NativeView } from '../native/platform'
import type { FeedbackInput, FeedbackResult } from '../shared/api'
import { buildFeedbackBody, buildFeedbackTitle } from '../shared/feedback-body'
import { captureConsole, gatherDiagnostics, redact } from './feedback-diagnostics'
import { workflowOwner } from './workflow-owner'

/**
 * In-app feedback (LKM-27) → a GitHub issue on Trezi's OWN repo. The app is
 * distributed as a git checkout (`app.getAppPath()`), so `gh issue create` run
 * there targets the right repo via its `origin` remote. Bun only composes the
 * title and body; the workflow owner files the issue (service/WorkflowTools.swift,
 * journaled so a retry never files it twice).
 *
 * GitHub exposes no API/gh way to upload an image attachment, so an opted-in
 * screenshot rides along inside the issue body as a downscaled base64 data URI
 * (see feedback-body.ts) rather than a rendered attachment. Opted-in diagnostics
 * (LKM-165) are gathered and redacted by feedback-diagnostics.ts.
 */

/** Downscale + re-encode a full-window capture so its data URI stays small. */
async function captureWindow(win: NativeView | null): Promise<string | null> {
  if (!win) return null
  try {
    const img = await win.webContents.capturePage()
    if (!img || img.isEmpty()) return null
    // A retina window capture is huge; 900px-wide JPEG keeps the data URI small
    // enough to survive GitHub's 65536-char issue-body cap.
    const { width } = img.getSize()
    const scaled = width > 900 ? img.resize({ width: 900 }) : img
    const jpeg = scaled.toJPEG(60)
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  } catch {
    return null
  }
}

/** The host's pid and a main-thread round trip, for the diagnostics' busy check. */
export interface FeedbackHost {
  pid: number | null
  ping(): Promise<unknown>
}

async function submitFeedback(
  repoRoot: string,
  input: FeedbackInput,
  host: FeedbackHost | null
): Promise<FeedbackResult> {
  const body = (input.body ?? '').trim()
  if (!body) return { ok: false, error: 'Please describe your feedback first.' }

  const title = buildFeedbackTitle(body)
  const diagnostics = input.diagnostics
    ? await gatherDiagnostics({
        chat: input.chat ?? null,
        ping: host ? () => host.ping() : undefined,
        hostPid: host?.pid ?? null
      }).catch((error) => `Diagnostics could not be gathered: ${redact(String(error))}`)
    : null
  const issueBody = buildFeedbackBody({
    body,
    conversation: input.conversation ?? null,
    screenshot: input.screenshot ?? null,
    diagnostics
  })
  try {
    return await workflowOwner().feedback(repoRoot, title, issueBody)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Register the feedback IPC. `getWindow` yields the main window (for the
 * screenshot capture), `getHost` the host for the diagnostics' busy check; the
 * issue is filed against Trezi's own checkout.
 */
export function registerFeedbackIpc(
  getWindow: () => NativeView | null,
  getHost: () => FeedbackHost | null = () => null
): void {
  const repoRoot = app.getAppPath()
  captureConsole()
  ipcMain.handle('feedback:capture', () => captureWindow(getWindow()))
  ipcMain.handle('feedback:submit', (_e, input: FeedbackInput) =>
    submitFeedback(repoRoot, input, getHost())
  )
}
