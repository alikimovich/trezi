import { type PreviewLoadEvent, pathOf, previewLoads } from '../main/preview-loads'
import type { NativeBridge } from './bridge'
import type { NativeShellController } from './shell-controller'
import type { NativeWorkspaceController } from './workspace-controller'

type HostEvent = { view?: unknown; url?: unknown; status?: unknown; message?: unknown }
const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** A page that cannot load is a clear error with Restart, never a blank preview. */
export function loadErrorStatus(event: { url?: unknown; message?: unknown }): {
  kind: 'error'
  message: string
  restart?: true
} {
  const message = text(event.message)
  const url = text(event.url)
  return url
    ? {
        kind: 'error',
        message: `The preview could not open ${pathOf(url)}: ${message} The dev server may have stopped; Restart starts it again.`,
        restart: true
      }
    : { kind: 'error', message }
}

/**
 * The preview's main-frame navigation events into `previewLoads` (LKM-196): what
 * `open_preview` waits for, and the loading / HTTP-error pill over the page.
 */
export function installPreviewLoads(
  host: NativeBridge,
  workspace: NativeWorkspaceController,
  shell: NativeShellController
): void {
  previewLoads.onChange = () => shell.schedule()
  const on = (name: string, event: (e: HostEvent) => PreviewLoadEvent | null) =>
    host.on(name, (e: HostEvent) => {
      if (e?.view !== 'preview') return
      const recorded = event(e)
      if (recorded) previewLoads.record(recorded)
    })
  on('navigation-start', (e) => ({ type: 'start', url: text(e.url) }))
  on('navigation-response', (e) =>
    Number.isInteger(e.status)
      ? { type: 'response', url: text(e.url), status: e.status as number }
      : null
  )
  on('navigation-cancelled', (e) => ({ type: 'cancelled', url: text(e.url) }))
  on('navigation-failed', (e) => ({ type: 'failed', url: text(e.url), message: text(e.message) }))
  on('load-error', (e) => ({ type: 'failed', url: text(e.url), message: text(e.message) }))
  on('loaded', (e) => ({ type: 'loaded', url: text(e.url) }))
  host.on('preview-load-action', ({ action }: { action?: unknown }) => {
    if (action === 'dismiss') previewLoads.dismiss()
    else if (action === 'reload' && workspace.active?.url) host.send('reload', { view: 'preview' })
  })
}
