import { SyntaxDocument, type SyntaxTokenizer } from '../main/syntax-document'
import { type SyntaxLanguage, syntaxLanguage } from '../main/syntax-languages'
import { syntaxTokenizer } from '../main/syntax-shiki'

/** One highlight message to the Swift editor (`sourceHighlight`). It applies only while
 *  its own revision of `source` is the one on screen. */
export type SyntaxMessage = {
  root: string
  source: string
  revision: number
  language: SyntaxLanguage
  spans: number[]
  runs: number[]
}
/** What the editor reports (`highlight` source action): its visible lines, a text it
 *  replaced with `revision`'s (`reset`) or a result it dropped as stale. */
export type SyntaxReport = {
  source?: string
  first?: number
  last?: number
  reset?: boolean
  revision?: number
  dropped?: number
}
type Session = {
  source: string
  language: SyntaxLanguage
  revision: number
  doc: SyntaxDocument
  /** Visible lines, 0-based, inclusive. */
  window: [number, number]
  tokenizer?: SyntaxTokenizer | null
  running: boolean
  again: boolean
}

/** Tokenizing yields to the event loop after this long. */
export const SYNTAX_SLICE_MS = 8
/** Lines around the visible ones that are highlighted with them. */
export const SYNTAX_MARGIN = 100
/** Lines per message; one message per slice, so the editor's main thread is never flooded. */
export const SYNTAX_BATCH_LINES = 400

/**
 * Grammar highlighting for the native code editor (LKM-183), off the editor's main
 * thread. Each published editor state updates the document incrementally; a pass
 * tokenizes in short slices, sends the visible lines (plus a margin) first and the rest
 * after, and stops as soon as everything is tokenized and shown.
 */
export class SyntaxController {
  readonly sessions = new Map<string, Session>()
  constructor(
    readonly send: (message: SyntaxMessage) => void,
    readonly load: (language: SyntaxLanguage) => Promise<SyntaxTokenizer | null> = syntaxTokenizer,
    readonly warn: (message: string) => void = () => {},
    readonly pause: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve))
  ) {}
  /** The editor controller's state for `root`: the open document, its text and revision. */
  document(root: string, source: string, text: string, revision: number, highlight: boolean) {
    let session = this.sessions.get(root)
    if (!highlight || !source) {
      this.sessions.delete(root)
      return
    }
    if (!session || session.source !== source) {
      session = {
        source,
        language: syntaxLanguage(source),
        revision,
        doc: new SyntaxDocument(text),
        window: session?.window ?? [0, 80],
        running: false,
        again: false
      }
      this.sessions.set(root, session)
    } else {
      if (
        revision < session.revision ||
        (revision === session.revision && text === session.doc.text)
      )
        return
      session.doc.update(text)
      session.revision = revision
    }
    this.schedule(root, session)
  }
  report(root: string, report: SyntaxReport) {
    const session = this.sessions.get(root)
    if (!session || session.source !== report.source) return
    if (Number.isInteger(report.first) && Number.isInteger(report.last))
      session.window = [Math.max(0, report.first!), Math.max(report.first!, report.last!)]
    if (report.reset)
      session.doc.reset(Number.isInteger(report.revision) ? report.revision : undefined)
    if (Number.isInteger(report.dropped)) session.doc.dropped(report.dropped!)
    this.schedule(root, session)
  }
  /** Resolves when `root`'s pass has finished (tests). */
  async idle(root: string) {
    while (this.sessions.get(root)?.running) await this.pause()
  }
  private schedule(root: string, session: Session) {
    if (session.running) {
      session.again = true
      return
    }
    session.running = true
    void this.run(root, session)
      .catch((error) =>
        this.warn(`Syntax highlighting stopped: ${String(error?.message ?? error)}`)
      )
      .finally(() => {
        session.running = false
        if (session.again && this.sessions.get(root) === session) {
          session.again = false
          this.schedule(root, session)
        }
      })
  }
  private async run(root: string, session: Session) {
    if (session.tokenizer === undefined) {
      try {
        session.tokenizer =
          session.language === 'plaintext' ? null : await this.load(session.language)
      } catch (error) {
        session.tokenizer = null
        this.warn(`Syntax highlighting unavailable: ${String((error as Error)?.message ?? error)}`)
      }
    }
    // Plain text needs nothing: the editor's own plain style is right.
    const tokenizer = session.tokenizer
    if (!tokenizer) return
    while (this.sessions.get(root) === session) {
      session.again = false
      const doc = session.doc
      const window: [number, number] = [
        Math.max(0, session.window[0] - SYNTAX_MARGIN),
        Math.min(doc.length, session.window[1] + 1 + SYNTAX_MARGIN)
      ]
      const deadline = performance.now() + SYNTAX_SLICE_MS
      const ready = doc.tokenize(tokenizer, window[1], deadline)
      if (ready) doc.tokenize(tokenizer, doc.length, deadline)
      // The visible lines go first: nothing is sent until they are tokenized.
      if (ready) {
        let lines = doc.pending(window[0], window[1], SYNTAX_BATCH_LINES)
        if (!lines.length) lines = doc.pending(0, doc.length, SYNTAX_BATCH_LINES)
        if (lines.length)
          this.send({
            root,
            source: session.source,
            revision: session.revision,
            language: session.language,
            ...doc.batch(lines, session.revision)
          })
      }
      if (doc.settled && !session.again) return
      await this.pause()
    }
  }
}
