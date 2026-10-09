import { createHash } from 'node:crypto'
import { bridge } from '../native/bridge'
import { NativeView } from '../native/platform'
import { projectKey } from '../shared/projectKey'
import { previewServers } from './preview-evidence'
import { liveHead, type PreviewIdentity, previewSession } from './preview-identity'
import type { AgentCapture, PreviewAgentHost } from './preview-state'

/** At most three independent WebKit pages, released after an idle session. */
export const AGENT_BROWSER_LIMIT = 3
export const AGENT_BROWSER_IDLE_MS = 120_000

export interface AgentBrowser {
  readonly id: string
  readonly root: string
  readonly host: PreviewAgentHost
  url: string | null
  navigation: number
  servedRevision: string | null
  speed: number
  setSpeed(speed: number): Promise<void>
  step(frames: number): Promise<void>
  capture(full?: boolean): Promise<AgentCapture | null>
  open(
    path: string
  ): Promise<{ url: string; loaded: boolean; status?: number | null; identity: PreviewIdentity }>
  identity(): Promise<PreviewIdentity>
  close(): Promise<void>
}

interface BrowserRecord {
  browser: AgentBrowser
  lastUsed: number
  timer: ReturnType<typeof setTimeout>
}
const browsers = new Map<string, BrowserRecord>()
const opening = new Map<string, Promise<AgentBrowser>>()

/** Injectable engine for the optional Chromium adapter and deterministic tests. */
export type BrowserFactory = (key: string, root: string) => Promise<AgentBrowser>
let chromiumFactory: BrowserFactory | null = null
export function registerChromiumBrowser(factory: BrowserFactory | null): void {
  chromiumFactory = factory
}

const sessionId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24)

async function webkitBrowser(key: string, root: string): Promise<AgentBrowser> {
  const id = sessionId(key)
  const viewName = `agent:${id}`
  await bridge().request('agentBrowserCreate', { session: id })
  const wc = new NativeView(viewName).webContents
  const onUrl = (event: { view?: string; url?: string }) => {
    if (event.view === viewName && typeof event.url === 'string') browser.url = event.url
  }
  const onLoaded = (event: { view?: string }) => {
    if (event.view === viewName) browser.navigation++
  }
  const browser: AgentBrowser = {
    id,
    root,
    url: null,
    navigation: 0,
    servedRevision: null,
    speed: 1,
    host: {
      evaluate: (code, world, timeoutMs) => wc.evaluateIn(code, world, timeoutMs),
      captureRect: (rect) => wc.captureRect(rect),
      setViewport: (width) => wc.setViewport(width),
      thumbnail: async (rect, width) => wc.captureThumbnail(rect ? { rect, width } : { width })
    },
    async capture(full = false) {
      const result = await wc.captureAgent({ full })
      return result?.jpeg
        ? { jpeg: Buffer.from(result.jpeg, 'base64'), width: result.width, height: result.height }
        : null
    },
    async setSpeed(speed) {
      await bridge().request('agentBrowserSpeed', { view: viewName, speed })
      browser.speed = speed
    },
    async step(frames) {
      await bridge().request('agentBrowserSpeed', { view: viewName, speed: 0, step: frames })
      browser.speed = 0
    },
    async open(path) {
      const server = previewServers.get(projectKey(root))
      if (!server) throw new Error('The project dev server is stopped.')
      const url = new URL(path, server.url).href
      if (new URL(url).origin !== new URL(server.url).origin)
        throw new Error('Route leaves the project dev server.')
      if (browser.url === url) {
        const ready = await browser.host
          .evaluate('document.readyState', 'preview', 1000)
          .catch(() => null)
        if (ready === 'complete') return { url, loaded: true, identity: await browser.identity() }
      }
      browser.servedRevision = await liveHead(root, true)
      const loaded = (await bridge().request(
        'agentBrowserOpen',
        { view: viewName, url },
        11_000
      )) as { url: string; loaded: boolean; status: number | null }
      browser.url = loaded.url
      return { ...loaded, identity: await browser.identity() }
    },
    async identity() {
      const started = await browser.host
        .evaluate('performance.timeOrigin', 'preview', 1000)
        .catch(() => null)
      const liveRevision = await liveHead(root)
      const servedRevision = browser.servedRevision
      return {
        session: `${previewSession(browser.url ? new URL(browser.url).origin : null) ?? 'ps'}-agent-${id}`,
        navigation: browser.navigation,
        documentStartedAt: typeof started === 'number' ? new Date(started).toISOString() : null,
        servedRevision,
        liveRevision,
        stale: !!servedRevision && !!liveRevision && servedRevision !== liveRevision
      }
    },
    async close() {
      bridge().off('url', onUrl)
      bridge().off('loaded', onLoaded)
      await bridge()
        .request('agentBrowserClose', { session: id })
        .catch(() => {})
      // NativeView is a bridge wrapper; its map entry must not retain a closed page.
      const { views } = await import('../native/platform')
      views.delete(viewName)
    }
  }
  bridge().on('url', onUrl)
  bridge().on('loaded', onLoaded)
  return browser
}

export async function agentBrowser(
  key: string,
  root: string,
  engine: 'webkit' | 'chromium' = 'webkit'
): Promise<AgentBrowser> {
  const name = `${engine}:${key}`
  const existing = browsers.get(name)
  if (existing) {
    existing.lastUsed = Date.now()
    clearTimeout(existing.timer)
    existing.timer = idleTimer(name)
    return existing.browser
  }
  const inFlight = opening.get(name)
  if (inFlight) return inFlight
  if (browsers.size + opening.size >= AGENT_BROWSER_LIMIT)
    throw new Error(`Agent browser limit (${AGENT_BROWSER_LIMIT}) reached.`)
  const factory = engine === 'chromium' ? chromiumFactory : webkitBrowser
  if (!factory)
    throw new Error(
      'Chromium agent browser is unavailable. Install agent-browser and use engine: "chromium" when configured.'
    )
  const created = factory(key, root)
  opening.set(name, created)
  try {
    const browser = await created
    browsers.set(name, { browser, lastUsed: Date.now(), timer: idleTimer(name) })
    return browser
  } finally {
    opening.delete(name)
  }
}

function idleTimer(name: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    void closeAgentBrowser(name)
  }, AGENT_BROWSER_IDLE_MS)
  timer.unref?.()
  return timer
}

export async function closeAgentBrowser(name: string): Promise<void> {
  const record = browsers.get(name)
  if (!record) return
  browsers.delete(name)
  clearTimeout(record.timer)
  await record.browser.close()
}

export function agentBrowserCount(): number {
  return browsers.size + opening.size
}
