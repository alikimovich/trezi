import type { SourceDraft } from '../main/source-owner'
import type { SourceView, SourceWriteResult } from '../shared/api'
import type { NativeEditorAction, NativeEditorState } from '../shared/native-editor'

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
    readonly render: (state: NativeEditorState) => void
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
    session.state.canBack = session.cursor > 0
    session.state.canForward = session.cursor < session.history.length - 1
    this.render({ ...session.state })
  }
  async open(root: string, source?: string, popped?: boolean, navigating = false) {
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
      const line = source.match(/:(\d+)(?::\d+)?$/)?.[1]
      if (line) session.documents.get(file)!.view.line = Number(line)
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
          await this.open(action.root, action.source)
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
