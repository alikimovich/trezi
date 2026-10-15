import type { CanvasRecipe, CanvasState } from '../shared/states-canvas'
import type { LocatedComponent } from './states-locate'
import { type PropShape, sampleFor } from './states-schema'

const MAX_STATES = 16
const LOADING = /^(is)?(loading|pending|busy|fetching|submitting|saving)$/i
const ERROR = /^(error|err|errors|errorMessage|failure|failed|hasError|isError|isFailed)$/i
const DISABLED = /^(is)?(disabled|readOnly|locked)$/i
const TEXT = /name|title|label|heading|description|summary/i
const LONG =
  'An unusually long piece of text that keeps going to show how this component wraps, truncates or grows when real content is longer than the design expected'

type Missing = CanvasRecipe['missing'][number]

const humanize = (name: string) => {
  const words = name
    .replace(/^(is|has|show)(?=[A-Z])/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : name
}
const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'state'

/** A shape guessed from a value, for components without prop types. */
export function shapeFromValue(value: unknown, depth = 0): PropShape {
  if (value === null) return { kind: 'unknown', nullable: true }
  if (Array.isArray(value))
    return {
      kind: 'array',
      ...(value.length && depth < 3 ? { item: shapeFromValue(value[0], depth + 1) } : {})
    }
  if (typeof value === 'string') return { kind: 'string' }
  if (typeof value === 'number') return { kind: 'number' }
  if (typeof value === 'boolean') return { kind: 'boolean' }
  if (typeof value === 'object') {
    const tagged = value as Record<string, unknown>
    if ('$fn' in tagged) return { kind: 'function' }
    if ('$node' in tagged) return { kind: 'node' }
    if ('$date' in tagged) return { kind: 'date' }
    if ('$pending' in tagged || '$reject' in tagged) return { kind: 'promise' }
    if (depth >= 3) return { kind: 'unknown' }
    return {
      kind: 'object',
      fields: Object.fromEntries(
        Object.entries(tagged).map(([k, v]) => [k, shapeFromValue(v, depth + 1)])
      )
    }
  }
  return { kind: 'unknown' }
}

/** The props the first state renders with: the live instance's, else typed samples under the
 * literal props written at the call site. */
export function baseProps(located: LocatedComponent, live: Record<string, unknown> | null) {
  if (live) return live
  const out: Record<string, unknown> = {}
  for (const [name, shape] of Object.entries(located.schema ?? {}))
    if (!shape.optional) out[name] = sampleFor(name, shape)
  return { ...out, ...located.callProps }
}

/**
 * Meaningful states from the props a component accepts: the page's own instance first, then
 * loading, empty, error and disabled where a prop expresses them, every value of an enum
 * (nested one level, `project.status`), boolean flags and long text. This is discovery, not a
 * proof: states that hide behind internal state or data loading are listed as missing.
 */
export function proposeStates(
  located: LocatedComponent,
  live: Record<string, unknown> | null
): { states: CanvasState[]; missing: Missing[] } {
  const base = baseProps(located, live)
  const schema =
    located.schema ??
    Object.fromEntries(Object.entries(base).map(([name, value]) => [name, shapeFromValue(value)]))
  const states: CanvasState[] = []
  const seen = new Set<string>()
  const ids = new Set<string>()
  const add = (
    label: string,
    props: Record<string, unknown>,
    origin: CanvasState['origin'],
    note?: string
  ) => {
    const key = JSON.stringify(props)
    if (states.length >= MAX_STATES || seen.has(key) || key.length > 16_384) return
    seen.add(key)
    let id = slug(label)
    for (let n = 2; ids.has(id) || id === 'all'; n++) id = `${slug(label).slice(0, 33)}-${n}`
    ids.add(id)
    states.push({ id, label: label.slice(0, 80), props, origin, ...(note ? { note } : {}) })
  }
  const vary = (name: string, value: unknown) => {
    const next = { ...base }
    if (value === undefined) delete next[name]
    else next[name] = value
    return next
  }
  const nested = (name: string, field: string, value: unknown) => {
    const object = base[name]
    if (!object || typeof object !== 'object' || Array.isArray(object)) return null
    const copy = { ...(object as Record<string, unknown>) }
    if (value === undefined) delete copy[field]
    else copy[field] = value
    return { ...base, [name]: copy }
  }
  add(
    live ? 'As on the page' : 'Default',
    base,
    live ? 'page' : 'discovered',
    live ? undefined : 'Sample data'
  )
  const entries = Object.entries(schema)
  const done = new Set<string>()
  const take = (match: (name: string, shape: PropShape) => boolean) =>
    entries.find(([name, shape]) => !done.has(name) && match(name, shape))
  const loading = take((name, shape) => shape.kind === 'boolean' && LOADING.test(name))
  if (loading) {
    done.add(loading[0])
    add('Loading', vary(loading[0], true), 'discovered')
  }
  const promise = take((_, shape) => shape.kind === 'promise')
  if (promise) {
    add('Loading', vary(promise[0], { $pending: true }), 'discovered')
    add('Failed', vary(promise[0], { $reject: 'Something went wrong. Try again.' }), 'discovered')
  }
  const arrays = entries.filter(([, shape]) => shape.kind === 'array')
  for (const [name] of arrays.slice(0, 2))
    add(
      arrays.length === 1 ? 'Empty' : `No ${humanize(name).toLowerCase()}`,
      vary(name, []),
      'discovered'
    )
  const error = take((name) => ERROR.test(name))
  if (error) {
    const [name, shape] = error
    done.add(name)
    const value =
      shape.kind === 'boolean'
        ? true
        : shape.kind === 'object'
          ? { message: 'Something went wrong. Try again.' }
          : shape.kind === 'array'
            ? ['Something went wrong. Try again.']
            : 'Something went wrong. Try again.'
    add('Error', vary(name, value), 'discovered')
  }
  const disabled = take((name, shape) => shape.kind === 'boolean' && DISABLED.test(name))
  if (disabled) {
    done.add(disabled[0])
    add(humanize(disabled[0]), vary(disabled[0], true), 'discovered')
  }
  for (const [name, shape] of entries) {
    if (shape.kind === 'enum')
      for (const option of (shape.options ?? []).slice(0, 6))
        if (base[name] !== option)
          add(`${humanize(name)}: ${option}`, vary(name, option), 'discovered')
    if (shape.kind !== 'object') continue
    for (const [field, inner] of Object.entries(shape.fields ?? {})) {
      if (inner.kind === 'enum')
        for (const option of (inner.options ?? []).slice(0, 6)) {
          const props = nested(name, field, option)
          if (props && (base[name] as Record<string, unknown>)[field] !== option)
            add(`${humanize(field)}: ${option}`, props, 'discovered')
        }
      if (inner.kind === 'array') {
        const props = nested(name, field, [])
        if (props) add(`No ${humanize(field).toLowerCase()}`, props, 'discovered')
      }
      if (inner.kind === 'boolean') {
        const current = (base[name] as Record<string, unknown> | undefined)?.[field]
        const props = nested(name, field, !current)
        if (props)
          add(
            current ? `Not ${humanize(field).toLowerCase()}` : humanize(field),
            props,
            'discovered'
          )
      }
    }
  }
  for (const [name, shape] of entries) {
    if (done.has(name) || shape.kind !== 'boolean') continue
    add(
      base[name] ? `Not ${humanize(name).toLowerCase()}` : humanize(name),
      vary(name, !base[name]),
      'discovered'
    )
  }
  for (const [name, shape] of entries)
    if ((shape.optional || shape.nullable) && base[name] !== undefined && shape.kind !== 'function')
      add(
        `Without ${humanize(name).toLowerCase()}`,
        vary(name, shape.nullable ? null : undefined),
        'discovered'
      )
  const text =
    entries.find(([name, shape]) => shape.kind === 'string' && TEXT.test(name)) ??
    entries.find(
      ([name, shape]) =>
        shape.kind === 'object' && Object.keys(shape.fields ?? {}).some((f) => TEXT.test(f)) && name
    )
  if (text) {
    const [name, shape] = text
    if (shape.kind === 'string') add('Long text', vary(name, LONG), 'discovered')
    else {
      const field = Object.keys(shape.fields ?? {}).find(
        (f) => TEXT.test(f) && shape.fields?.[f].kind === 'string'
      )
      const props = field ? nested(name, field, LONG) : null
      if (props) add('Long text', props, 'discovered')
    }
  }
  const missing: Missing[] = []
  if (located.internal.state)
    missing.push({
      id: 'interactive',
      label: 'Interactive states',
      note: 'Menus, toggles and other internal state need a recipe with actions. Ask the agent to register one.'
    })
  if (located.internal.data)
    missing.push({
      id: 'data-loading',
      label: 'Data loading',
      note: 'This component loads its own data. A recipe with a provider or fixtures covers its loading and error states.'
    })
  if (!located.schema)
    missing.push({
      id: 'prop-types',
      label: 'Typed props',
      note: 'The props have no types, so states come from the values on the page. Types or a recipe add more.'
    })
  return { states, missing }
}
