import type {
  IslandBlocker,
  IslandCommand,
  IslandHealth,
  IslandRecord,
  IslandValue,
  IslandView
} from '../shared/chat-islands'
import {
  IslandBindingError,
  islandHealth,
  islandProblem,
  islandStatus,
  nameIslands,
  plannedFailure,
  plannedLine
} from './chat-island-bindings'
import { islandMessageContext } from './chat-island-context'
import { islandDefinition } from './chat-island-schema'
import { islandSource, undoIsland, writeIsland } from './chat-island-source'
import { islandTool } from './chat-island-tool'
import { renderLiteral } from './control-manifest'
import { selectControlCandidates } from './control-selection'
import { cancelControlComposition } from './controls-jev'
import { type EditingOwner, editingOwner } from './editing-owner'
import type { IslandOverrides } from './island-overrides'
import { shadowBlockCss } from './shadow-controls'

export interface IslandSession {
  root: string
  recordId: string
  records: IslandRecord[]
  views: Map<string, IslandView>
  turn: () => number
  busy: boolean
  composing: boolean
  epoch: number
  writes: number
  preview?: { turn: number; view: IslandView }
  opening: Promise<void>
  pending?: Promise<void>
  /** island id → the bound values it last saw (its last refresh or its own last write). */
  seen: Map<string, Record<string, IslandValue>>
  /** island id → the inline notice after a bound value changed outside the island. */
  notices: Map<string, string>
  /** island id → param id → why the code no longer supports that field (LKM-181). */
  broken: Map<string, Record<string, string>>
  /** island id → its commit that has not started yet; a newer frame of the gesture replaces it. */
  queued: Map<string, Queued>
  /** `id:gesture` of gestures whose bound values changed outside the island; their frames are dropped. */
  conflicted: Set<string>
  /** island id → its running gesture's merged values; `live` once it must write every frame (LKM-133). */
  gestures: Map<string, { gesture: string; values: Record<string, IslandValue>; live: boolean }>
  drafts: Map<
    string,
    {
      revision: number
      sourceRevision: string
      values: Record<string, IslandValue>
      history: Record<string, IslandValue>[]
      preview: boolean
      submittedTurn?: string
    }
  >
}
type Session = IslandSession
interface Queued {
  command: IslandCommand
  replaced: boolean
}
/** Where a chat's islands live: its project root and owner record (LKM-199). */
export interface IslandLocation {
  root: string
  recordId: string
  turn: () => number
}
export type LocateIslands = (
  chat: string,
  wait: boolean
) => Promise<IslandLocation | IslandBlocker | null>
/** A chat's session, or why it has none (LKM-199). */
export type Attached = { session: Session } | { blocked: IslandBlocker }
export const ISLAND_CONFLICT_NOTICE =
  'This value changed in the source. The controls now show the source values.'
/**
 * The chat's islands as Bun shows and edits them. Every decision (definition
 * admission, activation by the defining turn's landing, command admission, the
 * revision chain of a queued batch, per-island Undo) and every history write belong to
 * the editing owner (S12: the Swift service; its history lives in the profile); this
 * class keeps the views, the composing preview and the JS helpers (definition
 * validation, Jev selection, literal resolution and hash-bound source proposals).
 */
export class ChatIslands {
  readonly sessions = new Map<string, Session>()
  readonly origin: (chat: string) => string | null
  private readonly given?: EditingOwner
  /** Shadow gestures shown in the preview, written once (LKM-140); without it every frame writes. */
  readonly overrides?: IslandOverrides
  private readonly applyDraft?: (chat: string, prompt: string) => Promise<string>
  /**
   * Finds a chat's record once its workspace is ready (a new chat's is prepared later);
   * without `wait` it answers at once, with why there is no record yet. Null is "no locator".
   */
  private readonly locate: LocateIslands
  private locating = new Map<string, Promise<Attached>>()
  constructor(
    readonly changed: (chat: string) => void,
    readonly select = selectControlCandidates,
    options: {
      owner?: EditingOwner
      origin?: (chat: string) => string | null
      overrides?: IslandOverrides
      locate?: LocateIslands
      applyDraft?: (chat: string, prompt: string) => Promise<string>
    } = {}
  ) {
    this.given = options.owner
    this.origin = options.origin ?? (() => null)
    this.overrides = options.overrides
    this.applyDraft = options.applyDraft
    this.locate = options.locate ?? (async (): Promise<null> => null)
  }
  get owner(): EditingOwner {
    return this.given ?? editingOwner()
  }
  register(chat: string, root: string, recordId: string, turn: () => number) {
    const existing = this.sessions.get(chat)
    if (existing?.root === root && existing.recordId === recordId) return
    this.close(chat)
    const session: Session = {
      root,
      recordId,
      records: [],
      views: new Map(),
      turn,
      busy: false,
      composing: false,
      epoch: 0,
      writes: 0,
      opening: Promise.resolve(),
      seen: new Map(),
      notices: new Map(),
      broken: new Map(),
      queued: new Map(),
      conflicted: new Set(),
      gestures: new Map(),
      drafts: new Map()
    }
    session.opening = this.owner
      .islandsOpen(chat, root, recordId)
      .then((records) => {
        if (this.sessions.get(chat) === session) session.records = validated(records)
      })
      .catch(() => {
        /* Missing/old history cannot prevent opening a chat. */
      })
    this.sessions.set(chat, session)
    void this.refresh(chat)
  }
  /**
   * The chat's session, registered when it is missing (LKM-199): a new chat's record
   * exists only once its workspace is prepared, so this waits for it. Undefined when the
   * chat closed or has no record; `attach` says which.
   */
  async ensure(chat: string): Promise<Session | undefined> {
    const attached = await this.attach(chat)
    return 'session' in attached ? attached.session : undefined
  }
  /**
   * The chat's session, or why it has none. With `wait` (the default) a pending workspace
   * is awaited and concurrent callers share one lookup; without it the answer is
   * immediate: a workspace that is ready is attached, one still being prepared is
   * reported as `workspace_pending`.
   */
  attach(chat: string, wait = true): Promise<Attached> {
    const known = this.sessions.get(chat)
    if (known) return Promise.resolve({ session: known })
    const settle = (found: IslandLocation | IslandBlocker | null): Attached => {
      if (found && 'recordId' in found && found.recordId) {
        this.register(chat, found.root, found.recordId, found.turn)
        const session = this.sessions.get(chat)
        if (session) return { session }
      }
      return { blocked: found && 'code' in found ? found : { code: 'no_session' } }
    }
    if (!wait) {
      if (this.locating.has(chat))
        return Promise.resolve({ blocked: { code: 'workspace_pending' } })
      return this.locate(chat, false)
        .catch((): null => null)
        .then((found) => {
          const session = this.sessions.get(chat)
          return session ? { session } : settle(found)
        })
    }
    let run = this.locating.get(chat)
    if (run) return run
    run = this.locate(chat, true)
      .catch((): null => null)
      .then((found): Attached => {
        // Closed while waiting: no session is registered for it.
        if (this.locating.get(chat) !== run) {
          const session = this.sessions.get(chat)
          return session ? { session } : { blocked: { code: 'closed' } }
        }
        this.locating.delete(chat)
        return settle(found)
      })
    this.locating.set(chat, run)
    return run
  }
  close(chat: string) {
    this.locating.delete(chat)
    cancelControlComposition(`island:${chat}`)
    this.overrides?.clearAll(`${chat}\n`)
    for (const id of this.sessions.get(chat)?.drafts.keys() ?? [])
      void this.overrides?.port.clear(`${chat}\n${id}`).catch(() => {})
    if (this.sessions.delete(chat)) void this.owner.islandsClose(chat).catch(() => {})
  }
  adopt(chat: string, session: IslandSession, records: IslandRecord[] | null) {
    if (records && this.sessions.get(chat) === session) session.records = validated(records)
  }
  /**
   * Re-reads every island's bindings (LKM-181): after a landing, a write, a file change
   * or a read. A binding the code no longer supports disables its field (with the reason),
   * all of them the island; what changed is saved with the record by the owner.
   */
  async refresh(chat: string) {
    const session = this.sessions.get(chat)
    if (!session) return
    await session.opening
    const epoch = ++session.epoch,
      writes = session.writes
    const views = new Map<string, IslandView>(),
      seen = new Map<string, Record<string, IslandValue>>(),
      broken = new Map<string, Record<string, string>>()
    const changes: {
      record: IslandRecord
      health: IslandHealth
      reason?: string
      reasons: Record<string, string>
    }[] = []
    /** Landed planned islands whose bindings all resolve now (LKM-201). */
    const activations: { record: IslandRecord; values: Record<string, IslandValue> }[] = []
    for (const record of session.records) {
      let values: Record<string, IslandValue> = {},
        sourceRevision = '',
        fieldReasons: Record<string, string> = {},
        check: { health: IslandHealth; reason?: string }
      const planned = record.planned && record.status === 'ready'
      try {
        const source = await islandSource(session.root, record)
        values = source.values
        sourceRevision = source.revision
        fieldReasons = source.broken
        check = islandHealth(record, fieldReasons)
        seen.set(record.id, values)
        if (planned && !Object.keys(fieldReasons).length) activations.push({ record, values })
        else if (planned) {
          fieldReasons = Object.fromEntries(
            Object.entries(fieldReasons).map(([id, line]) => [id, plannedLine(line)])
          )
          check = plannedFailure(record, fieldReasons)
        }
      } catch (error) {
        const problem =
          error instanceof IslandBindingError
            ? error.message
            : islandProblem(error, 'These controls can’t read their source right now.')
        check = planned
          ? plannedFailure(record, {}, problem)
          : { health: 'disabled', reason: problem }
      }
      // A waiting island's bindings are in its turn's worktree until that turn lands.
      if (record.status === 'waiting') fieldReasons = {}
      broken.set(record.id, fieldReasons)
      const state = islandStatus(record, check)
      if (
        record.status === 'ready' &&
        ((record.health ?? 'ready') !== check.health ||
          (record.reason ?? '') !== (check.reason ?? '') ||
          JSON.stringify(record.reasons ?? {}) !== JSON.stringify(fieldReasons))
      )
        changes.push({ record, ...check, reasons: fieldReasons })
      const draft = session.drafts.get(record.id)
      views.set(record.id, {
        id: record.id,
        name: `#${record.name}`,
        revision: record.revision,
        title: record.manifest.title,
        blocks: record.blocks,
        fields: record.manifest.params.map((p) => ({
          ...p,
          value: draft?.values[p.id] ?? values[p.id] ?? null,
          ...(fieldReasons[p.id] ? { disabled: fieldReasons[p.id] } : {})
        })),
        sourceRevision,
        ...state,
        detail:
          record.status === 'waiting'
            ? record.planned
              ? 'Pending: its bindings are planned. Controls activate after this turn lands and every binding resolves.'
              : 'Waiting for this turn’s source changes to land.'
            : (record.fallback ?? ''),
        engine: record.engine,
        replay: !!record.manifest.replay,
        notice: session.notices.get(record.id) ?? '',
        ...(draft
          ? {
              draft: {
                count: Object.keys(draft.values).length,
                preview: draft.preview,
                conflict:
                  draft.revision !== record.revision || draft.sourceRevision !== sourceRevision,
                submitted: !!draft.submittedTurn
              }
            }
          : {})
      })
    }
    if (this.sessions.get(chat) !== session || session.epoch !== epoch) return
    // A write since this read already recorded what its island sees.
    session.views = views
    session.broken = broken
    if (session.writes === writes) session.seen = seen
    this.changed(chat)
    // A landed planned island becomes an ordinary one, its landed values as `initial`.
    for (const { record, values } of activations)
      this.adopt(
        chat,
        session,
        await this.owner.islandActivate(chat, record.id, record.revision, values).catch(() => null)
      )
    // The status is persisted with the record, so a restart shows it before any read.
    for (const change of changes) {
      const records = await this.owner
        .islandHealth(
          chat,
          change.record.id,
          change.record.revision,
          change.health,
          change.reason,
          change.reasons
        )
        .catch(() => null)
      this.adopt(chat, session, records)
    }
  }
  /** A turn's terminal. `turn` names it; only islands that turn defined change. */
  async settle(chat: string, successful: boolean, turn: string | null = null) {
    const session = this.sessions.get(chat)
    if (!session) return
    await session.opening
    const settled = await this.owner.islandSettle(chat, turn, successful)
    if (settled.cancelled) cancelControlComposition(`island:${chat}`)
    this.adopt(chat, session, settled.records)
    await this.refresh(chat)
    for (const [id, draft] of session.drafts) {
      if (!draft.submittedTurn || draft.submittedTurn !== turn) continue
      const record = session.records.find((item) => item.id === id)
      const source =
        successful && record ? await islandSource(session.root, record).catch(() => null) : null
      if (
        source &&
        source.revision !== draft.sourceRevision &&
        Object.entries(draft.values).every(
          ([field, value]) => JSON.stringify(source.values[field]) === JSON.stringify(value)
        )
      ) {
        const ids = Object.keys(draft.values)
        const block = draft.preview
          ? record?.blocks.find(
              (item) => item.kind === 'shadow' && ids.every((field) => item.params.includes(field))
            )
          : undefined
        if (block && this.overrides) {
          const css = shadowBlockCss(block, source.values)
          const { port, timing } = this.overrides
          const deadline = Date.now() + timing.timeout
          let rendered = false
          while (Date.now() < deadline) {
            if (await port.settle(`${chat}\n${id}`, css).catch(() => null)) {
              rendered = true
              break
            }
            await new Promise((resolve) => setTimeout(resolve, timing.poll))
          }
          if (!rendered) {
            draft.submittedTurn = undefined
            continue
          }
        }
        session.drafts.delete(id)
        await this.overrides?.port.clear(`${chat}\n${id}`).catch(() => {})
      } else draft.submittedTurn = undefined
    }
    await this.refresh(chat)
  }
  attachments(chat: string) {
    const session = this.sessions.get(chat)
    if (!session) return []
    const attachments = session.records
      .filter((r) => r.id !== session.preview?.view.id)
      .map((r) => ({ turn: r.turn, view: session.views.get(r.id) }))
      .filter((r) => r.view)
    if (session.preview) attachments.push(session.preview)
    return attachments
  }
  tool(chat: string, sourceRoot: string, raw: any, connectionId?: string) {
    return islandTool(this, chat, sourceRoot, raw, connectionId)
  }
  /**
   * The island's … menu (LKM-181): Disable/Enable, Hide/Show and Show all hidden. Saved with
   * the record by the owner; Enable re-validates the bindings before the controls return.
   */
  async user(
    chat: string,
    id: string,
    action: 'disable' | 'enable' | 'hide' | 'show' | 'show-hidden'
  ) {
    const session = this.sessions.get(chat)
    if (!session) throw new Error('Island is unavailable. Reopen this chat.')
    await session.opening
    const targets =
      action === 'show-hidden'
        ? session.records.filter((r) => r.user === 'hidden')
        : session.records.filter((r) => r.id === id)
    if (!targets.length && action !== 'show-hidden')
      throw new Error('Island changed. Reload its controls.')
    if (action === 'enable') await this.refresh(chat)
    const state = action === 'disable' ? 'disabled' : action === 'hide' ? 'hidden' : null
    for (const record of targets) {
      if (state) await this.overrides?.clear(`${chat}\n${record.id}`)
      this.adopt(chat, session, await this.owner.islandMark(chat, record.id, state))
    }
    await this.refresh(chat)
  }
  /**
   * One island's commands run one at a time. A commit that has not started yet is replaced by
   * the next frame of the same gesture (latest value wins, values merged), so a fast drag never
   * races itself. Commits do not depend on the revision the UI last rendered: the write checks
   * the island's own bindings (see `writeIsland`). A Shadow island's gesture frames are shown
   * in the preview and written once instead (`gestureFrame`).
   */
  async interact(command: IslandCommand) {
    const session = this.sessions.get(command.chat)
    if (!session) throw new Error('Island is unavailable. Reopen this chat.')
    switch (command.action) {
      case 'disable':
      case 'enable':
      case 'hide':
      case 'show':
      case 'show-hidden':
        return this.user(command.chat, command.id, command.action)
      case 'reference':
      case 'recreate':
        throw new Error('Unknown island action.')
      case 'draft':
      case 'draft-reset':
      case 'undo-draft':
      case 'revert-draft':
      case 'apply-draft':
        return this.draftCommand(session, command)
    }
    if (this.overrides && command.action === 'commit' && command.gesture) {
      const live = await this.gestureFrame(session, command)
      if (!live) return
      command = { ...command, values: live }
    } else if (this.overrides && command.action !== 'commit')
      await this.overrides.clear(`${command.chat}\n${command.id}`)
    return this.enqueue(session, command)
  }
  private async draftCommand(session: Session, command: IslandCommand) {
    await session.opening
    const record = session.records.find((r) => r.id === command.id)
    const view = session.views.get(command.id)
    let draft = session.drafts.get(command.id)
    const dismissing = command.action === 'undo-draft' || command.action === 'revert-draft'
    const brokenDismissal =
      dismissing &&
      draft &&
      (!record ||
        !view ||
        record.revision !== command.revision ||
        !['ready', 'partially-disabled'].includes(view.status) ||
        draft.sourceRevision !== view.sourceRevision)
    if (brokenDismissal && draft) {
      if (
        command.sourceRevision !== draft.sourceRevision &&
        command.sourceRevision !== view?.sourceRevision
      )
        throw new Error('This island draft changed. Reload its controls.')
      if (draft.submittedTurn) throw new Error('Apply is in progress.')
      if (command.action === 'undo-draft') {
        draft.values = draft.history.pop() ?? {}
        if (!Object.keys(draft.values).length) session.drafts.delete(command.id)
      } else session.drafts.delete(command.id)
      await this.overrides?.port.clear(`${command.chat}\n${command.id}`).catch(() => {})
      await this.refresh(command.chat)
      return
    }
    if (
      !record ||
      !view ||
      record.revision !== command.revision ||
      !['ready', 'partially-disabled'].includes(view.status) ||
      session.composing ||
      session.busy
    )
      throw new Error('This island changed or is unavailable. Reload its controls.')
    draft = session.drafts.get(record.id)
    if (draft?.submittedTurn) throw new Error('Apply is in progress.')
    const key = `${command.chat}\n${record.id}`
    if (command.action === 'draft' || command.action === 'draft-reset') {
      if (
        view.sourceRevision !== command.sourceRevision ||
        (draft && draft.sourceRevision !== view.sourceRevision)
      )
        throw new Error('Source changed while this preview draft was pending.')
      // Reset is a preview gesture too. Keep the original values in the draft
      // until Apply, and leave bindings that no longer exist or are broken alone.
      const values =
        command.action === 'draft-reset'
          ? Object.fromEntries(
              Object.entries(record.initial).filter(([id]) =>
                view.fields.some((field) => field.id === id && !field.disabled)
              )
            )
          : (command.values ?? {})
      if (!Object.keys(values).length) return
      for (const [id, value] of Object.entries(values)) {
        const field = view.fields.find((f) => f.id === id)
        if (!field || field.disabled) throw new Error('This control is no longer editable.')
        if (command.action === 'draft') {
          const rendered = renderLiteral(field.kind, value, field)
          if (typeof rendered !== 'string') throw new Error(rendered.error)
        }
      }
      if (!draft) {
        draft = {
          revision: record.revision,
          sourceRevision: view.sourceRevision,
          values: {},
          history: [],
          preview: false
        }
        session.drafts.set(record.id, draft)
      }
      draft.history.push({ ...draft.values })
      draft.values = { ...draft.values, ...values }
    } else if (command.action === 'undo-draft') {
      if (!draft) return
      draft.values = draft.history.pop() ?? {}
      if (!Object.keys(draft.values).length) session.drafts.delete(record.id)
    } else if (command.action === 'revert-draft') {
      session.drafts.delete(record.id)
    } else {
      if (!draft) return
      if (draft.revision !== record.revision || draft.sourceRevision !== view.sourceRevision)
        throw new Error('Source changed while this preview draft was pending. Review or revert it.')
      const source = await islandSource(session.root, record)
      if (source.revision !== draft.sourceRevision)
        throw new Error('Source changed while this preview draft was pending. Review or revert it.')
      if (!this.applyDraft) throw new Error('Apply requires an active chat agent.')
      const values = draft.values
      const prompt = `Apply these chat-island preview drafts as one source edit in this chat workspace. Verify the exact source revision before writing, preserve other edits, and confirm the rendered preview after the source reload. Island ${record.id}; source ${record.manifest.file}; revision ${draft.sourceRevision}. Values: ${JSON.stringify(values)}. Bindings: ${JSON.stringify(record.manifest.params.filter((param) => Object.hasOwn(values, param.id)).map((param) => ({ id: param.id, apply: param.apply })))}.`
      draft.submittedTurn = await this.applyDraft(command.chat, prompt)
      await this.refresh(command.chat)
      return
    }
    draft = session.drafts.get(record.id)
    if (draft && this.overrides) {
      const ids = Object.keys(draft.values)
      const block = record.blocks.find(
        (b) => b.kind === 'shadow' && ids.every((id) => b.params.includes(id))
      )
      if (block) {
        const base = session.seen.get(record.id) ?? {}
        const shown = await this.overrides.port
          .apply(
            key,
            shadowBlockCss(block, base),
            shadowBlockCss(block, { ...base, ...draft.values })
          )
          .catch(() => 0)
        draft.preview = shown > 0
      } else draft.preview = false
    } else await this.overrides?.port.clear(key).catch(() => {})
    await this.refresh(command.chat)
  }
  /**
   * LKM-140: a frame of a Shadow island gesture. The preview shows the derived box-shadow at
   * once and the source is written at the gesture's end, so no HMR update runs mid-drag.
   * Returns the values to write now when the frame is not shown that way.
   */
  private async gestureFrame(
    session: Session,
    command: IslandCommand
  ): Promise<Record<string, IslandValue> | null> {
    const record = session.records.find(
      (r) => r.id === command.id && r.revision === command.revision && r.status === 'ready'
    )
    if (!record || session.composing) return command.values ?? {}
    // Only a gesture whose values all belong to one Shadow block is shown in the preview; any
    // other control (group, point, a second shadow block) keeps its per-frame live writes (LKM-133).
    let state = session.gestures.get(command.id)
    if (!state || state.gesture !== command.gesture) {
      state = { gesture: command.gesture!, values: {}, live: false }
      session.gestures.set(command.id, state)
    }
    state.values = { ...state.values, ...command.values }
    if (state.live) return command.values ?? {}
    const keys = Object.keys(state.values)
    const block = keys.length
      ? record.blocks.find(
          (b) => b.kind === 'shadow' && keys.every((key) => b.params.includes(key))
        )
      : undefined
    if (!block) {
      // The gesture is (or became) another control's: show the source, write every frame from now on.
      state.live = true
      const key = `${command.chat}\n${command.id}`
      const shown = this.overrides!.holds(key)
      if (shown) await this.overrides!.clear(key)
      return shown ? { ...state.values } : (command.values ?? {})
    }
    const conflict = `${command.id}:${command.gesture}`
    if (session.conflicted.has(conflict)) return null
    const source = () => session.seen.get(record.id) ?? {}
    return this.overrides!.frame({
      key: `${command.chat}\n${command.id}`,
      gesture: command.gesture!,
      values: command.values ?? {},
      ended: !!command.ended,
      from: () => shadowBlockCss(block, source()),
      css: (values) => shadowBlockCss(block, { ...source(), ...values }),
      write: async (values) => {
        await this.enqueue(session, { ...command, values })
        return session.conflicted.has(conflict) ? 'conflict' : 'written'
      }
    })
  }
  private async enqueue(session: Session, command: IslandCommand) {
    let queued: Queued | undefined
    if (command.action === 'commit') {
      const waiting = session.queued.get(command.id)
      if (
        waiting &&
        command.gesture &&
        waiting.command.gesture === command.gesture &&
        waiting.command.revision === command.revision
      ) {
        waiting.replaced = true
        command = { ...command, values: { ...waiting.command.values, ...command.values } }
      }
      queued = { command, replaced: false }
      session.queued.set(command.id, queued)
    }
    const previous = session.pending
    const run = (async () => {
      if (previous) await previous.catch(() => {})
      if (queued) {
        if (session.queued.get(command.id) === queued) session.queued.delete(command.id)
        if (queued.replaced) return
      }
      if (this.sessions.get(command.chat) !== session)
        throw new Error('This island changed or closed.')
      await this.apply(session, command, () => session.pending === run)
    })()
    session.pending = run
    try {
      await run
    } finally {
      if (session.pending === run) session.pending = undefined
    }
  }
  private async apply(session: Session, command: IslandCommand, last: () => boolean) {
    await session.opening
    if (session.busy || session.composing) throw new Error('Island is unavailable or busy.')
    // A gesture whose bound values changed outside the island stops writing; the controls show the source.
    const gesture = command.gesture ? `${command.id}:${command.gesture}` : ''
    if (command.action === 'commit' && session.conflicted.has(gesture)) return
    // Admission (ready, current definition revision, one command at a time) is the owner's.
    const admission = await this.owner
      .islandCommand(
        command.chat,
        command.id,
        command.revision,
        command.action === 'replay'
          ? 'reload'
          : (command.action as 'commit' | 'reset' | 'undo' | 'reload'),
        command.sourceRevision
      )
      .catch((error) => {
        throw this.sessions.get(command.chat) === session
          ? error
          : new Error('This island changed or closed.')
      })
    if (command.action !== 'commit') {
      session.notices.delete(command.id)
      session.conflicted.clear()
    }
    if (command.action === 'reload') {
      await this.refresh(command.chat)
      return
    }
    const record = session.records.find((r) => r.id === command.id)!
    session.busy = true
    const guard = () =>
      this.sessions.get(command.chat) === session &&
      session.records.some(
        (r) => r.id === record.id && r.revision === record.revision && r.status === 'ready'
      )
    let outcome: { ok: boolean; group?: string; revision?: string } = { ok: false }
    try {
      if (command.action === 'undo') {
        await undoIsland(session.root, admission.group!, guard)
        outcome = { ok: true }
      } else if (command.action === 'commit' || command.action === 'reset') {
        const reset = command.action === 'reset'
        // Reset leaves a field the code no longer supports alone (LKM-181).
        const broken = session.broken.get(record.id) ?? {}
        const values = reset
          ? Object.fromEntries(
              Object.entries(admission.initial ?? record.initial).filter(([id]) => !(id in broken))
            )
          : command.values!
        // Reset restores the initial values whatever the source holds now.
        const result = await writeIsland(
          session.root,
          record,
          reset ? undefined : session.seen.get(record.id),
          values,
          guard,
          command.gesture ? `island:${record.id}:${command.gesture}` : undefined,
          session.drafts.get(record.id)?.sourceRevision
        )
        if (result) {
          session.writes++
          session.seen.set(record.id, result.values)
        }
        if (result?.conflict) {
          session.notices.set(record.id, ISLAND_CONFLICT_NOTICE)
          if (gesture) session.conflicted.add(gesture)
          outcome = { ok: true }
        } else {
          if (!reset) session.notices.delete(record.id)
          outcome = result
            ? { ok: true, group: result.group, revision: result.revision }
            : { ok: true }
        }
      } else throw new Error('Unknown island action.')
    } finally {
      session.busy = false
      await this.owner.islandFinish(command.chat, admission.ticket, outcome, last()).catch(() => {})
    }
    // Other islands may expose the same source values.
    await Promise.all(
      [...this.sessions]
        .filter(([, s]) => s.root === session.root)
        .map(([key]) => this.refresh(key))
    )
  }
}
/** Bun re-validates each stored definition for display; one that fails stays hidden. */
function validated(records: IslandRecord[]): IslandRecord[] {
  return nameIslands(
    records.flatMap((record) => {
      try {
        return [{ ...record, ...islandDefinition(record) }]
      } catch {
        return []
      }
    })
  )
}
let installed: ChatIslands | undefined
export function installChatIslands(service: ChatIslands) {
  installed = service
}
/**
 * LKM-216: the live tree changed, so every island of the project re-reads its bound
 * values. An island in a gesture is skipped; its own write refreshes it when it ends.
 */
export function refreshChatIslands(root: string) {
  if (!installed) return Promise.resolve()
  const service = installed
  return Promise.all(
    [...service.sessions]
      .filter(([, session]) => session.root === root && !session.busy && !session.gestures.size)
      .map(([chat]) => service.refresh(chat))
  ).then(() => {})
}
export function runChatIslandTool(
  chat: string,
  sourceRoot: string,
  raw: unknown,
  connectionId?: string
) {
  return (
    installed?.tool(chat, sourceRoot, raw, connectionId) ??
    Promise.resolve({ error: 'Native chat islands are not available.' })
  )
}

/**
 * Provider-only context; never persisted as part of the user's visible message. Islands
 * the message names (`#island-…`) come with their whole definition (LKM-181).
 */
export async function chatIslandContext(chat: string, text = '') {
  if (!installed) return ''
  // A new chat's first send registers its islands (LKM-199).
  const session = await installed.ensure(chat)
  if (session) await installed.refresh(chat)
  if (!session) return ''
  return islandMessageContext(
    session.records,
    installed.attachments(chat).map(({ view }) => view),
    text
  )
}
