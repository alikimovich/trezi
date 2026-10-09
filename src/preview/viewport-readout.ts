/** The preview's sole dimension badge, measured in CSS viewport pixels. */
export function createViewportReadout(
  parent: HTMLElement,
  fixed = false
): {
  update: (width: number, height: number) => void
  dispose: () => void
} {
  const host = document.createElement('div')
  host.setAttribute('data-trezi-viewport-size', '')
  host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2147483647;'
  if (fixed) host.style.position = 'fixed'
  const shadow = host.attachShadow({ mode: 'open' })
  const badge = document.createElement('div')
  badge.style.cssText =
    'all:initial;position:absolute;right:0;top:0;display:none;pointer-events:none;' +
    'padding:4px 8px;background:#fff;color:#222;font:500 15px/20px system-ui,sans-serif;' +
    'font-variant-numeric:tabular-nums;white-space:nowrap;'
  shadow.append(badge)
  parent.append(host)
  let previous = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    update(width, height) {
      const text = `${Math.round(width)}px × ${Math.round(height)}px`
      if (text === previous || width <= 0 || height <= 0) return
      const initialized = !!previous
      previous = text
      if (!initialized) return
      badge.textContent = text
      badge.style.display = 'block'
      clearTimeout(timer)
      timer = setTimeout(() => {
        badge.style.display = 'none'
      }, 1000)
    },
    dispose() {
      clearTimeout(timer)
      host.remove()
    }
  }
}
