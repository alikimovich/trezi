/**
 * The `preview_evaluate` runtime (LKM-138). Main serializes this function with
 * `toString()` and runs it in the dedicated TreziAgent content world, which has no
 * Trezi message handler and no page globals. It must stay self-contained: no
 * imports, no module-scope references.
 *
 * Read-only by construction: the agent expression only ever sees a membrane.
 * - Its scope is a proxy: safe JS builtins raw, `eval`/`Function`/storage denied,
 *   everything else read from the real window and wrapped.
 * - Wrapped objects reject set/define/delete/setPrototypeOf; wrapped functions run
 *   only from an identity allowlist of read-only DOM calls (querySelector,
 *   getComputedStyle, getBoundingClientRect, …). Navigation, storage and DOM
 *   writes are therefore unreachable.
 * - The world's JS intrinsics are frozen and the Function constructors neutered on
 *   first use, so no call can compile code outside the membrane or poison a later one.
 * - The result goes through a bounded serializer and is rejected over `maxBytes`;
 *   async work is raced against `timeMs`, and slow synchronous work is rejected.
 */
// biome-ignore lint/suspicious/noExplicitAny: crosses into an untyped JS world
type Any = any

export async function agentEvaluateRuntime(
  run: (scope: object, self: object) => Promise<unknown>,
  limits: { timeMs: number; maxBytes: number }
): Promise<
  | { ok: true; type: string; value: unknown; bytes: number; ms: number }
  | { ok: false; error: string }
> {
  // biome-ignore lint/suspicious/noRedundantUseStrict: serialized with toString() and run as a classic script
  'use strict'
  const G: Any = globalThis
  const STATE = '__treziAgentRuntime'
  const started = Date.now()
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
  const fail = (error: unknown) => ({
    ok: false as const,
    error: clip(String((error && (error as Any).message) || error), 1000)
  })

  // One-time lockdown of this world's realm (a navigation creates a new realm).
  if (!Object.hasOwn(G, STATE)) {
    const intrinsics = new Set<unknown>()
    const visit = (value: unknown) => {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
      if (intrinsics.has(value)) return
      intrinsics.add(value)
      visit(Object.getPrototypeOf(value))
      for (const key of Reflect.ownKeys(value as object)) {
        const desc = Reflect.getOwnPropertyDescriptor(value as object, key)
        if (!desc) continue
        if ('value' in desc) visit(desc.value)
        else {
          visit(desc.get)
          visit(desc.set)
        }
      }
    }
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor
    const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor
    const safe: Record<string, unknown> = Object.create(null)
    for (const name of [
      'Object',
      'Array',
      'String',
      'Number',
      'Boolean',
      'Symbol',
      'BigInt',
      'Math',
      'JSON',
      'Reflect',
      'Promise',
      'Map',
      'Set',
      'WeakMap',
      'WeakSet',
      'Date',
      'RegExp',
      'Error',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'ReferenceError',
      'EvalError',
      'URIError',
      'AggregateError',
      'ArrayBuffer',
      'DataView',
      'Int8Array',
      'Uint8Array',
      'Uint8ClampedArray',
      'Int16Array',
      'Uint16Array',
      'Int32Array',
      'Uint32Array',
      'Float32Array',
      'Float64Array',
      'BigInt64Array',
      'BigUint64Array',
      'Intl',
      'parseInt',
      'parseFloat',
      'isNaN',
      'isFinite',
      'encodeURIComponent',
      'decodeURIComponent',
      'encodeURI',
      'decodeURI',
      'URL',
      'URLSearchParams',
      'NaN',
      'Infinity',
      'undefined'
    ])
      if (name in G) safe[name] = G[name]
    for (const value of Object.values(safe)) visit(value)
    for (const value of [
      AsyncFunction,
      GeneratorFunction,
      AsyncGeneratorFunction,
      Function,
      [][Symbol.iterator]()
    ])
      visit(value)
    const denied = () => {
      throw new TypeError('Compiling code is not available in preview_evaluate')
    }
    for (const ctor of [Function, AsyncFunction, GeneratorFunction, AsyncGeneratorFunction])
      Object.defineProperty(ctor.prototype, 'constructor', {
        value: denied,
        writable: false,
        configurable: false
      })
    intrinsics.add(denied)
    for (const value of intrinsics) Object.freeze(value)
    Object.defineProperty(G, STATE, {
      value: Object.freeze({
        intrinsics,
        safe: Object.freeze(safe),
        setTimeout: G.setTimeout,
        clearTimeout: G.clearTimeout
      }),
      enumerable: false
    })
  }
  const state = G[STATE]
  const intrinsics: Set<unknown> = state.intrinsics

  // The read-only call allowlist, by function identity in this world.
  const calls = new Set<unknown>()
  const own = (target: unknown, names: string[]) => {
    for (let proto = target; proto; proto = Object.getPrototypeOf(proto))
      for (const name of names) {
        const desc = Reflect.getOwnPropertyDescriptor(proto as object, name)
        if (desc && typeof desc.value === 'function') calls.add(desc.value)
      }
  }
  const iface = (name: string, names: (string | symbol)[]) => {
    const proto = G[name]?.prototype
    if (!proto) return
    for (const key of names) {
      const desc = Reflect.getOwnPropertyDescriptor(proto, key)
      if (desc && typeof desc.value === 'function') calls.add(desc.value)
    }
  }
  const query = [
    'querySelector',
    'querySelectorAll',
    'getElementById',
    'getElementsByClassName',
    'getElementsByTagName'
  ]
  const iterate = ['item', 'namedItem', 'forEach', 'entries', 'keys', 'values', Symbol.iterator]
  iface('Document', [
    ...query,
    'getElementsByName',
    'elementFromPoint',
    'elementsFromPoint',
    'hasFocus'
  ])
  iface('DocumentFragment', query)
  iface('ShadowRoot', ['elementFromPoint', 'elementsFromPoint'])
  iface('Element', [
    ...query,
    'getAttribute',
    'getAttributeNS',
    'getAttributeNames',
    'hasAttribute',
    'hasAttributes',
    'getBoundingClientRect',
    'getClientRects',
    'closest',
    'matches',
    'webkitMatchesSelector',
    'checkVisibility',
    'getAnimations'
  ])
  iface('Node', [
    'contains',
    'compareDocumentPosition',
    'hasChildNodes',
    'getRootNode',
    'isEqualNode',
    'isSameNode'
  ])
  iface('SVGGraphicsElement', ['getBBox'])
  for (const name of [
    'NodeList',
    'HTMLCollection',
    'DOMTokenList',
    'DOMRectList',
    'CSSRuleList',
    'StyleSheetList',
    'NamedNodeMap'
  ])
    iface(name, iterate)
  iface('DOMTokenList', ['contains'])
  iface('CSSStyleDeclaration', ['getPropertyValue', 'getPropertyPriority', 'item'])
  iface('DOMRectReadOnly', ['toJSON'])
  iface('DOMRect', ['toJSON'])
  iface('MediaQueryList', [])
  own(G, ['getComputedStyle', 'matchMedia'])
  if (G.CSS)
    for (const name of ['supports', 'escape'])
      if (typeof G.CSS[name] === 'function') calls.add(G.CSS[name])
  try {
    for (const list of [document.childNodes, document.documentElement.classList])
      calls.add(Object.getPrototypeOf(list.values()).next)
  } catch {}

  // The membrane.
  const DENY = new Set([
    STATE,
    'eval',
    'Function',
    'Proxy',
    'cookie',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'caches',
    'opener',
    'webkit'
  ])
  const readOnly = () => new TypeError('preview_evaluate is read-only: the page cannot be changed')
  const toProxy = new WeakMap<object, object>()
  const toReal = new WeakMap<object, object>()
  const unwrap = (value: unknown) =>
    (value !== null && typeof value === 'object') || typeof value === 'function'
      ? (toReal.get(value as object) ?? value)
      : value
  const callback = (fn: Any) =>
    function (this: unknown, ...args: unknown[]) {
      return unwrap(Reflect.apply(fn, wrap(this), args.map(wrap)))
    }
  const wrap = (value: unknown): unknown => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
    if (toReal.has(value as object) || intrinsics.has(value)) return value
    if (value instanceof Promise) return value.then(wrap)
    if (Array.isArray(value)) return value.map(wrap)
    const known = toProxy.get(value as object)
    if (known) return known
    const real = value as Any
    const shadow = typeof value === 'function' ? () => {} : {}
    const proxy = new Proxy(shadow, {
      get(_, key) {
        if (DENY.has(key as string))
          throw new TypeError(`${String(key)} is not available in preview_evaluate`)
        return wrap(Reflect.get(real, key, real))
      },
      has: (_, key) => !DENY.has(key as string) && Reflect.has(real, key),
      ownKeys: () => Reflect.ownKeys(real).filter((key) => !DENY.has(key as string)),
      getOwnPropertyDescriptor(_, key) {
        const desc = DENY.has(key as string)
          ? undefined
          : Reflect.getOwnPropertyDescriptor(real, key)
        if (!desc) return undefined
        if ('value' in desc) desc.value = wrap(desc.value)
        else {
          desc.get = wrap(desc.get) as Any
          desc.set = wrap(desc.set) as Any
        }
        desc.configurable = true
        return desc
      },
      getPrototypeOf: () => wrap(Reflect.getPrototypeOf(real)) as object | null,
      set: () => {
        throw readOnly()
      },
      defineProperty: () => {
        throw readOnly()
      },
      deleteProperty: () => {
        throw readOnly()
      },
      setPrototypeOf: () => {
        throw readOnly()
      },
      preventExtensions: () => {
        throw readOnly()
      },
      apply(_, self, args) {
        if (!calls.has(real))
          throw new TypeError(
            `${real.name || 'This function'}() is not a read-only call and cannot run in preview_evaluate`
          )
        return wrap(
          Reflect.apply(
            real,
            unwrap(self),
            args.map((arg) =>
              typeof arg === 'function' && !toReal.has(arg) ? callback(arg) : unwrap(arg)
            )
          )
        )
      },
      construct: () => {
        throw readOnly()
      }
    })
    toProxy.set(real, proxy)
    toReal.set(proxy, real)
    return proxy
  }
  const self = wrap(G) as object
  const scope = new Proxy(Object.create(null), {
    has: () => true,
    get(_, key) {
      if (key === Symbol.unscopables || typeof key !== 'string') return undefined
      if (key in state.safe) return state.safe[key]
      if (key === 'globalThis' || key === 'window' || key === 'self') return self
      if (DENY.has(key)) throw new ReferenceError(`${key} is not available in preview_evaluate`)
      return wrap(Reflect.get(G, key, G))
    },
    set: () => {
      throw readOnly()
    },
    defineProperty: () => {
      throw readOnly()
    },
    deleteProperty: () => {
      throw readOnly()
    }
  })
  toReal.set(scope, G)

  // Bounded, page-object-free JSON.
  const describe = (el: Any) => {
    const id = el.id ? `#${el.id}` : ''
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}`
        : ''
    const source = el.getAttribute('data-trezi-source')
    return clip(`<${el.tagName.toLowerCase()}${id}${cls}>${source ? ` @ ${source}` : ''}`, 240)
  }
  const MAX_ITEMS = 100
  const serialize = (input: unknown, depth: number, seen: Set<unknown>): unknown => {
    const value = unwrap(input) as Any
    if (typeof value === 'string') return clip(value, 4000)
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
    if (typeof value === 'boolean' || value === null) return value
    if (value === undefined) return null
    if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
    if (seen.has(value)) return '[Circular]'
    if (value === G) return '[Window]'
    if (G.Node && value instanceof G.Node) {
      if (value.nodeType === 1) return describe(value)
      if (value.nodeType === 3) return `#text ${JSON.stringify(clip(value.data, 200))}`
      if (value.nodeType === 9) return `#document ${value.URL}`
      return `#${value.nodeName}`
    }
    if (depth > 6) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]'
    seen.add(value)
    try {
      const list = (items: unknown[], total: number) => {
        const out = items.slice(0, MAX_ITEMS).map((item) => serialize(item, depth + 1, seen))
        if (total > MAX_ITEMS) out.push(`… ${total - MAX_ITEMS} more`)
        return out
      }
      if (G.DOMRectReadOnly && value instanceof G.DOMRectReadOnly) {
        const { x, y, width, height, top, right, bottom, left } = value
        return { x, y, width, height, top, right, bottom, left }
      }
      if (G.CSSStyleDeclaration && value instanceof G.CSSStyleDeclaration) {
        const out: Record<string, string> = {}
        for (let i = 0; i < Math.min(value.length, MAX_ITEMS); i++)
          out[value[i]] = clip(value.getPropertyValue(value[i]), 400)
        if (value.length > MAX_ITEMS)
          out['…'] =
            `${value.length - MAX_ITEMS} more properties; read specific ones with getPropertyValue`
        return out
      }
      if (Array.isArray(value)) return list(value, value.length)
      if (value instanceof Map) return list([...value].slice(0, MAX_ITEMS), value.size)
      if (value instanceof Set) return list([...value].slice(0, MAX_ITEMS), value.size)
      if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
      if (value instanceof RegExp) return String(value)
      if (value instanceof Error)
        return { name: value.name, message: clip(String(value.message), 1000) }
      if (typeof value.length === 'number' && typeof value.item === 'function')
        return list(
          Array.from({ length: Math.min(value.length, MAX_ITEMS) }, (_, i) => value.item(i)),
          value.length
        )
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        if (typeof value.toJSON === 'function') return serialize(value.toJSON(), depth + 1, seen)
        return `[object ${Object.prototype.toString.call(value).slice(8, -1)}]`
      }
      const out: Record<string, unknown> = {}
      const keys = Object.keys(value)
      for (const key of keys.slice(0, MAX_ITEMS)) {
        try {
          out[key] = serialize(value[key], depth + 1, seen)
        } catch (error) {
          out[key] = `[Thrown: ${clip(String((error as Any)?.message ?? error), 200)}]`
        }
      }
      if (keys.length > MAX_ITEMS) out['…'] = `${keys.length - MAX_ITEMS} more keys`
      return out
    } finally {
      seen.delete(value)
    }
  }

  let timer: unknown
  try {
    const timeout = new Promise((_, reject) => {
      timer = state.setTimeout.call(
        G,
        () => reject(new Error(`Timed out after ${limits.timeMs} ms`)),
        limits.timeMs
      )
    })
    const value = await Promise.race([run(scope, self), timeout])
    const ms = Date.now() - started
    if (ms > limits.timeMs)
      return fail(`Too slow: took ${ms} ms, over the ${limits.timeMs} ms limit`)
    const raw = unwrap(value)
    const type =
      raw === null
        ? 'null'
        : G.Node && raw instanceof G.Node
          ? 'node'
          : Array.isArray(raw)
            ? 'array'
            : typeof raw
    const serialized = serialize(value, 0, new Set())
    const bytes = JSON.stringify(serialized ?? null).length
    if (bytes > limits.maxBytes)
      return fail(
        `Result too large: ${bytes} bytes, over the ${limits.maxBytes}-byte limit. Return fewer fields or slice arrays.`
      )
    return { ok: true, type, value: serialized, bytes, ms }
  } catch (error) {
    return fail(error)
  } finally {
    state.clearTimeout.call(G, timer)
  }
}
