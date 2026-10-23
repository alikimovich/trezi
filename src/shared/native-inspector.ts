export interface NativeInspectorField {
  id: string
  label: string
  group: string
  kind: string
  value: string
  disabled?: boolean
  detail?: string
  options?: string[]
  optionLabels?: Record<string, string>
  min?: number
  max?: number
  step?: number
  unit?: string
  tokens?: { id: string; label: string }[]
  reset?: boolean
  /** Compact Layout row. Paired fields keep the real longhands in the source. */
  layout?: 'size' | 'padding' | 'margin' | 'finish' | 'gap' | 'flow'
  axis?: 'horizontal' | 'vertical' | 'top' | 'right' | 'bottom' | 'left'
  mixed?: boolean
  expanded?: boolean
  /** A Custom tab control's panel id: its group header carries the panel's Comment and
   *  Remove menu, the control its own (LKM-323). */
  panel?: string
}
/** The Custom tab's request field and the request it runs (LKM-323). */
export interface NativeInspectorCustom {
  placeholder: string
  /** What the next request comments on ("Card › Radius"); absent asks for a new panel. */
  target?: string
  /** The running request ("Making controls…"); the field waits until it ends. */
  pending?: string
  error?: string
  enabled: boolean
  /** Each new value focuses the field. */
  focus: number
}
export interface NativeInspectorState {
  root: string
  generation: number
  visible: boolean
  title: string
  notice?: { title: string; reason: string; editable: boolean }
  tab: string
  fields: NativeInspectorField[]
  actions: { id: string; label: string }[]
  error: string
  busy: boolean
  /** Counts re-reads after a change that altered what the island shows; each new value
   *  plays the island's "updated" pulse (LKM-216). */
  updated?: number
  /** Counts edits whose write (and Undo record) finished, applied or not. A selection
   *  change resets `busy` but never this, so a test can wait for one specific edit. */
  edits?: number
  /** Only on the Custom tab. */
  custom?: NativeInspectorCustom
}
export interface NativeInspectorAction {
  root: string
  generation: number
  action: string
  field?: string
  value?: string
}
