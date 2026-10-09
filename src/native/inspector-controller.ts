import type {
  PropInspection,
  ResolvedControlPanel,
  SelectedElement,
  StyleReadResult,
  TokenSet
} from '../shared/api'
import { animationControlsPrompt, controlsPrompt } from '../shared/controls-prompt'
import { numericValue, STYLE_PROP_META, sameCssValue, toCssText } from '../shared/css-values'
import type {
  NativeInspectorAction,
  NativeInspectorField,
  NativeInspectorState
} from '../shared/native-inspector'
import { describeSelectionForPrompt } from '../shared/selection-context'
import { showStatesText } from '../shared/states-workbench'
import { tokensForProp } from '../shared/token-match'

type Binding = {
  apply(value: string): Promise<any>
  preview?(value: string): Promise<any>
  reset?(): Promise<any>
  token?(value: string): Promise<any>
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
    updated: 0
  }
  requestedFile: string | null = null
  linked = new Set<string>()
  element: SelectedElement | null = null
  /** Every selection change, null when cleared; Layers follows it (LKM-179). */
  onElement: (element: SelectedElement | null) => void = () => {}
  inspection: PropInspection | null = null
  controls: ResolvedControlPanel[] = []
  tokens: TokenSet | null = null
  styles: StyleReadResult | null = null
  classRule: { file: string; className: string } | null = null
  readonly bindings = new Map<string, Binding>()
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
    this.state.tab = saved.tab
    this.state.visible = saved.visible
    await this.select(element)
  }
  /** LKM-172: the selection and the island belong to one project and one page. Drops both
   *  and publishes the hidden island now; a refresh still in flight is discarded. */
  clear() {
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
    this.build()
    this.publish()
    void this.send('styles:clear-preview', {}).catch(() => {})
  }
  async select(element: SelectedElement | null) {
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
    this.build()
    this.publish()
    if (element) await this.refresh()
  }
  /**
   * LKM-216: the live tree, the page or its CSS changed. Re-reads everything the island
   * shows (computed styles, props, tokens, controls) without a new generation, so open
   * fields update in place. An edit of the island's own (busy, or reconciling its
   * preview override) is left alone: it re-reads when it settles.
   */
  async invalidated() {
    if (!this.state.root || this.state.busy || this.reconciles.size) return
    await this.refresh(true)
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
      element && !element.source
        ? this.invoke('styles:resolve-class', root, element.classes)
        : Promise.resolve(null)
    ])
    if (generation !== this.sequence || root !== this.state.root || element !== this.element) return
    this.inspection = results[0].status === 'fulfilled' ? results[0].value : null
    const styles = results[1].status === 'fulfilled' ? results[1].value : null
    // Mid-reload the page has no selection to read; keep the last values until it has.
    if (!changed || styles?.values) this.styles = styles
    this.classRule = results[4].status === 'fulfilled' ? results[4].value : null
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
      for (const group of ['padding', 'margin'])
        this.state.actions.unshift({
          id: 'link:' + group,
          label: `${this.linked.has(group) ? 'Unlink' : 'Link'} ${group} sides`
        })
    }
    if (element)
      this.state.actions.unshift(
        { id: 'controls', label: 'Create controls…' },
        { id: 'animation', label: 'Add animation…' },
        { id: 'states', label: 'Show states…' }
      )
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
      for (const [prop, meta] of Object.entries(STYLE_PROP_META)) {
        if (meta.flexGridOnly && !/flex|grid/.test(values.display ?? '')) continue
        const tokens = tokensForProp(this.tokens, prop),
          value = values[prop] ?? '',
          id = 'style:' + prop
        const cssValue = (value: string) =>
          meta.control === 'number' && /^-?\d+(\.\d+)?$/.test(value.trim())
            ? toCssText(prop, finite(value))
            : value
        const targets = () =>
          this.linked.has(prop.split('-')[0])
            ? ['top', 'right', 'bottom', 'left'].map((side) => prop.split('-')[0] + '-' + side)
            : [prop]
        const apply = async (value: string, token?: any) => {
          const group = crypto.randomUUID(),
            changed: { prop: string; value: string }[] = []
          for (const target of targets()) {
            const result = await this.invoke(
              element.source ? 'styles:apply' : 'styles:apply-class',
              root,
              {
                source: element.source ?? '',
                prop: target,
                value: cssValue(value),
                classes: element.classes,
                authored: this.styles?.specified[target],
                token,
                group
              }
            )
            if (!result.applied) return result
            changed.push({ prop: target, value: cssValue(value) })
          }
          return { applied: true, nativeStyles: changed }
        }
        add(
          {
            id,
            label: prop,
            group: meta.group,
            kind: meta.control,
            value: meta.control === 'number' ? String(numericValue(prop, values) ?? value) : value,
            disabled: (!element.source && !this.classRule) || meta.control === 'readonly',
            min: meta.min,
            max: meta.max,
            step: meta.step,
            unit: meta.unit,
            options: meta.options,
            detail: this.styles?.specified[prop],
            tokens: tokens.map((t, i) => ({
              id: String(i),
              label: `${t.token.name} · ${t.token.value}`
            }))
          },
          {
            apply,
            preview: async (value) => {
              for (const target of targets())
                await this.send('styles:preview', { prop: target, value: cssValue(value) })
            },
            token: (value) => {
              const token = tokens[Number(value)]
              if (!token) throw new Error('This token is no longer available.')
              return apply(token.token.value, { name: token.token.name, group: token.group })
            }
          }
        )
      }
    } else if (this.state.tab === 'custom') {
      for (const panel of this.controls) {
        if (panel.params.some((p) => !p.valid))
          this.state.actions.unshift({
            id: `regenerate:${panel.manifest.id}`,
            label: `Repair ${panel.manifest.title}…`
          })
        this.state.actions.unshift({
          id: `remove:${panel.manifest.id}`,
          label: `Remove ${panel.manifest.title}`
        })
        if (panel.manifest.replay)
          this.state.actions.unshift({
            id: `replay:${panel.manifest.id}`,
            label: `Replay ${panel.manifest.title}`
          })
        for (const param of panel.params) {
          const id = `custom:${panel.manifest.id}:${param.id}`,
            apply = param.apply
          const kind = param.kind === 'toggle' ? 'toggle' : param.kind
          add(
            {
              id,
              label: param.label,
              group: panel.manifest.title,
              kind,
              value: String(param.value ?? ''),
              disabled: !param.valid,
              detail: param.reason,
              options: param.options,
              min: param.min,
              max: param.max,
              step: param.step,
              unit: param.unit
            },
            {
              apply: async (raw) => {
                const value =
                  param.kind === 'number'
                    ? finite(raw)
                    : param.kind === 'toggle'
                      ? raw === 'true'
                      : raw
                if (apply.strategy === 'literal')
                  return this.invoke(
                    'controls:apply-literal',
                    root,
                    panel.manifest.id,
                    param.id,
                    value
                  )
                if (!element?.source)
                  throw new Error('Select this component before editing its controls.')
                if (apply.strategy === 'style')
                  return this.invoke('styles:apply', root, {
                    source: element.source,
                    prop: apply.styleProp,
                    value: String(value),
                    classes: element.classes
                  })
                return this.invoke('props:apply', root, {
                  source: inspection?.source ?? element.componentSource ?? element.source,
                  name: apply.propName,
                  kind:
                    param.kind === 'number'
                      ? 'number'
                      : param.kind === 'toggle'
                        ? 'boolean'
                        : 'string',
                  value
                })
              }
            }
          )
        }
      }
      if (!this.controls.length)
        add({
          id: 'empty',
          label: 'Custom controls',
          group: '',
          kind: 'readonly',
          value: 'Create controls for the selected object to expose its source parameters.'
        })
    }
  }
  async action(action: NativeInspectorAction) {
    if (action.root !== this.state.root || action.generation !== this.state.generation) return
    const root = this.state.root,
      generation = this.state.generation
    try {
      if (action.action.startsWith('link:')) {
        const group = action.action.slice(5)
        if (['padding', 'margin'].includes(group)) {
          if (this.linked.has(group)) this.linked.delete(group)
          else this.linked.add(group)
          this.build()
          this.publish()
        }
        return
      }
      if (action.action === 'tab') {
        this.state.tab = ['props', 'styles', 'custom'].includes(action.value ?? '')
          ? action.value!
          : 'styles'
        this.build()
        this.publish()
        return
      }
      if (action.action === 'close') {
        this.state.visible = false
        this.clearReconciles()
        await this.send('styles:clear-preview', {})
        this.publish()
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
      if (action.action === 'states' && this.element) {
        const selection = describeSelectionForPrompt(this.element, root)
        await this.agent(root, showStatesText(selection, this.element.componentSource), true)
        return
      }
      if (action.action === 'controls' || action.action === 'animation') {
        if (this.element)
          await this.agent(
            root,
            (action.action === 'animation' ? animationControlsPrompt : controlsPrompt)(
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
      if (action.action.startsWith('regenerate:')) {
        const panel = this.controls.find((p) => p.manifest.id === action.action.slice(11))
        if (panel && this.element)
          await this.agent(
            root,
            controlsPrompt(this.element, root, this.inspection, action.value, this.provider(), {
              json: JSON.stringify(panel.manifest),
              brokenIds: panel.params.filter((p) => !p.valid).map((p) => p.id)
            }),
            true
          )
        return
      }
      if (action.action.startsWith('replay:')) {
        const panel = this.controls.find((p) => p.manifest.id === action.action.slice(7))
        if (panel) await this.send('preview:animation-replay', panel.manifest.component)
        return
      }
      if (action.action.startsWith('remove:')) {
        await this.invoke('controls:remove', root, action.action.slice(7))
        await this.refresh()
        return
      }
      const binding = this.bindings.get(action.field ?? '')
      if (!binding || this.state.fields.find((f) => f.id === action.field)?.disabled) return
      if (action.action === 'preview') {
        await binding.preview?.(action.value ?? '')
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
          if (generation === this.state.generation) {
            this.state.busy = false
            this.publish()
          }
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
