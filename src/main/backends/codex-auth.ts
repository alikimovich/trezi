/**
 * Which Codex failures mean "the ChatGPT seat is not usable": the CLI is missing, the
 * seat is signed out or its token was rejected (LKM-231). Those end the turn with
 * `code: 'auth'`, which shows the chat's sign-in card instead of a warning line that
 * tells the user to run `codex login` in Terminal. A custom endpoint connection has
 * its own key, so signing in to ChatGPT would not help and it never qualifies.
 */
const SEAT_AUTH =
  /`codex` CLI was not found|codex login|not logged in|not signed in|sign in with chatgpt|please (?:log|sign) in|log in again|unauthori[sz]ed|\b401\b|\bENOENT\b|invalid[_ ]?(?:api[_ ]?key|token)|token (?:expired|is expired)/i

export function codexSeatAuthFailure(message: string, connectionId?: string | null): boolean {
  return !connectionId && SEAT_AUTH.test(message)
}
