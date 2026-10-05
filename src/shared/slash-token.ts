/**
 * Parse the "/" slash-command token that contains the caret in the composer.
 *
 * The skills/commands menu opens on the "/" token the caret sits in, so it
 * triggers anywhere in the message — at the very start OR after whitespace —
 * but NOT when a non-whitespace character sits directly before the "/"
 * (e.g. a URL path like `foo/bar` must not open the menu).
 *
 * Pure + string-only (no React, no DOM) so it's unit-testable and safe to
 * import from any process.
 *
 * @param input  the full composer text
 * @param caret  the caret offset (selectionStart) within `input`
 * @returns `{ query, start }` where `query` is the text after "/" up to the
 *          caret and `start` is the index of the "/" itself, or `null` when
 *          the caret is not inside an eligible "/" token.
 */
export function parseSlashToken(
  input: string,
  caret: number
): { query: string; start: number } | null {
  const before = input.slice(0, caret)
  const m = before.match(/(?:^|\s)\/(\S*)$/)
  if (!m) return null
  const query = m[1]
  return { query, start: caret - query.length - 1 }
}
