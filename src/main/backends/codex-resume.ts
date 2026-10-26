/**
 * LKM-346: a Codex chat continues its saved thread (`codex exec resume <id>`). The CLI
 * cannot always honour that: the thread's rollout was deleted or never written, or the
 * id belongs to another provider. These tell a lost resume apart from other failures.
 */

/** The CLI's own wording for a thread it cannot resume. */
export function isCodexResumeFailure(message: string): boolean {
  return /no rollout found|thread not found|session not found|no saved session|could not be resumed|failed to resume|cannot resume/i.test(
    message
  )
}

/**
 * The thread a resumed run reported is not the one it was asked to continue: the CLI
 * started a new, empty thread instead (it does so for an unknown id).
 */
export function resumedElsewhere(expected: string | null, started: string): boolean {
  return !!expected && started !== expected
}
