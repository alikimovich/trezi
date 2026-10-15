/**
 * Reads the selected component instance's live props from React in the page world, encoded the
 * way state fixtures are (`$fn`, `$date`, `$node` …). The page is untrusted: the result is only
 * ever data, size-checked here and decoded inside a sandboxed state frame.
 */
export function probeScript(input: {
  path: number[]
  tag: string
  callSite: string | null
  component: string
}): string {
  return `(() => {
  const input = ${JSON.stringify(input)}
  let el = document.body
  for (const i of input.path) el = el && el.children[i]
  if (!el || el.tagName.toLowerCase() !== input.tag) return null
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
  if (!key) return { found: false }
  const nameOf = (type) => type && (type.displayName || type.name || (type.render && (type.render.displayName || type.render.name)) || (type.type && (type.type.displayName || type.type.name)))
  let match = null, named = null
  for (let fiber = el[key]; fiber; fiber = fiber.return) {
    if (!fiber.type || typeof fiber.type === 'string') continue
    const props = fiber.memoizedProps
    if (input.callSite && props && props['data-trezi-component-source'] === input.callSite) { match = fiber; break }
    if (!named && nameOf(fiber.type) === input.component) named = fiber
  }
  const fiber = match || named
  if (!fiber) return { found: false }
  let node = fiber
  while (node && !(node.stateNode instanceof Element)) node = node.child
  const width = node ? Math.round(node.stateNode.getBoundingClientRect().width) : 0
  const text = (value, depth) => {
    if (value == null || typeof value === 'boolean') return ''
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (Array.isArray(value)) return value.map((item) => text(item, depth + 1)).join('')
    if (depth < 6 && value.props) return text(value.props.children, depth + 1)
    return ''
  }
  const encode = (value, depth, items) => {
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'string') return value.slice(0, 2000)
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0
    if (value === undefined) return { $undefined: true }
    if (typeof value === 'function') return { $fn: String(value.name || 'callback').slice(0, 60) }
    if (typeof value !== 'object') return null
    if (value instanceof Date) return { $date: isNaN(value) ? '1970-01-01T00:00:00.000Z' : value.toISOString() }
    if (typeof value.then === 'function') return { $pending: true }
    if (value.$$typeof) return { $node: text(value, 0).slice(0, 400) }
    if (depth > 5) return null
    if (Array.isArray(value)) return value.slice(0, items).map((item) => encode(item, depth + 1, items))
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return null
    const out = {}
    for (const k of Object.keys(value).slice(0, 60)) if (!k.startsWith('data-trezi-')) out[k] = encode(value[k], depth + 1, items)
    return out
  }
  for (const items of [50, 12, 4, 1]) {
    const props = encode(fiber.memoizedProps || {}, 0, items)
    const json = JSON.stringify(props)
    if (json.length <= 16000) return { found: true, props, width }
  }
  return { found: true, props: null, width }
})()`
}

export type ProbeResult = { props: Record<string, unknown> | null; width: number }

/** Validate what the page returned: a plain bounded object, or nothing. */
export function readProbe(value: unknown): ProbeResult {
  const raw = value as { found?: unknown; props?: unknown; width?: unknown } | null
  const width = Number(raw?.width)
  const props = raw?.found === true ? raw.props : null
  let json = ''
  try {
    json = JSON.stringify(props ?? null)
  } catch {}
  const valid =
    !!props && typeof props === 'object' && !Array.isArray(props) && json.length <= 16_384
  return {
    props: valid ? (props as Record<string, unknown>) : null,
    width: Number.isFinite(width) && width >= 40 ? Math.min(1600, Math.round(width)) : 0
  }
}
