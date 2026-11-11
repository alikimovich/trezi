import { ipcRenderer } from '../native/preview-transport'
import { PREVIEW_HISTORY } from '../shared/preview-channels'

const typing = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

/**
 * LKM-219: ⌘← / ⌘→ step Back/Forward. LKM-644: ⌘Z / ⇧⌘Z step the visual Styles draft
 * (Edit → Undo / Redo): a focused preview claims every ⌘ key before the menu, so the page
 * sees them first. A page field (input, textarea, contenteditable, Trezi's own text edit)
 * keeps its typing Undo: the key goes on to the menu, which gives it to the page.
 * The host re-reads ⌘ keys on any layout before WebKit sees them (`KeyShortcut`).
 */
export function historyStep(
  e: Pick<KeyboardEvent, 'isTrusted' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>
): 'back' | 'forward' | 'undo' | 'redo' | null {
  if (!e.isTrusted || !e.metaKey || e.ctrlKey || e.altKey) return null
  if (e.key.toLowerCase() === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (e.shiftKey) return null
  return e.key === 'ArrowLeft' ? 'back' : e.key === 'ArrowRight' ? 'forward' : null
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
      const step = historyStep(e)
      if (!step || modal()) return
      if (typing(e.composedPath()[0] ?? e.target)) return
      // LKM-644: WebKit re-sends a ⌘ key the page left unhandled to the app menu, whose
      // Undo would then run too: outside a field the step is taken here, once, at once.
      if (busy() || step === 'undo' || step === 'redo') {
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
