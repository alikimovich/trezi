import { sourceOwner } from '../main/source-owner'
import { isClassSelector, matchingUtilityClass } from '../main/tw-styles'
import type {
  PropInspection,
  ResolvedControlPanel,
  SelectedElement,
  StyleReadResult,
  TokenSet
} from '../shared/api'
import { animationControlsPrompt } from '../shared/controls-prompt'
import { numericValue, STYLE_PROP_META, sameCssValue, toCssText } from '../shared/css-values'
import type {
  NativeInspectorAction,
  NativeInspectorField,
  NativeInspectorState
} from '../shared/native-inspector'
import { describeSelectionForPrompt } from '../shared/selection-context'
import { tokensForProp } from '../shared/token-match'

type Binding = {
  apply(value: string): Promise<any>
  preview?(value: string): Promise<any>
  reset?(): Promise<any>
  token?(value: string): Promise<any>
  tokenValue?(value: string): string
}
type StyleDraft = {
  field: string
  value: string
  file: string
  hash: string
  tokenChoice?: string
}
type HeldDraft = {
  drafts: Map<string, StyleDraft>
  history: Map<string, StyleDraft>[]
  conflict: boolean
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
  /** Every selection change, null when cleared; Layers follows it (LKM-179). */
  onElement: (element: SelectedElement | null) => void = () => {}
  inspection: PropInspection | null = null
  controls: ResolvedControlPanel[] = []
  tokens: TokenSet | null = null
  styles: StyleReadResult | null = null
  classRule: { file: string; className: string } | null = null
  readonly bindings = new Map<string, Binding>()
  private draftTarget = ''
  private drafts = new Map<string, StyleDraft>()
  private draftHistory: Map<string, StyleDraft>[] = []
  private submitted = false
  private submitting = false
  private draftConflict = false
  private previewAvailable = false
  private readonly heldDrafts = new Map<string, HeldDraft>()
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
    // A turn can finish while another project is active. Its source and
    // rendered result must be checked again before a restored draft can Apply.
    const hashes = await Promise.all(
      [...held.drafts.values()].map(
        async (draft) => (await sourceOwner().read(root, draft.file)).hash === draft.hash
      )
    ).catch(() => [false])
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
    this.submitted = false
    this.draftConflict = held.conflict || !hashes.every(Boolean)
    await this.projectDrafts()
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
    this.state.draft = this.drafts.size
      ? {
          count: this.drafts.size,
          submitted: this.submitted,
          conflict: this.draftConflict,
          preview: this.previewAvailable
        }
      : undefined
    this.publish()
  }
  private async projectDrafts() {
    await this.send('styles:clear-preview', {})
    // Rebuild from the last source read before overlaying the current draft.
    // Otherwise Undo, Revert and a restored held draft can leave the controls
    // displaying values from a draft that is no longer present.
    this.build()
    for (const draft of this.drafts.values()) {
      const field = this.state.fields.find((item) => item.id === draft.field)
      if (field) field.value = draft.value
    }
    try {
      for (const draft of this.drafts.values()) {
        const binding = this.bindings.get(draft.field)
        if (!binding?.preview || this.styleSourceFile(draft.field) !== draft.file)
          throw new Error('The selected style binding changed.')
        await binding.preview(draft.value)
      }
      this.previewAvailable = this.drafts.size > 0
    } catch (error) {
      await this.send('styles:clear-preview', {}).catch(() => {})
      this.previewAvailable = false
      this.state.error = `Live preview is unavailable: ${String(error)}`
    }
    this.publishDraft()
  }
  async settleDraftTurn(success: boolean) {
    if (!this.submitted) return
    if (success) await this.invalidated()
    if (!this.submitted) return
    // A landed turn is not proof that it edited the requested source. Release
    // the submitted lock if source plus rendered preview did not confirm it.
    this.submitted = false
    this.state.error = success
      ? 'Apply did not confirm source and rendered preview. The draft is still pending.'
      : 'Apply failed. The preview draft is still pending.'
    await this.projectDrafts()
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
    readonly agent: (root: string, prompt: string, submit?: boolean) => Promise<void>,
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
    this.drafts.clear()
    this.draftHistory = []
    this.draftTarget = ''
    this.submitted = false
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
    if (nextTarget !== this.target()) this.holdDraft()
    this.clearReconciles()
    await this.send('styles:clear-preview', {})
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
      this.drafts.clear()
      this.draftHistory = []
      this.draftTarget = ''
      this.submitted = false
      this.draftConflict = false
      this.state.draft = undefined
      this.previewAvailable = false
    }
    this.build()
    this.publish()
    if (element) {
      await this.refresh()
      if (this.drafts.size) await this.projectDrafts()
      else await this.resumeDraft()
    }
  }
  /**
   * LKM-216: the live tree, the page or its CSS changed. Re-reads everything the island
   * shows (computed styles, props, tokens, controls) without a new generation, so open
   * fields update in place. An edit of the island's own (busy, or reconciling its
   * preview override) is left alone: it re-reads when it settles.
   */
  async invalidated() {
    if (!this.state.root || this.state.busy || this.reconciles.size) return
    if (this.submitted && this.drafts.size) {
      await this.send('styles:clear-preview', {})
      await this.refresh(true)
      const sourced = await Promise.all(
        [...this.drafts.values()].map(async (draft) => {
          const current = await sourceOwner().read(this.state.root, draft.file)
          const rendered = this.styles?.values[draft.field.slice(6)]
          return (
            current.hash !== draft.hash &&
            rendered !== undefined &&
            sameCssValue(draft.field.slice(6), rendered, draft.value)
          )
        })
      ).catch(() => [false])
      if (sourced.every(Boolean)) {
        this.drafts.clear()
        this.draftHistory = []
        this.submitted = false
        this.draftConflict = false
        this.publishDraft()
        return
      }
      this.state.error = 'Apply is waiting for source and rendered preview confirmation.'
      await this.projectDrafts()
      return
    }
    await this.refresh(true)
    if (this.drafts.size) {
      const current = await Promise.all(
        [...this.drafts.values()].map(
          async (draft) =>
            (await sourceOwner().read(this.state.root, draft.file)).hash === draft.hash
        )
      ).catch(() => [false])
      this.draftConflict = !current.every(Boolean)
      await this.projectDrafts()
    }
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
    this.element = element
    this.onElement(element)
    await this.refresh(true)
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
      this.drafts.clear()
      this.draftHistory = []
      this.submitted = false
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
    for (const draft of this.drafts.values()) {
      const field = this.state.fields.find((f) => f.id === draft.field)
      if (field) field.value = draft.value
    }
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
  async action(action: NativeInspectorAction) {
    if (action.root !== this.state.root || action.generation !== this.state.generation) return
    const root = this.state.root,
      generation = this.state.generation
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
        await this.send('styles:clear-preview', {})
        this.previewAvailable = false
        this.publishDraft()
        this.publish()
        return
      }
      if (action.action === 'undo-draft' || action.action === 'revert-draft') {
        if (this.submitted) return
        this.drafts =
          action.action === 'undo-draft' ? (this.draftHistory.pop() ?? new Map()) : new Map()
        if (!this.drafts.size) {
          this.draftTarget = ''
          this.draftConflict = false
        }
        await this.refresh(true)
        await this.projectDrafts()
        return
      }
      if (action.action === 'apply-drafts') {
        if (
          !this.drafts.size ||
          this.submitted ||
          this.submitting ||
          this.draftConflict ||
          this.target() !== this.draftTarget
        )
          throw new Error('The selected element changed. Review or revert the preview draft.')
        this.submitting = true
        this.state.busy = true
        this.publish()
        try {
          for (const draft of this.drafts.values()) {
            const selectedFile = this.styleSourceFile(draft.field)
            if (draft.file !== selectedFile)
              throw new Error(
                'The selected source file changed. Review or revert the preview draft.'
              )
            const current = await sourceOwner().read(root, draft.file)
            if (current.hash !== draft.hash) {
              this.draftConflict = true
              this.publishDraft()
              throw new Error(
                'Source changed while the preview draft was pending. Review or revert it.'
              )
            }
          }
          const edits = [...this.drafts.values()].map((draft) => {
            const token = draft.tokenChoice
              ? this.state.fields
                  .find((field) => field.id === draft.field)
                  ?.tokens?.find((item) => item.id === draft.tokenChoice)?.label
              : undefined
            return `${draft.file} (SHA-256 ${draft.hash}): set ${draft.field.slice(6)} to ${draft.value}${token ? ` using token ${token}` : ''}`
          })
          await this.agent(
            root,
            `Apply this single batch of Styles preview drafts to the actual application source. Target ${this.element?.selector ?? ''} from ${this.element?.source ?? ''} in workspace ${root}. Preserve all other edits. Refuse any changed source hash, stale selection or unsupported target. Edits:\n${edits.join('\n')}`,
            true
          )
          if (root !== this.state.root || generation !== this.state.generation) return
          this.submitted = true
          this.state.edits = (this.state.edits ?? 0) + 1
          this.publishDraft()
        } finally {
          this.submitting = false
          this.state.busy = false
          this.publish()
        }
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
        await this.send('styles:clear-preview', {})
        // A style-watch read may have cached the temporary inline value. Re-read
        // the authored declaration after cancel so a var() stays visible.
        await this.refresh(true)
        if (this.drafts.size) await this.projectDrafts()
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
        const draft = this.drafts.get(action.field)
        if (draft?.value === value) draft.tokenChoice = action.value
        return
      }
      if (draftOwner && action.action === 'apply' && action.field?.startsWith('style:')) {
        if (this.submitted || this.submitting || this.draftConflict)
          throw new Error('Wait for Apply to finish or revert the stale draft.')
        const field = this.state.fields.find((f) => f.id === action.field)
        if (!field || field.disabled || !binding.preview || !this.element)
          throw new Error('This style has no safe live preview. Ask the agent to edit it.')
        const file = this.styleSourceFile(action.field)
        if (!file) throw new Error('This style has no source file. Ask the agent to edit it.')
        const current = await draftOwner.read(root, file)
        if (!current.hash || current.binary)
          throw new Error('This source cannot be previewed safely. Ask the agent to edit it.')
        const target = this.target()
        if (this.drafts.size && this.draftTarget !== target)
          throw new Error('The selected element changed. Review or revert the preview draft.')
        const prior = this.drafts.get(action.field)
        if ([...this.drafts.values()].some((draft) => draft.file !== file))
          throw new Error('The selected source file changed. Review or revert the preview draft.')
        if (prior && prior.hash !== current.hash)
          throw new Error('Source changed while the preview draft was pending.')
        this.draftTarget = target
        this.draftHistory.push(new Map(this.drafts))
        const prop = action.field.slice(6)
        const input = action.value ?? ''
        const value =
          field.kind === 'number' && /^-?\d+(\.\d+)?$/.test(input.trim())
            ? toCssText(prop, finite(input))
            : input
        this.drafts.set(action.field, {
          field: action.field,
          value,
          file,
          hash: current.hash
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
