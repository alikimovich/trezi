import { agentRuntime, agentRuntimeEnded } from './agent-runtime'
import type { PreviewIdentity } from './preview-identity'
import { type SourceSnapshot, sourceSnapshot } from './source-snapshot'

/**
 * LOCAL-WEBKIT-1: what a private agent page shows, checked rather than sampled. A
 * page's source is verified only when all of these hold:
 *  - its agent's private server is still running, with the generation and origin the
 *    document loaded from (a restart or another worktree is a new server);
 *  - the observed document is the last navigation the page made and the same
 *    document (`performance.timeOrigin`) that loaded then;
 *  - the worktree's source snapshot was the same when the navigation started, when it
 *    finished loading, and now.
 * Anything else answers `verified: false` with the first failing reason, so an edit,
 * a base change, a server restart or a navigation after a check can never keep an
 * earlier success. Hot reload may have applied a later edit; it is not counted.
 */
export type SourceReason =
  | 'not-loaded'
  | 'runtime-stopped'
  | 'runtime-restarted'
  | 'unknown-navigation'
  | 'document-replaced'
  | 'snapshot-unavailable'
  | 'changed-during-load'
  | 'source-changed'

export interface RuntimeIdentity {
  kind: 'private' | 'live'
  /** The private browser and runtime id. */
  agent: string
  /** The checkout the page is served from: the agent's worktree, or the live root. */
  root: string
  url: string | null
  /** The owner's generation of the private server; null for the visible server. */
  generation: number | null
  /** Why the private server last ended by itself, when it did. */
  ended?: string
}

export interface SourceIdentity {
  /** The snapshot the document loaded (equal before and after its load), when known. */
  served: string | null
  /** The candidate Git tree of `served` (LOCAL-WEBKIT-3), when known. */
  servedTree?: string | null
  /** The worktree's snapshot now. */
  current: string | null
  head: string | null
  dirty: number
  verified: boolean
  reason: SourceReason | null
  /** The snapshot's own failure, for `snapshot-unavailable`. */
  detail?: string
}

/** One main-frame navigation of a private page, recorded as it starts and loads. */
export interface ServedRecord {
  navigation: number
  generation: number | null
  origin: string | null
  before: Promise<SourceSnapshot | null>
  after: Promise<SourceSnapshot | null>
  started: Promise<number | null>
}

export const snapshotOf = (root: string): Promise<SourceSnapshot | null> =>
  sourceSnapshot(root).catch(() => null)

const originOf = (url: string | null) => {
  try {
    return url ? new URL(url).origin : null
  } catch {
    return null
  }
}

/** The private page's identity: the PreviewIdentity fields plus `runtime` and `source`. */
export async function privateIdentity(page: {
  id: string
  root: string
  url: string | null
  navigation: number
  served: ServedRecord | null
  documentStartedAt: () => Promise<number | null>
}): Promise<PreviewIdentity> {
  const server = agentRuntime(page.id)
  const served = page.served
  const [before, after, recordedStart, now, started] = await Promise.all([
    served?.before ?? null,
    served?.after ?? null,
    served?.started ?? null,
    snapshotOf(page.root),
    page.documentStartedAt()
  ])
  let reason: SourceReason | null = null
  if (!page.url || page.navigation === 0) reason = 'not-loaded'
  else if (!served) reason = 'unknown-navigation'
  else if (!server || server.root !== page.root) reason = 'runtime-stopped'
  else if (served.generation !== server.generation || served.origin !== originOf(server.url))
    reason = 'runtime-restarted'
  else if (served.navigation !== page.navigation) reason = 'unknown-navigation'
  else if (recordedStart === null || started === null || recordedStart !== started)
    reason = 'document-replaced'
  else if (!before?.id || !after?.id || !now?.id) reason = 'snapshot-unavailable'
  else if (before.id !== after.id) reason = 'changed-during-load'
  else if (after.id !== now.id) reason = 'source-changed'
  const unavailable = [before, after, now].find((snapshot) => snapshot && !snapshot.id)
  const ended = agentRuntimeEnded(page.id)
  const generation = server?.generation ?? served?.generation ?? null
  return {
    session: `rt-${page.id}-g${generation ?? 0}`,
    navigation: page.navigation,
    documentStartedAt: started !== null ? new Date(started).toISOString() : null,
    servedRevision: before?.head ?? null,
    liveRevision: now?.head ?? null,
    stale: reason !== null,
    runtime: {
      kind: 'private',
      agent: page.id,
      root: page.root,
      url: server?.url ?? null,
      generation,
      ...(ended && !server ? { ended: ended.reason } : {})
    },
    source: {
      served: before?.id && before.id === after?.id ? before.id : null,
      servedTree: before?.id && before.id === after?.id ? before.tree : null,
      current: now?.id ?? null,
      head: now?.head ?? null,
      dirty: now?.dirty ?? 0,
      verified: reason === null,
      reason,
      ...(reason === 'snapshot-unavailable' && unavailable?.reason
        ? { detail: unavailable.reason }
        : {})
    }
  }
}

const REASONS: Record<SourceReason, string> = {
  'not-loaded': 'the agent page has not loaded a route from its private server yet',
  'runtime-stopped': "the agent's private dev server is not running",
  'runtime-restarted': 'the private dev server restarted after this document loaded',
  'unknown-navigation': 'the page navigated without Trezi recording its source',
  'document-replaced': 'the document was replaced after it loaded',
  'snapshot-unavailable': "the worktree's exact source could not be read",
  'changed-during-load': 'the worktree changed while the page was loading',
  'source-changed': 'the worktree changed after the page loaded'
}

/** One line for a tool answer about a private page's source. */
export function describeSource(identity: PreviewIdentity): string | null {
  const { runtime, source } = identity
  if (runtime?.kind !== 'private' || !source) return null
  const where = `Private agent dev server ${runtime.url ?? 'stopped'} (generation ${runtime.generation ?? 'none'}) serving the agent's worktree`
  if (source.verified)
    return `${where}. Source verified: snapshot ${source.served?.slice(0, 12)}, ${source.dirty} uncommitted path${source.dirty === 1 ? '' : 's'} over ${source.head?.slice(0, 10) ?? 'no commit'}.`
  const why = source.reason ? REASONS[source.reason] : 'unknown'
  const ended = runtime.ended ? ` It ended: ${runtime.ended.split('\n')[0]}` : ''
  return `${where}. Source NOT verified: ${why}${source.detail ? ` (${source.detail})` : ''}. Call reload_preview to load the current source.${ended}`
}
