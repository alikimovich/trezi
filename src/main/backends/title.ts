import type { SessionTranscriptEntry } from '../../shared/api'
import { isSystemText } from '../../shared/chat-title'

/**
 * Pure helpers for auto-naming a chat by its subject (LKM-45) — the transcript →
 * prompt digest and the model-output → clean-label sanitiser. Kept free of any
 * Electron/SDK imports so they unit-test in plain bun; the Claude backend wires
 * them into a one-shot `generateTitle` completion.
 */

/** Prompt-digest cap — enough of the opening exchange to name the subject. */
const DIGEST_MAX = 4000
/** Length cap for a finished title; matches the renderer's `chatTitle` cap so
 *  the rail truncates the LLM name and the first-message fallback identically. */
const TITLE_MAX = 40

/**
 * Flatten a transcript into a compact `User:`/`Assistant:` digest for the title
 * prompt: drop tool-status lines and assistant turns that are only an error,
 * auth or system message (LKM-120), collapse whitespace, skip empty turns, and cap
 * the total so a long conversation can't bloat the request. Returns '' when there
 * is nothing worth summarising (the caller then skips the model call entirely).
 */
export function transcriptDigest(transcript: SessionTranscriptEntry[]): string {
  return transcript
    .filter((t) => t.role === 'user' || t.role === 'assistant')
    .map((t) => {
      const text = t.text.replace(/\s+/g, ' ').trim()
      if (t.role === 'assistant' && isSystemText(text)) return ''
      return text ? `${t.role === 'user' ? 'User' : 'Assistant'}: ${text}` : ''
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, DIGEST_MAX)
    .trim()
}

/**
 * Tidy a model-produced title into a short, single-line label: collapse
 * whitespace, drop a leading "Title:"/"Name:" preamble and wrapping
 * quotes/backticks, strip trailing punctuation, and cap the length. Returns null
 * when nothing usable survives, or when the "title" is an error, auth or system
 * message (a signed-out provider answers the title prompt with one), so the caller
 * falls back to the first-message heuristic.
 */
export function sanitizeTitle(raw: string): string | null {
  if (isSystemText(raw)) return null
  let t = raw.replace(/\s+/g, ' ').trim()
  // Models sometimes answer "Title: Foo Bar" or otherwise frame the label.
  t = t.replace(/^(?:title|chat title|name)\s*[:\-–—]\s*/i, '')
  // Peel matching wrapping quotes/backticks (only when they bracket the whole string).
  const wrap = t.match(/^(['"`])([\s\S]+)\1$/)
  if (wrap) t = wrap[2].trim()
  t = t.replace(/[.!?,;:]+$/, '').trim()
  if (!t || isSystemText(t)) return null
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX).trimEnd()}…` : t
}
