import { parseSpeed, previewSpeed } from '../main/preview-speed'
import { PREVIEW_SET_SPEED } from '../shared/preview-channels'
import type { NativeBridge } from './bridge'
import type { NativeView } from './platform'

/**
 * Preview slow motion (LKM-206): the toolbar menu (`speed` shell actions), Actions →
 * Toggle Slow Motion (⌃⇧S) and Step Preview Frame drive `previewSpeed`; each change goes
 * to the host, which re-registers the document-start script and updates the badge and
 * toolbar (`PreviewSpeed.swift`), and to the open page through the isolated world.
 */
export function installPreviewSpeed(host: NativeBridge, preview: NativeView) {
  previewSpeed.on((change) => {
    if ('speed' in change) host.send('previewSpeed', { speed: change.speed })
    preview.webContents.send(PREVIEW_SET_SPEED, change)
  })
  host.on('shell-action', ({ action, value }: { action?: unknown; value?: unknown }) => {
    if (action !== 'speed') return
    if (value === 'step') previewSpeed.step(1)
    else {
      const speed = parseSpeed(value)
      if (speed !== null) previewSpeed.set(speed)
    }
  })
  host.on('menu', ({ action }: { action?: unknown }) => {
    if (action === 'slow-motion') previewSpeed.toggle()
    else if (action === 'slow-motion-step') previewSpeed.step(1)
  })
  // A change made while the page navigated is not in the script its document started with.
  host.on('loaded', ({ view }: { view?: unknown }) => {
    if (view === 'preview')
      preview.webContents.send(PREVIEW_SET_SPEED, { speed: previewSpeed.speed })
  })
}
