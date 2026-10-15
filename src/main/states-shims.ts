/**
 * Browser stand-ins for the Next.js modules a client component imports. They keep a
 * component's markup and styling real while taking routing, image optimization and font loading
 * out of the isolated frame: links never navigate, the router never moves, and
 * `next/navigation` reports the state's route fixture.
 */

const IMAGE = `
const srcOf = (src) => (src && typeof src === 'object' ? (src.default ?? src).src : src)
function Image({ src, fill, priority, placeholder, blurDataURL, loader, quality, unoptimized, overrideSrc, onLoadingComplete, width, height, style, ...rest }, ref) {
  const meta = src && typeof src === 'object' ? (src.default ?? src) : {}
  return React.createElement('img', {
    ref, src: srcOf(src), loading: 'eager', decoding: 'async',
    width: fill ? undefined : (width ?? meta.width), height: fill ? undefined : (height ?? meta.height),
    style: fill ? { position: 'absolute', inset: 0, width: '100%', height: '100%', ...style } : style,
    ...rest
  })
}
export default React.forwardRef(Image)
export function getImageProps(props) { return { props: { ...props, src: srcOf(props.src) } } }
`

const LINK = `
const hrefOf = (href) => typeof href === 'string' ? href : href ? (href.pathname ?? '') + (href.query ? '?' + new URLSearchParams(href.query) : '') + (href.hash ? '#' + href.hash : '') : '#'
function Link({ href, as, prefetch, replace, scroll, shallow, passHref, legacyBehavior, locale, onNavigate, children, onClick, ...rest }, ref) {
  const click = (event) => { onClick?.(event); event.preventDefault() }
  if (legacyBehavior && React.isValidElement(children)) return React.cloneElement(children, { href: hrefOf(href), onClick: click })
  return React.createElement('a', { ...rest, ref, href: hrefOf(href), onClick: click }, children)
}
export default React.forwardRef(Link)
export const useLinkStatus = () => ({ pending: false })
`

const ROUTE = `const route = () => globalThis.__treziRoute ?? {}
const noop = () => {}
const router = { push: noop, replace: noop, back: noop, forward: noop, refresh: noop, prefetch: () => Promise.resolve() }`

const NAVIGATION = `${ROUTE}
export const usePathname = () => route().pathname ?? '/'
export const useSearchParams = () => new URLSearchParams(route().search ?? '')
export const useParams = () => route().params ?? {}
export const useRouter = () => router
export const useSelectedLayoutSegment = () => null
export const useSelectedLayoutSegments = () => []
export const useServerInsertedHTML = noop
export const ReadonlyURLSearchParams = URLSearchParams
export const RedirectType = { push: 'push', replace: 'replace' }
export const unstable_rethrow = noop
export function redirect(to) { throw new Error('redirect(' + JSON.stringify(to) + ') ran while rendering this state') }
export const permanentRedirect = redirect
export function notFound() { throw new Error('notFound() ran while rendering this state') }
export function forbidden() { throw new Error('forbidden() ran while rendering this state') }
export function unauthorized() { throw new Error('unauthorized() ran while rendering this state') }
`

const ROUTER = `${ROUTE}
const events = { on: noop, off: noop, emit: noop }
const current = () => {
  const r = route()
  const path = (r.pathname ?? '/') + (r.search ?? '')
  return { ...router, pathname: r.pathname ?? '/', route: r.pathname ?? '/', asPath: path, query: { ...Object.fromEntries(new URLSearchParams(r.search ?? '')), ...(r.params ?? {}) }, basePath: '', isReady: true, isFallback: false, isPreview: false, isLocaleDomain: false, events, beforePopState: noop }
}
export const useRouter = current
export function withRouter(Component) { return (props) => React.createElement(Component, { ...props, router: current() }) }
export default new Proxy({}, { get: (_, key) => current()[key] })
`

const FONT = (names: string[]) => `
const font = () => ({ className: '', variable: '', style: { fontFamily: 'inherit' } })
export default font
${names.map((name) => `export const ${name} = font`).join('\n')}
`

const DYNAMIC = `
export default function dynamic(load, options = {}) {
  const Lazy = React.lazy(async () => {
    const value = await (typeof load === 'function' ? load() : load)
    return { default: value && typeof value === 'object' && 'default' in value ? value.default : value }
  })
  const Loading = options.loading
  return function Dynamic(props) {
    return React.createElement(React.Suspense, { fallback: Loading ? React.createElement(Loading, { isLoading: true }) : null }, React.createElement(Lazy, props))
  }
}
`

const NOTHING = 'export default function Nothing() { return null }'

/** Specifiers only a server can satisfy: a module graph that reaches one cannot render here. */
export const SERVER_ONLY =
  /^(server-only|next\/(headers|cache|server|og)|node:.*|fs|fs\/promises|child_process|net|tls|dns|cluster|worker_threads|@prisma\/client|prisma|pg|postgres|mysql2|mongodb|mongoose|better-sqlite3|@vercel\/(postgres|kv|blob)|@neondatabase\/serverless|drizzle-orm\/(node-postgres|postgres-js|better-sqlite3|neon-http))$/

/** Names a file imports from a specifier, so a shim can export exactly those. */
export function importedNames(code: string, specifier: string): string[] {
  const names = new Set<string>()
  const quoted = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const pattern = new RegExp(
    `import\\s*(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${quoted}['"]`,
    'g'
  )
  for (const match of code.matchAll(pattern))
    for (const part of match[1].split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name)
    }
  return [...names]
}

/** The shim module for `specifier`, or null when Trezi does not replace it. */
export function nextShim(specifier: string, react: string, importer: string): string | null {
  const head = `import * as React from ${JSON.stringify(react)}\n`
  switch (specifier) {
    case 'next':
    case 'client-only':
      return 'export {}'
    case 'next/image':
    case 'next/legacy/image':
      return head + IMAGE
    case 'next/link':
      return head + LINK
    case 'next/navigation':
      return NAVIGATION
    case 'next/router':
      return head + ROUTER
    case 'next/font/google':
    case 'next/font/local':
      return FONT(importedNames(importer, specifier))
    case 'next/dynamic':
      return head + DYNAMIC
    case 'next/head':
    case 'next/script':
      return NOTHING
    case 'next/config':
      return 'export default () => ({ publicRuntimeConfig: {}, serverRuntimeConfig: {} })'
    default:
      return null
  }
}
