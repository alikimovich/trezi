import { ipcRenderer } from '../native/preview-transport'
import {
  PREVIEW_CANVAS,
  PREVIEW_CANVAS_RESULT,
  PREVIEW_STATES_KEY
} from '../shared/preview-channels'
import { CANVAS_ALL, type StatesFrame, type StatesViewCommand } from '../shared/states-canvas'
import { latinKey } from './latin-key'

/** No frame reported within this time: the bundle did not start (a page CSP can block it). */
const BOOT_TIMEOUT = 12000

const VIEW_CSS = `
:host{all:initial}
dialog{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;box-sizing:border-box;overflow:auto;background:Canvas;color:CanvasText;color-scheme:light dark;font:13px/1.4 -apple-system,system-ui,sans-serif}
dialog::backdrop{background:transparent}
header{position:sticky;top:0;z-index:1;display:flex;gap:8px;align-items:baseline;padding:14px 20px 10px;background:Canvas}
header strong{font-size:15px;font-weight:600}
header span{opacity:.6}
main{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:center;gap:20px;padding:12px 20px 96px}
section{display:flex;flex-direction:column;gap:6px;max-width:100%}
section h2{margin:0;font:500 12px/1.3 -apple-system,system-ui,sans-serif;opacity:.75}
section p{margin:0;font-size:11px;opacity:.55;max-width:100%}
.frame{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:10px;overflow:hidden;max-width:100%}
iframe{display:block;border:0;width:100%;height:120px;pointer-events:none;color-scheme:normal}
.message{max-width:520px;margin:12vh auto 0;padding:20px 22px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:12px}
.message strong{display:block;font-size:15px;margin-bottom:6px}
.notes{margin:0 auto;padding:0 20px 96px;max-width:720px;opacity:.6;font-size:11px}
`

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const attributes = (element: Element) =>
  [...element.attributes]
    .filter((attr) => !attr.name.startsWith('data-trezi') && /^[\w:-]+$/.test(attr.name))
    .map((attr) => ` ${attr.name}="${escapeAttr(attr.value)}"`)
    .join('')
const scriptText = (text: string) =>
  text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')

/** The page's own stylesheets, as markup a state frame can load: links by URL, inline styles by
 * text, and CSSOM-only sheets (CSS-in-JS speedy mode, adopted sheets) by their rules. */
function pageStyles(): string {
  const out: string[] = []
  const rulesOf = (sheet: CSSStyleSheet | null) => {
    try {
      return sheet ? [...sheet.cssRules].map((rule) => rule.cssText).join('\n') : ''
    } catch {
      return ''
    }
  }
  for (const node of document.querySelectorAll('link[rel~="stylesheet"], style')) {
    if (node instanceof HTMLLinkElement) {
      if (node.disabled || !node.href) continue
      out.push(
        `<link rel="stylesheet" href="${escapeAttr(node.href)}"${node.media ? ` media="${escapeAttr(node.media)}"` : ''}>`
      )
    } else if (node instanceof HTMLStyleElement) {
      const text = node.textContent?.trim() ? node.textContent : rulesOf(node.sheet)
      if (text)
        out.push(
          `<style${node.media ? ` media="${escapeAttr(node.media)}"` : ''}>${scriptText(text).replace(/<\/style/gi, '<\\/style')}</style>`
        )
    }
  }
  for (const sheet of document.adoptedStyleSheets ?? []) {
    const text = rulesOf(sheet)
    if (text) out.push(`<style>${text.replace(/<\/style/gi, '<\\/style')}</style>`)
  }
  return out.join('\n')
}

function frameDocument(command: StatesViewCommand, state: StatesFrame, styles: string): string {
  const data = JSON.stringify({
    session: command.session,
    frame: state.id,
    props: state.props,
    actions: state.actions,
    route: state.route
  }).replace(/</g, '\\u003c')
  const html = document.documentElement
  return `<!doctype html><html${attributes(html)}><head><meta charset="utf-8"><base href="${escapeAttr(location.href)}">
${styles}
<style data-trezi-frame>html,body{height:auto!important;min-height:0!important;overflow:hidden!important}body{margin:0!important;display:block!important}#trezi-root{display:flow-root}</style>
<style data-trezi-bundle>${(command.bundle?.css ?? '').replace(/<\/style/gi, '<\\/style')}</style>
<script>globalThis.process??={env:{NODE_ENV:'development'}}</script>
<script type="application/json" id="trezi-state">${data}</script>
</head><body${attributes(document.body)}><div id="trezi-root"></div><script type="module">${scriptText(command.bundle?.code ?? '')}</script></body></html>`
}

/** Only the isolated preview can address native IPC. The view lives in a closed-off shadow
 * root outside `<body>` (so Layers and the page's CSS never see it) and draws every state in a
 * sandboxed frame of its own that boots the real component bundle. */
export function installStatesCanvas(busy: () => boolean): void {
  let current: StatesViewCommand | null = null
  let host: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const frames = new Map<Window, { id: string; label: string; iframe: HTMLIFrameElement }>()
  const status = new Map<string, { status: string; reason: string }>()

  const send = (value: string, reason = '') => {
    if (!current) return
    ipcRenderer.send(PREVIEW_CANVAS_RESULT, {
      session: current.session,
      status: value,
      reason: reason.slice(0, 240)
    })
  }
  const summarize = () => {
    if (!current) return
    const shown = [...frames.values()]
    const failed = shown.find((frame) => status.get(frame.id)?.status === 'error')
    if (failed) {
      const reason = status.get(failed.id)?.reason || 'The component threw while rendering.'
      host?.setAttribute('data-trezi-status', 'error')
      return send('error', shown.length > 1 ? `${failed.label}: ${reason}` : reason)
    }
    if (shown.length && shown.every((frame) => status.get(frame.id)?.status === 'ready')) {
      clearTimeout(timer)
      host?.setAttribute('data-trezi-status', 'ready')
      send('ready')
    }
  }
  const close = () => {
    clearTimeout(timer)
    frames.clear()
    status.clear()
    host?.remove()
    host = null
    current = null
  }
  const open = (command: StatesViewCommand) => {
    close()
    current = command
    host = document.createElement('div')
    host.setAttribute('data-trezi-states-canvas', command.session)
    host.setAttribute(
      'data-trezi-state',
      command.unavailable ? 'unavailable' : (command.state ?? '')
    )
    host.setAttribute('data-trezi-status', 'loading')
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = VIEW_CSS
    const dialog = document.createElement('dialog')
    dialog.setAttribute('aria-label', `${command.component ?? 'Component'} states`)
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      ipcRenderer.send(PREVIEW_STATES_KEY, 'close')
    })
    const header = document.createElement('header')
    const name = document.createElement('strong')
    name.textContent = command.component ?? 'Component'
    const where = document.createElement('span')
    where.textContent = command.source ?? ''
    header.append(name, where)
    dialog.append(header)
    shadow.append(style, dialog)
    document.documentElement.append(host)
    dialog.showModal()
    if (command.unavailable || !command.bundle) {
      const message = document.createElement('div')
      message.className = 'message'
      message.setAttribute('data-trezi-states-message', '')
      const title = document.createElement('strong')
      title.textContent = command.unavailable
        ? `Trezi can’t show states for ${command.component ?? 'this component'}`
        : `Building ${command.component ?? 'the component'}…`
      const reason = document.createElement('div')
      reason.textContent = command.unavailable ?? ''
      message.append(title, reason)
      dialog.append(message)
      if (command.unavailable) send('error', command.unavailable)
      return
    }
    const states = (command.states ?? []).filter(
      (state) => command.state === CANVAS_ALL || state.id === command.state
    )
    const main = document.createElement('main')
    dialog.append(main)
    const styles = pageStyles()
    const width = Math.max(120, Math.min(1600, command.width ?? 360))
    for (const state of states) {
      const section = document.createElement('section')
      section.setAttribute('data-trezi-state-frame', state.id)
      section.style.width = `${width}px`
      const label = document.createElement('h2')
      label.textContent = state.label
      const box = document.createElement('div')
      box.className = 'frame'
      const iframe = document.createElement('iframe')
      iframe.title = `${command.component ?? 'Component'}: ${state.label}`
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
      iframe.srcdoc = frameDocument(command, state, styles)
      box.append(iframe)
      section.append(label, box)
      if (state.note) {
        const note = document.createElement('p')
        note.textContent = state.note
        section.append(note)
      }
      main.append(section)
      iframe.addEventListener('load', () => {
        try {
          iframe.contentWindow?.addEventListener('keydown', onKey, true)
        } catch {}
      })
      if (iframe.contentWindow)
        frames.set(iframe.contentWindow, { id: state.id, label: state.label, iframe })
    }
    if (command.notes?.length) {
      const notes = document.createElement('p')
      notes.className = 'notes'
      notes.textContent = command.notes.join(' ')
      dialog.append(notes)
    }
    send('loading')
    timer = setTimeout(() => {
      for (const frame of frames.values())
        if (!status.has(frame.id))
          status.set(frame.id, {
            status: 'error',
            reason:
              'The state did not start. The page may block inline scripts (Content-Security-Policy).'
          })
      summarize()
    }, BOOT_TIMEOUT)
  }

  window.addEventListener('message', (event) => {
    const data = event.data as {
      trezi?: string
      session?: string
      status?: string
      reason?: string
      height?: number
    } | null
    if (!current || data?.trezi !== 'states-frame' || data.session !== current.session) return
    const frame =
      frames.get(event.source as Window) ??
      [...frames.values()].find((item) => item.iframe.contentWindow === event.source)
    if (!frame || !['ready', 'error'].includes(String(data.status))) return
    const height = Number(data.height)
    if (Number.isFinite(height))
      frame.iframe.style.height = `${Math.max(24, Math.min(4000, height))}px`
    status.set(frame.id, {
      status: String(data.status),
      reason: typeof data.reason === 'string' ? data.reason.slice(0, 400) : ''
    })
    summarize()
  })

  ipcRenderer.on(PREVIEW_CANVAS, (_event, value: StatesViewCommand) => {
    if (!value || typeof value.session !== 'string') return
    if (value.command === 'close') {
      if (current?.session === value.session) close()
      return
    }
    open(value)
  })

  function onKey(event: KeyboardEvent) {
    if (!current || busy() || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement | null
    if (
      target?.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')
    )
      return
    const ids = (current.states ?? []).map((state) => state.id)
    const key = latinKey(event)
    let id: string | undefined
    if (event.key === 'Escape') ipcRenderer.send(PREVIEW_STATES_KEY, 'close')
    else if (key === 'h' && event.isTrusted) ipcRenderer.send(PREVIEW_STATES_KEY, 'hide')
    else if (/^[1-9]$/.test(key)) id = ids[Number(key) - 1]
    else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const at = ids.indexOf(current.state ?? '')
      const delta = event.key === 'ArrowRight' ? 1 : -1
      id = ids[(at + delta + ids.length) % ids.length]
    }
    if (!id && event.key !== 'Escape' && key !== 'h') return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (id) ipcRenderer.send(PREVIEW_STATES_KEY, id)
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pagehide', close)
}
