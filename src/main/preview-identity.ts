import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RunningDevServer } from '../shared/api'
import { previewServers } from './preview-evidence'
import { previewLoads } from './preview-loads'

/**
 * LKM-200: which page an observation describes. Every preview observation (location,
 * screenshot, DOM, console, open_preview) carries the same identity: the preview
 * session (one dev server shown in the preview; a restart or another project is a new
 * session), the main-frame navigation, when the document started (the page's own
 * `performance.timeOrigin`) and the live revision the dev server had when it did.
 * A document that started before the live checkout's current revision is flagged
 * stale: hot reload may have applied the change, or it may not have.
 */
export interface PreviewIdentity {
  session: string | null
  navigation: number
  /** ISO time the document started, from the page itself. */
  documentStartedAt: string | null
  /** The live checkout's HEAD when the document's navigation started; null when unknown. */
  servedRevision: string | null
  /** The live checkout's HEAD now. */
  liveRevision: string | null
  stale: boolean
}

const execFileP = promisify(execFile)
const sessions = new WeakMap<RunningDevServer, string>()
let sessionCount = 0
/** Navigation id → the live HEAD read when it started (the last few only). */
const revisions = new Map<number, Promise<string | null>>()
const KEEP_REVISIONS = 16
const heads = new Map<string, { at: number; value: Promise<string | null> }>()
/** A HEAD read is reused this long (one `git rev-parse` per burst of tool calls). */
export const HEAD_TTL_MS = 1500

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** The project root and server shown at `origin`, if it is one of Trezi's dev servers. */
function serverAt(origin: string | null): { root: string; server: RunningDevServer } | null {
  if (!origin) return null
  for (const [root, server] of previewServers)
    if (originOf(server.url) === origin) return { root, server }
  return null
}

/** `ps-N` for the dev server at `origin`; null when no Trezi dev server serves it. */
export function previewSession(origin: string | null): string | null {
  const found = serverAt(origin)
  if (!found) return null
  let id = sessions.get(found.server)
  if (!id) {
    id = `ps-${++sessionCount}`
    sessions.set(found.server, id)
  }
  return id
}

/** The live checkout's HEAD (short-lived cache); null outside a Git repository. */
export function liveHead(root: string, fresh = false): Promise<string | null> {
  const now = Date.now()
  const cached = heads.get(root)
  if (!fresh && cached && now - cached.at < HEAD_TTL_MS) return cached.value
  const value = execFileP('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 3000 }).then(
    ({ stdout }) => stdout.trim() || null,
    () => null
  )
  heads.set(root, { at: now, value })
  return value
}

/** Records the served revision of each navigation as it starts. */
export function installPreviewIdentity(): void {
  previewLoads.onNavigation = (navigation, url) => {
    const found = serverAt(originOf(url))
    revisions.set(navigation, found ? liveHead(found.root, true) : Promise.resolve(null))
    for (const id of revisions.keys())
      if (revisions.size > KEEP_REVISIONS) revisions.delete(id)
      else break
  }
}

/** The identity of the document at `url` that started at `startedAt` (epoch ms). */
export async function previewIdentity(
  url: string | null,
  startedAt: number | null,
  root?: string
): Promise<PreviewIdentity> {
  const navigation = previewLoads.navigation
  const [servedRevision, liveRevision] = await Promise.all([
    revisions.get(navigation) ?? Promise.resolve(null),
    root ? liveHead(root) : Promise.resolve(null)
  ])
  return {
    session: url ? previewSession(originOf(url)) : null,
    navigation,
    documentStartedAt:
      startedAt !== null && Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : null,
    servedRevision,
    liveRevision,
    stale: !!servedRevision && !!liveRevision && servedRevision !== liveRevision
  }
}

const short = (sha: string | null) => sha?.slice(0, 10) ?? 'unknown'

/** One line for a tool answer: the identity fields, and the stale flag when it applies. */
export function describeIdentity(identity: PreviewIdentity): string {
  const line = `Preview identity: session ${identity.session ?? 'none'}, navigation ${identity.navigation}, document started ${identity.documentStartedAt ?? 'unknown'}, served revision ${short(identity.servedRevision)}.`
  return identity.stale
    ? `${line} Stale: this document loaded at ${short(identity.servedRevision)} and the live checkout has since moved to ${short(identity.liveRevision)}. Hot reload usually applies the change; if the page does not show it, call reload_preview.`
    : line
}
