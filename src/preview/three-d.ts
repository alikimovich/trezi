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

export function createThreeDInspector(options: {
  select: (element: Element, open: boolean) => void
  hasSource: (element: Element) => boolean
  code: (element: Element) => void
  lost: () => void
  close: () => void
}): {
  active: () => boolean
  open: (element: Element) => void
  close: () => void
  selected: () => Element | null
} {
  let host: HTMLDivElement | null = null
  let cleanup: (() => void) | null = null
  let resolveSelected: (() => Element | null) | null = null
  const close = (): void => {
    if (!host) return
    cleanup?.()
    cleanup = null
    host.remove()
    host = null
    resolveSelected = null
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
    const dialog = document.createElement('dialog')
    dialog.setAttribute('aria-label', '3D component inspector')
    dialog.style.cssText =
      'position:fixed;inset:0;margin:0;padding:0;border:0;max-width:none;max-height:none;width:100vw;height:100vh;'
    const workspace = document.createElement('div')
    workspace.className = 'workspace'
    const header = document.createElement('header')
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = '3D component'
    const button = (text: string, action: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      b.addEventListener('click', (e) => {
        if (e.isTrusted) action()
      })
      return b
    }
    const back = button('Back to page', close)
    const code = button('Code', () => {
      const element = resolveSelected?.()
      if (element && options.hasSource(element)) options.code(element)
    })
    code.title = 'View selected layer source'
    const updateCode = (): void => {
      code.hidden = !selected || !options.hasSource(selected)
    }
    updateCode()
    const stage = document.createElement('div')
    stage.className = 'stage'
    stage.tabIndex = 0
    stage.setAttribute(
      'aria-label',
      '3D canvas. Arrow keys rotate; plus and minus zoom; Shift and drag pans.'
    )
    const scene = document.createElement('div')
    scene.className = 'scene'
    stage.append(scene)
    const status = document.createElement('div')
    status.className = 'status'
    status.setAttribute('role', 'status')
    const footer = document.createElement('footer')
    const layers = document.createElement('select')
    layers.className = 'layers'
    layers.setAttribute('aria-label', 'Component layer')
    const hint = document.createElement('span')
    hint.className = 'hint'
    hint.textContent = 'Drag to orbit · Shift-drag to pan · Scroll to zoom'
    let surfaces: Surface[] = []
    let pitch = 48,
      yaw = -28,
      zoom = 1,
      separation = 36,
      panX = 0,
      panY = 0
    let frame = 0,
      timer = 0,
      disposed = false
    let width = 1,
      height = 1,
      maxDepth = 0,
      originX = 0,
      originY = 0
    const updateCamera = (): void => {
      const fit = Math.min(
        (stage.clientWidth - 70) / width,
        (stage.clientHeight - 70) / (height + maxDepth * separation),
        1.5
      )
      scene.style.transform = `translate(${panX}px,${panY}px) scale(${Math.max(0.04, fit) * zoom}) rotateX(${pitch}deg) rotateY(${yaw}deg)`
      Array.from(scene.children).forEach((node, i) => {
        const s = surfaces[i]
        ;(node as HTMLElement).style.transform =
          `translate3d(${s.rect.left - originX - width / 2}px,${s.rect.top - originY - height / 2}px,${(s.depth - maxDepth / 2) * separation}px)`
      })
    }
    const scheduleCamera = (): void => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          updateCamera()
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
      layers.value = String(i)
      Array.from(scene.children).forEach((node, n) => {
        node.toggleAttribute('data-selected', i === n)
      })
      options.select(selected, true)
      updateCode()
    }
    const refresh = (): void => {
      if (disposed) return
      const nextRoot = resolveRoot()
      if (!nextRoot) {
        scene.replaceChildren()
        layers.replaceChildren()
        layers.disabled = true
        status.textContent =
          'This component was removed or replaced ambiguously. Return to the page and select it again.'
        if (selected) {
          selected = null
          resolveSelected = null
          options.lost()
        }
        updateCode()
        return
      }
      root = nextRoot
      const nextSelected = resolveSelected?.() ?? null
      if (nextSelected !== selected) {
        selected = nextSelected
        if (selected) options.select(selected, true)
        else options.lost()
      }
      updateCode()
      const captured = captureSurfaces(root)
      surfaces = captured.surfaces
      const rootRect = root.getBoundingClientRect()
      originX = Math.min(rootRect.left, ...surfaces.map((s) => s.rect.left))
      originY = Math.min(rootRect.top, ...surfaces.map((s) => s.rect.top))
      width = Math.max(1, rootRect.right - originX, ...surfaces.map((s) => s.rect.right - originX))
      height = Math.max(
        1,
        rootRect.bottom - originY,
        ...surfaces.map((s) => s.rect.bottom - originY)
      )
      maxDepth = Math.max(0, ...surfaces.map((s) => s.depth))
      const planes = document.createDocumentFragment()
      const choices = document.createDocumentFragment()
      for (const [i, s] of surfaces.entries()) {
        const plane = document.createElement('div')
        plane.className = 'surface'
        plane.dataset.layer = String(i)
        plane.title = s.label
        plane.toggleAttribute('data-selected', selected === s.element)
        plane.style.width = `${s.rect.width}px`
        plane.style.height = `${s.rect.height}px`
        plane.append(s.paint)
        planes.append(plane)
        const option = document.createElement('option')
        option.value = String(i)
        option.textContent = `${'· '.repeat(s.depth)}${s.label}`
        option.selected = selected === s.element
        choices.append(option)
      }
      scene.replaceChildren(planes)
      layers.replaceChildren(choices)
      layers.disabled = !surfaces.length
      if (!selected) layers.selectedIndex = -1
      title.textContent = `3D · ${surfaces[0]?.label ?? root.localName}`
      status.textContent = `${surfaces.length} layers · Depth shows nesting${captured.truncated ? ' · Large component: capture limited' : ''}${captured.approximate ? ' · Some effects or embedded content are simplified' : ''}`
      updateCamera()
    }
    const scheduleRefresh = (): void => {
      // Throttle, rather than debounce: continuously changing pages still update.
      if (!timer)
        timer = window.setTimeout(() => {
          timer = 0
          refresh()
        }, 180)
    }
    const separationLabel = document.createElement('label')
    separationLabel.textContent = 'Separation'
    const depth = document.createElement('input')
    depth.type = 'range'
    depth.min = '0'
    depth.max = '100'
    depth.value = String(separation)
    depth.setAttribute('aria-label', 'Layer separation')
    depth.addEventListener('input', () => {
      separation = Number(depth.value)
      scheduleCamera()
    })
    separationLabel.append(depth)
    const reset = (): void => {
      pitch = 48
      yaw = -28
      zoom = 1
      panX = 0
      panY = 0
      separation = 36
      depth.value = '36'
      scheduleCamera()
    }
    header.append(
      back,
      title,
      code,
      button('Front', () => {
        pitch = 0
        yaw = 0
        separation = 0
        depth.value = '0'
        scheduleCamera()
      }),
      button('Reset view', reset)
    )
    footer.append(separationLabel, layers, hint)
    workspace.append(header, stage, footer, status)
    dialog.append(workspace)
    shadow.append(style, dialog)
    document.documentElement.append(host)
    dialog.showModal()
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      close()
    })
    layers.addEventListener('change', () => choose(Number(layers.value)))
    const onKey = (e: KeyboardEvent): void => {
      if (!e.isTrusted) return
      // Keep shortcuts from reaching the running app while this modal owns focus.
      e.stopImmediatePropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.target !== host) return
      const target = e.composedPath()[0]
      if (target !== stage) return
      if (e.key === 'ArrowLeft') yaw -= 5
      else if (e.key === 'ArrowRight') yaw += 5
      else if (e.key === 'ArrowUp') pitch -= 5
      else if (e.key === 'ArrowDown') pitch += 5
      else if (e.key === '+' || e.key === '=') zoom = Math.min(4, zoom * 1.1)
      else if (e.key === '-') zoom = Math.max(0.2, zoom / 1.1)
      else return
      pitch = Math.max(-80, Math.min(80, pitch))
      e.preventDefault()
      scheduleCamera()
    }
    window.addEventListener('keydown', onKey, true)
    let drag: { id: number; x: number; y: number; moved: boolean; layer: number | null } | null =
      null
    stage.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted || e.button !== 0) return
      const target = (e.target as Element).closest<HTMLElement>('[data-layer]')
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        moved: false,
        layer: target ? Number(target.dataset.layer) : null
      }
      stage.setPointerCapture(e.pointerId)
      stage.focus({ preventScroll: true })
    })
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
      drag.moved = true
      drag.x = e.clientX
      drag.y = e.clientY
      if (e.shiftKey) {
        panX += dx
        panY += dy
      } else {
        yaw += dx * 0.4
        pitch = Math.max(-80, Math.min(80, pitch - dy * 0.4))
      }
      scheduleCamera()
    })
    stage.addEventListener('pointerup', (e) => {
      if (!drag || drag.id !== e.pointerId) return
      if (!drag.moved && drag.layer !== null) choose(drag.layer)
      drag = null
      stage.releasePointerCapture(e.pointerId)
    })
    stage.addEventListener('lostpointercapture', () => {
      drag = null
    })
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        e.stopPropagation()
        zoom = Math.max(0.2, Math.min(4, zoom * Math.exp(-e.deltaY * 0.001)))
        scheduleCamera()
      },
      { passive: false }
    )
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
    const resize = new ResizeObserver(scheduleRefresh)
    resize.observe(stage)
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
      resize.disconnect()
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey, true)
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
    stage.focus({ preventScroll: true })
  }
  return { active: () => host !== null, open, close, selected: () => resolveSelected?.() ?? null }
}
