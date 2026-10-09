/** Paint-only copies in the preview's shadow DOM. Never copy page markup,
 * event handlers, custom elements, IDs, or executable SVG into inspector UI.
 * Geometry stays owned by the live page; the copies never join its layout. */
const PAINT = [
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'background-origin',
  'background-clip',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'box-shadow',
  'color',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-variant',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'text-decoration',
  'text-shadow',
  'word-spacing',
  'white-space',
  'direction',
  'writing-mode',
  'opacity'
]
const ATOMIC = new Set(['svg', 'canvas', 'video', 'iframe', 'input', 'textarea', 'select', 'img'])
const SKIP = new Set(['script', 'style', 'link', 'meta', 'template', 'noscript', 'source', 'br'])
export interface Surface {
  element: Element
  depth: number
  rect: DOMRect
  paint: HTMLDivElement
  label: string
}

function bitmap(el: Element): HTMLImageElement | null {
  const img = document.createElement('img')
  img.draggable = false
  if (el instanceof HTMLImageElement) img.src = el.currentSrc || el.src
  else if (el instanceof HTMLCanvasElement) {
    try {
      const canvas = document.createElement('canvas')
      const scale = Math.min(1, 2048 / Math.max(el.width, el.height, 1))
      canvas.width = Math.max(1, Math.round(el.width * scale))
      canvas.height = Math.max(1, Math.round(el.height * scale))
      canvas.getContext('2d')?.drawImage(el, 0, 0, canvas.width, canvas.height)
      img.src = canvas.toDataURL()
    } catch {
      return null
    }
  } else if (el instanceof SVGSVGElement) {
    // SVG loaded as an image has scripting and external resources disabled.
    if (el.querySelectorAll('*').length > 1000) return null
    const copy = el.cloneNode(true) as SVGSVGElement
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const originals = [el, ...el.querySelectorAll('*')]
    const copies = [copy, ...copy.querySelectorAll('*')]
    for (let i = 0; i < copies.length; i++) {
      const cs = getComputedStyle(originals[i])
      for (const prop of ['fill', 'stroke', 'stroke-width', 'color', 'font']) {
        ;(copies[i] as SVGElement).style.setProperty(prop, cs.getPropertyValue(prop))
      }
    }
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
  } else return null
  img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;'
  img.style.objectFit = getComputedStyle(el).objectFit
  img.style.objectPosition = getComputedStyle(el).objectPosition
  return img
}

function paintElement(el: Element, rect: DOMRect): HTMLDivElement {
  const paint = document.createElement('div')
  const cs = getComputedStyle(el)
  for (const prop of PAINT) paint.style.setProperty(prop, cs.getPropertyValue(prop))
  paint.style.cssText += `;position:absolute;inset:0;box-sizing:border-box;width:${rect.width}px;height:${rect.height}px;pointer-events:none;overflow:visible;`
  const raster = bitmap(el)
  if (raster) paint.append(raster)
  else if (ATOMIC.has(el.localName)) {
    const label = document.createElement('span')
    label.textContent =
      el instanceof HTMLInputElement && el.type !== 'password'
        ? el.value
        : el instanceof HTMLTextAreaElement
          ? el.value
          : `[${el.localName}]`
    paint.append(label)
  } else {
    // Direct text only: descendants get their own surfaces. Range geometry keeps
    // mixed text and wrapping in their live positions, without double-painting.
    let budget = 1800
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
      const text = node.textContent
      const range = document.createRange()
      let start = 0
      while (start < text.length && budget-- > 0) {
        range.setStart(node, start)
        range.setEnd(node, start + 1)
        const first = range.getBoundingClientRect()
        let end = start + 1
        // Find the end of this visual line. Bounded even for hostile text nodes.
        while (end < text.length && budget-- > 0) {
          range.setStart(node, end)
          range.setEnd(node, end + 1)
          if (Math.abs(range.getBoundingClientRect().top - first.top) > 1) break
          end++
        }
        range.setStart(node, start)
        range.setEnd(node, end)
        const r = range.getBoundingClientRect()
        const span = document.createElement('span')
        span.textContent = text.slice(start, end)
        span.style.cssText = `position:absolute;left:${r.left - rect.left - parseFloat(cs.borderLeftWidth)}px;top:${r.top - rect.top - parseFloat(cs.borderTopWidth)}px;white-space:pre;line-height:${r.height}px;`
        paint.append(span)
        start = end
      }
    }
  }
  return paint
}

export function captureSurfaces(root: Element): {
  surfaces: Surface[]
  truncated: boolean
  approximate: boolean
} {
  const surfaces: Surface[] = []
  let truncated = false
  let approximate = false
  let visited = 0
  const visit = (el: Element, depth: number): void => {
    if (++visited > 500 || surfaces.length >= 160 || depth > 18) {
      truncated = true
      return
    }
    if (SKIP.has(el.localName)) return
    const cs = getComputedStyle(el)
    if (cs.display === 'none') return
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0 && cs.visibility === 'visible') {
      if (
        cs.transform !== 'none' ||
        cs.filter !== 'none' ||
        cs.mixBlendMode !== 'normal' ||
        cs.overflowX !== 'visible' ||
        cs.overflowY !== 'visible' ||
        el.shadowRoot ||
        ['video', 'iframe', 'input', 'textarea', 'select'].includes(el.localName) ||
        ['::before', '::after'].some(
          (p) => !['none', 'normal', '""'].includes(getComputedStyle(el, p).content)
        )
      )
        approximate = true
      surfaces.push({
        element: el,
        depth,
        rect,
        paint: paintElement(el, rect),
        label: `${el.localName}${el.id ? `#${el.id.slice(0, 60)}` : ''}`
      })
    }
    if (!ATOMIC.has(el.localName)) {
      for (const child of el.children) {
        if (visited >= 500) {
          truncated = true
          break
        }
        visit(child, depth + 1)
      }
    }
  }
  visit(root, 0)
  return { surfaces, truncated, approximate }
}
