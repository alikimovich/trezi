// LKM-219: in-page shortcuts follow the physical key under non-Latin layouts. A Latin
// `key` (U.S., Dvorak, AZERTY…) is the shortcut; a Cyrillic, Hebrew or Greek one falls
// back to the key's position (`code`), so S, H and 1-9 work on any layout.
const CODE_CHARS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

/** The key a shortcut compares: lowercase for letters; named keys (Escape, ArrowLeft) as is. */
export function latinKey(e: { key: string; code: string }): string {
  if (e.key.length !== 1) return e.key
  if (e.key.charCodeAt(0) < 0x7f) return e.key.toLowerCase()
  const letter = /^Key([A-Z])$/.exec(e.code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code)
  if (digit) return digit[1]
  return CODE_CHARS[e.code] ?? e.key
}
