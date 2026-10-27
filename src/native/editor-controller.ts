import type { SourceDraft } from '../main/source-owner'
import type { CodeRevealRequest, SourceView, SourceWriteResult } from '../shared/api'
import type { NativeEditorAction, NativeEditorState, SourceRange } from '../shared/native-editor'
import type { NativePreferences } from './preferences'

/** Soft wrap in the code editor (LKM-192): on unless the user turned it off ('0'). */
export const SOURCE_WRAP = 'trezi:source-wrap'

/** `baseHash`: the hash of the text the draft was typed against (issued with the read, or a restored draft's). */
type Document = {
  view: SourceView
  baseline: string
  baseHash?: string
  text: string
  revision: number
  conflict: boolean
}
type Session = {
  state: NativeEditorState
  documents: Map<string, Document>
  generation: number
  saving: Set<string>
  history: string[]
  cursor: number
  restored?: Promise<Map<string, SourceDraft>>
}
/** An agent's `open_code` (LKM-363) opens only in the project and chat that asked: a
 *  request from another project or a chat not in front is dropped, never shown later. */
export function codeRevealTarget(
  request: CodeRevealRequest,
  active: { root: string; chat: string } | null
): { root: string; source: string; range: SourceRange } | null {
  if (!active || request?.root !== active.root || request.key !== active.chat) return null
  if (typeof request.source !== 'string' || typeof request.code !== 'string') return null
  const { startLine, endLine, code } = request
  return { root: request.root, source: request.source, range: { startLine, endLine, code } }
}

type Shown = { range: { startLine: number; endLine: number } | null; error?: string }
const LINE = /:(\d+)(?::\d+)?$/

/**
 * The lines a reveal selects in a document's open text, a draft included (LKM-363).
 * A requested range with `code` must find exactly those lines: where they are, or
 * moved once by an unsaved or unlanded edit; otherwise nothing is highlighted rather
 * than unrelated code. A stamped line selects its element's span (from the read) while
 * the open text still has the span's lines.
 */
export function revealRange(
  doc: Pick<Document, 'view' | 'baseline' | 'text'>,
  source: string,
  request?: SourceRange
): Shown {
  const lines = doc.text.replace(/\r\n/g, '\n').split('\n')
  const at = (start: number, count: number) => lines.slice(start - 1, start - 1 + count).join('\n')
  if (request) {
    const { startLine: start, endLine: end } = request
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
      return { range: null }
    if (typeof request.code !== 'string')
      return { range: end <= lines.length ? { startLine: start, endLine: end } : null }
    const code = request.code.replace(/\r\n/g, '\n'),
      count = code.split('\n').length
    if (count === end - start + 1 && end <= lines.length && at(start, count) === code)
      return { range: { startLine: start, endLine: end } }
    const first = code.split('\n')[0]
    const hits: number[] = []
    for (let line = 1; line + count - 1 <= lines.length && hits.length < 2; line++)
      if (lines[line - 1] === first && at(line, count) === code) hits.push(line)
    if (hits.length === 1) return { range: { startLine: hits[0], endLine: hits[0] + count - 1 } }
    return {
      range: null,
      error: hits.length
        ? 'The requested code appears more than once in this file, so no range is highlighted.'
        : 'This file does not contain the requested code yet (it may not have landed), so no range is highlighted.'
    }
  }
  const line = Number(source.match(LINE)?.[1])
  const { elementStart: start, elementEnd: end } = doc.view
  if (!line || !start || !end || line < start || line > end) return { range: null }
  const base = doc.baseline.replace(/\r\n/g, '\n').split('\n')
  const count = end - start + 1
  return end <= base.length && at(start, count) === base.slice(start - 1, end).join('\n')
    ? { range: { startLine: start, endLine: end } }
    : { range: null }
}

/**
 * Per-project drafts survive file navigation and window docking. Saves always compare
 * the disk baseline (by hash). Under the Swift owner an unsaved draft is also saved to
 * the service (S08), so a restart restores it; one whose file changed meanwhile comes
 * back as a conflict and is never saved over the newer file.
 */
export class NativeEditorController {
  readonly sessions = new Map<string, Session>()
  private readonly persisting = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(
    readonly invoke: (channel: string, ...args: any[]) => Promise<any>,
    readonly render: (state: NativeEditorState) => void,
    readonly preferences?: Pick<NativePreferences, 'get' | 'set'>
  ) {}
  session(root: string) {
    let session = this.sessions.get(root)
    if (!session) {
      session = {
        state: {
          root,
          visible: false,
          popped: false,
          files: [],
          source: '',
          document: null,
          text: '',
          revision: 0,
          dirty: false,
          busy: false,
          error: '',
          conflict: false
        },
        documents: new Map(),
        generation: 0,
        saving: new Set(),
        history: [],
        cursor: -1
      }
      this.sessions.set(root, session)
    }
    return session
  }
  publish(session: Session) {
    const doc = session.documents.get(session.state.source)
    Object.assign(session.state, {
      document: doc?.view ?? null,
      text: doc?.text ?? '',
      revision: doc?.revision ?? 0,
      dirty: !!doc && doc.text !== doc.baseline,
      conflict: doc?.conflict ?? false
    })
    session.state.wrap = this.preferences?.get(SOURCE_WRAP) !== '0'
    session.state.canBack = session.cursor > 0
    session.state.canForward = session.cursor < session.history.length - 1
    this.render({ ...session.state })
  }
  /** Opens `source` (`file[:line[:col]]`). A stamped line selects its element's span, and
   *  `range` (LKM-363) an exact one, both only where the open text (a draft included)
   *  still has those lines. Opening never writes and never replaces a draft. */
  async open(
    root: string,
    source?: string,
    popped?: boolean,
    navigating = false,
    range?: SourceRange
  ) {
    const session = this.session(root),
      generation = ++session.generation
    session.state.visible = true
    session.state.error = ''
    session.state.busy = true
    if (popped !== undefined) session.state.popped = popped
    this.publish(session)
    try {
      session.state.files = await this.invoke('source:tree', root)
      if (generation !== session.generation) return
      const requested = source
      source ||=
        session.state.source ||
        session.state.files.find((f) => /\.(tsx?|jsx?|svelte|html|css)$/.test(f)) ||
        session.state.files[0]
      if (source) {
        await this.read(session, source, generation)
        if (generation !== session.generation) return
        if (!navigating && session.history[session.cursor] !== source) {
          session.history.splice(session.cursor + 1)
          session.history.push(source)
          session.cursor = session.history.length - 1
        }
        const doc = session.documents.get(session.state.source)
        const shown =
          doc && requested ? revealRange(doc, requested, range) : { range: null as null }
        session.state.range = shown.range
        if (shown.error) session.state.error = shown.error
        session.state.reveal = (session.state.reveal ?? 0) + 1
      }
    } catch (error) {
      if (generation === session.generation) session.state.error = String(error)
    } finally {
      if (generation === session.generation) {
        session.state.busy = false
        this.publish(session)
      }
    }
  }
  async read(session: Session, source: string, generation: number, reload = false) {
    const file = source.replace(/:\d+(?::\d+)?$/, '')
    if (
      session.documents.get(file)?.text !== session.documents.get(file)?.baseline &&
      session.documents.has(file) &&
      !reload
    ) {
      session.state.source = file
      const line = source.match(/:(\d+)(?::\d+)?$/)?.[1],
        view = session.documents.get(file)!.view
      if (line && view.line !== Number(line)) {
        // The element span belongs to the old stamp line.
        view.line = Number(line)
        view.elementStart = view.elementEnd = undefined
      }
      return
    }
    const view: SourceView | null = await this.invoke(
      'source:read',
      session.state.root,
      /:\d+(?::\d+)?$/.test(source) ? source : `${source}:1:0`
    )
    if (generation !== session.generation) return
    if (!view) throw new Error('This source file is not available.')
    const previous = session.documents.get(view.file)
    if (!reload && previous && previous.text !== previous.baseline) {
      session.state.source = view.file
      const same = previous.view.code === view.code
      Object.assign(previous.view, {
        line: view.line,
        elementStart: same ? view.elementStart : undefined,
        elementEnd: same ? view.elementEnd : undefined
      })
      return
    }
    const doc: Document = {
      view,
      baseline: view.code,
      baseHash: view.hash,
      text: view.code,
      revision: (previous?.revision ?? 0) + 1,
      conflict: false
    }
    const restored = reload ? undefined : (await this.restored(session)).get(view.file)
    if (generation !== session.generation) return
    if (restored) {
      ;(await this.restored(session)).delete(view.file)
      if (restored.text !== view.code) {
        // Saving checks the draft's own base: a file changed since the draft refuses to be overwritten.
        Object.assign(doc, {
          text: restored.text,
          baseHash: restored.base,
          conflict: !!view.hash && restored.base !== view.hash
        })
      }
    }
    session.documents.set(view.file, doc)
    session.state.source = view.file
  }
  /** Drafts the owner kept for this project, loaded once per session. */
  restored(session: Session) {
    session.restored ??= this.invoke('source:drafts', session.state.root).then(
      (drafts: SourceDraft[] | undefined) =>
        new Map((Array.isArray(drafts) ? drafts : []).map((d) => [d.path, d])),
      () => new Map()
    )
    return session.restored
  }
  /** Keeps the owner's copy of a document's draft current (debounced); clean documents have none. */
  persist(session: Session, file: string, now = false) {
    const key = `${session.state.root}\0${file}`
    clearTimeout(this.persisting.get(key))
    this.persisting.delete(key)
    const write = () => {
      this.persisting.delete(key)
      const doc = session.documents.get(file)
      const request =
        doc && doc.text !== doc.baseline && doc.baseHash
          ? this.invoke('source:save-draft', session.state.root, file, doc.baseHash, doc.text)
          : this.invoke('source:clear-draft', session.state.root, file)
      void Promise.resolve(request).catch(() => {})
    }
    if (now) write()
    else this.persisting.set(key, setTimeout(write, 400))
  }
  async save(session: Session) {
    const source = session.state.source,
      doc = session.documents.get(source)
    if (!doc || doc.view.binary || doc.view.media || session.saving.has(source)) return
    const content = doc.text,
      baseline = doc.baseline
    session.saving.add(source)
    session.state.busy = true
    session.state.error = ''
    this.publish(session)
    try {
      const result: SourceWriteResult = await this.invoke(
        'source:write',
        session.state.root,
        `${source}:1:0`,
        baseline,
        content,
        doc.baseHash
      )
      if (!result.ok) {
        doc.conflict = !!result.conflict
        throw new Error(
          result.conflict
            ? 'The file changed on disk. Your draft is preserved. Reload to discard it, or copy it before reconciling.'
            : result.error || 'Save failed.'
        )
      }
      // An edit made while the write is in flight stays dirty against the saved version.
      doc.baseline = content
      doc.baseHash = result.hash
      doc.view.code = content
      doc.conflict = false
      this.persist(session, source, true)
    } catch (error) {
      session.state.error = String(error)
    } finally {
      session.saving.delete(source)
      session.state.busy = false
      this.publish(session)
    }
  }
  async action(action: NativeEditorAction) {
    const session = this.session(action.root)
    try {
      switch (action.action) {
        case 'back':
        case 'forward': {
          const cursor = session.cursor + (action.action === 'back' ? -1 : 1)
          if (cursor >= 0 && cursor < session.history.length) {
            session.cursor = cursor
            await this.open(action.root, session.history[cursor], undefined, true)
          }
          return
        }
        case 'open':
          await this.open(action.root, action.source, undefined, false, action.range)
          return
        case 'edit': {
          const doc = session.documents.get(action.source ?? session.state.source)
          if (
            doc &&
            typeof action.text === 'string' &&
            !doc.view.binary &&
            !doc.view.media &&
            (action.revision ?? -1) > doc.revision
          ) {
            doc.text = action.text
            doc.revision = action.revision!
            this.publish(session)
            this.persist(session, action.source ?? session.state.source)
          }
          return
        }
        case 'save':
          await this.save(session)
          return
        case 'reload':
          await this.read(session, session.state.source, ++session.generation, true)
          this.persist(session, session.state.source, true)
          break
        case 'hide':
          session.state.visible = false
          ++session.generation
          break
        case 'popout':
          session.state.popped = true
          break
        case 'dock':
          session.state.popped = false
          break
        // Wrap Lines (LKM-192) is one app-wide preference; every open editor follows it.
        case 'wrap':
          await this.preferences?.set(SOURCE_WRAP, action.wrap === false ? '0' : '1')
          for (const other of this.sessions.values()) if (other !== session) this.publish(other)
          break
        case 'component': {
          if (!action.name || !/^[A-Za-z_$][\w$]*$/.test(action.name)) return
          const source = await this.invoke(
            'source:resolve-component',
            action.root,
            session.state.source,
            action.name
          )
          if (source) await this.open(action.root, source)
          else session.state.error = `Could not resolve ${action.name}.`
          break
        }
        case 'create':
        case 'rename':
        case 'delete': {
          if (session.saving.size) throw new Error('Wait for the current save to finish.')
          const from = session.state.source
          const result = await this.invoke(
            `source:${action.action === 'create' ? 'create-file' : action.action === 'rename' ? 'rename-file' : 'delete-file'}`,
            action.root,
            action.action === 'create' ? action.name : from,
            ...(action.action === 'rename' ? [action.name] : [])
          )
          if (!result.ok) throw new Error(result.error || 'File operation failed.')
          if (action.action === 'rename') {
            const doc = session.documents.get(from)
            if (doc) {
              session.documents.delete(from)
              doc.view.file = result.path
              session.documents.set(result.path, doc)
              this.persist(session, from, true)
              this.persist(session, result.path, true)
            }
          }
          if (action.action === 'delete') {
            session.documents.delete(from)
            session.state.source = ''
            this.persist(session, from, true)
          }
          await this.open(action.root, result.path || undefined)
          return
        }
      }
      this.publish(session)
    } catch (error) {
      session.state.error = String(error)
      session.state.busy = false
      this.publish(session)
    }
  }
}
