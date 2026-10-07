import { previewAgentHost } from './preview-state'

/**
 * LKM-197: does the CSS/JS the preview loaded match what the dev server serves now?
 * After a dependency upgrade the page can keep old styles from WebKit's caches or from
 * a dev server that still serves its old pre-bundle. The page lists its same-origin
 * stylesheets and scripts with a hash of its (cached) copy and the size it decoded;
 * Bun fetches each one fresh from the dev server and compares.
 * Page-supplied URLs are untrusted: only paths on the dev server's origin are fetched.
 */
export interface PreviewFreshness {
  /** Assets compared. */
  checked: number
  /** null when nothing could be compared. */
  matches: boolean | null
  /** Paths whose loaded copy differs from what the server serves now. */
  stale: string[]
  note: string
}

interface PageAsset {
  url: string
  kind: 'style' | 'script'
  hash: string | null
  size: number
}

const MAX_ASSETS = 16
const MAX_URL = 2048
const STYLE_ACCEPT = 'text/css,*/*;q=0.1'

/** FNV-1a over UTF-16 code units; `PAGE_FNV` is the same function for the page. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
export const PAGE_FNV = `(text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}`

/** Runs in the preview's isolated world: the page's own copies of its CSS/JS. */
export const PAGE_ASSETS = `(async () => {
  const fnv = ${PAGE_FNV};
  const origin = location.origin, seen = new Map();
  const add = (raw, kind) => {
    try {
      const url = new URL(raw, location.href);
      url.hash = '';
      if (url.origin !== origin || seen.has(url.href)) return;
      seen.set(url.href, kind);
    } catch {}
  };
  for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) add(link.href, 'style');
  for (const script of document.querySelectorAll('script[src]')) add(script.src, 'script');
  for (const entry of performance.getEntriesByType('resource'))
    if (entry.initiatorType === 'script' || /\\.(css|m?js|jsx|tsx?|vue|svelte)$/.test(new URL(entry.name).pathname))
      add(entry.name, ['link', 'css'].includes(entry.initiatorType) ? 'style' : 'script');
  const picked = [...seen].filter(([, kind]) => kind === 'style').slice(0, 8)
    .concat([...seen].filter(([, kind]) => kind === 'script').slice(0, 8));
  const sizes = new Map(performance.getEntriesByType('resource').map((e) => [e.name.split('#')[0], e.decodedBodySize || 0]));
  return Promise.all(picked.map(async ([url, kind]) => {
    let hash = null;
    try {
      const res = await fetch(url, { cache: 'force-cache', credentials: 'same-origin',
        headers: { Accept: kind === 'style' ? '${STYLE_ACCEPT}' : '*/*' } });
      if (res.ok) hash = fnv(await res.text());
    } catch {}
    return { url, kind, hash, size: sizes.get(url) || 0 };
  }));
})()`

function assets(raw: unknown, origin: string): PageAsset[] {
  if (!Array.isArray(raw)) return []
  const out: PageAsset[] = []
  for (const item of raw.slice(0, MAX_ASSETS)) {
    const { url, kind, hash, size } = (item ?? {}) as Record<string, unknown>
    if (typeof url !== 'string' || url.length > MAX_URL) continue
    try {
      if (new URL(url).origin !== origin) continue
    } catch {
      continue
    }
    out.push({
      url,
      kind: kind === 'style' ? 'style' : 'script',
      hash: typeof hash === 'string' ? hash : null,
      size: typeof size === 'number' && Number.isFinite(size) ? size : 0
    })
  }
  return out
}

const pathOf = (url: string) => {
  const parsed = new URL(url)
  return parsed.pathname + parsed.search
}

/** Whether one loaded asset differs from the server's current response. */
export function staleAsset(page: { hash: string | null; size: number }, served: string): boolean {
  if (page.hash !== null && page.hash !== fnv1a(served)) return true
  return page.size > 0 && page.size !== Buffer.byteLength(served)
}

/**
 * Compares the preview's loaded CSS/JS with the dev server at `serverUrl`; null when no
 * preview page can be read (no project page open, the page refused the script).
 */
export async function previewFreshness(
  serverUrl: string,
  timeoutMs: number
): Promise<PreviewFreshness | null> {
  const host = previewAgentHost()
  if (!host) return null
  const deadline = Date.now() + timeoutMs
  let origin: string
  try {
    origin = new URL(serverUrl).origin
  } catch {
    return null
  }
  let page: PageAsset[]
  try {
    page = assets(await host.evaluate(PAGE_ASSETS, 'preview', Math.max(500, timeoutMs / 2)), origin)
  } catch {
    return null
  }
  const results = await Promise.all(
    page.map(async (asset) => {
      try {
        const res = await fetch(asset.url, {
          cache: 'no-store',
          redirect: 'error',
          headers: { Accept: asset.kind === 'style' ? STYLE_ACCEPT : '*/*' },
          signal: AbortSignal.timeout(Math.max(250, deadline - Date.now()))
        })
        if (!res.ok) return null
        return staleAsset(asset, await res.text())
      } catch {
        return null
      }
    })
  )
  const checked = results.filter((r) => r !== null).length
  const stale = page.filter((_asset, i) => results[i] === true).map((asset) => pathOf(asset.url))
  return {
    checked,
    matches: checked ? stale.length === 0 : null,
    stale,
    note: !checked
      ? 'No stylesheet or script of the page could be compared with the dev server.'
      : stale.length
        ? 'The preview runs older CSS/JS than the dev server serves now: call reload_preview with hard: true; if it stays stale, restart_dev_server with cleanCache: true.'
        : 'The CSS/JS the preview loaded matches what the dev server serves now.'
  }
}
