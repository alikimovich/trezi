import { projectKey } from '../shared/projectKey'
import { previewServers } from './preview-evidence'
import { getPreviewUrl, previewAgentHost } from './preview-state'

/** The page the user's preview shows, as every preview tool names it. */
export interface PreviewPage {
  url: string
  origin: string
  port: string
  route: string
}

/**
 * LKM-199: one page for every preview tool. Route, DOM and screenshot all read the
 * user's preview view, and its location comes from the page itself (an SPA route the
 * view's URL has not caught up with included). A chat's tools read the preview only
 * while it shows that chat's own dev server: after a project switch or a server on
 * another port, an answer would describe a different page, so they refuse and say why.
 */
export async function previewPage(
  root?: string
): Promise<{ page: PreviewPage | null; refusal?: string }> {
  const page = parsePage((await pageLocation()) ?? getPreviewUrl())
  const server = root ? previewServers.get(projectKey(root)) : undefined
  const expected = server ? parsePage(server.url) : null
  if (!page || !expected || page.origin === expected.origin) return { page }
  return {
    page,
    refusal: `The user's preview shows ${page.url} (port ${page.port}), not this project's dev server ${expected.origin} (port ${expected.port}), so its route, DOM and screenshot would describe another page. Call open_preview with a path to show this project's page, then look again.`
  }
}

/** "Preview page: <url> (port N, route /x)." — appended to every preview tool's answer. */
export function describePage(page: PreviewPage): string {
  return `Preview page: ${page.url} (port ${page.port}, route ${page.route}).`
}

async function pageLocation(): Promise<string | null> {
  try {
    const href = await previewAgentHost()?.evaluate('location.href', 'preview', 1000)
    return typeof href === 'string' ? href : null
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
