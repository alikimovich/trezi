import type { CanvasRecipe } from '../shared/states-canvas'

/** Page-world adapter. It has no native bridge: the isolated preload supplies a bounded
 * recipe, and the only reply is DOM state. Project code runs solely as the real module
 * imported from the current dev server, inside a disposable React root. */
type Request = {
  session: string
  recipe?: CanvasRecipe
  state?: string
  refresh?: boolean
  command: 'open' | 'select' | 'close'
}
let session = ''
let dialog: HTMLDialogElement | null = null
let roots: { unmount(): void }[] = []
let generation = 0
let savedScroll: { x: number; y: number } | null = null

function close() {
  generation++
  for (const root of roots) root.unmount()
  roots = []
  dialog?.close()
  dialog?.remove()
  dialog = null
  if (savedScroll) window.scrollTo(savedScroll.x, savedScroll.y)
  savedScroll = null
  session = ''
}

function report(status: string, reason = '') {
  document.documentElement.setAttribute(
    'data-trezi-canvas-result',
    JSON.stringify({
      session,
      status,
      reason: reason.slice(0, 240)
    })
  )
  document.dispatchEvent(new Event('trezi:canvas-result'))
}

function frame(id: string, label: string, width: number): { box: HTMLElement; mount: HTMLElement } {
  const box = document.createElement('section')
  box.setAttribute('data-trezi-state-frame', id)
  box.style.cssText = `width:${width}px;max-width:100%;box-sizing:border-box;padding:12px;border:1px solid currentColor;border-radius:8px;overflow:hidden;`
  const heading = document.createElement('div')
  heading.textContent = label
  heading.style.cssText = 'font:500 16px system-ui;margin-bottom:10px;'
  const mount = document.createElement('div')
  mount.style.pointerEvents = 'none'
  box.append(heading, mount)
  return { box, mount }
}

async function open(request: Request) {
  close()
  const recipe = request.recipe
  if (!recipe || !request.session || !/^https?:$/.test(location.protocol)) return
  session = request.session
  const ticket = generation
  savedScroll = { x: scrollX, y: scrollY }
  dialog = document.createElement('dialog')
  dialog.setAttribute('data-trezi-states-canvas', session)
  dialog.setAttribute('aria-label', `${recipe.component} states canvas`)
  dialog.style.cssText =
    'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:52px 20px 64px;border:0;box-sizing:border-box;overflow:auto;background:Canvas;color:CanvasText;color-scheme:light dark;'
  const style = document.createElement('style')
  style.textContent = 'dialog[data-trezi-states-canvas]::backdrop{background:transparent}'
  dialog.append(style)
  const contents = document.createElement('div')
  contents.style.cssText =
    'display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:center;gap:16px;min-height:100%;'
  contents.textContent = 'Loading component…'
  dialog.append(contents)
  document.body.append(dialog)
  dialog.showModal()
  window.scrollTo(savedScroll.x, savedScroll.y)
  report('loading')
  const url = (path: string) => new URL(path, location.origin).href
  try {
    const modules = await Promise.race([
      Promise.all([
        import(
          /* @vite-ignore */ url(
            `/${recipe.source}${request.refresh ? `?trezi=${Date.now()}` : ''}`
          )
        ),
        import(/* @vite-ignore */ url(recipe.react)),
        import(/* @vite-ignore */ url(recipe.reactDom)),
        recipe.provider
          ? import(
              /* @vite-ignore */ url(
                `/${recipe.provider.source}${request.refresh ? `?trezi=${Date.now()}` : ''}`
              )
            )
          : Promise.resolve(null)
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Module load timed out')), 8000)
      )
    ])
    if (ticket !== generation || !dialog) return
    const [source, react, reactDom, providerModule] = modules
    const component = source[recipe.exportName]
    const provider = recipe.provider && providerModule?.[recipe.provider.exportName]
    if (
      typeof component !== 'function' ||
      typeof react.createElement !== 'function' ||
      typeof react.Component !== 'function' ||
      typeof reactDom.createRoot !== 'function' ||
      (recipe.provider && typeof provider !== 'function')
    )
      throw new Error('Component, provider, or React runtime export is unavailable')
    const shown =
      request.state === 'all'
        ? recipe.states
        : recipe.states.filter((state) => state.id === request.state)
    if (!shown.length) throw new Error('State is missing or unsupported')
    class StateBoundary extends react.Component {
      declare state: { error: string | null }
      constructor(props: unknown) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error: unknown) {
        return { error: error instanceof Error ? error.message : 'Component render failed' }
      }
      componentDidCatch(error: unknown) {
        report('error', error instanceof Error ? error.message : 'Component render failed')
      }
      render() {
        return this.state.error
          ? react.createElement('pre', { 'data-trezi-canvas-error': '' }, this.state.error)
          : this.props.children
      }
    }
    contents.replaceChildren()
    for (const state of shown) {
      const { box, mount } = frame(state.id, state.label, recipe.width)
      contents.append(box)
      const child = react.createElement(component, state.props)
      const tree = provider ? react.createElement(provider, null, child) : child
      const root = reactDom.createRoot(mount)
      roots.push(root)
      root.render(react.createElement(StateBoundary, null, tree))
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (ticket !== generation || !dialog) return
    dialog.setAttribute('data-trezi-state', request.state ?? '')
    if (!dialog.querySelector('[data-trezi-canvas-error]')) report('ready')
  } catch (error) {
    if (ticket !== generation || !dialog) return
    contents.textContent = error instanceof Error ? error.message : 'Component could not render'
    dialog.setAttribute('data-trezi-state', 'error')
    report('error', contents.textContent)
  }
}

document.addEventListener('trezi:canvas-command', () => {
  let request: Request
  try {
    request = JSON.parse(document.documentElement.getAttribute('data-trezi-canvas-command') || '')
  } catch {
    return
  }
  if (!request || typeof request.session !== 'string') return
  if (request.command === 'close') {
    if (request.session === session) close()
    return
  }
  if (request.command === 'open' && request.recipe) void open(request)
  if (request.command === 'select' && request.session === session && request.recipe)
    void open(request)
})
window.addEventListener('pagehide', close)
