// LKM-207: the component states workbench. The agent (agent-plugin/skills/component-states)
// writes one folder holding a scratch route and `trezi-workbench.json`; Trezi reads that
// manifest to drive the native switcher, the All-states grid and removal. Pure: no I/O.

export const WORKBENCH_MANIFEST = 'trezi-workbench.json'
/** The URL query parameter holding the current state id. */
export const STATE_PARAM = '__state'
/** `__state=all` renders every state side by side (the grid). */
export const ALL_STATES = 'all'

export interface WorkbenchState {
  id: string
  label: string
  note?: string
}

export interface Workbench {
  /** Repo-relative POSIX folder holding the manifest. */
  folder: string
  component: string
  source?: string
  /** Root-relative path, normalized without a trailing slash. */
  route: string
  width?: number
  states: WorkbenchState[]
  missing: WorkbenchState[]
  /** Repo-relative files outside the folder made only for the workbench. */
  seams: string[]
  fixtures: string[]
  chat?: string
  createdAt?: string
}

/** What the native switcher shows for the current preview URL. */
export interface StatesView {
  folder: string
  component: string
  states: WorkbenchState[]
  missing: WorkbenchState[]
  /** A state id, or `all` for the grid. */
  current: string
  hidden: boolean
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
const relPath = (value: unknown): string | undefined => {
  const path = text(value, 400)?.replace(/\\/g, '/')
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return undefined
  const parts = path.split('/').filter(Boolean)
  return parts.some((part) => part === '.' || part === '..' || part === '.git')
    ? undefined
    : parts.join('/')
}

export function normalizeRoute(path: string): string {
  let route = path.split(/[?#]/)[0].replace(/\/index\.html?$/i, '')
  while (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1)
  return route.startsWith('/') ? route : `/${route}`
}

function states(value: unknown, limit: number): WorkbenchState[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: WorkbenchState[] = []
  for (const item of value.slice(0, limit)) {
    const id = text((item as WorkbenchState)?.id, 40)
    if (!id || !ID.test(id) || id === ALL_STATES || seen.has(id)) continue
    seen.add(id)
    const note = text((item as WorkbenchState).note, 200)
    out.push({
      id,
      label: text((item as WorkbenchState).label, 40) ?? id,
      ...(note ? { note } : {})
    })
  }
  return out
}

/** A manifest found at `<folder>/trezi-workbench.json`, or null when it is unusable. */
export function parseWorkbench(raw: string, folder: string): Workbench | null {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const route = text(data.route, 300)
  const listed = states(data.states, 24)
  if (!route || !listed.length) return null
  const width = typeof data.width === 'number' && data.width >= 120 && data.width <= 4000
  const seams = Array.isArray(data.seams) ? data.seams.slice(0, 32).map(relPath) : []
  const fixtures = Array.isArray(data.fixtures)
    ? data.fixtures
        .slice(0, 32)
        .map((name) => text(name, 80))
        .filter((name) => name && /^[\w$.-]+$/.test(name))
    : []
  const optional = (key: string, max: number) => {
    const value = text(data[key], max)
    return value ? { [key]: value } : {}
  }
  return {
    folder,
    component: text(data.component, 120) ?? folder.split('/').pop() ?? 'Component',
    ...optional('source', 400),
    route: normalizeRoute(route),
    ...(width ? { width: Math.round(data.width as number) } : {}),
    states: listed,
    missing: states(data.missing, 24).filter((state) => !listed.some((s) => s.id === state.id)),
    seams: seams.filter((path): path is string => !!path && !`${path}/`.startsWith(`${folder}/`)),
    fixtures: fixtures as string[],
    ...optional('chat', 200),
    ...optional('createdAt', 40)
  }
}

/** The workbench serving `url` (any origin) and its current state, or null. */
export function matchWorkbench(
  url: string,
  workbenches: readonly Workbench[]
): { workbench: Workbench; current: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null
  const route = normalizeRoute(parsed.pathname)
  const workbench = workbenches.find((bench) => bench.route === route)
  if (!workbench) return null
  const asked = parsed.searchParams.get(STATE_PARAM) ?? ''
  const current =
    asked === ALL_STATES || workbench.states.some((state) => state.id === asked)
      ? asked
      : workbench.states[0].id
  return { workbench, current }
}

/** `url` with `__state` set, everything else (path, other params, hash) kept. */
export function stateUrl(url: string, id: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set(STATE_PARAM, id)
  return parsed.toString()
}

/** The state `step` places from `current` (wrapping; the grid steps from its ends). */
export function stepState(view: Pick<StatesView, 'states' | 'current'>, step: number): string {
  const ids = view.states.map((state) => state.id)
  const at = ids.indexOf(view.current)
  if (at < 0) return step > 0 ? ids[0] : ids[ids.length - 1]
  return ids[(at + step + ids.length) % ids.length]
}

/** The `/states` command (`agent-plugin/skills/component-states`, user-invoked only). */
export const STATES_INVOCATION = /(?:^|\s)\/states(?=\s|$)/

/** The turn text for Show states on a selected element (toolbar or … menu). */
export function showStatesText(selection: string, componentSource?: string | null): string {
  const instance = componentSource ? `The component instance is at ${componentSource}. ` : ''
  return `/states ${selection}${instance}Build a states workbench for this component.`
}

/** Appended to a `/states` prompt so the manifest records the creating chat. */
export function statesContext(text: string, chat: string): string {
  return STATES_INVOCATION.test(text)
    ? `\n\nTrezi chat key for the workbench manifest "chat" field: ${JSON.stringify(chat)}.`
    : ''
}

/**
 * The project root a chat session key belongs to. A project's first chat uses the project's
 * own key; additional or resumed chats use `${projectKey}#…`. The live chat knows its root
 * best (`live`), but a chat created by an event before its setup has an empty root: an
 * empty root counts as missing. Otherwise the project whose key precedes the `#`.
 */
export function chatRoot(
  key: string,
  projects: readonly { key: string; root: string }[],
  live?: (key: string) => string | undefined
): string | undefined {
  return (
    live?.(key) ||
    (projects.find((p) => p.key === key) ?? projects.find((p) => p.key === key.split('#')[0]))?.root
  )
}

/** The text search terms that mean a removed workbench left something behind. */
export function leftoverTerms(workbench: Workbench): string[] {
  const terms = [workbench.route, workbench.folder, ...workbench.fixtures]
  return [...new Set(terms.filter((term) => term && term !== '/' && term.length >= 4))]
}
