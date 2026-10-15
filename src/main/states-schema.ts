import ts from 'typescript'

/** What a prop accepts, as far as discovery needs it to propose states. */
export interface PropShape {
  kind:
    | 'string'
    | 'number'
    | 'boolean'
    | 'enum'
    | 'array'
    | 'object'
    | 'function'
    | 'node'
    | 'date'
    | 'promise'
    | 'unknown'
  optional?: boolean
  nullable?: boolean
  options?: (string | number)[]
  item?: PropShape
  fields?: Record<string, PropShape>
}

const NODE_TYPES = new Set(['ReactNode', 'ReactElement', 'Element', 'JSX.Element', 'ReactChild'])
const MAX_FIELDS = 24

/** The shape of one TypeScript type, `depth` levels into objects and arrays. */
export function shapeOf(checker: ts.TypeChecker, type: ts.Type, at: ts.Node, depth = 0): PropShape {
  const alias = type.aliasSymbol?.name ?? ''
  if (NODE_TYPES.has(alias)) return { kind: 'node' }
  const all = type.isUnion() ? type.types : [type]
  const nullable = all.some((part) => part.flags & ts.TypeFlags.Null)
  const optional = all.some((part) => part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void))
  const parts = all.filter(
    (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void))
  )
  const flags = { ...(nullable ? { nullable } : {}), ...(optional ? { optional } : {}) }
  if (!parts.length) return { kind: 'unknown', ...flags }
  if (parts.every((part) => part.flags & ts.TypeFlags.BooleanLike))
    return { kind: 'boolean', ...flags }
  if (parts.every((part) => part.isStringLiteral() || part.isNumberLiteral()))
    return {
      kind: 'enum',
      options: parts.map((part) => (part as ts.LiteralType).value as string | number),
      ...flags
    }
  // A mixed union (`string | Error`, `Item[] | null`) is shaped by its first useful member.
  const part =
    parts.find((p) => !(p.flags & ts.TypeFlags.BooleanLike) && !p.isStringLiteral()) ?? parts[0]
  const name = part.getSymbol()?.name ?? ''
  if (NODE_TYPES.has(part.aliasSymbol?.name ?? '') || name === 'ReactElement')
    return { kind: 'node', ...flags }
  if (part.flags & ts.TypeFlags.StringLike) return { kind: 'string', ...flags }
  if (part.flags & ts.TypeFlags.NumberLike) return { kind: 'number', ...flags }
  if (name === 'Date') return { kind: 'date', ...flags }
  if (name === 'Promise') return { kind: 'promise', ...flags }
  if (part.getCallSignatures().length) return { kind: 'function', ...flags }
  if (checker.isArrayType(part) || checker.isTupleType(part)) {
    const [item] = checker.getTypeArguments(part as ts.TypeReference)
    return {
      kind: 'array',
      ...(item && depth < 3 ? { item: shapeOf(checker, item, at, depth + 1) } : {}),
      ...flags
    }
  }
  if (part.flags & ts.TypeFlags.Object && depth < 3) {
    const fields: Record<string, PropShape> = {}
    for (const symbol of checker.getPropertiesOfType(part).slice(0, MAX_FIELDS)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(symbol.name)) continue
      const field = shapeOf(checker, checker.getTypeOfSymbolAtLocation(symbol, at), at, depth + 1)
      fields[symbol.name] =
        symbol.flags & ts.SymbolFlags.Optional ? { ...field, optional: true } : field
    }
    return { kind: 'object', fields, ...flags }
  }
  return { kind: 'unknown', ...flags }
}

/** The props schema of a component signature (its first parameter), or null when untyped. */
export function propsSchema(
  checker: ts.TypeChecker,
  signature: ts.Signature | undefined,
  at: ts.Node
): Record<string, PropShape> | null {
  const param = signature?.parameters[0]
  if (!param) return {}
  const type = checker.getTypeOfSymbolAtLocation(param, at)
  if (type.flags & ts.TypeFlags.Any) return null
  const shape = shapeOf(checker, type, at)
  if (shape.kind !== 'object') return null
  const out: Record<string, PropShape> = {}
  for (const [name, field] of Object.entries(shape.fields ?? {}))
    if (name !== 'key' && name !== 'ref') out[name] = field
  return out
}

/** Sample data for a shape: what a required prop gets when the page gave no value. */
export function sampleFor(name: string, shape: PropShape, depth = 0): unknown {
  switch (shape.kind) {
    case 'string':
      return sampleText(name)
    case 'number':
      return /count|total|amount|price/i.test(name) ? 12 : /progress|percent/i.test(name) ? 60 : 3
    case 'boolean':
      return false
    case 'enum':
      return shape.options?.[0] ?? ''
    case 'array':
      return shape.item && depth < 3
        ? [0, 1, 2].map((i) => withIndex(sampleFor(singular(name), shape.item!, depth + 1), i))
        : []
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [key, field] of Object.entries(shape.fields ?? {}))
        if (!field.optional || field.kind === 'string') out[key] = sampleFor(key, field, depth + 1)
      return out
    }
    case 'function':
      return { $fn: name }
    case 'node':
      return { $node: sampleText(name) }
    case 'date':
      return { $date: '2026-03-14T10:00:00.000Z' }
    case 'promise':
      return { $pending: true }
    default:
      return shape.nullable ? null : { $undefined: true }
  }
}

const singular = (name: string) => name.replace(/ies$/, 'y').replace(/s$/, '')

function withIndex(value: unknown, index: number): unknown {
  if (typeof value === 'string') return index ? `${value} ${index + 1}` : value
  if (typeof value === 'number') return value + index
  if (value && typeof value === 'object' && !Array.isArray(value) && !('$fn' in value)) {
    const out = { ...(value as Record<string, unknown>) }
    for (const key of Object.keys(out)) {
      if (/^(id|key)$/i.test(key))
        out[key] = typeof out[key] === 'number' ? index + 1 : `${index + 1}`
      else if (typeof out[key] === 'string' && /name|title|label/i.test(key))
        out[key] = withIndex(out[key], index)
    }
    return out
  }
  return value
}

function sampleText(name: string): string {
  if (/^(id|key)$/i.test(name)) return '1'
  if (/email/i.test(name)) return 'ada@example.com'
  if (/url|href|link/i.test(name)) return '/'
  if (/image|src|avatar|logo|thumbnail|cover/i.test(name))
    return 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22180%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23cbd5e1%22/%3E%3C/svg%3E'
  if (/date|time|at$/i.test(name)) return '2026-03-14'
  if (/color/i.test(name)) return '#4f46e5'
  if (/description|summary|body|text|content|message/i.test(name))
    return 'A short description of this item.'
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Sample'
}
