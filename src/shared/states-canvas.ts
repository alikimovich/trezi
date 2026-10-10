/** App-owned recipes. No route, fixture module, or manifest is written to the project. */
export const STATES_CANVAS_PREFERENCE = 'trezi:states-canvases:v1'
export const CANVAS_PREFIX = 'canvas:'
export const CANVAS_ALL = 'all'

export interface CanvasState {
  id: string
  label: string
  props: Record<string, unknown>
}

export interface CanvasRecipe {
  id: string
  component: string
  source: string
  exportName: string
  /** Existing source export that wraps the component with required providers. */
  provider?: { source: string; exportName: string }
  /** Existing Vite-served module paths for React and react-dom/client. */
  react: string
  reactDom: string
  width: number
  states: CanvasState[]
  missing: { id: string; label: string; note: string }[]
  chat: string
  selection: { tag: string; source: string; path: number[] }
  revision: number
  last?: string
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
/** A same-origin module path, optionally with the dev server's `?v=<hash>` cache key so the
 * recipe can name the exact URL the component itself imports (one React instance). */
const modulePath = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const [path, query, ...rest] = value.split('?')
  return (
    !rest.length &&
    (query === undefined || /^v=[A-Za-z0-9]{1,32}$/.test(query)) &&
    path.startsWith('/') &&
    value.length <= 400 &&
    !path.startsWith('//') &&
    !/[#\\]/.test(value) &&
    path.split('/').every((part) => part !== '..' && part !== '.')
  )
}
const jsonData = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    return JSON.stringify(value).length <= 16_384
  } catch {
    return false
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

/** Validate an untrusted tool argument before it enters the preference or page world. */
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
    !modulePath(value.react) ||
    !modulePath(value.reactDom) ||
    !Number.isInteger(value.width) ||
    value.width < 120 ||
    value.width > 1600 ||
    !Array.isArray(value.states) ||
    !value.states.length ||
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
    if (
      !item ||
      !slug.test(item.id) ||
      item.id === CANVAS_ALL ||
      seen.has(item.id) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      item.label.length > 80 ||
      !jsonData(item.props)
    )
      return null
    seen.add(item.id)
    states.push({ id: item.id, label: item.label, props: item.props })
  }
  if (!Array.isArray(value.missing) || value.missing.length > 24) return null
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
    react: value.react,
    reactDom: value.reactDom,
    width: value.width,
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
