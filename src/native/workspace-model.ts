/**
 * The workspace's operations and client-side validation. The persisted file,
 * `<profile>/workspace.json` in its unchanged legacy format, has one writer: the
 * Swift owner (`src/service/WorkspaceFile.swift`), since LKM-111 removed the Bun
 * twin. The twin's recorded answers pin the format in `test/workspace-owner.mjs`.
 */
export interface WorkspaceEntryRecord {
  root: string
  key: string
  touchedAt?: unknown
  [field: string]: unknown
}
export interface WorkspaceRecent {
  root: string
  name: string
  at?: unknown
  [field: string]: unknown
}
export interface WorkspaceView {
  projects: WorkspaceEntryRecord[]
  activeKey: string | null
  recents: WorkspaceRecent[]
}
export type WorkspacePatch = { key: string; fields: Record<string, unknown> }

export type WorkspaceOperation =
  | { method: 'open'; root: string; chatSettings?: Record<string, unknown> }
  | { method: 'select' | 'close'; key: string }
  | { method: 'reorder'; key: string; before: string | null }
  | { method: 'update'; projects: WorkspacePatch[] }
  | { method: 'recent'; root: string; name: string }

export class WorkspaceModelError extends Error {
  constructor(
    readonly code: 'invalidRequest',
    message: string
  ) {
    super(message)
  }
}

export const MAX_PATCHES = 256
const MAX_ROOT = 4096
const MAX_TEXT = 8192
const MAX_NAME = 1024
const MAX_SESSIONS = 1000
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

const isObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max
const path = (value: unknown): value is string =>
  text(value, MAX_ROOT) && value.startsWith('/') && !LONE_SURROGATE.test(value)

/**
 * The legacy-owned metadata slice (sessions, servers, Git, display), written
 * through the typed `update` adapter. Swift owns membership, order, `root`,
 * `key`, `touchedAt`, `activeKey` and `recents`; Bun owns these values and
 * Swift only persists them. Each rule is the validation both owners apply.
 */
export const METADATA_FIELDS: Record<string, (value: unknown) => boolean> = {
  name: (value) => text(value, MAX_NAME),
  url: (value) => value === null || text(value, MAX_TEXT),
  previewKind: (value) => value === 'web' || value === 'simulator',
  branch: (value) => value === null || text(value, MAX_NAME),
  launchSpec: (value) => value === null || isObject(value),
  viewport: (value) => value === 'desktop' || value === 'mobile',
  chatsCollapsed: (value) => typeof value === 'boolean',
  environmentRevision: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  dependenciesPending: (value) => typeof value === 'boolean',
  sessionKeys: (value) =>
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_SESSIONS &&
    value.every((key) => text(key, MAX_TEXT)),
  activeSessionKey: (value) => text(value, MAX_TEXT),
  chatSettings: (value) => isObject(value),
  sourceSetup: (value) =>
    isObject(value) &&
    ['done', 'declined', 'failed', 'unstamped'].includes(value.state) &&
    Number.isSafeInteger(value.at) &&
    value.at >= 0 &&
    (value.reason === undefined || text(value.reason, MAX_TEXT)) &&
    Object.keys(value).every((name) => ['state', 'reason', 'at'].includes(name))
}

export const projectName = (root: string) => root.split('/').filter(Boolean).at(-1) ?? root

/** Strict request validation by the Bun client, before an operation reaches the owner. */
export function validateOperation(op: WorkspaceOperation) {
  const bad = (message: string) => new WorkspaceModelError('invalidRequest', message)
  switch (op.method) {
    case 'open':
      if (!path(op.root)) throw bad('A project needs an absolute path.')
      if (op.chatSettings !== undefined && !isObject(op.chatSettings))
        throw bad('Invalid chat settings.')
      return
    case 'select':
    case 'close':
      if (!text(op.key, MAX_ROOT)) throw bad('Invalid project key.')
      return
    case 'reorder':
      if (!text(op.key, MAX_ROOT) || !(op.before === null || text(op.before, MAX_ROOT)))
        throw bad('Invalid project order.')
      return
    case 'recent':
      if (!path(op.root) || !text(op.name, MAX_NAME)) throw bad('Invalid recent project.')
      return
    case 'update':
      if (!Array.isArray(op.projects) || op.projects.length < 1 || op.projects.length > MAX_PATCHES)
        throw bad('Invalid project update.')
      for (const patch of op.projects) {
        if (
          !isObject(patch) ||
          Object.keys(patch).length !== 2 ||
          !text(patch.key, MAX_ROOT) ||
          !isObject(patch.fields)
        )
          throw bad('Invalid project update.')
        const names = Object.keys(patch.fields)
        if (!names.length) throw bad('Empty project update.')
        for (const name of names) {
          const rule = Object.hasOwn(METADATA_FIELDS, name) ? METADATA_FIELDS[name] : undefined
          if (!rule || !rule(patch.fields[name]))
            throw bad(`Invalid project field ${JSON.stringify(name)}.`)
        }
      }
      return
    default:
      throw bad('Unknown workspace operation.')
  }
}
