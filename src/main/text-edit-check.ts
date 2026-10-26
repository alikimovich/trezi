/**
 * LKM-352: an inline text edit that falls back to the background agent hands it the
 * full text, and after the agent's edit lands Trezi checks the text is in the source.
 * An edit over the cap is refused with a message; text is never cut silently.
 */

/** Longest inline text edit Trezi accepts, in characters (whitespace-normalised). */
export const TEXT_EDIT_MAX = 20_000

export const textEditTooLong = (length: number): string =>
  `This text is too long to edit inline (${length} characters, the limit is ${TEXT_EDIT_MAX}). Edit it in the code editor or ask in the chat.`

const ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–'
}

/** How source spells text the page renders: JS string escapes and HTML entities
 *  decoded, JSX `{' '}` spacers dropped, whitespace collapsed. Lower-cased, because
 *  WebKit's innerText applies CSS `text-transform` to what the user edited. */
function normalise(text: string): string {
  return text
    .replace(/\{\s*(['"`])\s*\1\s*\}/g, ' ')
    .replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gi, (_, a, b) =>
      String.fromCodePoint(Number.parseInt(a ?? b, 16))
    )
    .replace(/\\([nrt])/g, ' ')
    .replace(/\\(['"`\\])/g, '$1')
    .replace(/&#x([0-9a-f]+);|&#(\d+);/gi, (_, hex, dec) =>
      String.fromCodePoint(hex ? Number.parseInt(hex, 16) : Number(dec))
    )
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** True when the requested text appears in one of the edited files, whitespace-normalised. */
export function textEditLanded(contents: string[], expected: string): boolean {
  const want = normalise(expected)
  return !want || contents.some((code) => normalise(code).includes(want))
}

export const textEditMismatch = (expected: string): string =>
  `The background text edit was applied, but the source does not contain the full text you typed (${expected.length} characters), so the page may show only part of it. Check the element, then undo the edit or ask in the chat to fix it.`
