/**
 * LKM-210: what the post-landing check (`src/native/landing-check.ts`) shares with the
 * agent's session.
 *  - The revisions each chat's agent saw served in the preview (`servedRevision` of a
 *    preview observation, open_preview or reload_preview). A landed commit the agent
 *    already looked at, typically after land_now, needs no automatic check: a commit
 *    cannot be observed before it lands, so this is always the same turn's work.
 *  - A failed check, prepended once to the chat's next prompt, so the agent knows about
 *    the problem whether or not the user clicks Ask agent to fix. A later passing check
 *    clears it.
 */
const KEEP_REVISIONS = 8
const served = new Map<string, string[]>()
const problems = new Map<string, string>()

/** A preview observation by chat `key`'s agent answered for `revision`. */
export function noteServedRevision(key: string, revision: string | null | undefined) {
  if (!revision) return
  const seen = (served.get(key) ?? []).filter((r) => r !== revision)
  seen.push(revision)
  served.set(key, seen.slice(-KEEP_REVISIONS))
}

/** Chat `key`'s agent looked at the preview serving `revision`. */
export function agentSawRevision(key: string, revision: string | null): boolean {
  return !!revision && (served.get(key)?.includes(revision) ?? false)
}

/** The latest check of chat `key`'s landing: its problem for the agent, or null when it passed. */
export function setLandingProblem(key: string, text: string | null) {
  if (text) problems.set(key, text)
  else problems.delete(key)
}

/** The failed check the agent has not heard of yet, once. */
export function landingCheckContext(key: string): string {
  const text = problems.get(key)
  if (!text) return ''
  problems.delete(key)
  return `${text}\n\n`
}

export function forgetLandingContext(key: string) {
  served.delete(key)
  problems.delete(key)
}
