import { sourceOwner } from '../main/source-owner'
import { isClassSelector, matchingUtilityClass } from '../main/tw-styles'
import type {
  PropInspection,
  ResolvedControlPanel,
  SelectedElement,
  StyleReadResult,
  TokenSet
} from '../shared/api'
import type { AppAction } from '../shared/app-action'
import { animationControlsPrompt } from '../shared/controls-prompt'
import { numericValue, STYLE_PROP_META, sameCssValue, toCssText } from '../shared/css-values'
import type {
  NativeInspectorAction,
  NativeInspectorField,
  NativeInspectorState
} from '../shared/native-inspector'
import { projectRelative } from '../shared/project-path'
import { describeSelectionForPrompt } from '../shared/selection-context'
import { tokensForProp } from '../shared/token-match'
import { applySummary } from './inspector-apply'
import {
  type ApplyBatch,
  batchesLabel,
  composeLayers,
  draftProps,
  restoreUnder,
  type StyleDraft
} from './inspector-batches'
import {
  type PreviewFreshness,
  type PreviewRefreshOutcome,
  refreshRefusal
} from './inspector-preview-refresh'

type Binding = {
  apply(value: string): Promise<any>
  preview?(value: string): Promise<any>
  reset?(): Promise<any>
  token?(value: string): Promise<any>
  tokenValue?(value: string): string
}
type HeldDraft = {
  drafts: Map<string, StyleDraft>
  history: Map<string, StyleDraft>[]
  conflict: boolean
  /** Why a submitted batch came back, shown once its element is selected again. */
  reason?: string
}
/**
 * LKM-599: the immutable instruction for one Apply, captured when it is dispatched. Paths
 * are project-relative (LKM-151): the background agent edits its own checkout, never the
 * live one. The hashes are the versions the draft was staged on, read from the live project.
 */
export function applyDraftsPrompt(
  element: SelectedElement | null,
  root: string,
  edits: string[]
): string {
  const source = element?.source ? projectRelative(element.source, root) : ''
  return `Apply this single batch of Styles preview drafts to the actual application source. Target ${element?.selector ?? ''} from ${source}. Change only these properties of this element and preserve all other edits. If the file no longer holds this element, or it differs from the staged version in a way that touches this element, make no change and say why. Refuse an unsupported target. Judge this by the source only: Trezi checked the staged hashes before starting and refreshes its own preview when these files need it, so a preview identity marked stale is not a reason to refuse, and you do not need to reload the preview. Edits:\n${edits.join('\n')}`
}
/** Exact submitted turns survive another chat or workspace starting its own Apply. */
export class InspectorDraftTurns {
  private readonly pending = new Map<string, Set<string>>()
  add(chat: string, turn: string) {
    const turns = this.pending.get(chat) ?? new Set<string>()
    turns.add(turn)
    this.pending.set(chat, turns)
  }
  take(chat: string, turn: string | null): string[] {
    const turns = this.pending.get(chat)
    if (!turns) return []
    const matched = turn ? (turns.has(turn) ? [turn] : []) : [...turns]
    for (const item of matched) turns.delete(item)
    if (!turns.size) this.pending.delete(chat)
    return matched
  }
}
export class NativeInspectorController {
  readonly state: NativeInspectorState = {
    root: '',
    generation: 0,
    visible: false,
    title: 'Inspector',
    tab: 'styles',
    fields: [],
    actions: [],
    error: '',
    busy: false,
    updated: 0,
    edits: 0
  }
  requestedFile: string | null = null
  expanded = new Set<string>()
  element: SelectedElement | null = null
  /** LKM-600: whether the preview document predates a change to the draft's files. */
  previewFreshness: (root: string, files: string[]) => Promise<PreviewFreshness> = async () =>
    'current'
  /** LKM-600: one bounded preview reload that re-resolves `element` uniquely. */
  refreshPreview: (
    root: string,
    element: SelectedElement,
    still: () => boolean
  ) => Promise<PreviewRefreshOutcome> = async () => 'timeout'
  /** Every selection change, null when cleared; Layers follows it (LKM-179). */
  onElement: (element: SelectedElement | null) => void = () => {}
  inspection: PropInspection | null = null
  controls: ResolvedControlPanel[] = []
  tokens: TokenSet | null = null
  styles: StyleReadResult | null = null
  classRule: { file: string; className: string } | null = null
  readonly bindings = new Map<string, Binding>()
  private draftTarget = ''
  /** LKM-638: the editable draft (B). Submitted batches never share this map. */
  private drafts = new Map<string, StyleDraft>()
  private draftHistory: Map<string, StyleDraft>[] = []
  private draftConflict = false
  private previewAvailable = false
  private readonly heldDrafts = new Map<string, HeldDraft>()
  /** LKM-638: submitted Apply batches (A), oldest first, across elements and projects. */
  private readonly batches: ApplyBatch[] = []
  private batchKey = 0
  /**
   * LKM-638: a file hash a landed batch moved to, by `root\0file\0hash` it was staged on.
   * Drafts staged on the old hash describe the same intent over the landed change.
   */
  private readonly rebased = new Map<string, string>()
  private follow(root: string, file: string, hash: string) {
    // A file that returns to an earlier version would make a cycle: stop before repeating.
    const seen = new Set([hash])
    for (;;) {
      const next = this.rebased.get(`${root}\0${file}\0${hash}`)
      if (!next || seen.has(next)) return hash
      seen.add(next)
      hash = next
    }
  }
  /** Every draft not yet sent: the editable one, held ones and queued batches. */
  private unsentDrafts() {
    return [
      ...this.drafts.values(),
      ...[...this.heldDrafts.values()].flatMap((held) => [...held.drafts.values()]),
      ...this.batches
        .filter((batch) => batch.status === 'queued')
        .flatMap((batch) => [...batch.drafts.values()])
    ]
  }
  /** An unreported batch on this file: its source may move under the drafts at any time. */
  private waitingOn(root: string, file: string) {
    return this.batches.some(
      (batch) =>
        batch.root === root &&
        batch.status !== 'landed' &&
        [...batch.drafts.values()].some((draft) => draft.file === file)
    )
  }
  /** Whether `drafts` are still current: same source, or waiting on a batch over that file. */
  private async draftsCurrent(root: string, drafts: Iterable<StyleDraft>) {
    const checks = await Promise.all(
      [...drafts].map(
        async (draft) =>
          this.waitingOn(root, draft.file) ||
          (await sourceOwner().read(root, draft.file)).hash ===
            this.follow(root, draft.file, draft.hash)
      )
    ).catch(() => [false])
    return checks.every(Boolean)
  }
  /** The selected element's submitted batches, oldest first. */
  private targetBatches() {
    const target = this.target()
    return target
      ? this.batches.filter((batch) => batch.root === this.state.root && batch.target === target)
      : []
  }
  private holdDraft() {
    if (!this.draftTarget) return
    if (this.drafts.size)
      this.heldDrafts.set(this.draftTarget, {
        drafts: new Map(this.drafts),
        history: this.draftHistory.map((step) => new Map(step)),
        conflict: this.draftConflict
      })
    else this.heldDrafts.delete(this.draftTarget)
  }
  private async resumeDraft() {
    const target = this.target()
    const held = this.heldDrafts.get(target)
    if (!held) return
    const root = this.state.root
    const generation = this.state.generation
    // A batch can come back while another project is active. Its source must be
    // checked again before a restored draft can Apply.
    const current = await this.draftsCurrent(root, held.drafts.values())
    if (
      this.state.root !== root ||
      this.state.generation !== generation ||
      this.target() !== target
    )
      return
    this.heldDrafts.delete(target)
    this.draftTarget = target
    this.drafts = held.drafts
    this.draftHistory = held.history
    this.draftConflict = held.conflict || !current
    if (held.reason) this.state.error = held.reason
  }
  private target() {
    const e = this.element
    return e ? JSON.stringify([this.state.root, e.source, e.tag, e.id, e.selector]) : ''
  }
  private styleSourceFile(field: string) {
    const prop = field
      .slice(6)
      .replace(/-horizontal$/, '-left')
      .replace(/-vertical$/, '-top')
    const origin = this.styles?.origins?.[prop]
    const source = this.element?.source?.replace(/:\d+(?::\d+)?$/, '')
    return origin?.kind === 'inline' ? source : (this.classRule?.file ?? source)
  }
  private publishDraft() {
    const batches = this.targetBatches()
    this.state.draft =
      this.drafts.size || batches.length
        ? {
            count: this.drafts.size,
            submitted: batches.some((batch) => batch.status !== 'landed'),
            conflict: this.draftConflict,
            preview: this.previewAvailable,
            applying: batchesLabel(batches),
            landed: batches.some((batch) => batch.status === 'landed')
          }
        : undefined
    this.publish()
  }
  /** Submitted batches, then the editable draft, shown in the fields (later wins). */
  private overlay() {
    const layers = [...this.targetBatches().map((batch) => batch.drafts), this.drafts]
    for (const layer of layers)
      for (const draft of layer.values()) {
        const field = this.state.fields.find((item) => item.id === draft.field)
        if (field) field.value = draft.value
      }
  }
  /**
   * LKM-638: the preview shows every submitted batch of this element, then the editable
   * draft above them. Only overrides no layer drives any more are removed, so a value that
   * stays never flashes through the authored style on the way.
   */
  private async projectDrafts() {
    // Rebuild from the last source read before overlaying the current layers. Otherwise
    // Undo, Revert and a restored held draft can leave the controls displaying values
    // from a draft that is no longer present.
    this.build()
    this.overlay()
    let unavailable = ''
    for (const draft of this.drafts.values()) {
      const binding = this.bindings.get(draft.field)
      if (
        (this.state.tab === 'styles' && !binding?.preview) ||
        this.styleSourceFile(draft.field) !== draft.file
      ) {
        unavailable = 'Error: The selected style binding changed.'
        break
      }
    }
    const layers = this.targetBatches().map((batch) => batch.drafts)
    if (!unavailable) layers.push(this.drafts)
    try {
      await this.showLayers(composeLayers(layers))
    } catch (error) {
      unavailable = String(error)
      await this.send('styles:clear-preview', {}).catch(() => {})
    }
    this.previewAvailable = !unavailable && this.drafts.size > 0
    if (unavailable) this.state.error = `Live preview is unavailable: ${unavailable}`
    this.publishDraft()
  }
  /** Overrides other than `composed` are restored; each composed value is (re)applied. */
  private async showLayers(composed: Map<string, string>) {
    const adopt = [...this.adopting].filter((prop) => !composed.has(prop))
    this.adopting.clear()
    await this.send('styles:clear-preview', {
      ...(composed.size ? { keep: [...composed.keys()] } : {}),
      ...(adopt.length ? { adopt } : {})
    })
    for (const [prop, value] of composed) await this.send('styles:preview', { prop, value })
  }
  /**
   * LKM-638: a landed batch retires once the preview renders its values without the
   * override (`base`: the computed value with Trezi's overrides lifted, read in one task so
   * nothing paints). A property a later batch also drives is that batch's to confirm.
   * Worker completion or a new document alone is not proof. Returns whether one retired.
   */
  private confirmLanded() {
    const styles = this.styles
    if (!styles?.values) return false
    const list = this.targetBatches()
    const shown = composeLayers([...list.map((batch) => batch.drafts), this.drafts])
    let retired = false
    list.forEach((batch, index) => {
      if (batch.status !== 'landed') return
      const adopt = new Set<string>()
      const later = composeLayers(list.slice(index + 1).map((other) => other.drafts))
      for (const [prop, value] of composeLayers([batch.drafts])) {
        if (later.has(prop)) continue
        const lifted = styles.base?.[prop]
        const base = lifted ?? styles.values[prop]
        if (base === undefined) return
        const specified = styles.specified?.[prop]
        const rendered =
          sameCssValue(prop, base, value) ||
          // The override's own computed value (e.g. 1rem as 16px) equals the lifted one.
          (lifted !== undefined && shown.get(prop) === value && styles.values[prop] === lifted) ||
          (specified !== undefined && sameCssValue(prop, specified, value))
        if (rendered) continue
        // A JSX `style={}` value shares the override's inline slot: a page re-render that
        // writes the same value leaves no trace to read. Once the page updated after the
        // landing, the inline value is the source's own; it is adopted, never restored to
        // the value stashed before (which would snap back).
        if (
          styles.origins?.[prop]?.kind === 'inline' &&
          batch.landedAt !== undefined &&
          this.invalidations > batch.landedAt &&
          shown.get(prop) === value
        ) {
          adopt.add(prop)
          continue
        }
        return
      }
      for (const prop of adopt) this.adopting.add(prop)
      this.batches.splice(this.batches.indexOf(batch), 1)
      retired = true
    })
    return retired
  }
  /** Page updates seen (`invalidated` calls), to order them after a landing. */
  private invalidations = 0
  /** Inline properties whose override the next projection drops without restoring. */
  private readonly adopting = new Set<string>()
  /** LKM-599: a background Apply that finished before its dispatch was recorded. */
  private readonly early = new Map<string, { success: boolean; reason?: string }>()
  /** Batches whose reported success is being checked against their source. */
  private readonly settling = new Map<ApplyBatch, string>()
  /**
   * The Apply operation `turn` (a chat turn, or a background Apply's id) finished.
   * Only the batch dispatched under that id settles: a result for an id no batch holds
   * changes nothing, so a late result never clears, replaces or completes a newer draft.
   * `reason` is shown when it did not land. `dispatched` marks an id this inspector sent
   * whose result may arrive before the dispatch is recorded.
   */
  async settleDraftTurn(success: boolean, turn?: string, reason?: string, dispatched = false) {
    const running = (batch: ApplyBatch) => batch.status === 'running'
    const batch = turn
      ? this.batches.find((item) => item.id === turn)
      : (this.targetBatches().filter(running).at(-1) ?? this.batches.filter(running).at(-1))
    if (!batch) {
      if (turn && dispatched) this.early.set(turn, { success, reason })
      return
    }
    if (batch.status !== 'running') return
    if (this.settling.has(batch)) {
      // A failure reported while its success is being checked wins once the check ends.
      if (!success)
        this.settling.set(batch, reason ?? 'Apply failed. The preview draft is still pending.')
      return
    }
    if (!success) {
      await this.failBatch(batch, reason ?? 'Apply failed. The preview draft is still pending.')
      return
    }
    // A reported success is not proof that it edited the requested source: the file must
    // have moved off the staged version. The new version is where drafts staged on the
    // old one now sit (LKM-638 rebase); the preview confirms the values later.
    const files = new Map<string, string>()
    for (const draft of batch.drafts.values())
      if (!files.has(draft.file)) files.set(draft.file, draft.hash)
    this.settling.set(batch, '')
    const moved = await Promise.all(
      [...files].map(async ([file, hash]) => {
        const staged = this.follow(batch.root, file, hash)
        const now = (await sourceOwner().read(batch.root, file)).hash
        if (now && now !== staged) {
          this.rebased.set(`${batch.root}\0${file}\0${staged}`, now)
          // Drafts staged on an intermediate version while this batch was writing.
          for (const draft of this.unsentDrafts())
            if (draft.file === file && draft.during?.has(batch.key)) {
              const at = this.follow(batch.root, file, draft.hash)
              if (at !== now) this.rebased.set(`${batch.root}\0${file}\0${at}`, now)
            }
        }
        return !!now && now !== staged
      })
    ).catch(() => [false])
    const failure = this.settling.get(batch)
    this.settling.delete(batch)
    if (!this.batches.includes(batch)) return
    if (failure) {
      await this.failBatch(batch, failure)
      return
    }
    if (!moved.every(Boolean)) {
      await this.failBatch(
        batch,
        'Apply did not confirm source and rendered preview. The draft is still pending.'
      )
      return
    }
    batch.status = 'landed'
    batch.landedAt = this.invalidations
    await this.pump()
    if (batch.root === this.state.root && batch.target === this.target())
      await this.reconcileLayers()
    else this.publishDraft()
  }
  /**
   * Re-reads the selected element and retires what its preview now renders. Never clears
   * the preview first: a layer that stays is re-applied, a retired one is already shown.
   */
  private async reconcileLayers() {
    const root = this.state.root,
      target = this.target()
    await this.refresh(true)
    if (root !== this.state.root || target !== this.target()) return
    this.confirmLanded()
    await this.projectDrafts()
  }
  /**
   * LKM-638: a batch that did not land (failed, cancelled, refused before dispatch, source
   * conflict) returns beneath the newer draft of its element, with its reason; nothing is
   * re-sent. Its element shows it now, or when it is selected again.
   */
  private async failBatch(batch: ApplyBatch, reason: string, conflict = false) {
    const at = this.batches.indexOf(batch)
    if (at < 0) return
    this.batches.splice(at, 1)
    const later = this.batches
      .slice(at)
      .filter((other) => other.root === batch.root && other.target === batch.target)
      .map((other) => other.drafts)
    if (batch.root === this.state.root && batch.target === this.target()) {
      this.drafts = restoreUnder(batch.drafts, this.drafts, later)
      this.draftHistory = this.returnedHistory(batch, this.draftHistory, later)
      this.draftTarget = batch.target
      this.draftConflict ||= conflict
      this.state.error = reason
      await this.projectDrafts()
    } else {
      const held: HeldDraft = this.heldDrafts.get(batch.target) ?? {
        drafts: new Map(),
        history: [],
        conflict: false
      }
      held.drafts = restoreUnder(batch.drafts, held.drafts, later)
      held.history = this.returnedHistory(batch, held.history, later)
      held.conflict ||= conflict
      held.reason = reason
      this.heldDrafts.set(batch.target, held)
    }
    await this.pump()
  }
  /** Undo after a batch came back: the newer draft's steps (over it), then its own steps. */
  private returnedHistory(
    batch: ApplyBatch,
    history: Map<string, StyleDraft>[],
    later: ReadonlyMap<string, StyleDraft>[]
  ) {
    return [
      ...batch.history.map((step) => restoreUnder(step, new Map(), later)),
      ...history.map((step) => restoreUnder(batch.drafts, step, later))
    ]
  }
  /**
   * Starts every queued batch whose files no earlier unreported batch is writing. Source
   * mutation stays ordered per file: B starts only after A reported its result.
   */
  private async pump() {
    for (const batch of [...this.batches]) {
      if (batch.status !== 'queued') continue
      const at = this.batches.indexOf(batch)
      const files = new Set([...batch.drafts.values()].map((draft) => draft.file))
      const blocked = this.batches
        .slice(0, at)
        .some(
          (other) =>
            other.root === batch.root &&
            (other.status === 'starting' || other.status === 'running') &&
            [...other.drafts.values()].some((draft) => files.has(draft.file))
        )
      const away =
        batch.needsElement && (batch.root !== this.state.root || batch.target !== this.target())
      if (!blocked && !away) await this.startBatch(batch)
    }
  }
  /**
   * LKM-599/600/638: preflight and dispatch of one batch. Its drafts are the ones captured
   * at Apply; staging the next draft meanwhile cannot change them. A source change refuses
   * it as a conflict; an out-of-date preview is refreshed once while its element is
   * selected. Anything that stops it returns the batch beneath the newer draft.
   */
  private async startBatch(batch: ApplyBatch) {
    batch.status = 'starting'
    this.publishDraft()
    const root = batch.root
    const drafts = [...batch.drafts.values()]
    const anchored = () => root === this.state.root && this.target() === batch.target
    // LKM-581: a selection change during the reads holds this batch for its own element;
    // never flag, or submit against, the new selection.
    const selected = anchored()
    const moved = () => selected && !anchored()
    let conflict = false
    const verify = async () => {
      for (const draft of drafts) {
        if (anchored() && draft.file !== this.styleSourceFile(draft.field))
          throw new Error('The selected source file changed. Review or revert the preview draft.')
        const current = await sourceOwner().read(root, draft.file)
        if (moved())
          throw new Error('The selected element changed. The preview draft is still pending.')
        if (current.hash !== this.follow(root, draft.file, draft.hash)) {
          conflict = true
          throw new Error(
            'Source changed while the preview draft was pending. Review or revert it.'
          )
        }
      }
    }
    try {
      await verify()
      // LKM-600: the app, not the agent, brings an out-of-date preview current: one bounded
      // reload that re-resolves this element, then the same source checks.
      const files = [...new Set(drafts.map((draft) => projectRelative(draft.file, root)))]
      if ((await this.previewFreshness(root, files)) === 'stale') {
        if (!selected && !moved()) {
          // LKM-638: a queued batch whose element is not selected cannot refresh it; it
          // waits, still queued, and continues when that element is selected again.
          batch.status = 'queued'
          batch.needsElement = true
          this.publishDraft()
          return
        }
        if (moved() || !anchored() || !this.element) throw new Error(refreshRefusal('moved'))
        const identity = (e: SelectedElement | null) =>
          e ? JSON.stringify([e.source, e.tag, e.id ?? null]) : ''
        const original = identity(this.element)
        const kept = () =>
          this.batches.includes(batch) && anchored() && identity(this.element) === original
        const outcome = await this.refreshPreview(root, this.element, kept)
        if (outcome !== 'ok' || !kept())
          throw new Error(refreshRefusal(outcome === 'ok' ? 'moved' : outcome))
        // The reloaded document has no overrides: show the layers again.
        await this.projectDrafts()
        if (!kept()) throw new Error(refreshRefusal('moved'))
        await verify()
        if ((await this.previewFreshness(root, files)) === 'stale')
          throw new Error(refreshRefusal('timeout'))
        if (!kept()) throw new Error(refreshRefusal('moved'))
      }
      if (anchored() && this.element) batch.element = this.element
      const element = batch.element
      const changes = drafts.map((draft) => ({ prop: draft.field.slice(6), value: draft.value }))
      const edits = drafts.map((draft) => {
        const token = batch.tokens.get(draft.field)
        return `${projectRelative(draft.file, root)} (staged against SHA-256 ${this.follow(root, draft.file, draft.hash)}): set ${draft.field.slice(6)} to ${draft.value}${token ? ` using token ${token}` : ''}`
      })
      const turn = await this.agent(root, applyDraftsPrompt(element, root, edits), true, {
        kind: 'inspector-apply',
        summary: applySummary(element, changes)
      })
      if (!this.batches.includes(batch)) return
      const id = turn || `draft-${Date.now()}-${batch.key}`
      batch.id = id
      batch.status = 'running'
      this.state.edits = (this.state.edits ?? 0) + 1
      const early = this.early.get(id)
      this.early.delete(id)
      this.publishDraft()
      if (early)
        queueMicrotask(() => {
          void this.settleDraftTurn(early.success, id, early.reason).catch(() => {})
        })
    } catch (error) {
      await this.failBatch(batch, String(error), conflict)
    }
  }
  private sequence = 0
  private readonly saved = new Map<
    string,
    { element: SelectedElement; tab: NativeInspectorState['tab']; visible: boolean }
  >()
  private reconciles = new Map<string, ReturnType<typeof setTimeout>>()
  private clearReconciles() {
    for (const timer of this.reconciles.values()) clearTimeout(timer)
    this.reconciles.clear()
  }
  private reconcile(prop: string, value: string, remaining = 5) {
    const generation = this.state.generation,
      root = this.state.root
    clearTimeout(this.reconciles.get(prop))
    const timer = setTimeout(async () => {
      if (generation !== this.state.generation || root !== this.state.root) return
      try {
        await this.send('styles:clear-preview', { prop })
        const result = await this.invoke('styles:read', [prop])
        if (
          generation !== this.state.generation ||
          root !== this.state.root ||
          this.reconciles.get(prop) !== timer
        )
          return
        const fresh = result?.values?.[prop]
        if (fresh === undefined) {
          this.reconciles.delete(prop)
          return
        }
        if (sameCssValue(prop, fresh, value)) {
          this.reconciles.delete(prop)
          await this.refresh()
        } else {
          await this.send('styles:preview', { prop, value })
          if (remaining > 1) this.reconcile(prop, value, remaining - 1)
        }
      } catch (error) {
        if (generation === this.state.generation) {
          this.state.error = String(error)
          this.publish()
        }
      }
    }, 600)
    timer.unref?.()
    this.reconciles.set(prop, timer)
  }
  private operation: Promise<void> = Promise.resolve()
  constructor(
    readonly invoke: (channel: string, ...args: any[]) => Promise<any>,
    readonly send: (channel: string, ...args: any[]) => Promise<any>,
    readonly render: (state: NativeInspectorState) => void,
    readonly agent: (
      root: string,
      prompt: string,
      submit?: boolean,
      action?: AppAction
    ) => Promise<void | string>,
    readonly setup: () => Promise<void>,
    readonly provider: () => string = () => 'claude',
    readonly setupReason: (root: string) => string = () =>
      'This element may come from a library or generated markup.'
  ) {}
  publish() {
    if (this.state.tab !== 'props' && this.state.tab !== 'styles') {
      this.state.tab = 'styles'
      this.build()
    }
    this.render({ ...this.state, fields: [...this.state.fields], actions: [...this.state.actions] })
  }
  async activate(root: string) {
    this.clear()
    this.state.root = root
    await this.refresh()
  }
  /** The old project's island is hidden synchronously; its view state stays in memory. */
  suspend() {
    if (this.state.root && this.element)
      this.saved.set(this.state.root, {
        element: this.element,
        tab: this.state.tab,
        visible: this.state.visible
      })
    this.clear()
  }
  savedElement(root: string) {
    return this.saved.get(root)?.element ?? null
  }
  forget(root: string) {
    this.saved.delete(root)
  }
  async restore(root: string, element: SelectedElement) {
    const saved = this.saved.get(root)
    if (!saved || root !== this.state.root) return
    this.state.tab = saved.tab === 'props' ? 'props' : 'styles'
    this.state.visible = saved.visible
    await this.select(element)
  }
  /** LKM-172: the selection and the island belong to one project and one page. Drops both
   *  and publishes the hidden island now; a refresh still in flight is discarded. */
  clear() {
    this.holdDraft()
    this.clearReconciles()
    ++this.sequence
    ++this.state.generation
    this.requestedFile = null
    this.element = null
    this.onElement(null)
    this.inspection = null
    this.styles = null
    this.controls = []
    this.state.visible = false
    this.state.busy = false
    this.state.error = ''
    this.drafts = new Map()
    this.draftHistory = []
    this.draftTarget = ''
    this.draftConflict = false
    this.previewAvailable = false
    this.state.draft = undefined
    this.build()
    this.publish()
    void this.send('styles:clear-preview', {}).catch(() => {})
  }
  async select(element: SelectedElement | null) {
    const nextTarget = element
      ? JSON.stringify([this.state.root, element.source, element.tag, element.id, element.selector])
      : ''
    // LKM-638: the same element picked again keeps its overrides; projecting below only
    // removes what no layer drives, so nothing flashes through the authored style.
    const retarget = nextTarget !== this.target()
    if (retarget) this.holdDraft()
    this.clearReconciles()
    if (retarget) await this.send('styles:clear-preview', {})
    this.state.busy = false
    this.element = element
    this.onElement(element)
    this.state.visible = this.state.visible && !!element
    ++this.state.generation
    this.inspection = null
    this.styles = null
    this.classRule = null
    this.controls = []
    this.state.error = ''
    if (this.target() !== this.draftTarget) {
      this.drafts = new Map()
      this.draftHistory = []
      this.draftTarget = ''
      this.draftConflict = false
      this.state.draft = undefined
      this.previewAvailable = false
    }
    this.build()
    this.publish()
    if (element) {
      const generation = this.state.generation
      await this.refresh()
      if (generation !== this.state.generation) return
      if (!this.drafts.size) await this.resumeDraft()
      if (generation !== this.state.generation) return
      this.confirmLanded()
      if (this.drafts.size || this.targetBatches().length) await this.projectDrafts()
      else this.publishDraft()
      // A batch that waited for this element to refresh its preview continues now.
      if (this.targetBatches().some((batch) => batch.needsElement)) await this.pump()
    }
  }
  /**
   * LKM-216: the live tree, the page or its CSS changed. Re-reads everything the island
   * shows (computed styles, props, tokens, controls) without a new generation, so open
   * fields update in place. An edit of the island's own (busy, or reconciling its
   * preview override) is left alone: it re-reads when it settles.
   */
  async invalidated() {
    this.invalidations++
    if (!this.state.root || this.state.busy || this.reconciles.size) return
    const root = this.state.root,
      generation = this.state.generation,
      target = this.target()
    // LKM-581: after the awaits below the selection may have moved to another element
    // with its own drafts; the old reads must not clear or flag them.
    const moved = () =>
      root !== this.state.root || generation !== this.state.generation || this.target() !== target
    await this.refresh(true)
    if (moved()) return
    if (this.drafts.size) {
      // LKM-638: a file an unreported batch is writing is waiting on that batch, not a
      // conflict; once it lands, drafts staged on the old version follow it.
      const current = await this.draftsCurrent(root, this.drafts.values())
      if (moved()) return
      this.draftConflict = !current
    }
    this.confirmLanded()
    if (this.drafts.size || this.targetBatches().length) await this.projectDrafts()
    else if (this.state.draft) this.publishDraft()
  }
  /** The same element, picked again in a new document (a reload); false when it is another one. */
  async reattach(element: SelectedElement): Promise<boolean> {
    const current = this.element
    if (
      !current ||
      current.tag !== element.tag ||
      current.source !== element.source ||
      (current.id ?? null) !== (element.id ?? null)
    )
      return false
    // LKM-600: the same element (tag, source stamp, id, matched uniquely by the caller) may
    // sit at a new structural selector after a reload; its draft follows it.
    const before = this.target()
    const draft = this.draftTarget && this.draftTarget === before
    this.element = element
    // LKM-638: submitted batches follow the same element too, and only it.
    for (const batch of this.batches)
      if (batch.root === this.state.root && batch.target === before) {
        batch.target = this.target()
        batch.element = element
      }
    if (draft) {
      this.draftTarget = this.target()
      this.publishDraft()
    }
    this.onElement(element)
    await this.refresh(true)
    // A new document has none of the overrides: retire what it renders, show the rest.
    if (this.element === element && (this.drafts.size || this.targetBatches().length)) {
      this.confirmLanded()
      await this.projectDrafts()
      if (this.targetBatches().some((batch) => batch.needsElement)) await this.pump()
    }
    return true
  }
  async refresh(changed = false) {
    const root = this.state.root,
      element = this.element,
      generation = ++this.sequence
    if (!root) return
    const files = [element?.source, element?.componentSource, this.requestedFile]
      .filter(Boolean)
      .map((v) => v!.replace(/:\d+(?::\d+)?$/, ''))
    const results = await Promise.allSettled([
      element?.source
        ? this.invoke(
            'props:inspect',
            root,
            element.componentSource || element.source,
            element.text
          )
        : Promise.resolve(null),
      element ? this.invoke('styles:read', Object.keys(STYLE_PROP_META)) : Promise.resolve(null),
      this.invoke('tokens:detect', root),
      this.invoke('controls:list', root),
      element ? this.invoke('styles:resolve-class', root, element.classes) : Promise.resolve(null)
    ])
    if (generation !== this.sequence || root !== this.state.root || element !== this.element) return
    this.inspection = results[0].status === 'fulfilled' ? results[0].value : null
    const styles = results[1].status === 'fulfilled' ? results[1].value : null
    // Mid-reload the page has no selection to read; keep the last values until it has.
    if (!changed || styles?.values) this.styles = styles
    this.classRule = results[4].status === 'fulfilled' ? results[4].value : null
    if (this.drafts.size && this.target() !== this.draftTarget) {
      this.drafts = new Map()
      this.draftHistory = []
      this.draftConflict = false
      this.state.draft = undefined
    }
    this.tokens = results[2].status === 'fulfilled' ? results[2].value : null
    const manifests = results[3].status === 'fulfilled' ? results[3].value : []
    const animationFiles = manifests
      .filter((p: any) => p.presentation === 'animation')
      .map((p: any) => p.file)
    const controls = await this.invoke('controls:get', root, {
      files: [...new Set([...files, ...animationFiles])]
    }).catch(() => [])
    if (generation !== this.sequence || element !== this.element || root !== this.state.root) return
    this.controls = controls
    const before = changed ? JSON.stringify(this.state.fields) : ''
    this.build()
    this.overlay()
    if (changed && JSON.stringify(this.state.fields) !== before)
      this.state.updated = (this.state.updated ?? 0) + 1
    this.publish()
  }
  build() {
    const root = this.state.root,
      element = this.element,
      inspection = this.inspection
    this.bindings.clear()
    this.state.fields = []
    this.state.notice =
      element && !element.source
        ? {
            title: "Trezi can't find this element's source code.",
            reason: this.setupReason(root),
            editable: !!this.classRule
          }
        : undefined
    this.state.actions = [
      { id: 'refresh', label: 'Refresh' },
      { id: 'close', label: 'Close' }
    ]
    this.state.title = element
      ? `${element.tag}${element.id ? '#' + element.id : ''}`
      : 'Project controls'
    const add = (field: NativeInspectorField, binding?: Binding) => {
      this.state.fields.push(field)
      if (binding) this.bindings.set(field.id, binding)
    }
    if (element && this.state.tab === 'styles') {
      this.state.actions.unshift({ id: 'replay-style', label: 'Replay transition' })
    }
    if (element) this.state.actions.unshift({ id: 'animation', label: 'Add animation…' })
    if (element?.componentSource)
      this.state.actions.unshift({ id: 'owner', label: 'Inspect owning component' })
    if (element && !element.source)
      this.state.actions.unshift(
        { id: 'setup', label: 'Connect project to Trezi' },
        { id: 'ask-agent', label: 'Ask the agent' }
      )
    if (this.state.tab === 'props' && element) {
      if (!inspection?.hasSchema)
        add({
          id: 'schema',
          label: 'No editable prop schema',
          group: 'Properties',
          kind: 'readonly',
          value:
            inspection?.note ?? 'Use chat to change this element, or set up source instrumentation.'
        })
      else
        for (const field of inspection.fields) {
          const id = 'prop:' + field.name,
            source = inspection.source
          add(
            {
              id,
              label: field.name,
              group: inspection.component,
              kind:
                field.kind === 'boolean'
                  ? 'toggle'
                  : field.kind === 'enum'
                    ? 'select'
                    : field.kind === 'number'
                      ? 'number'
                      : 'text',
              value: String(field.value ?? field.default ?? ''),
              options: field.options,
              disabled: field.kind === 'other',
              detail:
                field.description ??
                (field.expression ? 'Expression: this edit may use the agent.' : ''),
              reset: true
            },
            {
              apply: (value) =>
                this.invoke('props:apply', root, {
                  source,
                  name: field.name,
                  kind: field.kind,
                  value:
                    field.kind === 'number'
                      ? finite(value)
                      : field.kind === 'boolean'
                        ? value === 'true'
                        : value
                }),
              reset: () => this.invoke('props:remove', root, source, field.name)
            }
          )
        }
    } else if (this.state.tab === 'styles' && element) {
      const values = this.styles?.values ?? element.styles ?? {}
      const paired = (group: 'padding' | 'margin', axis: 'horizontal' | 'vertical') => {
        const sides = axis === 'horizontal' ? ['left', 'right'] : ['top', 'bottom']
        const props = sides.map((side) => `${group}-${side}`)
        const equal =
          values[props[0]] === values[props[1]] &&
          this.styles?.specified[props[0]] === this.styles?.specified[props[1]]
        const authored = this.styles?.specified[props[0]] ?? values[props[0]] ?? ''
        const raw = equal
          ? /^-?\d+(?:\.\d+)?px$/.test(authored)
            ? authored.slice(0, -2)
            : authored
          : ''
        const id = `style:${group}-${axis}`
        const cssValue = (input: string) =>
          /^-?\d+(\.\d+)?$/.test(input.trim()) ? toCssText(props[0], finite(input)) : input
        add(
          {
            id,
            label: axis === 'horizontal' ? 'Horizontal' : 'Vertical',
            group: 'layout',
            kind: 'number',
            value: raw,
            mixed: !equal,
            layout: group,
            axis,
            expanded: this.expanded.has(group),
            disabled: !element.source && !this.classRule,
            unit: 'px',
            min: group === 'padding' ? 0 : -400,
            max: 400,
            step: 1
          },
          {
            apply: async (input) => {
              const value = cssValue(input)
              const result = await this.invoke(
                element.source ? 'styles:apply-pair' : 'styles:apply-class-pair',
                root,
                {
                  source: element.source ?? '',
                  props,
                  value,
                  classes: element.classes
                }
              )
              return result.applied
                ? { ...result, nativeStyles: props.map((prop) => ({ prop, value })) }
                : result
            },
            preview: async (input) => {
              for (const prop of props)
                await this.send('styles:preview', { prop, value: cssValue(input) })
            }
          }
        )
      }
      const spacing = (group: 'padding' | 'margin') => {
        if (this.expanded.has(group)) {
          // Column order matches the compact horizontal/vertical pair. Keep each
          // axis's existing side order (right/left and top/bottom).
          for (const side of ['right', 'left', 'top', 'bottom'])
            style(`${group}-${side}`, group, side as NativeInspectorField['axis'])
        } else {
          paired(group, 'horizontal')
          paired(group, 'vertical')
        }
      }
      const style = (
        prop: string,
        layout?: NativeInspectorField['layout'],
        axis?: NativeInspectorField['axis']
      ) => {
        const meta = STYLE_PROP_META[prop]
        const ownLayout = /(?:^|-)flex$/.test(values.display ?? '')
          ? 'flex'
          : /(?:^|-)grid$/.test(values.display ?? '')
            ? 'grid'
            : ''
        const parentLayout = /(?:^|-)(?:flex|grid)$/.test(this.styles?.parentDisplay ?? '')
        const ownDeclaration = Object.hasOwn(this.styles?.specified ?? {}, prop)
        const gapShorthand =
          (prop === 'row-gap' || prop === 'column-gap') && !ownDeclaration
            ? this.styles?.specified.gap
            : undefined
        const authored = ownDeclaration || gapShorthand !== undefined
        if (meta.appliesTo === 'flex' && ownLayout !== 'flex' && !authored) return
        if (meta.appliesTo === 'flex-grid' && !ownLayout && !authored) return
        if (meta.appliesTo === 'flex-grid-child' && !parentLayout && !authored) return
        if (meta.flexGridOnly && !ownLayout && !authored) return
        const tokens = tokensForProp(this.tokens, prop),
          value = values[prop] ?? '',
          id = 'style:' + prop
        const origin =
          this.styles?.origins?.[prop] ?? (gapShorthand ? this.styles?.origins?.gap : undefined)
        const ownsRule =
          origin?.kind === 'rule' &&
          this.classRule &&
          element.classes.some(
            (className) =>
              isClassSelector(origin.selector, className) &&
              (className === this.classRule?.className ||
                className.startsWith(`_${this.classRule?.className}_`))
          ) &&
          origin.href?.split('?')[0].endsWith(this.classRule.file) &&
          !origin.important &&
          !origin.conditional
        const utility = matchingUtilityClass(element.classes, prop)
        const ownsUtility =
          origin?.kind === 'rule' &&
          !!element.source &&
          !!utility &&
          isClassSelector(origin.selector, utility) &&
          !origin.important &&
          !origin.conditional
        const sourceEditable =
          origin?.kind === 'inline'
            ? !!element.source && !origin.important
            : origin?.kind === 'rule'
              ? !!ownsRule || !!ownsUtility
              : !!element.source || !!this.classRule
        // Existing baseline controls keep their established utility editing
        // contract. New layout controls require proof of the winning source.
        const editable =
          meta.appliesTo || prop === 'gap' ? sourceEditable : !!element.source || !!this.classRule
        const detail = authored
          ? `${origin?.kind === 'inline' ? 'Inline' : origin?.kind === 'rule' ? `CSS rule ${origin.selector ?? ''}` : 'Authored'}: ${this.styles?.specified[prop] ?? `gap: ${gapShorthand}`}${value && value !== this.styles?.specified[prop] ? ` · resolved ${value}` : ''}`
          : `Computed default: ${value || 'unset'}`
        const cssValue = (input: string) =>
          meta.control === 'number' && /^-?\d+(\.\d+)?$/.test(input.trim())
            ? toCssText(prop, finite(input))
            : input
        const apply = async (input: string, token?: any) => {
          const result = await this.invoke(
            ownsRule
              ? 'styles:apply-class'
              : element.source
                ? 'styles:apply'
                : 'styles:apply-class',
            root,
            {
              source: element.source ?? '',
              prop,
              value: cssValue(input),
              classes: element.classes,
              authored: this.styles?.specified[prop],
              token
            }
          )
          return result.applied
            ? { ...result, nativeStyles: [{ prop, value: cssValue(input) }] }
            : result
        }
        add(
          {
            id,
            label: axis ? axis[0].toUpperCase() + axis.slice(1) : prop,
            group: meta.group,
            kind: meta.control,
            value:
              this.styles?.specified[prop] ??
              (meta.control === 'number' && !meta.appliesTo
                ? String(numericValue(prop, values) ?? value)
                : value),
            disabled: !editable || meta.control === 'readonly',
            min: meta.min,
            max: meta.max,
            step: meta.step,
            unit: meta.unit,
            options: meta.options,
            optionLabels: meta.optionLabels,
            detail: authored || meta.appliesTo ? detail : undefined,
            layout,
            axis,
            expanded: layout ? this.expanded.has(layout) : undefined,
            tokens: tokens.map((t, i) => ({
              id: String(i),
              label: `${t.token.name} · ${t.token.value}`
            }))
          },
          {
            apply,
            preview: (input) => this.send('styles:preview', { prop, value: cssValue(input) }),
            token: (choice) => {
              const token = tokens[Number(choice)]
              if (!token) throw new Error('This token is no longer available.')
              return apply(token.token.value, { name: token.token.name, group: token.group })
            },
            tokenValue: (choice) => {
              const token = tokens[Number(choice)]
              if (!token) throw new Error('This token is no longer available.')
              return token.token.value
            }
          }
        )
      }
      style('width', 'size')
      style('height', 'size')
      spacing('padding')
      spacing('margin')
      style('border-radius', 'finish')
      style('opacity', 'finish')
      for (const [prop, meta] of Object.entries(STYLE_PROP_META)) {
        if (
          ['width', 'height', 'border-radius', 'opacity'].includes(prop) ||
          /^(padding|margin)-/.test(prop)
        )
          continue
        if (prop === 'gap') {
          // The two computed longhands preserve asymmetric gap values. The
          // shorthand is shown separately only when it was explicitly authored.
          if (!Object.hasOwn(this.styles?.specified ?? {}, prop)) continue
        }
        if (prop === 'row-gap' || prop === 'column-gap') {
          style(prop, 'gap', prop === 'row-gap' ? 'vertical' : 'horizontal')
          continue
        }
        if (meta.appliesTo) {
          style(prop, 'flow')
          continue
        }
        style(prop)
      }
    }
  }
  /**
   * LKM-541: a Selection-mode spacing handle was released at `value` px. It stages the
   * same draft as typing into that Styles field, so one explicit Apply batches it
   * through the agent with any other drafts. A side without its own field, a field
   * without a proven source owner or a changed source drops the gesture's preview.
   */
  async gesture(prop: string, value: string): Promise<boolean> {
    if (!this.element || !/^\d+$/.test(value)) {
      await this.send('styles:clear-preview', { prop })
      return false
    }
    this.state.error = ''
    if (/^padding-/.test(prop) && !this.expanded.has('padding')) this.expanded.add('padding')
    if (this.state.tab !== 'styles') this.state.tab = 'styles'
    this.build()
    const field = 'style:' + prop
    const before = this.drafts.get(field)
    const target = this.state.fields.find((item) => item.id === field)
    const root = this.state.root,
      generation = this.state.generation
    if (target && !target.disabled && this.bindings.get(field)?.preview)
      await this.action({ root, generation, action: 'apply', field, value })
    // LKM-581: another element was selected meanwhile; this gesture no longer owns the island.
    if (root !== this.state.root || generation !== this.state.generation) return false
    const staged = this.drafts.get(field)
    if (staged && staged !== before) {
      // The draft and its Apply live in the inspector: show it.
      this.state.visible = true
      this.publish()
      return true
    }
    await this.send('styles:clear-preview', { prop })
    if (this.drafts.size || this.targetBatches().length) await this.projectDrafts()
    if (!this.state.error)
      this.state.error = target
        ? `${prop} has no source-backed preview here. Edit it in Styles or ask the agent.`
        : `${prop} is not editable for this element. Edit it in Styles or ask the agent.`
    this.state.visible = true
    this.publish()
    return false
  }
  async action(action: NativeInspectorAction) {
    if (action.root !== this.state.root || action.generation !== this.state.generation) return
    const root = this.state.root
    let generation = this.state.generation
    try {
      if (action.action.startsWith('spacing:')) {
        const group = action.action.slice(8)
        if (['padding', 'margin'].includes(group)) {
          if (this.expanded.has(group)) this.expanded.delete(group)
          else this.expanded.add(group)
          this.build()
          this.publish()
        }
        return
      }
      if (action.action === 'tab') {
        this.state.tab = action.value === 'props' ? 'props' : 'styles'
        this.build()
        this.publish()
        return
      }
      if (action.action === 'close') {
        this.state.visible = false
        this.clearReconciles()
        // LKM-638: a submitted batch keeps showing until its source renders; only the
        // editable draft's preview goes with the island.
        await this.showLayers(composeLayers(this.targetBatches().map((batch) => batch.drafts)))
        this.previewAvailable = false
        this.publishDraft()
        this.publish()
        return
      }
      if (action.action === 'undo-draft' || action.action === 'revert-draft') {
        // LKM-638: Undo and Revert act on the editable draft only. A submitted batch is the
        // worker's; it is never rewritten or undone in source from here. Revert with nothing
        // staged dismisses the display of batches whose source already landed but whose
        // preview never rendered them (no source change).
        if (!this.drafts.size) {
          if (action.action !== 'revert-draft') return
          const landed = this.targetBatches().filter((batch) => batch.status === 'landed')
          if (!landed.length) return
          for (const batch of landed) this.batches.splice(this.batches.indexOf(batch), 1)
        } else {
          this.drafts =
            action.action === 'undo-draft' ? (this.draftHistory.pop() ?? new Map()) : new Map()
          if (action.action === 'revert-draft') this.draftHistory = []
        }
        if (!this.drafts.size) {
          this.draftTarget = ''
          this.draftConflict = false
        }
        this.state.error = ''
        await this.refresh(true)
        await this.projectDrafts()
        return
      }
      if (action.action === 'apply-drafts') {
        // LKM-638: Apply captures the editable draft as its own immutable batch and the
        // fields stay usable for the next one. A press with nothing new staged (a repeated
        // press) is not an error and starts nothing.
        if (!this.drafts.size) return
        if (this.draftConflict || this.target() !== this.draftTarget || !this.element)
          throw new Error('The selected element changed. Review or revert the preview draft.')
        const tokens = new Map<string, string>()
        for (const draft of this.drafts.values()) {
          const label = draft.tokenChoice
            ? this.state.fields
                .find((field) => field.id === draft.field)
                ?.tokens?.find((item) => item.id === draft.tokenChoice)?.label
            : undefined
          if (label) tokens.set(draft.field, label)
        }
        this.batches.push({
          key: ++this.batchKey,
          root,
          target: this.draftTarget,
          element: this.element,
          drafts: new Map(this.drafts),
          history: this.draftHistory.map((step) => new Map(step)),
          tokens,
          status: 'queued'
        })
        this.drafts = new Map()
        this.draftHistory = []
        this.draftTarget = ''
        this.state.error = ''
        this.publishDraft()
        await this.pump()
        return
      }
      if (action.action === 'refresh') {
        await this.refresh()
        return
      }
      if (action.action === 'owner' && this.element?.componentSource) {
        await this.select({
          ...this.element,
          source: this.element.componentSource,
          componentSource: null
        })
        this.state.tab = 'props'
        this.build()
        this.publish()
        return
      }
      if (action.action === 'setup') {
        await this.setup()
        return
      }
      if (action.action === 'ask-agent' && this.element) {
        await this.agent(root, describeSelectionForPrompt(this.element, root))
        return
      }
      if (action.action === 'animation') {
        if (this.element)
          await this.agent(
            root,
            animationControlsPrompt(
              this.element,
              root,
              this.inspection,
              action.value,
              this.provider()
            ),
            true
          )
        return
      }
      if (action.action === 'replay-style') {
        await this.send('styles:replay', {
          prop: 'opacity',
          from: '0.5',
          to: this.styles?.values.opacity || '1'
        })
        return
      }
      const binding = this.bindings.get(action.field ?? '')
      if (!binding || this.state.fields.find((f) => f.id === action.field)?.disabled) return
      if (action.action === 'preview') {
        await binding.preview?.(action.value ?? '')
        return
      }
      if (action.action === 'cancel-preview') {
        // LKM-638: the scrub's override goes; the layers' own overrides stay put.
        await this.showLayers(
          composeLayers([...this.targetBatches().map((batch) => batch.drafts), this.drafts])
        )
        // A style-watch read may have cached the temporary inline value. Re-read
        // the authored declaration after cancel so a var() stays visible.
        await this.refresh(true)
        if (this.drafts.size || this.targetBatches().length) await this.projectDrafts()
        return
      }
      let draftOwner: ReturnType<typeof sourceOwner> | null = null
      try {
        draftOwner = sourceOwner()
      } catch {
        /* unavailable outside the native owner */
      }
      if (draftOwner && action.action === 'token' && action.field?.startsWith('style:')) {
        if (!binding.tokenValue) throw new Error('This token cannot be previewed safely.')
        const value = binding.tokenValue(action.value ?? '')
        await this.action({ ...action, action: 'apply', value })
        if (generation !== this.state.generation) return
        const draft = this.drafts.get(action.field)
        if (draft?.value === value) draft.tokenChoice = action.value
        return
      }
      if (draftOwner && action.action === 'apply' && action.field?.startsWith('style:')) {
        // LKM-638: a submitted Apply never locks the fields; only a real source conflict
        // of this draft does, and it says so.
        if (this.draftConflict)
          throw new Error('Source changed outside this draft. Revert the draft to keep editing.')
        const field = this.state.fields.find((f) => f.id === action.field)
        if (!field || field.disabled || !binding.preview || !this.element)
          throw new Error('This style has no safe live preview. Ask the agent to edit it.')
        const file = this.styleSourceFile(action.field)
        if (!file) throw new Error('This style has no source file. Ask the agent to edit it.')
        const target = this.target()
        const current = await draftOwner.read(root, file)
        // LKM-581: the field and file belong to the element selected before the read.
        if (
          root !== this.state.root ||
          generation !== this.state.generation ||
          this.target() !== target
        )
          throw new Error('The selected element changed. The edit was not staged.')
        if (!current.hash || current.binary)
          throw new Error('This source cannot be previewed safely. Ask the agent to edit it.')
        if (this.drafts.size && this.draftTarget !== target)
          throw new Error('The selected element changed. Review or revert the preview draft.')
        const prior = this.drafts.get(action.field)
        if ([...this.drafts.values()].some((draft) => draft.file !== file))
          throw new Error('The selected source file changed. Review or revert the preview draft.')
        if (
          prior &&
          this.follow(root, file, prior.hash) !== current.hash &&
          !this.waitingOn(root, file)
        )
          throw new Error('Source changed while the preview draft was pending.')
        this.draftTarget = target
        this.draftHistory.push(new Map(this.drafts))
        const prop = action.field.slice(6)
        const input = action.value ?? ''
        const value =
          field.kind === 'number' && /^-?\d+(\.\d+)?$/.test(input.trim())
            ? toCssText(prop, finite(input))
            : input
        const during = this.batches
          .filter(
            (batch) =>
              batch.root === root &&
              batch.status !== 'landed' &&
              batch.status !== 'queued' &&
              [...batch.drafts.values()].some((draft) => draft.file === file)
          )
          .map((batch) => batch.key)
        this.drafts.set(action.field, {
          field: action.field,
          value,
          file,
          hash: current.hash,
          ...(during.length ? { during: new Set(during) } : {})
        })
        await this.projectDrafts()
        return
      }
      const write = async () => {
        if (root !== this.state.root || generation !== this.state.generation) return
        this.state.busy = true
        this.state.error = ''
        this.publish()
        try {
          const result =
            action.action === 'reset'
              ? await binding.reset?.()
              : action.action === 'token'
                ? await binding.token?.(action.value ?? '')
                : await binding.apply(action.value ?? '')
          if (result?.needsAgent && result.agentPrompt) await this.agent(root, result.agentPrompt)
          else if (result && !result.applied)
            throw new Error(result.error ?? 'The edit was not applied.')
          if (generation === this.state.generation) {
            if (result?.applied && result.nativeStyles) {
              for (const { prop, value } of result.nativeStyles) {
                await this.send('styles:preview', { prop, value })
                this.reconcile(prop, value)
              }
            } else {
              await this.send('styles:clear-preview', {})
              await this.refresh()
            }
          }
        } catch (error) {
          if (generation === this.state.generation) this.state.error = String(error)
        } finally {
          this.state.edits = (this.state.edits ?? 0) + 1
          if (generation === this.state.generation) this.state.busy = false
          this.publish()
        }
      }
      this.operation = this.operation.then(write, write)
      await this.operation
    } catch (error) {
      if (generation === this.state.generation) {
        this.state.error = String(error)
        this.publish()
      }
    }
  }
}
function finite(value: string) {
  const number = Number(value)
  if (!value.trim() || !Number.isFinite(number)) throw new Error('Enter a valid number.')
  return number
}
