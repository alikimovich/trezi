/**
 * Every ipcMain handler that talks to (or about) the native preview: its
 * geometry, its lifecycle, the select/comment/annotate relays, the floating
 * prop-panel island's plumbing, the Styles tab's reads and the Layers panel.
 *
 * Split out of index.ts, which owns the WINDOWS and the VIEWS — this module owns
 * none of them. It reaches the views and the shared preview flags through the
 * `PreviewIpcHost` it is handed, so index.ts stays the single place a
 * NativeView is created, raised, hidden or destroyed.
 *
 * Trust: the preview hosts the user's project — untrusted content. Every message
 * arriving on a `trezi:preview:*` / `layers:*` channel is therefore checked
 * against the preview's own webContents before it's believed, and every message
 * that drives the preview is checked to have come from the trusted native service target (never from the preview itself).
 */
import {
  ipcMain,
  type NativeIpcEvent,
  type NativeView,
  type NativeWebContents
} from '../native/platform'
import type { MoveNodeRequest, SelectedElement, StyleReadResult } from '../shared/api'
import {
  ANIMATION_REPLAY,
  LAYERS_CHANGED,
  LAYERS_HOVER,
  LAYERS_READ,
  LAYERS_READ_REPLY,
  LAYERS_SELECT,
  LAYERS_SET_WATCH,
  PREVIEW_CANCELLED,
  PREVIEW_CLEAR_SELECTED,
  PREVIEW_COMMENT,
  PREVIEW_COMMENT_MODE,
  PREVIEW_MOVE_NODE,
  PREVIEW_PICKED,
  PREVIEW_PIN_CLICK,
  PREVIEW_READINESS,
  PREVIEW_SELECTION_LOST,
  PREVIEW_SET_COMMENT_MODE,
  PREVIEW_SET_FRAME,
  PREVIEW_SET_MODE,
  PREVIEW_SET_PINS,
  PREVIEW_SET_STATUS,
  PREVIEW_STATES_KEY,
  PREVIEW_TEXT_EDIT,
  PREVIEW_TOGGLE_SELECT,
  PREVIEW_TOOLBAR_ACTION,
  STYLES_CLEAR_PREVIEW,
  STYLES_PREVIEW,
  STYLES_READ,
  STYLES_READ_REPLY,
  STYLES_REPLAY
} from '../shared/preview-channels'
import { applyMoveNode } from './move-node'
import { observePreview } from './preview-evidence'
import { registerPreviewSource } from './preview-state'

/**
 * Preview state shared with index.ts. The injected preload re-runs FRESH on
 * every navigation of the previewed app, so anything it was told (select mode,
 * comment mode, the mobile bezel, the layers watch, the pins, the status pill)
 * is remembered here and re-pushed from index.ts's `did-finish-load`. The rest
 * (url/retries/bounds/hidden) is the view's own bookkeeping, which index.ts's
 * retry + stale-preview paths read too.
 */
export interface PreviewState {
  /** The URL main last asked the preview to show; null on the placeholder. */
  url: string | null
  /** did-fail-load retry budget for `url` (reset on a successful load). */
  retries: number
  /** Renderer's last-reported preview slot rect, in CSS pixels (== DIP). */
  bounds: { x: number; y: number; width: number; height: number; radius: number }
  /** Renderer asked the view hidden beneath a freeze-frame overlay. */
  selectMode: boolean
  commentMode: 'comment' | 'annotate' | null
  frameMode: boolean
  layersWatch: boolean
  statusText: string | null
  pins: { id: string; selector: string; label?: string }[]
}

/** The bits of index.ts (views, window, state) this module is allowed to touch. */
export interface PreviewIpcHost {
  state: PreviewState
  /** Creates the preview view on first use; index.ts owns its wiring. */
  ensurePreviewView: () => NativeView
  getPreviewView: () => NativeView | null
  getMainWindow: () => NativeView | null
  /** Send to the main renderer, guarded against a destroyed webContents. */
  sendToMain: (channel: string, ...args: unknown[]) => void
  isLocalPreviewUrl: (url: string) => boolean
  /** The "no project open" data: URL. */
  placeholderUrl: string
}

/**
 * One request/reply round trip with the sandboxed preview preload.
 *
 * The preload has no contextBridge and `executeJavaScript` can't reach its
 * isolated world, so ANY read out of it has to be message passing: send
 * `{id, …}` on the request channel, await the matching `{id, …}` on the reply
 * channel. Both readers (`styles:read`, `layers:read`) had their own copy of the
 * seq counter / pending Map / timeout / sender check; this is that pattern once.
 *
 * `timeoutMs` guards a dead or navigating preview — a request that never gets
 * its reply resolves to null rather than hanging the renderer's invoke forever.
 */
function requestReply<T>(opts: {
  request: string
  reply: string
  timeoutMs: number
  /** Late-bound: the view is created on demand and replaced when the window is. */
  getView: () => NativeView | null
  /** Map a reply payload to the resolved value (null = nothing usable). */
  parse: (payload: Record<string, unknown>) => T | null
}): (payload?: Record<string, unknown>) => Promise<T | null> {
  let seq = 0
  const pending = new Map<number, (value: T | null) => void>()

  ipcMain.on(opts.reply, (e, p: { id?: unknown } | undefined) => {
    // Untrusted sender check: only the preview may answer its own read.
    if (e.sender !== opts.getView()?.webContents) return
    const resolve = typeof p?.id === 'number' ? pending.get(p.id) : undefined
    resolve?.(opts.parse((p ?? {}) as Record<string, unknown>))
  })

  return (payload = {}) => {
    const view = opts.getView()
    if (!view) return Promise.resolve(null)
    const id = ++seq
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(null)
      }, opts.timeoutMs)
      pending.set(id, (value) => {
        clearTimeout(timer)
        pending.delete(id)
        resolve(value)
      })
      view.webContents.send(opts.request, { id, ...payload })
    })
  }
}

export function registerPreviewIpc(host: PreviewIpcHost): void {
  const { state, sendToMain } = host
  const previewWc = (): NativeWebContents | undefined => host.getPreviewView()?.webContents
  /** Push to the preview's preload (no-op when there's no preview yet). */
  const toPreview = (channel: string, ...args: unknown[]): void => {
    previewWc()?.send(channel, ...args)
  }
  /** Did this really come from the previewed page, and not some other view? */
  const fromPreview = (e: NativeIpcEvent): boolean => e.sender === previewWc()

  // Let the in-process agent tools (backends/claude.ts) observe the user's live
  // preview without importing this module (would be a cycle). getUrl reports the
  // preview's CURRENT location (SPA navigations included) but null for the
  // placeholder/empty state; capture snapshots the current frame.
  registerPreviewSource({
    getUrl: () => {
      const url = previewWc()?.getURL()
      return url && /^https?:/.test(url) ? url : null
    },
    capture: async () => (await previewWc()?.capturePage()) ?? null,
    captureAgent: (options) => openPreview().captureAgent(options),
    agent: {
      evaluate: (code, world, timeoutMs) => openPreview().evaluateIn(code, world, timeoutMs),
      captureRect: (rect) => openPreview().captureRect(rect),
      setViewport: (width) => openPreview().setViewport(width)
    }
  })
  function openPreview(): NativeWebContents {
    const wc = previewWc()
    if (!wc || wc.isDestroyed() || !/^https?:/.test(wc.getURL()))
      throw new Error('No project preview is open.')
    return wc
  }

  // Apply the renderer's slot rect (PreviewPane already lays out around the
  // floating prop panel's strip, viewport-aware).
  const applyBounds = (): void => {
    const view = host.ensurePreviewView()
    view.setBounds({
      x: Math.round(state.bounds.x),
      y: Math.round(state.bounds.y),
      width: Math.max(0, Math.round(state.bounds.width)),
      height: Math.round(state.bounds.height)
    })
    // Round the native view's corners: the card's inner radius in desktop
    // viewport, the iPhone screen's in mobile (both supplied by the renderer).
    view.setBorderRadius(Math.round(state.bounds.radius || 0))
  }

  // Renderer reports where the preview rectangle is, in CSS pixels (== DIP).
  ipcMain.on(
    'preview:set-bounds',
    (
      _e,
      bounds: {
        x: number
        y: number
        width: number
        height: number
        radius?: number
      }
    ) => {
      state.bounds = { ...bounds, radius: bounds.radius ?? 0 }
      applyBounds()
    }
  )

  // Mobile viewport toggles the in-page iPhone bezel overlay (click pass-through).
  ipcMain.on('preview:set-frame', (_e, active: boolean) => {
    state.frameMode = !!active
    toPreview(PREVIEW_SET_FRAME, state.frameMode)
  })

  // `hard` bypasses WebKit's caches; `keepPath` keeps the route the preview showed on
  // the restarted server's origin (LKM-197).
  ipcMain.handle(
    'preview:load',
    (_e, url: string, options?: { hard?: boolean; keepPath?: boolean }) => {
      if (!host.isLocalPreviewUrl(url)) return
      const view = host.ensurePreviewView()
      if (options?.keepPath) url = keepRoute(view.webContents.getURL(), url)
      state.url = url
      state.retries = 0
      view.setVisible(true)
      view.webContents.loadURL(url, options?.hard ? { hard: true } : undefined)
    }
  )
  function keepRoute(shown: string, url: string): string {
    if (!/^https?:/.test(shown) || !host.isLocalPreviewUrl(shown)) return url
    const route = new URL(shown)
    return new URL(route.pathname + route.search + route.hash, url).href
  }

  ipcMain.handle('preview:reset', () => {
    state.url = null
    state.retries = 0
    // No app to select in on the placeholder — keep main's flags honest so none
    // of them silently re-arm the overlay/frame/pins on a later load (the
    // did-finish-load re-arm in index.ts reads these). PreviewPane re-reports the
    // frame on the next open, so zeroing it here is safe. (Renderer disarms too.)
    state.selectMode = false
    state.commentMode = null
    state.frameMode = false
    state.layersWatch = false
    state.pins = []
    host.ensurePreviewView().webContents.loadURL(host.placeholderUrl)
  })

  // v2 select mode: renderer → preview (arm/disarm the overlay).
  ipcMain.handle('preview:set-select-mode', (_e, active: boolean) => {
    state.selectMode = active
    if (active) state.commentMode = null // mutually exclusive with comment/annotate
    toPreview(PREVIEW_SET_MODE, active)
  })

  // preview → renderer relays. Only trust events from the preview's webContents.
  ipcMain.on(PREVIEW_PICKED, (e, el: SelectedElement) => {
    if (!fromPreview(e)) return
    sendToMain('preview:element-picked', el)
  })
  ipcMain.on(PREVIEW_CANCELLED, (e) => {
    if (!fromPreview(e)) return
    state.selectMode = false
    sendToMain('preview:select-cancelled')
  })
  // The selected element left the page; select mode stays as it was (LKM-172).
  ipcMain.on(PREVIEW_SELECTION_LOST, (e) => {
    if (!fromPreview(e)) return
    sendToMain('preview:selection-lost')
  })

  // Selection-toolbar actions that need the renderer (code drawer / delete turn);
  // comment/annotate are handled entirely inside the preview's composer.
  ipcMain.on(PREVIEW_TOOLBAR_ACTION, (e, kind: string) => {
    if (!fromPreview(e)) return
    if (!['code', 'delete', 'props', 'states'].includes(kind)) return
    sendToMain('preview:toolbar-action', kind)
  })
  // LKM-207: H on a states workbench hides the native switcher (for screenshots).
  ipcMain.on(PREVIEW_STATES_KEY, (e, key: unknown) => {
    if (!fromPreview(e) || key !== 'hide') return
    sendToMain('preview:states-key', key)
  })
  // Renderer dropped the selection (pill ×, message sent) → hide the toolbar.
  ipcMain.on('preview:clear-selected', () => {
    toPreview(PREVIEW_CLEAR_SELECTED)
  })

  // S pressed while the preview has focus → the renderer runs its toggle.
  ipcMain.on(PREVIEW_TOGGLE_SELECT, (e) => {
    if (!fromPreview(e)) return
    sendToMain('preview:toggle-select')
  })

  // Launch progress, drawn INSIDE the preview (bottom-center pill) instead of a
  // window-top banner. null clears it.
  ipcMain.on('preview:set-status', (_e, text: string | null) => {
    state.statusText = typeof text === 'string' && text.trim() ? text.slice(0, 300) : null
    toPreview(PREVIEW_SET_STATUS, state.statusText)
  })

  // Native inspectors send through the trusted application service target.
  const fromMainWindow = (e: NativeIpcEvent): boolean =>
    e.sender === host.getMainWindow()?.webContents
  ipcMain.on('styles:preview', (e, p: { prop: string; value: string }) => {
    if (!fromMainWindow(e)) return
    toPreview(STYLES_PREVIEW, p)
  })
  ipcMain.on('styles:clear-preview', (e, p?: { prop?: string }) => {
    if (!fromMainWindow(e)) return
    toPreview(STYLES_CLEAR_PREVIEW, p)
  })
  ipcMain.on('preview:animation-replay', (e, component: unknown) => {
    if (!fromMainWindow(e) || typeof component !== 'string' || component.length > 80) return
    toPreview(ANIMATION_REPLAY, component)
  })
  ipcMain.on('styles:replay', (e, p: { prop: string; from: string; to: string }) => {
    if (!fromMainWindow(e)) return
    toPreview(STYLES_REPLAY, p)
  })

  // Fresh computed values from the selection: `styles:read` {id, props} out,
  // `styles:read-reply` {id, values, declaredVars} back (see requestReply).
  // null means no preview / no selection / timeout. `declaredVars` is the proof
  // half (see `preview/style-provenance.ts`) that lets the panel tell a
  // property's value IS a token from it merely equalling one.
  const readStyles = requestReply<StyleReadResult>({
    request: STYLES_READ,
    reply: STYLES_READ_REPLY,
    timeoutMs: 500,
    getView: host.getPreviewView,
    parse: (p) => {
      const values = p.values as Record<string, string> | null | undefined
      if (!values) return null
      return {
        values,
        declaredVars: (p.declaredVars as Record<string, string | null> | null) ?? {},
        specified: (p.specified as Record<string, string> | null) ?? {}
      }
    }
  })
  ipcMain.handle('styles:read', (e, props: string[]): Promise<StyleReadResult | null> | null => {
    if (!fromMainWindow(e) || !host.getPreviewView() || !Array.isArray(props)) return null
    return readStyles({ props })
  })

  // v3 annotation pins: renderer pushes the list → preview; clicks come back.
  ipcMain.on('preview:set-annotations', (_e, pins: PreviewState['pins']) => {
    state.pins = Array.isArray(pins) ? pins : []
    toPreview(PREVIEW_SET_PINS, state.pins)
  })
  ipcMain.on(PREVIEW_PIN_CLICK, (e, id: string) => {
    if (!fromPreview(e)) return
    sendToMain('annotations:pin-click', id)
  })

  // Readiness probe (stamp count) → renderer, to drive the setup offer.
  ipcMain.on(
    PREVIEW_READINESS,
    (e, info: { stamps: number; url?: string; documentStartedAt?: number }) => {
      if (!fromPreview(e)) return
      observePreview({ ...info, url: e.sender.getURL() })
      sendToMain('preview:readiness', info)
    }
  )

  // Inline text edit committed in the preview → renderer (which applies it).
  ipcMain.on(PREVIEW_TEXT_EDIT, (e, edit: { source: string; text: string }) => {
    if (!fromPreview(e)) return
    sendToMain('preview:text-edit', edit)
  })

  // Inline commenting (C/Y): renderer arms the mode → preview.
  ipcMain.handle('preview:set-comment-mode', (_e, mode: 'comment' | 'annotate' | null) => {
    state.commentMode = mode
    if (mode) state.selectMode = false // mutually exclusive with select
    toPreview(PREVIEW_SET_COMMENT_MODE, mode)
  })
  // Preview echoes keyboard-initiated mode changes → renderer (toolbar mirror).
  ipcMain.on(PREVIEW_COMMENT_MODE, (e, mode: 'comment' | 'annotate' | null) => {
    if (!fromPreview(e)) return
    state.commentMode = mode
    sendToMain('preview:comment-mode', mode)
  })
  // A submitted comment/annotation (element + text) → renderer (agent vs pin).
  ipcMain.on(
    PREVIEW_COMMENT,
    (
      e,
      payload: {
        kind: 'comment' | 'annotate'
        el: SelectedElement
        text: string
      }
    ) => {
      if (!fromPreview(e)) return
      sendToMain('preview:comment', payload)
    }
  )

  // ── Layers panel ─────────────────────────────────────────────────────────
  // Bulk DOM-tree read: the same request/reply round trip as styles:read, with a
  // longer budget (walking the whole tree costs more than reading one element).
  const readLayers = requestReply<unknown>({
    request: LAYERS_READ,
    reply: LAYERS_READ_REPLY,
    timeoutMs: 800,
    getView: host.getPreviewView,
    parse: (p) => p.snapshot ?? null
  })
  ipcMain.handle('layers:read', (e): Promise<unknown> | null => {
    if (!fromMainWindow(e) || !host.getPreviewView()) return null
    return readLayers()
  })
  ipcMain.on('layers:select', (e, p: { path: number[]; fingerprint: unknown }) => {
    if (!fromMainWindow(e)) return
    toPreview(LAYERS_SELECT, p)
  })
  ipcMain.on('layers:hover', (e, p: { path: number[]; fingerprint: unknown } | null) => {
    if (!fromMainWindow(e)) return
    toPreview(LAYERS_HOVER, p)
  })
  ipcMain.on('layers:set-watch', (e, on: boolean) => {
    if (!fromMainWindow(e)) return
    state.layersWatch = !!on
    toPreview(LAYERS_SET_WATCH, state.layersWatch)
  })
  // Debounced structural-change ping from the preload → renderer (the renderer
  // decides whether/when to re-`layers:read`).
  ipcMain.on(LAYERS_CHANGED, (e) => {
    if (!fromPreview(e)) return
    sendToMain('layers:changed')
  })
  // Drag-to-reorder: writes real source for a same-parent sibling move;
  // anything ambiguous reports `needsAgent` instead (see move-node.ts).
  ipcMain.on(PREVIEW_MOVE_NODE, (e, req: MoveNodeRequest) => {
    if (!fromPreview(e)) return
    sendToMain('layers:move-request', req)
  })
  ipcMain.handle('layers:move', (e, root: string, req: MoveNodeRequest) => {
    if (!fromMainWindow(e)) return null
    return applyMoveNode(root, req)
  })
}
