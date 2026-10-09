// LKM-220: what Trezi remembers about each states workbench, next to its manifest (which
// stays the agent's record): the page it was opened from, the state last viewed and the
// chat that made it. Kept per project in one preference, so it survives restarts; entries
// whose folder no longer holds a manifest are pruned on every scan. Pure: no I/O.

import { ALL_STATES, normalizeRoute, type Workbench } from './states-workbench'

export const STATES_RECORDS_PREFERENCE = 'trezi:states-workbenches:v1'

/** The selected component instance, found again by the Layers fingerprint. */
export interface WorkbenchSelection {
  tag: string
  id: string | null
  source: string | null
  componentSource: string | null
  path: number[] | null
}

/** The page a workbench was opened from. */
export interface WorkbenchOrigin {
  url: string
  title?: string
  x?: number
  y?: number
  selection?: WorkbenchSelection
}

export interface WorkbenchRecord {
  origin?: WorkbenchOrigin
  /** The state last viewed (never `all`). */
  last?: string
  /** The chat session key that built (or last asked for) it. */
  chat?: string
}

/** root → folder → record */
export type WorkbenchRecords = Record<string, Record<string, WorkbenchRecord>>

const str = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value && value.length <= max ? value : undefined
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e7
    ? Math.round(value)
    : undefined

function selection(value: unknown): WorkbenchSelection | undefined {
  const raw = value as Record<string, unknown> | null
  const tag = str(raw?.tag, 40)
  if (!raw || !tag) return undefined
  const path = Array.isArray(raw.path) && raw.path.length <= 64 ? raw.path : null
  return {
    tag,
    id: str(raw.id, 200) ?? null,
    source: str(raw.source, 600) ?? null,
    componentSource: str(raw.componentSource, 600) ?? null,
    path: path?.every((n) => Number.isInteger(n) && n >= 0) ? (path as number[]) : null
  }
}

export function normalizeOrigin(value: unknown): WorkbenchOrigin | undefined {
  const raw = value as Record<string, unknown> | null
  const url = str(raw?.url, 2000)
  if (!raw || !url || !/^https?:\/\//.test(url)) return undefined
  const title = str(raw.title, 120)
  const x = num(raw.x)
  const y = num(raw.y)
  const picked = selection(raw.selection)
  return {
    url,
    ...(title ? { title } : {}),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(picked ? { selection: picked } : {})
  }
}

function record(value: unknown): WorkbenchRecord | undefined {
  const raw = value as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object') return undefined
  const origin = normalizeOrigin(raw.origin)
  const last = str(raw.last, 40)
  const chat = str(raw.chat, 200)
  const out: WorkbenchRecord = {
    ...(origin ? { origin } : {}),
    ...(last && last !== ALL_STATES ? { last } : {}),
    ...(chat ? { chat } : {})
  }
  return Object.keys(out).length ? out : undefined
}

/** The stored preference, validated; anything unusable is dropped. */
export function normalizeRecords(value: unknown): WorkbenchRecords {
  let raw = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  const out: WorkbenchRecords = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [root, folders] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
    if (!root.startsWith('/') || !folders || typeof folders !== 'object') continue
    const list: Record<string, WorkbenchRecord> = {}
    for (const [folder, value] of Object.entries(folders as Record<string, unknown>).slice(0, 32)) {
      const next = record(value)
      if (next && folder && folder.length <= 400) list[folder] = next
    }
    if (Object.keys(list).length) out[root] = list
  }
  return out
}

/** `store` with `root`'s records replaced (removed when empty). */
export function storeRecords(
  store: WorkbenchRecords,
  root: string,
  records: Record<string, WorkbenchRecord>
): WorkbenchRecords {
  const next = { ...store }
  if (Object.keys(records).length) next[root] = records
  else delete next[root]
  return next
}

/** Only the records of workbenches that still exist. */
export function pruneRecords(
  records: Record<string, WorkbenchRecord>,
  benches: readonly Workbench[]
): Record<string, WorkbenchRecord> {
  const folders = new Set(benches.map((bench) => bench.folder))
  return Object.fromEntries(Object.entries(records).filter(([folder]) => folders.has(folder)))
}

/** A `file:line[:col]` source as a project-relative file path, or null. */
export function sourceFile(source: string | null | undefined, root?: string): string | null {
  if (!source) return null
  let file = source.replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '')
  if (root && file.startsWith(`${root.replace(/\/$/, '')}/`)) file = file.slice(root.length + 1)
  return file.replace(/^\.\//, '') || null
}

/**
 * The workbench of a selected element's component, if one exists: the instance it was
 * opened from (same stamps), else the manifest's component source file holding the
 * element or its instance call site.
 */
export function benchForSelection(
  picked: Pick<WorkbenchSelection, 'source' | 'componentSource'>,
  benches: readonly Workbench[],
  records: Record<string, WorkbenchRecord>,
  root?: string
): Workbench | null {
  const instance = benches.find((bench) => {
    const origin = records[bench.folder]?.origin?.selection
    return (
      !!origin &&
      ((!!picked.componentSource && origin.componentSource === picked.componentSource) ||
        (!!picked.source && origin.source === picked.source))
    )
  })
  if (instance) return instance
  const files = [picked.source, picked.componentSource]
    .map((source) => sourceFile(source, root))
    .filter(Boolean)
  return (
    benches.find((bench) => {
      const file = sourceFile(bench.source, root)
      return !!file && files.includes(file)
    }) ?? null
  )
}

/** The words the switcher and menu use for a page: its title, else its path. */
export function pageLabel(origin: WorkbenchOrigin): string {
  if (origin.title) return origin.title
  try {
    const url = new URL(origin.url)
    return normalizeRoute(url.pathname) + url.search
  } catch {
    return origin.url
  }
}

/**
 * `url`'s path, query and hash on `base`'s origin. Preview ports are allocated per run, so
 * a stored absolute URL may point at a dead port or another project's dev server.
 */
export function rebaseUrl(url: string, base: string | null | undefined): string {
  if (!base) return url
  try {
    const from = new URL(url)
    return new URL(`${from.pathname}${from.search}${from.hash}`, base).href
  } catch {
    return url
  }
}

/** Whether two URLs are the same document (the hash aside). */
export function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return (
      x.origin === y.origin &&
      normalizeRoute(x.pathname) === normalizeRoute(y.pathname) &&
      x.search === y.search
    )
  } catch {
    return a === b
  }
}
