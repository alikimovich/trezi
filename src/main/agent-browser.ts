import { createHash } from 'node:crypto'
import { bridge } from '../native/bridge'
import { NativeView } from '../native/platform'
import { projectKey } from '../shared/projectKey'
import { privateIdentity, type ServedRecord, snapshotOf } from './agent-identity'
import { dropRefScopes } from './agent-refs'
import { agentRuntime, ensureAgentRuntime, stopAgentRuntime } from './agent-runtime'
import type { AgentViewport } from './agent-viewport'
import { previewServers } from './preview-evidence'
import { liveHead, type PreviewIdentity, previewSession } from './preview-identity'
import type { AgentCapture, PreviewAgentHost } from './preview-state'

/** At most three independent WebKit pages, released after an idle session. */
export const AGENT_BROWSER_LIMIT = 3
export const AGENT_BROWSER_IDLE_MS = 120_000
let idleMs = AGENT_BROWSER_IDLE_MS
/** Test seam: a shorter idle limit (`null` restores the real one). */
export function setAgentBrowserIdleMs(ms: number | null): void {
  idleMs = ms ?? AGENT_BROWSER_IDLE_MS
}

/** A navigation the host refused or that failed (LKM-230), newest last. */
export interface AgentNotice {
  phase: 'blocked' | 'failed'
  reason?: string
  url: string
  message?: string
  at: number
}

export interface AgentBrowser {
  readonly id: string
  /** The checkout the page is served from: the agent's worktree when `runtime` is private. */
  readonly root: string
  /** LOCAL-WEBKIT-1: `private` pages load their own worktree's server; unset is the live one. */
  readonly runtime?: 'private' | 'live'
  readonly host: PreviewAgentHost
  url: string | null
  navigation: number
  /** LKM-230: a main-frame load is in flight; engines that cannot tell leave both unset. */
  loading?: boolean
  notices?: AgentNotice[]
  servedRevision: string | null
  /** LOCAL-WEBKIT-2: the page's own viewport and color scheme (unset is 1280×800, system). */
  viewport?: AgentViewport
  speed: number
  setSpeed(speed: number): Promise<void>
  step(frames: number): Promise<void>
  capture(full?: boolean): Promise<AgentCapture | null>
  /** `reload` loads the page again even when it already shows `path`; `hard` also drops WebKit's caches. */
  open(
    path: string,
    options?: { reload?: boolean; hard?: boolean }
  ): Promise<{ url: string; loaded: boolean; status?: number | null; identity: PreviewIdentity }>
  identity(): Promise<PreviewIdentity>
  close(): Promise<void>
}

interface BrowserRecord {
  browser: AgentBrowser
  lastUsed: number
  timer: ReturnType<typeof setTimeout>
  /** Operations in flight that must not be reclaimed as idle (`open`). */
  busy: number
}
const browsers = new Map<string, BrowserRecord>()
/**
 * A page being created. `released` is set when its session closed meanwhile
 * (`releaseAgentBrowsersFor`): the page is then closed on arrival, never published.
 */
interface Opening {
  promise: Promise<AgentBrowser>
  root: string
  isolated: boolean
  released: boolean
}
const opening = new Map<string, Opening>()
/**
 * A page being closed. Its teardown stops the runtime and drops the view under the id the
 * registry name maps to, so the same name is not reopened until the close has finished.
 */
const closing = new Map<string, Promise<void>>()
const CLOSED = 'The agent browser was closed.'
const RELEASED = 'The agent browser was released before it opened: its session closed.'

/** Injectable engine for the optional Chromium adapter and deterministic tests. */
export type BrowserFactory = (key: string, root: string) => Promise<AgentBrowser>
let chromiumFactory: BrowserFactory | null = null
export function registerChromiumBrowser(factory: BrowserFactory | null): void {
  chromiumFactory = factory
}

const sessionId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24)
/** How long `open` waits for the page's `loaded` event after the host answered it. */
const LOADED_EVENT_MS = 1000

/**
 * The agent's offscreen WebKit page. With `isolated` (LOCAL-WEBKIT-1) the page is the
 * agent's own: it loads `root`, the agent's worktree, from the private dev server the
 * runtime owner runs there for this page's id, and its identity is that worktree's
 * exact source (`./agent-identity`). Otherwise it loads the live server, as before.
 */
async function webkitBrowser(key: string, root: string, isolated = false): Promise<AgentBrowser> {
  const id = sessionId(isolated ? `${key}\0${root}` : key)
  const viewName = `agent:${id}`
  await bridge().request('agentBrowserCreate', { session: id })
  const wc = new NativeView(viewName).webContents
  /** The navigation in flight, recorded when it starts; `served` once it loaded. */
  let pending: Omit<ServedRecord, 'navigation' | 'after' | 'started'> | null = null
  let served: ServedRecord | null = null
  const loadWaiters = new Set<() => void>()
  /** Set by `close()`: an `open` still in flight stops instead of using a closed page. */
  let closed = false
  const timeOrigin = async () => {
    const value = await browser.host
      .evaluate('performance.timeOrigin', 'preview', 1000)
      .catch(() => null)
    return typeof value === 'number' ? value : null
  }
  const begin = () => {
    const server = agentRuntime(id)
    pending = {
      generation: server?.generation ?? null,
      origin: server ? new URL(server.url).origin : null,
      before: snapshotOf(root)
    }
  }
  const onUrl = (event: { view?: string; url?: string }) => {
    if (event.view === viewName && typeof event.url === 'string') browser.url = event.url
  }
  const onLoaded = (event: { view?: string }) => {
    if (event.view !== viewName) return
    browser.navigation++
    browser.loading = false
    if (isolated) {
      served = pending
        ? {
            ...pending,
            navigation: browser.navigation,
            after: snapshotOf(root),
            started: timeOrigin()
          }
        : null
      pending = null
    }
    for (const resolve of loadWaiters) resolve()
    loadWaiters.clear()
  }
  const onNavigation = (
    event: Omit<Partial<AgentNotice>, 'phase'> & { view?: string; phase?: string }
  ) => {
    if (event.view !== viewName) return
    if (event.phase === 'start') {
      browser.loading = true
      // A navigation the page started itself (a link, a redirect) is recorded from here.
      if (isolated && !pending) begin()
      return
    }
    if (event.phase !== 'blocked' && event.phase !== 'failed') return
    if (event.phase === 'failed') {
      browser.loading = false
      pending = null
    }
    const notices = browser.notices ?? []
    notices.push({
      phase: event.phase,
      reason: typeof event.reason === 'string' ? event.reason : undefined,
      url: typeof event.url === 'string' ? event.url : '',
      message: typeof event.message === 'string' ? event.message : undefined,
      at: Date.now()
    })
    browser.notices = notices.slice(-20)
  }
  const browser: AgentBrowser = {
    id,
    root,
    runtime: isolated ? 'private' : 'live',
    url: null,
    navigation: 0,
    loading: false,
    notices: [],
    servedRevision: null,
    speed: 1,
    host: {
      evaluate: (code, world, timeoutMs) => wc.evaluateIn(code, world, timeoutMs),
      captureRect: (rect) => wc.captureRect(rect),
      setViewport: (width, options) => wc.setViewport(width, options),
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
    async open(path, options) {
      // A closed page starts nothing: its private server would have no page and no owner.
      if (closed) throw new Error(CLOSED)
      let server: { url: string } | null | undefined
      try {
        server = isolated
          ? await ensureAgentRuntime(id, root)
          : previewServers.get(projectKey(root))
      } catch (error) {
        // `close()` cancels a start in flight (stopAgentRuntime), which rejects it here.
        if (closed) throw new Error(CLOSED)
        throw error
      }
      // A close after the start answered has stopped that server too (it ran after it).
      if (closed) throw new Error(CLOSED)
      if (!server) throw new Error('The project dev server is stopped.')
      const url = new URL(path, server.url).href
      if (new URL(url).origin !== new URL(server.url).origin)
        throw new Error('Route leaves the project dev server.')
      if (!options?.reload && browser.url === url) {
        const ready = await browser.host
          .evaluate('document.readyState', 'preview', 1000)
          .catch(() => null)
        if (ready === 'complete') return { url, loaded: true, identity: await browser.identity() }
      }
      const navigation = browser.navigation
      if (isolated) {
        begin()
        await pending?.before
        if (closed) {
          pending = null
          throw new Error(CLOSED)
        }
      } else browser.servedRevision = await liveHead(root, true)
      let loaded: { url: string; loaded: boolean; status: number | null }
      try {
        loaded = (await bridge().request(
          'agentBrowserOpen',
          { view: viewName, url, reload: !!options?.reload, hard: !!options?.hard },
          11_000
        )) as typeof loaded
      } catch (error) {
        pending = null
        throw error
      }
      browser.url = loaded.url
      // The host answers before it emits `loaded`; the identity needs that event's record.
      if (isolated && browser.navigation === navigation)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, LOADED_EVENT_MS)
          loadWaiters.add(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      return { ...loaded, identity: await browser.identity() }
    },
    async identity() {
      if (isolated)
        return privateIdentity({
          id,
          root,
          url: browser.url,
          navigation: browser.navigation,
          served,
          documentStartedAt: timeOrigin
        })
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
      closed = true
      dropRefScopes(id)
      bridge().off('url', onUrl)
      bridge().off('loaded', onLoaded)
      bridge().off('agent-navigation', onNavigation)
      await bridge()
        .request('agentBrowserClose', { session: id })
        .catch(() => {})
      // The page's private server goes with it; the visible one is never touched.
      if (isolated) await stopAgentRuntime(id)
      // NativeView is a bridge wrapper; its map entry must not retain a closed page.
      const { views } = await import('../native/platform')
      views.delete(viewName)
    }
  }
  bridge().on('url', onUrl)
  bridge().on('loaded', onLoaded)
  bridge().on('agent-navigation', onNavigation)
  return browser
}

/**
 * The agent's page for `key`. A WebKit page for a `root` other than `liveRoot` (an
 * isolated agent's worktree) is private: its own name, id and dev server, so a spawn
 * that shares its parent's key never shares its parent's page. Chromium and pages of
 * the live checkout load the live server, unchanged.
 */
export async function agentBrowser(
  key: string,
  root: string,
  engine: 'webkit' | 'chromium' = 'webkit',
  liveRoot: string = root
): Promise<AgentBrowser> {
  const isolated = engine === 'webkit' && projectKey(root) !== projectKey(liveRoot)
  const name = isolated ? privateName(key, root) : `${engine}:${key}`
  // The previous page of this name is still closing: wait, or its teardown would stop
  // the runtime and drop the view of the page created here.
  const closed = closing.get(name)
  if (closed) {
    await closed.catch(() => {})
    return agentBrowser(key, root, engine, liveRoot)
  }
  const existing = browsers.get(name)
  if (existing) {
    existing.lastUsed = Date.now()
    clearTimeout(existing.timer)
    existing.timer = idleTimer(name)
    return existing.browser
  }
  const inFlight = opening.get(name)
  if (inFlight) {
    if (!inFlight.released) return inFlight.promise
    // Its session closed while it was created: wait for it to be closed (it shares this
    // page's id), then open a fresh page.
    await inFlight.promise.catch(() => {})
    return agentBrowser(key, root, engine, liveRoot)
  }
  if (browsers.size + opening.size >= AGENT_BROWSER_LIMIT)
    throw new Error(`Agent browser limit (${AGENT_BROWSER_LIMIT}) reached.`)
  const factory = engine === 'chromium' ? chromiumFactory : webkitBrowser
  if (!factory)
    throw new Error(
      'Chromium agent browser is unavailable. Install agent-browser and use engine: "chromium" when configured.'
    )
  const created =
    engine === 'chromium' ? factory(key, liveRoot) : webkitBrowser(key, root, isolated)
  const entry: Opening = { promise: created, root, isolated, released: false }
  entry.promise = (async () => {
    try {
      const browser = await created
      if (entry.released) {
        // Closing also stops the page's private dev server, which nothing started yet.
        await browser.close().catch(() => {})
        throw new Error(RELEASED)
      }
      browsers.set(name, { browser, lastUsed: Date.now(), timer: idleTimer(name), busy: 0 })
      keepBusyOpen(name, browser)
      return browser
    } finally {
      if (opening.get(name) === entry) opening.delete(name)
    }
  })()
  opening.set(name, entry)
  return entry.promise
}

/**
 * An `open` can wait longer than the idle limit (a private server's start takes up to
 * 150 s), so a page with one in flight is busy, never idle: the timer is re-armed while
 * it runs and restarts when it settles.
 */
function keepBusyOpen(name: string, browser: AgentBrowser): void {
  const open = browser.open
  browser.open = async (path, options) => {
    const record = browsers.get(name)
    if (record) record.busy++
    try {
      return await open.call(browser, path, options)
    } finally {
      const current = browsers.get(name)
      if (current && current === record) {
        current.busy--
        current.lastUsed = Date.now()
        clearTimeout(current.timer)
        current.timer = idleTimer(name)
      }
    }
  }
}

function idleTimer(name: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const record = browsers.get(name)
    if (record && record.busy > 0) {
      record.timer = idleTimer(name)
      return
    }
    void closeAgentBrowser(name)
  }, idleMs)
  timer.unref?.()
  return timer
}

export async function closeAgentBrowser(name: string): Promise<void> {
  const running = closing.get(name)
  if (running) return running
  const record = browsers.get(name)
  if (!record) return
  browsers.delete(name)
  clearTimeout(record.timer)
  const closed = record.browser.close().finally(() => {
    if (closing.get(name) === closed) closing.delete(name)
  })
  closing.set(name, closed)
  return closed
}

/** The session's WebKit page when it is open; never opens one (LOCAL-WEBKIT-2 receipts). */
export function openAgentBrowser(key: string, root: string, liveRoot: string): AgentBrowser | null {
  const isolated = projectKey(root) !== projectKey(liveRoot)
  return browsers.get(isolated ? privateName(key, root) : `webkit:${key}`)?.browser ?? null
}

export function agentBrowserCount(): number {
  return browsers.size + opening.size
}

/** The registry name of the private WebKit page for `key` in the worktree `root`. */
export function privateName(key: string, root: string): string {
  return `webkit:${key}@${sessionId(projectKey(root)).slice(0, 12)}`
}

/**
 * Closes every private page (and so its private dev server) of the worktree `root`:
 * the session that owned it closed. Live pages and the visible preview are untouched.
 */
export async function releaseAgentBrowsersFor(root: string): Promise<number> {
  const names = [...browsers]
    .filter(
      ([, record]) =>
        record.browser.runtime === 'private' && projectKey(record.browser.root) === projectKey(root)
    )
    .map(([name]) => name)
  // A page still being created is released too: it is closed as soon as it exists.
  let pending = 0
  for (const entry of opening.values()) {
    if (!entry.isolated || entry.released || projectKey(entry.root) !== projectKey(root)) continue
    entry.released = true
    pending++
  }
  await Promise.all(names.map(closeAgentBrowser))
  return names.length + pending
}
