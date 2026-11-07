/**
 * LKM-555: replies to selected chat text. Reply on a selection in an assistant message adds a
 * quote card to the composer: the exact excerpt, the message it came from and the user's
 * comment. Several cards send together with an optional main message, as one prompt where
 * each excerpt is paired with its comment. The excerpt is captured text, never a range, so a
 * message that keeps streaming or re-renders cannot retarget a card.
 */
export interface DraftQuote {
  id: string
  /** The source message's id and text segment when Reply was chosen. */
  message: string
  segment?: number
  /** The selected text exactly as it was shown and copied. */
  excerpt: string
  comment: string
}

/** A sent reply as the user bubble shows it. */
export interface SentQuote {
  excerpt: string
  comment: string
}

export const QUOTE_LIMIT = 12
export const EXCERPT_LIMIT = 8_000
export const COMMENT_LIMIT = 8_000
/** `planning:send` refuses a longer request (`MAX_TEXT` in `src/main/project-planning.ts`). */
export const PLANNING_TEXT_LIMIT = 32_000

/** A fence longer than any backtick run in `text`, so an excerpt or comment holding fences
 *  cannot close it early (as `textAgentPrompt` does). */
function fence(text: string) {
  return '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)))
}

const preamble = (count: number) =>
  count === 1
    ? 'I am replying to one excerpt quoted from your earlier messages. The reply pairs the exact excerpt with my comment on it.'
    : `I am replying to ${count} excerpts quoted from your earlier messages. Each numbered reply pairs one exact excerpt with my comment on that excerpt only.`

/**
 * The prompt for `text` with its quotes: the preamble, then per reply a header, the excerpt and
 * the comment, each in its own fence, and last the main message (if any) after `Message:`.
 * Everything a user wrote is fenced except the main message, which follows the last fence, so
 * no excerpt or comment can be read as another reply's or as the message.
 */
export function quotedPrompt(quotes: readonly SentQuote[], text: string): string {
  if (!quotes.length) return text
  const count = quotes.length
  const parts = [preamble(count)]
  quotes.forEach((quote, index) => {
    const excerpt = fence(quote.excerpt)
    const comment = fence(quote.comment)
    parts.push(
      [
        `Reply ${index + 1} of ${count}`,
        'Excerpt:',
        `${excerpt}text`,
        quote.excerpt,
        excerpt,
        'Comment:',
        `${comment}text`,
        quote.comment,
        comment
      ].join('\n')
    )
  })
  if (text.trim()) parts.push(`Message:\n${text}`)
  return parts.join('\n\n')
}

/** Reads `quotedPrompt` back (a reloaded transcript holds the prompt): the quotes and the main
 *  message, or null for any other text, which is then shown as it is. */
export function parseQuotedPrompt(prompt: string): { quotes: SentQuote[]; text: string } | null {
  // What the send put before the reply (an attachment header, a selected element) stays text,
  // as does a backend's note after it.
  const head = prompt.match(
    /(?:^|\n)I am replying to (one excerpt|(\d+) excerpts) quoted from[^\n]*/
  )
  if (!head || head.index === undefined) return null
  const before = prompt.slice(0, head.index + (head[0].startsWith('\n') ? 1 : 0))
  const parsed = parseFrom(prompt.slice(before.length), head[0].replace(/^\n/, ''), head[2])
  if (!parsed) return null
  return { quotes: parsed.quotes, text: (before + parsed.text).trim() }
}

function parseFrom(prompt: string, line: string, number: string | undefined) {
  const count = number ? Number(number) : 1
  if (!Number.isInteger(count) || count < 1 || line !== preamble(count)) return null
  let rest = prompt.slice(line.length)
  const quotes: SentQuote[] = []
  const block = (label: string) => {
    const opening = rest.match(new RegExp(`^${label}:\\n(\`{3,})text\\n`))
    if (!opening) return null
    const marker = `\n${opening[1]}`
    const end = rest.indexOf(marker, opening[0].length - 1)
    if (end < 0) return null
    const value = rest.slice(opening[0].length, end)
    rest = rest.slice(end + marker.length)
    return value
  }
  for (let index = 1; index <= count; index++) {
    const header = `\n\nReply ${index} of ${count}\n`
    if (!rest.startsWith(header)) return null
    rest = rest.slice(header.length)
    const excerpt = block('Excerpt')
    if (excerpt === null || !rest.startsWith('\n')) return null
    rest = rest.slice(1)
    const comment = block('Comment')
    if (comment === null) return null
    quotes.push({ excerpt, comment })
  }
  if (!rest) return { quotes, text: '' }
  if (rest.startsWith('\n\nMessage:\n'))
    return { quotes, text: rest.slice('\n\nMessage:\n'.length) }
  // The backend's note on images sent with a reply that had no message.
  return /^ \[\d+ image\(s\) attached\]$/.test(rest) ? { quotes, text: rest.trim() } : null
}

/** A card for Reply on `excerpt` of `message`, or why there is none. The excerpt is kept
 *  exactly; one that is empty, too long or already quoted from that message is refused. */
export function newQuote(
  quotes: readonly DraftQuote[],
  input: { message: unknown; segment?: unknown; excerpt: unknown },
  known: (message: string) => boolean,
  id: string
): DraftQuote | string {
  const { message, segment, excerpt } = input
  if (typeof message !== 'string' || !known(message))
    return 'That message is no longer in this chat.'
  if (typeof excerpt !== 'string' || !excerpt.trim()) return 'Select some text to reply to.'
  if (excerpt.length > EXCERPT_LIMIT)
    return `That selection is too long to quote (over ${EXCERPT_LIMIT.toLocaleString('en-US')} characters).`
  if (quotes.length >= QUOTE_LIMIT) return `A message can quote up to ${QUOTE_LIMIT} excerpts.`
  if (quotes.some((quote) => quote.message === message && quote.excerpt === excerpt))
    return 'That excerpt is already quoted.'
  return {
    id,
    message,
    ...(Number.isInteger(segment) && (segment as number) >= 0
      ? { segment: segment as number }
      : {}),
    excerpt,
    comment: ''
  }
}

/** The comment as the card keeps it: at most `COMMENT_LIMIT` characters. */
export const quoteComment = (value: unknown) =>
  typeof value === 'string' ? value.slice(0, COMMENT_LIMIT) : ''
