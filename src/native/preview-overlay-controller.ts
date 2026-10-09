import { setPreviewOverlaySource } from '../main/preview-overlay'
import {
  EMPTY_OVERLAY,
  normalizeLines,
  normalizeOverlay,
  type OverlayLines,
  overlayFor,
  PREVIEW_OVERLAY_PREFERENCE,
  storeOverlay
} from '../shared/preview-overlay'
import type { NativeBridge } from './bridge'
import type { NativePreferences } from './preferences'

const parse = (value: string | null | undefined): unknown => {
  try {
    return value ? JSON.parse(value) : {}
  } catch {
    return {}
  }
}

/**
 * Rulers, guides and layout grids (LKM-205). The host draws them and owns every edit;
 * this keeps them per project and per viewport in one preference, hands the host the
 * settings whenever the active project or its viewport changes, and passes the lines the
 * host shows to the page for its hover distance labels (again after each load). The key
 * the host echoes names the project and viewport an edit belongs to, so a late edit never
 * lands on the project opened after it.
 */
export function installPreviewOverlay(options: {
  host: NativeBridge
  preferences: NativePreferences
  /** The active project's root and viewport, or null on the home screen. */
  active: () => { root: string; viewport?: string } | null
  /** The viewport a known project is shown at, or null for an unknown root. */
  viewportOf: (root: string) => string | null
  deliver: (lines: OverlayLines) => void
  report: (error: unknown) => void
}): { sync(force?: boolean): void; loaded(): void } {
  const { host, preferences } = options
  let key: string | null | undefined
  let lines = normalizeLines(null)
  // What the host shows for `key`, and how many of its edits are still being saved.
  let shown = ''
  let saving = 0
  const stored = () => parse(preferences.get(PREVIEW_OVERLAY_PREFERENCE))
  const sync = (force = false) => {
    const active = options.active()
    const viewport = active?.viewport === 'mobile' ? 'mobile' : 'desktop'
    const next = active ? JSON.stringify([active.root, viewport]) : null
    if (next === key && !force) return
    const state = active ? overlayFor(stored(), active.root, viewport) : EMPTY_OVERLAY
    if (next === key && JSON.stringify(state) === shown) return
    key = next
    shown = JSON.stringify(state)
    host.send('previewOverlay', { key: next, viewport, state })
  }
  host.on('preview-overlay', ({ key: echoed, state }: { key?: unknown; state?: unknown }) => {
    const target = typeof echoed === 'string' ? (parse(echoed) as unknown[]) : null
    if (!Array.isArray(target) || typeof target[0] !== 'string' || typeof target[1] !== 'string')
      return
    const [root, viewport] = target as [string, string]
    if (echoed === key) shown = JSON.stringify(normalizeOverlay(state))
    saving += 1
    void preferences
      .apply((values) => [
        [
          PREVIEW_OVERLAY_PREFERENCE,
          JSON.stringify(
            storeOverlay(
              parse(values[PREVIEW_OVERLAY_PREFERENCE]),
              root,
              viewport,
              normalizeOverlay(state)
            )
          )
        ]
      ])
      .catch(options.report)
      .finally(() => {
        saving -= 1
      })
  })
  host.on('preview-overlay-lines', ({ lines: value }: { lines?: unknown }) => {
    lines = normalizeLines(value)
    options.deliver(lines)
  })
  // An edit made outside this window (another profile client) shows on the next sync. The
  // host's own saves are skipped: an earlier one landing would undo a newer edit.
  preferences.subscribe(() => {
    if (!saving) sync(true)
  })
  setPreviewOverlaySource((root) => {
    const viewport = options.viewportOf(root)
    return viewport === null ? null : { ...overlayFor(stored(), root, viewport), viewport }
  })
  return { sync, loaded: () => options.deliver(lines) }
}
