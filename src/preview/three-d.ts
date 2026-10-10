import type { ThreeDAction, ThreeDState } from '../shared/api'
import { packAtlas, THREE_D_LIMITS, threeDActionAllowed } from '../shared/three-d-contract'
import { sourceSelector, sourceStamp } from './source-stamp'
import { captureSurfaces, type Surface } from './three-d-paint'
import { THREE_D_CSS } from './three-d-styles'

/** Recover only an unambiguous identity after HMR. Repeated source stamps are
 * deliberately insufficient; child indexes can silently point at a sibling. */
function identity(el: Element, scope: ParentNode): () => Element | null {
  const tag = el.localName
  const stamp = sourceStamp(el)
  const selector = el.id ? `#${CSS.escape(el.id)}` : stamp ? sourceSelector(stamp) : null
  const unique = selector && scope.querySelectorAll(selector).length === 1
  return () => {
    if (el.isConnected) return el
    if (!selector || !unique) return null
    const matches = scope.querySelectorAll(selector)
    const next = matches.length === 1 ? matches[0] : null
    if (next?.localName !== tag || sourceStamp(next) !== stamp) return null
    el = next
    return el
  }
}

/** Owns capture, identity and selection of the exploded view. The host renders the
 * scene natively (`src/native/ThreeDScene.swift`) from snapshots of an atlas of inert
 * surfaces that this module paints in a modal dialog on request (LKM-227). */
export function createThreeDInspector(options: {
  select: (element: Element, open: boolean) => void
  hasSource: (element: Element) => boolean
  code: (element: Element) => void
  lost: () => void
  close: () => void
  publish: (state: ThreeDState | null) => void
}): {
  active: () => boolean
  open: (element: Element) => void
  close: () => void
  selected: () => Element | null
  action: (action: ThreeDAction) => boolean
  key: (event: KeyboardEvent) => void
} {
  let host: HTMLDivElement | null = null
  let cleanup: (() => void) | null = null
  let resolveSelected: (() => Element | null) | null = null
  let runAction: ((action: ThreeDAction) => boolean) | null = null
  let handleKey: ((event: KeyboardEvent) => void) | null = null
  const close = (): void => {
    if (!host) return
    cleanup?.()
    cleanup = null
    host.remove()
    host = null
    resolveSelected = null
    runAction = null
    handleKey = null
    options.publish(null)
    options.close()
  }
  const open = (initial: Element): void => {
    if (host || !initial.isConnected) return
    const resolveRoot = identity(initial, document)
    resolveSelected = identity(initial, document)
    let root = initial
    let selected: Element | null = initial
    const focusBefore = document.activeElement
    host = document.createElement('div')
    host.dataset.treziThreeD = ''
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = THREE_D_CSS
    // Modal so the live page takes no input; it paints only while the host snapshots.
    const dialog = document.createElement('dialog')
    dialog.setAttribute('aria-label', '3D component inspector')
    dialog.tabIndex = -1
    dialog.style.cssText =
      'position:fixed;inset:0;margin:0;padding:0;border:0;max-width:none;max-height:none;width:100vw;height:100vh;background:transparent;color:inherit;overflow:hidden;outline:none;'
    const session = `${Date.now()}-${Math.random()}`
    let revision = 0
    let ready = false
    let limited = false,
      simplified = false,
      invalid = false
    let surfaces: Surface[] = []
    let slots: { page: number; x: number; y: number }[] = []
    let pages: HTMLDivElement[] = []
    let scale = 1
    let timer = 0,
      disposed = false
    let width = 0,
      height = 0,
      originX = 0,
      originY = 0
    const publish = (): void => {
      if (!ready) return
      const selectedIndex = surfaces.findIndex((s) => s.element === selected)
      options.publish({
        session,
        revision,
        title: `3D · ${surfaces[0]?.label ?? root.localName}`.slice(0, THREE_D_LIMITS.title),
        layers: surfaces.map((s, id) => ({
          id,
          label: s.label.slice(0, THREE_D_LIMITS.label),
          depth: s.depth,
          x: s.rect.left - originX,
          y: s.rect.top - originY,
          width: s.rect.width,
          height: s.rect.height,
          page: slots[id].page,
          ax: slots[id].x,
          ay: slots[id].y
        })),
        width,
        height,
        scale,
        pages: pages.length,
        selected: selectedIndex < 0 ? null : selectedIndex,
        hasSource: !!selected && options.hasSource(selected),
        limited,
        simplified,
        invalid
      })
    }
    const paint = (value: number): void => {
      if (value < 0) dialog.removeAttribute('data-tone')
      else dialog.dataset.tone = String(value % 2)
      pages.forEach((page, i) => {
        page.toggleAttribute('data-shown', value >= 0 && i === Math.floor(value / 2))
      })
    }
    const choose = (i: number): void => {
      const s = surfaces[i]
      if (!s?.element.isConnected) {
        refresh()
        return
      }
      selected = s.element
      const resolve = identity(selected, document)
      resolveSelected = () => {
        const el = resolve()
        return el && root.contains(el) ? el : null
      }
      options.select(selected, true)
      publish()
    }
    const refresh = (): void => {
      if (disposed) return
      const nextRoot = resolveRoot()
      if (!nextRoot) {
        dialog.replaceChildren()
        surfaces = []
        slots = []
        pages = []
        invalid = true
        ready = true
        revision++
        if (selected) {
          selected = null
          resolveSelected = null
          options.lost()
        }
        publish()
        return
      }
      root = nextRoot
      const nextSelected = resolveSelected?.() ?? null
      if (nextSelected !== selected) {
        selected = nextSelected
        if (selected) options.select(selected, true)
        else options.lost()
      }
      const captured = captureSurfaces(root)
      const atlas = packAtlas(
        captured.surfaces.map((s) => ({ width: s.rect.width, height: s.rect.height })),
        { width: window.innerWidth, height: window.innerHeight }
      )
      // Surfaces beyond the page budget are dropped; their DOM order is kept.
      surfaces = captured.surfaces.filter((_, i) => atlas.slots[i])
      slots = atlas.slots.filter(Boolean)
      scale = atlas.scale
      limited = captured.truncated || atlas.fitted < captured.surfaces.length
      simplified = captured.approximate
      invalid = false
      revision++
      const rootRect = root.getBoundingClientRect()
      originX = Math.min(rootRect.left, ...surfaces.map((s) => s.rect.left))
      originY = Math.min(rootRect.top, ...surfaces.map((s) => s.rect.top))
      width = Math.max(1, rootRect.right - originX, ...surfaces.map((s) => s.rect.right - originX))
      height = Math.max(
        1,
        rootRect.bottom - originY,
        ...surfaces.map((s) => s.rect.bottom - originY)
      )
      pages = Array.from({ length: atlas.pages }, () => {
        const page = document.createElement('div')
        page.className = 'page'
        return page
      })
      for (const [i, s] of surfaces.entries()) {
        const slot = document.createElement('div')
        slot.className = 'slot'
        slot.style.left = `${slots[i].x}px`
        slot.style.top = `${slots[i].y}px`
        slot.style.width = `${s.rect.width}px`
        slot.style.height = `${s.rect.height}px`
        slot.style.transform = `scale(${scale})`
        slot.append(s.paint)
        pages[slots[i].page].append(slot)
      }
      dialog.removeAttribute('data-tone')
      dialog.replaceChildren(...pages)
      // Publish once images have decoded so the host's snapshots include them.
      ready = false
      const current = revision
      const images = Array.from(dialog.querySelectorAll('img'))
      void Promise.race([
        Promise.allSettled(images.map((img) => img.decode())),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]).then(() => {
        if (disposed || current !== revision) return
        ready = true
        publish()
      })
    }
    const scheduleRefresh = (): void => {
      // Throttle, rather than debounce: continuously changing pages still update.
      if (!timer)
        timer = window.setTimeout(() => {
          timer = 0
          refresh()
        }, 300)
    }
    runAction = (message) => {
      if (disposed) return false
      if (!threeDActionAllowed(message, session, revision, surfaces.length, pages.length)) {
        // A rejected action for the live session (a stale revision after a refresh) re-publishes
        // the scene so the native controls show what the scene actually has.
        if ((message as { session?: unknown } | null)?.session === session) publish()
        return false
      }
      switch (message.action) {
        case 'close':
          close()
          break
        case 'code': {
          const element = resolveSelected?.()
          if (element && options.hasSource(element)) options.code(element)
          break
        }
        case 'layer':
          choose(message.value)
          break
        case 'paint':
          // The host snapshots only after this returns true for a published revision.
          if (!ready) return false
          paint(message.value)
          break
      }
      return true
    }
    shadow.append(style, dialog)
    document.documentElement.append(host)
    dialog.showModal()
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      close()
    })
    handleKey = (e) => {
      if (!e.isTrusted) return
      // Keep shortcuts from reaching the running app while the scene is open.
      e.stopImmediatePropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    const observer = new MutationObserver(scheduleRefresh)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    })
    if (document.head)
      observer.observe(document.head, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true
      })
    window.addEventListener('resize', scheduleRefresh)
    document.addEventListener('load', scheduleRefresh, true)
    document.addEventListener('transitionend', scheduleRefresh, true)
    document.addEventListener('animationend', scheduleRefresh, true)
    document.fonts.addEventListener('loadingdone', scheduleRefresh)
    const onPageHide = (): void => close()
    window.addEventListener('pagehide', onPageHide)
    cleanup = () => {
      disposed = true
      observer.disconnect()
      clearTimeout(timer)
      window.removeEventListener('resize', scheduleRefresh)
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('load', scheduleRefresh, true)
      document.removeEventListener('transitionend', scheduleRefresh, true)
      document.removeEventListener('animationend', scheduleRefresh, true)
      document.fonts.removeEventListener('loadingdone', scheduleRefresh)
      dialog.close()
      if (focusBefore instanceof HTMLElement && focusBefore.isConnected)
        focusBefore.focus({ preventScroll: true })
    }
    refresh()
  }
  return {
    active: () => host !== null,
    open,
    close,
    selected: () => resolveSelected?.() ?? null,
    action: (message) => runAction?.(message) ?? false,
    key: (event) => handleKey?.(event)
  }
}
