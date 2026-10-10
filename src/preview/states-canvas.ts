import { ipcRenderer } from '../native/preview-transport'
import {
  PREVIEW_CANVAS,
  PREVIEW_CANVAS_RESULT,
  PREVIEW_STATES_KEY
} from '../shared/preview-channels'
import type { CanvasRecipe } from '../shared/states-canvas'
import { latinKey } from './latin-key'

export type CanvasCommand = {
  command: 'open' | 'select' | 'close'
  session: string
  recipe?: CanvasRecipe
  state?: string
  refresh?: boolean
  unavailable?: string
}

/** Only the isolated preview can address native IPC. The page-world renderer receives
 * commands through shared DOM and has no native message handler or evaluation hook. */
export function installStatesCanvas(busy: () => boolean): void {
  let current: CanvasCommand | null = null
  const send = (value: CanvasCommand) => {
    document.documentElement.setAttribute('data-trezi-canvas-command', JSON.stringify(value))
    document.dispatchEvent(new Event('trezi:canvas-command'))
  }
  ipcRenderer.on(PREVIEW_CANVAS, (_event, value: CanvasCommand) => {
    if (!value || typeof value.session !== 'string') return
    if (value.command === 'close') {
      if (current?.session === value.session) {
        send(value)
        current = null
      }
      return
    }
    if (!value.recipe?.states?.length || !value.state) return
    current = value
    send(value)
  })
  const receive = () => {
    let result: { session?: string; status?: string; reason?: string }
    try {
      result = JSON.parse(document.documentElement.getAttribute('data-trezi-canvas-result') || '')
    } catch {
      return
    }
    if (!current || result.session !== current.session) return
    ipcRenderer.send(PREVIEW_CANVAS_RESULT, {
      session: result.session,
      status: result.status,
      reason: result.reason
    })
  }
  new MutationObserver(receive).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-trezi-canvas-result']
  })
  window.addEventListener(
    'keydown',
    (event) => {
      if (!current || busy() || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')
      )
        return
      const ids = current.recipe?.states.map((state) => state.id) ?? []
      const key = latinKey(event)
      let id: string | undefined
      if (event.key === 'Escape') {
        ipcRenderer.send(PREVIEW_STATES_KEY, 'close')
      } else if (key === 'h' && event.isTrusted) {
        ipcRenderer.send(PREVIEW_STATES_KEY, 'hide')
      } else if (/^[1-9]$/.test(key)) id = ids[Number(key) - 1]
      else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const at = ids.indexOf(current.state ?? '')
        const delta = event.key === 'ArrowRight' ? 1 : -1
        id = ids[(at + delta + ids.length) % ids.length]
      }
      if (!id && event.key !== 'Escape' && key !== 'h') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (id) ipcRenderer.send(PREVIEW_STATES_KEY, id)
    },
    true
  )
  window.addEventListener('pagehide', () => {
    current = null
  })
}
