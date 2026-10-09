export interface NativeInspectorField {
  id: string
  label: string
  group: string
  kind: string
  value: string
  disabled?: boolean
  detail?: string
  options?: string[]
  min?: number
  max?: number
  step?: number
  unit?: string
  tokens?: { id: string; label: string }[]
  reset?: boolean
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
}
export interface NativeInspectorAction {
  root: string
  generation: number
  action: string
  field?: string
  value?: string
}
