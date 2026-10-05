/**
 * LKM-120: a chat is named only from real user or assistant content. Provider
 * errors, sign-in prompts and system notices ("Not logged in · Please run /login")
 * are neither its subject nor its name. A saved title that came from one is
 * replaced by the neutral default when the chat is loaded.
 */

/** The name of a chat without a usable title (the rail's own default). */
export const NEUTRAL_CHAT_TITLE = 'New chat'

// Shapes of provider/CLI failures and system notices, not wording a real subject
// uses: "Fix Login Error Handling" or "Rate Limit Settings" stay valid titles.
const SYSTEM_TEXT: RegExp[] = [
  /\bnot (?:logged|signed) in\b/,
  /\b(?:please )?run \/login\b/,
  /\binvalid api key\b/,
  /\bapi key\b.*\b(?:missing|invalid|expired|revoked)\b/,
  /\boauth token\b.*\b(?:revoked|expired)\b/,
  /\btoken (?:has )?(?:expired|been revoked)\b/,
  /^api error\b/,
  /^(?:[a-z]+ )?error\s*:/,
  /^execution error$/,
  /\bcredit balance is too low\b/,
  /\b(?:usage|rate|hour|weekly|session) limit (?:reached|exceeded)\b/,
  /\byou(?:'|’)ve hit your (?:usage )?limit\b/,
  /\bprompt is too long\b/,
  /^\[?request interrupted\b/,
  /\bno conversation found\b/,
  /\bunexpected status \d{3}\b/,
  /\bauthentication_error\b|\bauthentication (?:failed|required)\b/,
  /\boverloaded_error\b|\bapi is overloaded\b/,
  /\b(?:econnrefused|enotfound|etimedout|econnreset)\b|\bfetch failed\b|\brequest timed out\b/,
  /\bdoes not have access to claude\b|\borganization has been disabled\b/,
  /^\[?(?:system|warning)\]?\s*:/,
  /^unable to complete action\b/
]

/** An error, auth or system message rather than real conversation content. */
export function isSystemText(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase()
  return !!t && SYSTEM_TEXT.some((pattern) => pattern.test(t))
}

/** A stored title as it should be shown: one that came from an error becomes neutral. */
export function migrateChatTitle<T extends string | undefined>(
  title: T
): T | typeof NEUTRAL_CHAT_TITLE {
  return title && isSystemText(title) ? NEUTRAL_CHAT_TITLE : title
}
