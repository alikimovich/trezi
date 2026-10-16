/**
 * The runtime inside one state's frame. Trezi bundles it with the component and the project's
 * own React (src/main/states-build.ts); the isolated view (states-canvas.ts) gives each state
 * a frame of its own, so states never share module state, storage writes or routes.
 */

type Action = { type: string; selector?: string; text?: string; key?: string }
type FrameData = {
  session: string
  frame: string
  props: Record<string, unknown>
  actions?: Action[]
  route?: { pathname?: string; search?: string; params?: Record<string, string> }
}
type Mount = {
  React: any
  ReactDOM: any
  module: Record<string, any>
  exportName: string
  provider: Record<string, any> | null
  providerExport: string | null
}

const PSEUDO = /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g
// WebKit pauses animation frames in a frame scrolled out of view, so a timer also settles it.
const frames = () =>
  Promise.race([
    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    new Promise((done) => setTimeout(done, 100))
  ])

/** The height the frame needs: the root and anything that overflows it (an open menu). */
function contentHeight(): number {
  const root = document.getElementById('trezi-root')
  let bottom = root?.getBoundingClientRect().bottom ?? 0
  let seen = 0
  for (const element of root?.querySelectorAll('*') ?? []) {
    if (++seen > 2000) break
    bottom = Math.max(bottom, element.getBoundingClientRect().bottom)
  }
  return Math.ceil(bottom + scrollY)
}

function report(data: FrameData, status: string, reason = '') {
  parent.postMessage(
    {
      trezi: 'states-frame',
      session: data.session,
      frame: data.frame,
      status,
      reason: reason.slice(0, 400),
      height: contentHeight()
    },
    '*'
  )
}

/** Values JSON cannot carry arrive tagged (see CanvasState in src/shared/states-canvas.ts). */
function decode(value: unknown, calls: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => decode(item, calls))
  if (!value || typeof value !== 'object') return value
  const tagged = value as Record<string, unknown>
  if ('$fn' in tagged) {
    const name = String(tagged.$fn)
    return () => {
      calls.push(name)
    }
  }
  if ('$date' in tagged) return new Date(String(tagged.$date))
  if ('$pending' in tagged) return new Promise(() => {})
  if ('$reject' in tagged) {
    const rejected = Promise.reject(new Error(String(tagged.$reject)))
    rejected.catch(() => {})
    return rejected
  }
  if ('$node' in tagged) return String(tagged.$node ?? '')
  if ('$undefined' in tagged) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(tagged)) {
    const decoded = decode(item, calls)
    if (decoded !== undefined) out[key] = decoded
  }
  return out
}

/** A state renders as a snapshot of the app: it may read, but never navigate, write to the
 * server, or change the page's storage and cookies. */
function guard() {
  const block = (event: Event) => event.preventDefault()
  document.addEventListener('submit', block, true)
  document.addEventListener(
    'click',
    (event) => {
      if ((event.target as Element | null)?.closest?.('a[href]')) event.preventDefault()
    },
    true
  )
  window.open = () => null
  history.pushState = () => {}
  history.replaceState = () => {}
  const fetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    return method === 'GET' || method === 'HEAD'
      ? fetch(input, init)
      : Promise.reject(new TypeError(`Trezi blocked a ${method} request from a state preview.`))
  }
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, ...rest: any[]) {
    if (!/^(GET|HEAD)$/i.test(method)) throw new TypeError('Trezi blocked a write request.')
    return (open as any).call(this, method, ...rest)
  }
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const values = new Map<string, string>()
    try {
      const real = window[name]
      for (let i = 0; i < real.length; i++) {
        const key = real.key(i)
        if (key !== null) values.set(key, real.getItem(key) ?? '')
      }
    } catch {}
    const storage = {
      get length() {
        return values.size
      },
      key: (i: number) => [...values.keys()][i] ?? null,
      getItem: (key: string) => values.get(String(key)) ?? null,
      setItem: (key: string, value: string) => void values.set(String(key), String(value)),
      removeItem: (key: string) => void values.delete(String(key)),
      clear: () => values.clear()
    }
    Object.defineProperty(window, name, { configurable: true, value: storage })
  }
  const cookie = document.cookie
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookie,
    set: () => {}
  })
}

/** `:hover`/`:focus`/`:active` cannot be entered from script, so their rules are copied onto
 * attributes the actions set. Cross-origin sheets are unreadable and skipped. */
function emulatePseudoClasses() {
  const copies: string[] = []
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of [...rules]) {
      if (PSEUDO.test(rule.cssText)) copies.push(rule.cssText.replace(PSEUDO, '[data-trezi-$1]'))
      PSEUDO.lastIndex = 0
    }
  }
  const style = document.createElement('style')
  style.setAttribute('data-trezi-pseudo', '')
  style.textContent = copies.join('\n')
  document.head.append(style)
}

function mark(target: Element, self: string[], ancestors: string[]) {
  for (const name of self) target.setAttribute(`data-trezi-${name}`, '')
  for (let node = target.parentElement; node; node = node.parentElement)
    for (const name of ancestors) node.setAttribute(`data-trezi-${name}`, '')
}

async function run(root: HTMLElement, actions: Action[]): Promise<string> {
  if (actions.some((action) => ['hover', 'focus', 'press'].includes(action.type)))
    emulatePseudoClasses()
  for (const action of actions) {
    const target = (
      action.selector ? root.querySelector(action.selector) : root.firstElementChild
    ) as HTMLElement | null
    if (!target)
      return `No element matches "${action.selector ?? 'the component'}" for the ${action.type} step.`
    const mouse = (type: string) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    const pointer = (type: string) =>
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, view: window })
      )
    if (action.type === 'click') target.click()
    else if (action.type === 'hover') {
      for (const type of ['pointerover', 'pointerenter']) pointer(type)
      for (const type of ['mouseover', 'mouseenter']) mouse(type)
      mark(target, ['hover'], ['hover'])
    } else if (action.type === 'focus') {
      target.focus()
      mark(target, ['focus', 'focus-visible', 'focus-within'], ['focus-within'])
    } else if (action.type === 'press') {
      pointer('pointerdown')
      mouse('mousedown')
      mark(target, ['active', 'hover'], ['active', 'hover'])
    } else if (action.type === 'type') {
      target.focus()
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set
      if (setter) setter.call(target, action.text ?? '')
      else target.textContent = action.text ?? ''
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (action.type === 'key') {
      for (const type of ['keydown', 'keyup'])
        target.dispatchEvent(
          new KeyboardEvent(type, { key: action.key ?? 'Enter', bubbles: true, cancelable: true })
        )
    }
    await frames()
  }
  return ''
}

// The entry imports this module first, so the guard and the route are in place before the
// project's modules evaluate, and an error while they load is reported too.
const data = (
  typeof document === 'undefined'
    ? {}
    : JSON.parse(document.getElementById('trezi-state')?.textContent || '{}')
) as FrameData
let failed = ''
const fail = (reason: string) => {
  if (failed) return
  failed = reason || 'The component threw while rendering.'
  report(data, 'error', failed)
}
if (typeof document !== 'undefined') {
  addEventListener('error', (event) => fail(event.message))
  addEventListener('unhandledrejection', (event) =>
    fail(String(event.reason?.message ?? event.reason))
  )
  guard()
  ;(globalThis as any).__treziRoute = data.route ?? {}
}

export function mount({
  React: ReactModule,
  ReactDOM: DOMModule,
  module,
  exportName,
  provider,
  providerExport
}: Mount) {
  // CommonJS React arrives as a namespace whose members may sit on `default`.
  const React = ReactModule.createElement ? ReactModule : ReactModule.default
  const ReactDOM = DOMModule.createRoot || DOMModule.render ? DOMModule : DOMModule.default
  const pick = (from: Record<string, any> | null, name: string | null) =>
    from && name ? (from[name] ?? (name === 'default' ? undefined : from.default?.[name])) : null
  const Component = pick(module, exportName)
  const Provider = pick(provider, providerExport)
  if (typeof Component !== 'function' && typeof Component !== 'object') {
    fail(
      `${exportName === 'default' ? 'The default export' : exportName} is not a component exported by this module.`
    )
    return
  }
  class Boundary extends React.Component {
    state = { error: null as Error | null }
    static getDerivedStateFromError(error: Error) {
      return { error }
    }
    componentDidCatch(error: Error) {
      fail(error?.message ?? String(error))
    }
    render() {
      return this.state.error
        ? React.createElement(
            'pre',
            { 'data-trezi-state-error': '' },
            String(this.state.error.message ?? this.state.error)
          )
        : this.props.children
    }
  }
  const root = document.getElementById('trezi-root') as HTMLElement
  const calls: string[] = []
  const props = decode(data.props ?? {}, calls) as Record<string, unknown>
  let reported = false
  function Ready() {
    React.useEffect(() => {
      if (reported) return
      reported = true
      void (async () => {
        await Promise.race([document.fonts?.ready, new Promise((done) => setTimeout(done, 1500))])
        await frames()
        const reason = await run(root, data.actions ?? [])
        if (reason) return fail(reason)
        if (failed) return
        report(data, 'ready')
        new ResizeObserver(() => report(data, failed ? 'error' : 'ready')).observe(root)
      })()
    }, [])
    return null
  }
  const element = React.createElement(Component, props)
  const tree = React.createElement(
    React.Fragment,
    null,
    React.createElement(
      Boundary,
      null,
      React.createElement(
        React.Suspense,
        { fallback: null },
        Provider ? React.createElement(Provider, null, element) : element
      )
    ),
    React.createElement(Ready)
  )
  if (ReactDOM.createRoot) ReactDOM.createRoot(root).render(tree)
  else ReactDOM.render(tree, root)
}
