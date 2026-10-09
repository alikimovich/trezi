import { ipcRenderer } from '../native/preview-transport'
import {
  PREVIEW_STATES,
  PREVIEW_STATES_KEY,
  PREVIEW_STATES_SWITCH
} from '../shared/preview-channels'
import { ALL_STATES, STATE_PARAM } from '../shared/states-workbench'
import { latinKey } from './latin-key'

/** LKM-207: the page event a states workbench listens for (`detail` is the state id). */
export const STATE_EVENT = 'trezi:state'
/** How long a page may take to show the state before Trezi navigates instead. */
const FALLBACK_MS = 600

const typing = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

/**
 * The URL is the one source of truth: switching replaces `__state` (no history entry,
 * no reload, scroll kept) and tells the page with `trezi:state`. A page that does not
 * mark the state on `[data-trezi-state]` in time gets a plain navigation, so in-page
 * switchers and pages without the listener still follow the URL. Keys (←/→, 1-9, H)
 * work only while main has marked the page a workbench, never while Trezi's own
 * select, comment or edit modes own the keyboard.
 */
export function installStatesSwitch(busy: () => boolean): void {
  let ids: string[] = []
  let pending = 0
  const rendered = () =>
    document.querySelector('[data-trezi-state]')?.getAttribute('data-trezi-state') ?? null
  const current = () => new URL(location.href).searchParams.get(STATE_PARAM) ?? ids[0] ?? ''

  const go = (id: string): void => {
    if (!ids.length || (id !== ALL_STATES && !ids.includes(id))) return
    const url = new URL(location.href)
    if (url.searchParams.get(STATE_PARAM) === id && rendered() === id) return
    url.searchParams.set(STATE_PARAM, id)
    const x = window.scrollX,
      y = window.scrollY
    history.replaceState(history.state, '', url.href)
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: id }))
    const token = ++pending
    requestAnimationFrame(() => {
      if (token === pending && id !== ALL_STATES) window.scrollTo(x, y)
    })
    setTimeout(() => {
      if (token === pending && rendered() !== id && location.href === url.href)
        location.assign(url.href)
    }, FALLBACK_MS)
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (!ids.length || busy() || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
      let next: string | undefined
      // 1-9 and H by key position on any layout (LKM-219).
      const key = latinKey(e)
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const at = ids.indexOf(current())
        const step = e.key === 'ArrowRight' ? 1 : -1
        next =
          at < 0 ? ids[step > 0 ? 0 : ids.length - 1] : ids[(at + step + ids.length) % ids.length]
      } else if (/^[1-9]$/.test(key)) next = ids[Number(key) - 1]
      else if (key === 'h' && e.isTrusted) {
        e.preventDefault()
        e.stopImmediatePropagation()
        ipcRenderer.send(PREVIEW_STATES_KEY, 'hide')
        return
      }
      if (!next) return
      e.preventDefault()
      e.stopImmediatePropagation()
      go(next)
    },
    true
  )
  ipcRenderer.on(PREVIEW_STATES, (_e, value: unknown) => {
    const list = (value as { ids?: unknown } | null)?.ids
    ids = Array.isArray(list)
      ? list.filter((id): id is string => typeof id === 'string' && id.length <= 40).slice(0, 24)
      : []
  })
  ipcRenderer.on(PREVIEW_STATES_SWITCH, (_e, id: unknown) => {
    if (typeof id === 'string') go(id)
  })
}
