import type { RunningDevServer } from '../shared/api'
import { projectKey } from '../shared/projectKey'

// Shared with the agent tools without importing Electron's server lifecycle.
export const previewServers = new Map<string, RunningDevServer>()
const observations = new Map<
  string,
  {
    url: string
    stamps: number
    observedAt: number
    documentStartedAt: number | null
    server: RunningDevServer
  }
>()

export function observePreview(info: {
  url?: string
  stamps: number
  documentStartedAt?: number
}): void {
  if (!info.url || !Number.isFinite(info.stamps)) return
  let origin: string
  try {
    origin = new URL(info.url).origin
  } catch {
    return
  }
  for (const [key, server] of previewServers) {
    if (new URL(server.url).origin !== origin) continue
    observations.set(key, {
      server,
      url: info.url,
      stamps: info.stamps,
      observedAt: Date.now(),
      documentStartedAt: info.documentStartedAt ?? null
    })
  }
}

export function previewEvidence(root: string) {
  const key = projectKey(root)
  const server = previewServers.get(key)
  const stored = observations.get(key)
  const observation =
    stored?.server === server && stored
      ? {
          url: stored.url,
          stamps: stored.stamps,
          observedAt: stored.observedAt,
          documentStartedAt: stored.documentStartedAt
        }
      : null
  return {
    url: server?.url ?? null,
    running: Boolean(server),
    observation:
      server && observation && new URL(observation.url).origin === new URL(server.url).origin
        ? observation
        : null,
    // HTTP reachability/stamps do not establish which Git revision a hot compiler
    // served. Keep unknown explicit rather than mislabeling live HEAD as verified.
    servedRevision: null,
    revisionVerified: false
  }
}
