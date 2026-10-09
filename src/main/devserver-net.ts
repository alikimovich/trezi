import { createServer } from 'node:net'
import type { Framework } from '../shared/api'

/**
 * Pure networking helpers for the dev-server runner (no electron/child_process —
 * so they're unit-testable). Cover URL parsing, IPv4/IPv6 reachability, finding
 * a free port, and detecting an already-running dev server.
 */

/** `host` undefined = bind the unspecified address (node's dual-stack default). */
function tryBind(port: number, host?: string): Promise<'free' | 'in-use' | 'error'> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', (err: NodeJS.ErrnoException) =>
      resolve(err.code === 'EADDRINUSE' ? 'in-use' : 'error')
    )
    srv.once('listening', () => srv.close(() => resolve('free')))
    if (host === undefined) srv.listen(port)
    else srv.listen(port, host)
  })
}

/**
 * Can we bind `port` on `host`? (Used to pick a free preview port.)
 *
 * The `host` bind alone does NOT see every occupant: node sets SO_REUSEADDR, so
 * on macOS/BSD binding 127.0.0.1 succeeds while another process holds the
 * dual-stack wildcard on that port — the shape any `server.listen(port)` takes.
 * A false "free" is not a harmless retry: start() hands the port to the dev
 * server AND settles on the first thing that answers `http://host:port`, so the
 * squatter answers before our own server fails to bind and trezi previews a
 * stranger's app under the user's project name. Hence the second, wildcard
 * probe. It only ever votes "occupied" on an explicit EADDRINUSE — a wildcard
 * bind refused for any other reason (a sandbox, no IPv6) says nothing about the
 * port, and must not starve allocation of every port in the range.
 */
export async function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  if ((await tryBind(port, host)) !== 'free') return false
  return (await tryBind(port)) !== 'in-use'
}

// Ports browsers (Chromium) and the WHATWG fetch spec refuse to connect to — so
// the preview and the readiness probe both reject them (e.g. 6666 is IRC). The
// dev server could bind one, but nothing could load it. Skip them.
// https://fetch.spec.whatwg.org/#port-blocking
export const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080
])

/**
 * First free, browser-loadable port at or above `base` (a predictable,
 * conflict-free preview port that isn't on the blocked list).
 */
export async function findFreePort(base: number, attempts = 200): Promise<number> {
  for (let p = base; p < base + attempts && p <= 65535; p++) {
    if (BLOCKED_PORTS.has(p)) continue
    if (await isPortFree(p)) return p
  }
  throw new Error(`No free port found from ${base}.`)
}

export const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)]*)/i

// Dev servers colorize output (e.g. a bold port) even with FORCE_COLOR=0; the
// escape codes land inside the parsed URL and break it. Strip them first.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes start with ESC
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export function normalizeUrl(raw: string): string {
  return raw
    .replace('0.0.0.0', 'localhost')
    .replace(/[.,)]*$/, '')
    .replace(/\/$/, '')
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** GET the URL with a timeout; returns the HTTP status, or null if unreachable. */
export async function probe(url: string, ms = 1500): Promise<number | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { redirect: 'manual', signal: ctrl.signal })
    return res.status
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * Loopback host variants for a localhost-ish URL, preferring IPv4. A dev server
 * that binds to `localhost` can end up IPv6-only (`[::1]`) while the preview
 * resolves `localhost` to IPv4 (`127.0.0.1`) — so we try the concrete hosts and
 * use whichever actually answers, instead of trusting `localhost`.
 */
export function hostVariants(url: string): string[] {
  const m = /^(https?:\/\/)(\[[^\]]+\]|[^/:]+)(:\d+)?(\/.*)?$/.exec(url)
  if (!m) return [url]
  const [, proto, host, port = '', path = ''] = m
  if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(host)) return [url]
  const build = (h: string): string => `${proto}${h}${port}${path}`.replace(/\/$/, '')
  return [build('127.0.0.1'), build('localhost'), build('[::1]')]
}

/** Poll the candidate URLs until one answers; returns the reachable one (or null). */
export async function waitForReachable(
  urls: string[],
  isSettled: () => boolean
): Promise<string | null> {
  for (let i = 0; i < 120; i++) {
    if (isSettled()) return null
    for (const u of urls) {
      if (isSettled()) return null
      if ((await probe(u)) != null) return u
    }
    await delay(500)
  }
  return null
}

/**
 * Ports a framework's dev server is most likely already serving on. Only known
 * frameworks have a meaningful default — for 'unknown' we don't guess (avoids
 * attaching to an unrelated app that happens to hold 5173/3000).
 */
export function defaultPorts(framework?: Framework): number[] {
  switch (framework) {
    case 'next':
    case 'cra':
      return [3000]
    case 'sveltekit':
    case 'vite':
      return [5173]
    default:
      return []
  }
}

/**
 * If the user already runs this project's dev server, find it so we can attach
 * instead of spawning a competitor — two dev servers on one project clash (e.g.
 * over SvelteKit's .svelte-kit/) and the duplicate errors. We only attach to a
 * HEALTHY server (status < 400). Trezi has no application web server.
 */
export async function findRunningServer(
  framework?: Framework,
  probeFn: (url: string, ms?: number) => Promise<number | null> = probe
): Promise<string | null> {
  for (const port of defaultPorts(framework)) {
    for (const host of ['127.0.0.1', '[::1]']) {
      const status = await probeFn(`http://${host}:${port}`, 1000)
      if (status != null && status < 400) return `http://${host}:${port}`
    }
  }
  return null
}
