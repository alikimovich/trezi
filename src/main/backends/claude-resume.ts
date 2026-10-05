import { realpathSync } from 'node:fs'
import type { SessionRecord } from '../../shared/api'

/** The one note a recovered resume leaves in the chat (LKM-165). */
export const RESUME_NOTE = 'Started a new session; earlier context was summarized'

const SUMMARY_LIMIT = 6000
const MESSAGE_LIMIT = 600
const LAST_MESSAGES = 12
const FILES_LIMIT = 40

/**
 * The directory Claude keys a session by. The SDK stores a session under the cwd it
 * was started in, so a worktree reached through a symlink (`/var` → `/private/var`)
 * must start and resume with the same resolved path or the resume finds nothing.
 */
export function canonicalCwd(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

/** A resume the SDK or CLI could not honour: the session is gone, unreadable or foreign. */
export function isResumeFailure(message: string): boolean {
  return /no conversation found|session id|could not (?:find|resume)|failed to resume|unable to resume|--resume|exited with code/i.test(
    message
  )
}

/** The text of a thrown error or an error `result` message. */
export function failureText(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  const result = value as { result?: unknown; errors?: unknown } | null
  const errors = Array.isArray(result?.errors) ? result.errors.map(String).join(' ') : ''
  return `${typeof result?.result === 'string' ? result.result : ''} ${errors}`.trim()
}

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

/** A compact summary of the visible chat: its last messages and the files it changed. */
export function resumeSummary(
  record: Pick<SessionRecord, 'transcript' | 'filesTouched'> | undefined
): string {
  if (!record) return ''
  const lines: string[] = []
  const messages = record.transcript.filter((entry) => entry.role !== 'status' && entry.text.trim())
  for (const entry of messages.slice(-LAST_MESSAGES))
    lines.push(
      `${entry.role === 'user' ? 'User' : 'Assistant'}: ${clip(entry.text.trim(), MESSAGE_LIMIT)}`
    )
  const files = record.filesTouched.slice(-FILES_LIMIT)
  const text = [
    lines.length ? `Last messages:\n${lines.join('\n')}` : '',
    files.length ? `Files changed so far:\n${files.map((file) => `- ${file}`).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  return clip(text, SUMMARY_LIMIT)
}

/** The user's message with the summary of the conversation the new session replaces. */
export function seedPrompt(summary: string, text: string): string {
  if (!summary) return text
  return (
    "Earlier context: this chat's previous session could not be resumed, so this is a new " +
    `session in the same working directory. A summary of the chat so far:\n\n${summary}\n\n` +
    `Continue from there. The user's new message:\n\n${text}`
  )
}
