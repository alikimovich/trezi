/**
 * Incremental per-line tokenization for the code editor (LKM-183). Engine-agnostic:
 * a `SyntaxTokenizer` is a TextMate grammar's `tokenizeLine2` plus a metadata →
 * category map (`syntax-shiki.ts`), so unit tests can drive it with a fake grammar.
 *
 * Every line keeps the grammar state it was tokenized from. After an edit only the
 * changed lines are re-tokenized, and the pass stops as soon as a following line's
 * stored start state equals the new one (the rest of the file is unchanged).
 * `shown` is the run signature the editor is believed to display; a line whose
 * runs differ from it is sent again.
 */
export interface SyntaxState {
  equals(other: SyntaxState): boolean
}
export interface SyntaxTokenizer {
  /** `tokens` is TextMate's binary form: [startIndex, metadata, …]. */
  tokenizeLine2(
    line: string,
    state: SyntaxState | null
  ): { tokens: Uint32Array; ruleStack: SyntaxState }
  category(metadata: number): number
}
type Line = {
  text: string
  /** The state this line was tokenized from; `undefined` until tokenized. */
  start?: SyntaxState | null
  end?: SyntaxState | null
  /** [start, length, category, …] for non-plain runs, line-relative UTF-16 offsets. */
  runs?: number[]
  key?: string
  shown?: string
  sentAt?: number
}
/** One message to the editor: plain `spans` [start, length, …] and coloured `runs`
 *  [start, length, category, …], both absolute UTF-16 offsets in `revision`'s text. */
export type SyntaxBatch = { lines: number; spans: number[]; runs: number[] }

/** Like VS Code: longer lines (minified bundles) stay plain and pass the state through. */
export const MAX_TOKENIZED_LINE = 20_000

export class SyntaxDocument {
  lines: Line[]
  /** Lines [0, valid) are tokenized in one unbroken chain from the top. */
  valid = 0
  /** Lines [valid, chain) still hold runs computed from their stored `start`. */
  chain = 0
  private offsets: number[] | null = null
  constructor(public text: string) {
    this.lines = text.split('\n').map((line) => ({ text: line }))
  }
  get length() {
    return this.lines.length
  }
  /** Replaces the text; returns the first changed line. Unchanged lines before and
   *  after the change keep their tokens and their `shown` signature. */
  update(text: string): number {
    if (text === this.text) return this.lines.length
    const next = text.split('\n')
    const old = this.lines
    let first = 0
    while (first < old.length && first < next.length && old[first].text === next[first]) first++
    let oldEnd = old.length,
      newEnd = next.length
    while (oldEnd > first && newEnd > first && old[oldEnd - 1].text === next[newEnd - 1]) {
      oldEnd--
      newEnd--
    }
    const inserted = next.slice(first, newEnd).map((line) => ({ text: line }))
    this.lines = [...old.slice(0, first), ...inserted, ...old.slice(oldEnd)]
    this.text = text
    this.offsets = null
    // The lines after the change stay a reusable chain only when the whole change
    // lies before the chain's end; inserted lines are never part of it.
    const chain = Math.max(this.valid, this.chain)
    if (first >= this.valid) this.chain = Math.min(chain, first)
    else {
      this.chain = oldEnd <= chain ? chain + newEnd - oldEnd : first
      this.valid = first
    }
    return first
  }
  /** Tokenizes from `valid` up to line `until` (exclusive) or until `deadline`
   *  (performance.now()); returns true when [0, until) is tokenized. */
  tokenize(
    tokenizer: SyntaxTokenizer,
    until: number,
    deadline = Number.POSITIVE_INFINITY
  ): boolean {
    const end = Math.min(until, this.lines.length)
    while (this.valid < end) {
      const index = this.valid,
        line = this.lines[index]
      const start = index === 0 ? null : (this.lines[index - 1].end ?? null)
      // Converged: this line (and the chain after it) was tokenized from this same state.
      if (
        index > 0 &&
        index < this.chain &&
        line.start !== undefined &&
        sameState(line.start, start)
      ) {
        this.valid = this.chain
        continue
      }
      line.start = start
      if (line.text.length > MAX_TOKENIZED_LINE) {
        line.runs = []
        line.end = start
      } else {
        const result = tokenizer.tokenizeLine2(line.text, start)
        line.runs = runsOf(result.tokens, line.text.length, tokenizer)
        line.end = result.ruleStack
      }
      line.key = line.runs.join(',')
      this.valid = index + 1
      if (this.chain <= index) this.chain = index + 1
      if (performance.now() > deadline) break
    }
    return this.valid >= end
  }
  /** Up to `limit` tokenized lines in [from, to) whose runs the editor does not show yet. */
  pending(from: number, to: number, limit: number): number[] {
    const found: number[] = []
    for (let i = Math.max(0, from); i < Math.min(to, this.valid) && found.length < limit; i++)
      if (this.lines[i].key !== this.lines[i].shown) found.push(i)
    return found
  }
  /** Builds the message for these lines and records them as shown at `revision`. */
  batch(indices: number[], revision: number): SyntaxBatch {
    const offsets = this.lineOffsets()
    const spans: number[] = [],
      runs: number[] = []
    for (let k = 0; k < indices.length; k++) {
      const index = indices[k],
        line = this.lines[index],
        offset = offsets[index]
      // Contiguous lines share one span (the newline between them included).
      if (k > 0 && indices[k - 1] === index - 1) spans[spans.length - 1] += 1 + line.text.length
      else spans.push(offset, line.text.length)
      const own = line.runs ?? []
      for (let r = 0; r < own.length; r += 3) runs.push(offset + own[r], own[r + 1], own[r + 2])
      line.shown = line.key
      line.sentAt = revision
    }
    return { lines: indices.length, spans, runs }
  }
  /** The editor dropped `revision`'s results: what was sent then is not on screen. */
  dropped(revision: number) {
    for (const line of this.lines) if (line.sentAt === revision) line.shown = undefined
  }
  /** The editor replaced its text with `revision`'s (open, reload). Lines sent for that
   *  revision or later arrived after the replacement; anything older is gone. */
  reset(revision = Number.POSITIVE_INFINITY) {
    for (const line of this.lines)
      if (line.sentAt === undefined || line.sentAt < revision) line.shown = undefined
  }
  /** True when every line is tokenized and shown. */
  get settled() {
    return this.valid >= this.lines.length && this.pending(0, this.valid, 1).length === 0
  }
  private lineOffsets() {
    if (this.offsets) return this.offsets
    const offsets = new Array<number>(this.lines.length)
    let offset = 0
    for (let i = 0; i < this.lines.length; i++) {
      offsets[i] = offset
      offset += this.lines[i].text.length + 1
    }
    this.offsets = offsets
    return offsets
  }
}

function sameState(a: SyntaxState | null, b: SyntaxState | null) {
  return a === b || (!!a && !!b && a.equals(b))
}

/** Merges binary TextMate tokens into non-plain category runs. */
function runsOf(tokens: Uint32Array, length: number, tokenizer: SyntaxTokenizer) {
  const runs: number[] = []
  for (let i = 0; i < tokens.length; i += 2) {
    const start = tokens[i],
      end = i + 2 < tokens.length ? tokens[i + 2] : length
    if (end <= start) continue
    const category = tokenizer.category(tokens[i + 1])
    if (!category) continue
    const last = runs.length - 3
    if (last >= 0 && runs[last + 2] === category && runs[last] + runs[last + 1] === start)
      runs[last + 1] += end - start
    else runs.push(start, end - start, category)
  }
  return runs
}
