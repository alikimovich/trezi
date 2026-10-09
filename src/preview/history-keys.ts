import { ipcRenderer } from '../native/preview-transport'
import { PREVIEW_HISTORY } from '../shared/preview-channels'

const typing = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

/**
 * LKM-219: ⌘← / ⌘→ step the preview's Back/Forward while the page has focus, as the
 * host does elsewhere (`src/native/PreviewHistory.swift`). Never in a page field (the
 * caret moves to the line's start or end), and never when the page handles the key
 * itself: the host is told only after the page's own listeners had their turn. While
 * Trezi's select, comment or edit mode owns the keyboard the page sees no keys, so
 * the step is immediate. The 3D view (`modal`) keeps its arrows. Installed before the
 * other capture listeners, which may stop the event.
 */
export function installHistoryKeys(busy: () => boolean, modal: () => boolean): void {
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || modal()) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (typing(e.composedPath()[0] ?? e.target)) return
      const step = e.key === 'ArrowLeft' ? 'back' : 'forward'
      if (busy()) {
        e.preventDefault()
        ipcRenderer.send(PREVIEW_HISTORY, step)
        return
      }
      setTimeout(() => {
        if (!e.defaultPrevented) ipcRenderer.send(PREVIEW_HISTORY, step)
      }, 0)
    },
    true
  )
}
