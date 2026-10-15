/** App-owned recipes. No route, fixture module, or manifest is written to the project. */
export const STATES_CANVAS_PREFERENCE = 'trezi:states-canvases:v1'
export const CANVAS_PREFIX = 'canvas:'
export const CANVAS_ALL = 'all'
/** The id of the view Show states opens without a registered recipe. */
export const DISCOVERED_PREFIX = 'discovered:'

/**
 * A step run after a state mounts, for internal interactive states that props cannot reach
 * (an open menu, a focused field, a hovered card). `selector` is scoped to the state's own
 * frame; without it the component's first element is the target.
 */
export interface StateAction {
  type: 'click' | 'focus' | 'hover' | 'press' | 'type' | 'key'
  selector?: string
  text?: string
  key?: string
}

/** What `next/navigation` and `next/router` report inside a state's frame. */
export interface StateRoute {
  pathname?: string
  search?: string
  params?: Record<string, string>
}

/**
 * Props are JSON. A few tagged objects stand for values JSON cannot carry; the frame decodes
 * them: `{"$fn":"onSelect"}` a recorded no-op, `{"$date":"2026-01-01"}` a Date,
 * `{"$pending":true}` a promise that never settles, `{"$reject":"Network error"}` a rejected
 * promise, `{"$node":"text"}` rendered text and `{"$undefined":true}` an absent prop.
 */
export interface CanvasState {
  id: string
  label: string
  props: Record<string, unknown>
  actions?: StateAction[]
  route?: StateRoute
  /** Where the state came from: the live instance, prop/source discovery, or a recipe. */
  origin?: 'page' | 'discovered' | 'recipe'
  note?: string
}

export interface CanvasRecipe {
  id: string
  component: string
  source: string
  exportName: string
  /** Existing source export that wraps the component with required providers. */
  provider?: { source: string; exportName: string }
  width?: number
  states: CanvasState[]
  missing: { id: string; label: string; note: string }[]
  chat: string
  selection: { tag: string; source: string; path: number[] }
  revision: number
  last?: string
}

/** One frame the preview draws: the state the isolated runtime mounts. */
export type StatesFrame = Pick<CanvasState, 'id' | 'label' | 'props' | 'actions' | 'route'> & {
  note?: string
}

/** Bun → isolated preview. `open` draws `state` (or every state); a bundle-less open is the
 * "building" placeholder. */
export interface StatesViewCommand {
  command: 'open' | 'close'
  session: string
  component?: string
  source?: string
  width?: number
  states?: StatesFrame[]
  state?: string
  bundle?: { code: string; css: string }
  /** The component cannot be drawn: an actionable reason replaces the frames. */
  unavailable?: string
  notes?: string[]
}

const slug = /^[a-z0-9][a-z0-9-]{0,39}$/
const identifier = /^(default|[A-Za-z_$][\w$]*)$/
const source = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 400 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value.split('/').every((part) => part !== '.' && part !== '..' && part !== '')
const jsonData = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    return JSON.stringify(value).length <= 16_384
  } catch {
    return false
  }
}
const ACTIONS = new Set(['click', 'focus', 'hover', 'press', 'type', 'key'])
const text = (value: unknown, max: number) =>
  value === undefined || (typeof value === 'string' && value.length <= max)

function parseActions(value: unknown): StateAction[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 8) return null
  const out: StateAction[] = []
  for (const item of value) {
    if (
      !item ||
      !ACTIONS.has(item.type) ||
      !text(item.selector, 200) ||
      !text(item.text, 400) ||
      !text(item.key, 40)
    )
      return null
    out.push({
      type: item.type,
      ...(item.selector ? { selector: item.selector } : {}),
      ...(item.text !== undefined ? { text: item.text } : {}),
      ...(item.key ? { key: item.key } : {})
    })
  }
  return out
}

function parseRoute(value: unknown): StateRoute | null | undefined {
  if (value === undefined) return undefined
  const route = value as StateRoute | null
  if (
    !route ||
    typeof route !== 'object' ||
    !text(route.pathname, 400) ||
    (route.pathname !== undefined && !route.pathname.startsWith('/')) ||
    !text(route.search, 400) ||
    (route.params !== undefined &&
      (!route.params ||
        typeof route.params !== 'object' ||
        Object.entries(route.params).length > 16 ||
        Object.entries(route.params).some(([, v]) => typeof v !== 'string' || v.length > 200)))
  )
    return null
  return {
    ...(route.pathname ? { pathname: route.pathname } : {}),
    ...(route.search ? { search: route.search } : {}),
    ...(route.params ? { params: { ...route.params } } : {})
  }
}

/** One state from an untrusted tool argument or the stored preference. */
export function parseCanvasState(item: any): CanvasState | null {
  if (
    !item ||
    !slug.test(item.id) ||
    item.id === CANVAS_ALL ||
    typeof item.label !== 'string' ||
    !item.label.trim() ||
    item.label.length > 80 ||
    !jsonData(item.props) ||
    !text(item.note, 200)
  )
    return null
  const actions = parseActions(item.actions)
  const route = parseRoute(item.route)
  if (actions === null || route === null) return null
  return {
    id: item.id,
    label: item.label,
    props: item.props,
    ...(actions?.length ? { actions } : {}),
    ...(route ? { route } : {}),
    ...(item.note ? { note: item.note } : {}),
    origin: 'recipe'
  }
}

/** The id a recipe gets when the tool call names none: the component's source file and export, so
 * two exports of one file are two canvases. A short hash of the full pair keeps long paths apart. */
export function canvasIdFor(sourcePath: string, exportName: string): string {
  const key = `${sourcePath}#${exportName}`
  let hash = 5381
  for (let i = 0; i < key.length; i++) hash = (hash * 33 + key.charCodeAt(i)) >>> 0
  const tail = key
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase()
    .replace(/^-+/, '')
    .slice(-30)
    .replace(/^-+/, '')
  return `${CANVAS_PREFIX}${tail || 'c'}-${hash.toString(36).slice(0, 5)}`
}

/** Validate an untrusted tool argument before it enters the preference or page world. Recipes
 * stored before the isolated runtime named Vite module URLs (`react`, `reactDom`); those
 * fields are ignored, the component itself is what Trezi builds. */
export function parseCanvasRecipe(
  raw: unknown,
  chat: string,
  revision: number
): CanvasRecipe | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !chat || chat.length > 200)
    return null
  const value = raw as Record<string, any>
  if (
    typeof value.component !== 'string' ||
    !value.component.trim() ||
    value.component.length > 120 ||
    !source(value.source) ||
    !identifier.test(value.exportName) ||
    (value.width !== undefined &&
      (!Number.isInteger(value.width) || value.width < 120 || value.width > 1600)) ||
    !Array.isArray(value.states) ||
    value.states.length > 24
  )
    return null
  const selection = value.selection
  if (
    !selection ||
    typeof selection.tag !== 'string' ||
    selection.tag.length > 40 ||
    !source(selection.source) ||
    !Array.isArray(selection.path) ||
    selection.path.length > 64 ||
    !selection.path.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0)
  )
    return null
  const provider = value.provider
  if (provider && (!source(provider.source) || !identifier.test(provider.exportName))) return null
  const seen = new Set<string>()
  const states: CanvasState[] = []
  for (const item of value.states) {
    const state = parseCanvasState(item)
    if (!state || seen.has(state.id)) return null
    seen.add(state.id)
    states.push(state)
  }
  if (!Array.isArray(value.missing) || value.missing.length > 24) return null
  if (!states.length && !value.missing.length) return null
  const missing: CanvasRecipe['missing'] = []
  for (const item of value.missing) {
    if (
      !item ||
      !slug.test(item.id) ||
      seen.has(item.id) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      item.label.length > 80 ||
      typeof item.note !== 'string' ||
      item.note.length > 200
    )
      return null
    seen.add(item.id)
    missing.push({ id: item.id, label: item.label, note: item.note })
  }
  const id =
    typeof value.id === 'string' &&
    value.id.startsWith(CANVAS_PREFIX) &&
    slug.test(value.id.slice(CANVAS_PREFIX.length))
      ? value.id
      : canvasIdFor(value.source, value.exportName)
  return {
    id,
    component: value.component.trim(),
    source: value.source,
    exportName: value.exportName,
    ...(provider ? { provider: { source: provider.source, exportName: provider.exportName } } : {}),
    ...(value.width !== undefined ? { width: value.width } : {}),
    states,
    missing,
    chat,
    selection: { tag: selection.tag, source: selection.source, path: selection.path },
    revision,
    ...(typeof value.last === 'string' && states.some((state) => state.id === value.last)
      ? { last: value.last }
      : {})
  }
}

export function readCanvasRecipes(raw: string | null, root: string): CanvasRecipe[] {
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
    const list = parsed?.[root]
    if (!Array.isArray(list)) return []
    return list.slice(0, 64).flatMap((entry) => {
      const recipe = parseCanvasRecipe(
        entry,
        (entry as CanvasRecipe)?.chat,
        (entry as CanvasRecipe)?.revision
      )
      return recipe && recipe.id === (entry as CanvasRecipe).id ? [recipe] : []
    })
  } catch {
    return []
  }
}

export function writeCanvasRecipes(
  raw: string | null,
  root: string,
  recipes: CanvasRecipe[]
): string {
  let current: Record<string, unknown> = {}
  try {
    const data = JSON.parse(raw || '{}')
    if (data && typeof data === 'object' && !Array.isArray(data)) current = data
  } catch {}
  return JSON.stringify({ ...current, [root]: recipes.slice(0, 64) })
}
