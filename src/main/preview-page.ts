import { projectKey } from '../shared/projectKey'
import { previewServers } from './preview-evidence'
import { type PreviewIdentity, previewIdentity, previewSession } from './preview-identity'
import { previewLoads } from './preview-loads'
import { getPreviewUrl, previewAgentHost } from './preview-state'
import { phase } from './tool-timing'

/** The page the user's preview shows, as every preview tool names it. */
export interface PreviewPage {
  url: string
  origin: string
  port: string
  route: string
}

/** The page's own location, document start and load state, in one read. */
export const PAGE_PROBE =
  '({ href: location.href, startedAt: performance.timeOrigin, ready: document.readyState })'

/**
 * LKM-199: one page for every preview tool. Route, DOM and screenshot all read the
 * user's preview view, and its location comes from the page itself (an SPA route the
 * view's URL has not caught up with included). A chat's tools read the preview only
 * while it shows that chat's own dev server: after a project switch or a server on
 * another port, an answer would describe a different page, so they refuse and say why.
 * LKM-200: the same read gives the observation's identity (session, navigation,
 * document start, served revision).
 */
export async function previewPage(
  root?: string
): Promise<{ page: PreviewPage | null; identity: PreviewIdentity; refusal?: string }> {
  const probe = await phase('page', pageProbe)
  const page = parsePage(probe?.href ?? getPreviewUrl())
  const identity = await phase('identity', () =>
    previewIdentity(page?.url ?? null, probe?.startedAt ?? null, root)
  )
  const server = root ? previewServers.get(projectKey(root)) : undefined
  const expected = server ? parsePage(server.url) : null
  if (!page || !expected || page.origin === expected.origin) return { page, identity }
  const own = previewSession(expected.origin)
  return {
    page,
    identity,
    refusal: `The user's preview shows ${page.url} (port ${page.port}${identity.session ? `, preview session ${identity.session}` : ''}), not this project's dev server ${expected.origin} (port ${expected.port}${own ? `, preview session ${own}` : ''}), so its route, DOM and screenshot would describe another page. Call open_preview with a path to show this project's page, then look again.`
  }
}

/** "Preview page: <url> (port N, route /x)." — appended to every preview tool's answer. */
export function describePage(page: PreviewPage): string {
  return `Preview page: ${page.url} (port ${page.port}, route ${page.route}).`
}

/**
 * LKM-200: the preview already shows `url`, fully loaded, with no navigation under way:
 * `open_preview` of that route answers at once instead of reloading it.
 */
export async function previewShows(url: string): Promise<boolean> {
  if (previewLoads.busy) return false
  const probe = await pageProbe()
  return probe?.ready === 'complete' && probe.href === url && !previewLoads.busy
}

async function pageProbe(): Promise<{
  href: string
  startedAt: number | null
  ready: string | null
} | null> {
  try {
    const read = (await previewAgentHost()?.evaluate(PAGE_PROBE, 'preview', 1000)) as {
      href?: unknown
      startedAt?: unknown
      ready?: unknown
    } | null
    if (typeof read?.href !== 'string') return null
    return {
      href: read.href,
      startedAt: typeof read.startedAt === 'number' ? Math.round(read.startedAt) : null,
      ready: typeof read.ready === 'string' ? read.ready : null
    }
  } catch {
    return null
  }
}

function parsePage(url: string | null | undefined): PreviewPage | null {
  if (!url || !/^https?:/.test(url)) return null
  try {
    const parsed = new URL(url)
    return {
      url: parsed.href,
      origin: parsed.origin,
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
      route: parsed.pathname + parsed.search + parsed.hash
    }
  } catch {
    return null
  }
}
