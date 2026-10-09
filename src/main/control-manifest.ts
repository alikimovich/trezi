/**
 * Custom-control manifest validation + anchor/literal lexing (v10 Custom
 * Controls). PURE — no electron, no fs: everything operates on strings and
 * objects passed in, so the whole surface is bun-unit-testable
 * (test/control-panels.mjs). The manifest is UNTRUSTED agent output:
 * `validateManifest` enforces every structural security rule, and
 * `renderLiteral` is the only path from a value to source text — agent- or
 * renderer-supplied strings are never spliced raw. Filesystem checks (file
 * exists, anchor-once against the live file) live in control-panels.ts.
 */
import type { ControlKind, ControlPanelManifest, ControlParam } from '../shared/api'

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
// Mirrors props.ts's ATTR_NAME_RE (props.ts imports electron, so a pure module
// can't import it without dragging the whole props engine in).
const PROP_NAME_RE = /^[A-Za-z_][\w-]*$/
const KINDS: ControlKind[] = ['number', 'color', 'select', 'toggle', 'text', 'bezier']
// The Styles engine's fixed v1 longhand allowlist (plan "v1 property set").
const STYLE_PROPS = new Set([
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
  'color',
  'background-color',
  'border-radius',
  'box-shadow',
  'opacity',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'transition-property',
  'transition-duration',
  'transition-delay',
  'transition-timing-function'
])
const MAX_PARAMS = 12
const MAX_PANELS = 20
const MAX_LABEL = 80
const MAX_MANIFEST_BYTES = 32 * 1024
const MAX_STRING_VALUE = 500
const ANCHOR_MIN = 4
const ANCHOR_MAX = 200

const isStr = (v: unknown): v is string => typeof v === 'string'
const isFin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Repo-relative and traversal-free: no leading '/', no '..' segments, no backslashes. */
function isSafeRelativeFile(file: string): boolean {
  if (!file || file.includes('\\') || file.startsWith('/')) return false
  return file.split('/').every((seg) => seg !== '' && seg !== '..')
}

function validateParam(p: unknown, seen: Set<string>): { param: ControlParam } | { error: string } {
  if (typeof p !== 'object' || p == null || Array.isArray(p))
    return { error: 'param must be an object' }
  const q = p as Record<string, unknown>
  if (!isStr(q.id) || !ID_RE.test(q.id)) return { error: `bad param id: ${JSON.stringify(q.id)}` }
  if (seen.has(q.id)) return { error: `duplicate param id: ${q.id}` }
  seen.add(q.id)
  const where = `param '${q.id}'`
  if (!isStr(q.label) || !q.label.trim() || q.label.length > MAX_LABEL)
    return { error: `${where}: label must be 1-${MAX_LABEL} chars` }
  if (!isStr(q.kind) || !KINDS.includes(q.kind as ControlKind))
    return { error: `${where}: unknown kind ${JSON.stringify(q.kind)}` }
  const kind = q.kind as ControlKind
  // Numeric metadata only makes sense on 'number' — reject elsewhere (untrusted input: strict).
  for (const k of ['unit', 'min', 'max', 'step'] as const) {
    if (q[k] !== undefined && kind !== 'number')
      return { error: `${where}: '${k}' only allowed for kind 'number'` }
  }
  if (q.unit !== undefined && (!isStr(q.unit) || q.unit.length > 16))
    return { error: `${where}: bad unit` }
  for (const k of ['min', 'max', 'step'] as const) {
    if (q[k] !== undefined && !isFin(q[k]))
      return { error: `${where}: '${k}' must be a finite number` }
  }
  if (isFin(q.min) && isFin(q.max) && q.min > q.max) return { error: `${where}: min > max` }
  if (isFin(q.step) && q.step <= 0) return { error: `${where}: step must be > 0` }
  if (kind === 'select') {
    if (!Array.isArray(q.options) || q.options.length === 0 || q.options.length > 20)
      return { error: `${where}: kind 'select' requires 1-20 options` }
    if (!q.options.every((o) => isStr(o) && o.length > 0 && o.length <= MAX_LABEL))
      return { error: `${where}: options must be 1-${MAX_LABEL} char strings` }
    // '<'/'>' are refused in rendered string values (see renderLiteral) — an
    // option that could never apply must not be registered in the first place.
    if (q.options.some((o) => /[<>]/.test(o as string)))
      return { error: `${where}: options must not contain '<' or '>'` }
  } else if (q.options !== undefined) {
    return { error: `${where}: 'options' only allowed for kind 'select'` }
  }
  const a = q.apply as Record<string, unknown> | null
  if (typeof a !== 'object' || a == null) return { error: `${where}: missing apply` }
  let apply: ControlParam['apply']
  if (a.strategy === 'prop') {
    if (!isStr(a.propName) || !PROP_NAME_RE.test(a.propName))
      return { error: `${where}: bad propName` }
    apply = { strategy: 'prop', propName: a.propName }
  } else if (a.strategy === 'style') {
    if (!isStr(a.styleProp) || !STYLE_PROPS.has(a.styleProp))
      return { error: `${where}: styleProp not in the v1 allowlist` }
    apply = { strategy: 'style', styleProp: a.styleProp }
  } else if (a.strategy === 'literal') {
    if (
      !isStr(a.anchor) ||
      !a.anchor.trim() ||
      a.anchor.length < ANCHOR_MIN ||
      a.anchor.length > ANCHOR_MAX
    )
      return {
        error: `${where}: anchor must be ${ANCHOR_MIN}-${ANCHOR_MAX} chars, non-empty after trim`
      }
    apply = { strategy: 'literal', anchor: a.anchor }
  } else {
    return { error: `${where}: unknown apply strategy` }
  }
  // Rebuild with known fields only — never return the untrusted object itself.
  const param: ControlParam = { id: q.id, label: q.label, kind, apply }
  if (isStr(q.unit)) param.unit = q.unit
  if (isFin(q.min)) param.min = q.min
  if (isFin(q.max)) param.max = q.max
  if (isFin(q.step)) param.step = q.step
  if (kind === 'select') param.options = (q.options as string[]).slice()
  return { param }
}

/**
 * Structurally validate an untrusted manifest (agent tool output). Every rule
 * that doesn't need fs: shape, ids, caps, path safety, kind/strategy
 * compatibility. Returns a freshly-built manifest (known fields only) or
 * `{ error }` describing the first failure.
 */
export function validateManifest(input: unknown): ControlPanelManifest | { error: string } {
  if (typeof input !== 'object' || input == null || Array.isArray(input))
    return { error: 'manifest must be an object' }
  let json: string | undefined
  try {
    json = JSON.stringify(input) // undefined when a toJSON returns undefined
  } catch {
    return { error: 'manifest is not serializable' }
  }
  if (json == null || Buffer.byteLength(json, 'utf8') > MAX_MANIFEST_BYTES)
    return { error: `manifest exceeds ${MAX_MANIFEST_BYTES / 1024}KB` }
  const m = input as Record<string, unknown>
  if (!isStr(m.id) || !ID_RE.test(m.id)) return { error: 'bad manifest id' }
  if (!isStr(m.file) || !isSafeRelativeFile(m.file))
    return { error: 'file must be repo-relative (no leading /, no .., no backslashes)' }
  if (!isStr(m.component) || !m.component.trim() || m.component.length > MAX_LABEL)
    return { error: `component must be 1-${MAX_LABEL} chars` }
  if (!isStr(m.title) || !m.title.trim() || m.title.length > MAX_LABEL)
    return { error: `title must be 1-${MAX_LABEL} chars` }
  if (!isStr(m.createdAt) || !m.createdAt.trim()) return { error: 'missing createdAt' }
  if (!Array.isArray(m.params) || m.params.length === 0 || m.params.length > MAX_PARAMS)
    return { error: `params must have 1-${MAX_PARAMS} entries` }
  if (m.presentation !== undefined && m.presentation !== 'animation')
    return { error: 'unknown presentation' }
  if (m.replay !== undefined && (typeof m.replay !== 'boolean' || m.presentation !== 'animation'))
    return { error: 'replay is only supported for animation panels' }
  const seen = new Set<string>()
  const params: ControlParam[] = []
  for (const raw of m.params) {
    const r = validateParam(raw, seen)
    if ('error' in r) return r
    if (m.presentation === 'animation' && r.param.apply.strategy !== 'literal')
      return { error: 'animation panels require literal controls independent of selection' }
    params.push(r.param)
  }
  return {
    id: m.id,
    file: m.file,
    component: m.component,
    title: m.title,
    params,
    createdAt: m.createdAt,
    ...(m.presentation === 'animation'
      ? { presentation: 'animation' as const, replay: m.replay === true }
      : {})
  }
}

/**
 * Upsert `manifest` into `panels` by (file, component): a regenerate REPLACES
 * the existing panel for the same component in place — never duplicates. New
 * panels append, capped at 20 per repo. Pure — returns a new array (or
 * `{ error }` at the cap); control-panels.ts persists the result.
 */
export function upsertPanel(
  panels: ControlPanelManifest[],
  manifest: ControlPanelManifest
): ControlPanelManifest[] | { error: string } {
  const at = panels.findIndex((p) => p.file === manifest.file && p.component === manifest.component)
  // Store-wide id uniqueness: applyLiteral and removePanel key on id ALONE, so
  // an id shared with a different (file, component) panel would mis-route an
  // edit to the wrong file or delete both panels on remove.
  if (panels.some((p, i) => i !== at && p.id === manifest.id))
    return { error: `panel id '${manifest.id}' is already used by another panel` }
  if (at !== -1) {
    const next = panels.slice()
    next[at] = manifest
    return next
  }
  if (panels.length >= MAX_PANELS) return { error: `panel cap reached (${MAX_PANELS} per repo)` }
  return [...panels, manifest]
}

/**
 * Partition raw store entries (untrusted disk JSON) into loadable panels and
 * preserved entries. Loadable = validates, id unique so far, under the panel
 * cap — first occurrence wins. Everything else is PRESERVED verbatim: it stays
 * out of resolution, but control-panels.ts writes it back on every store
 * mutation, so a hand-edit typo (the file is user-editable) or a field from a
 * newer app version can't be permanently erased by an unrelated save.
 */
export function partitionStoreEntries(raw: unknown[]): {
  panels: ControlPanelManifest[]
  preserved: unknown[]
} {
  const panels: ControlPanelManifest[] = []
  const preserved: unknown[] = []
  const ids = new Set<string>()
  for (const entry of raw) {
    const v = validateManifest(entry)
    if ('error' in v || ids.has(v.id) || panels.length >= MAX_PANELS) {
      preserved.push(entry)
    } else {
      ids.add(v.id)
      panels.push(v)
    }
  }
  return { panels, preserved }
}

/**
 * Find the anchor in `code`. The anchor must occur EXACTLY once — a missing
 * anchor means the constant was renamed/removed, an ambiguous one means a
 * splice could land at the wrong site; both refuse. `at` is the offset just
 * after the anchor, where the literal's lexing starts.
 */
export function locateAnchor(
  code: string,
  anchor: string
): { at: number } | { error: 'missing' | 'ambiguous' } {
  const first = code.indexOf(anchor)
  if (first === -1) return { error: 'missing' }
  if (code.indexOf(anchor, first + 1) !== -1) return { error: 'ambiguous' }
  return { at: first + anchor.length }
}

// Decimal JS numbers incl. exponent forms (120, -0.75, .5, 1e3, 1.5E-2). Hex/
// binary/octal (0x10), numeric separators (1_000) and BigInt (4n) are NOT
// lexable: the boundary check in lexLiteral makes them resolve as stale
// instead of truncating to a partial match (a partial-span splice would
// silently corrupt the value — e.g. '250' over the '1' of '1e3' → '250e3').
const NUMBER_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iy
// A literal followed by one of these is a form we only partially matched
// (0x10, 1_000, 4n, trueish) — refuse, per "stale, never a wrong-site splice".
const IDENT_CONT_RE = /[\w$]/
const NUM_CONT_RE = /[\w$.]/
const BEZIER_STR_RE =
  /^cubic-bezier\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)$/

/** Lex a quoted string ('/"/`) at `i`, honoring backslash escapes. */
function lexQuoted(code: string, i: number): { start: number; end: number } | null {
  const quote = code[i]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j]
    if (c === '\\')
      j++ // skip the escaped char
    else if (quote === '`' && c === '$' && code[j + 1] === '{')
      return null // interpolation — can't lex safely
    else if (c === quote) return { start: i, end: j + 1 }
    else if (quote !== '`' && c === '\n') return null // unterminated
  }
  return null
}

/** Lex a 4-number array literal `[a, b, c, d]` at `i`, spanning ≤80 chars. */
function lexBezierArray(code: string, i: number): { start: number; end: number } | null {
  const window = code.slice(i, i + 80)
  const m =
    /^\[\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,?\s*\]/.exec(
      window
    )
  return m ? { start: i, end: i + m[0].length } : null
}

/**
 * Bound the literal of the given kind starting at/after `at` (leading
 * whitespace skipped). Kind-typed: number regex / quoted string / true|false /
 * bezier (4-number array, or a quoted `cubic-bezier(...)` string). Returns the
 * literal's exact span + raw text, or null when the code doesn't match — a
 * mismatch means the source changed shape and the param is stale.
 */
export function lexLiteral(
  code: string,
  at: number,
  kind: ControlKind
): { start: number; end: number; raw: string } | null {
  let i = at
  while (i < code.length && /\s/.test(code[i])) i++
  let span: { start: number; end: number } | null = null
  if (kind === 'number') {
    NUMBER_RE.lastIndex = i
    const m = NUMBER_RE.exec(code)
    if (m && !NUM_CONT_RE.test(code[i + m[0].length] ?? ''))
      span = { start: i, end: i + m[0].length }
  } else if (kind === 'toggle') {
    // Word boundary required — `trueish`/`falseByDefault` are identifiers, not
    // booleans; lexing their prefix would splice mid-identifier.
    if (code.startsWith('true', i) && !IDENT_CONT_RE.test(code[i + 4] ?? ''))
      span = { start: i, end: i + 4 }
    else if (code.startsWith('false', i) && !IDENT_CONT_RE.test(code[i + 5] ?? ''))
      span = { start: i, end: i + 5 }
  } else if (kind === 'bezier') {
    span = lexBezierArray(code, i)
    if (!span) {
      const q = lexQuoted(code, i)
      if (q && BEZIER_STR_RE.test(unquote(code.slice(q.start, q.end)) ?? '')) span = q
    }
  } else {
    // 'text' | 'color' | 'select' — quoted string literals
    span = lexQuoted(code, i)
  }
  return span ? { ...span, raw: code.slice(span.start, span.end) } : null
}

/** Decode a lexed quoted literal back to its JS string value. */
function unquote(raw: string): string | null {
  if (raw.length < 2) return null
  const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' }
  let out = ''
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i]
    if (c === '\\') {
      const next = raw[++i]
      if (next === 'u' || next === 'x') {
        const len = next === 'u' ? 4 : 2
        out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 1 + len), 16) || 0)
        i += len
      } else out += ESC[next] ?? next
    } else out += c
  }
  return out
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const FN_COLOR_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%,\s/-]+\s*\)$/
const VAR_COLOR_RE = /^var\(--[\w-]+\)$/
const isValidColor = (v: string): boolean =>
  HEX_COLOR_RE.test(v) || FN_COLOR_RE.test(v) || VAR_COLOR_RE.test(v)

const fmtNum = (n: number): string => String(Number(n.toFixed(4)))

/**
 * Render a replacement literal for a param — the ONLY path from a value to
 * source text. Numbers are clamped to the param's sanity-checked [min,max];
 * strings go through JSON.stringify (≤500 chars); colors must match a
 * hex/rgb()/hsl()/var() grammar; bezier is exactly 4 finite numbers, rendered
 * in the SAME shape as the existing literal (`bezierShape`: 'array' →
 * `[a, b, c, d]`, 'string' → a quoted `cubic-bezier(...)`; x coords clamped
 * to [0,1] as cubic-bezier requires).
 */
export function renderLiteral(
  kind: ControlKind,
  value: unknown,
  param: ControlParam,
  bezierShape: 'array' | 'string' = 'array'
): string | { error: string } {
  if (kind === 'number') {
    if (!isFin(value)) return { error: 'value must be a finite number' }
    let n = value
    if (isFin(param.min) && (!isFin(param.max) || param.min <= param.max))
      n = Math.max(param.min, n)
    if (isFin(param.max) && (!isFin(param.min) || param.min <= param.max))
      n = Math.min(param.max, n)
    return fmtNum(n)
  }
  if (kind === 'toggle') {
    if (typeof value !== 'boolean') return { error: 'value must be a boolean' }
    return value ? 'true' : 'false'
  }
  if (kind === 'bezier') {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(isFin))
      return { error: 'bezier value must be exactly 4 finite numbers' }
    const [x1, y1, x2, y2] = value as number[]
    const nums = [Math.min(1, Math.max(0, x1)), y1, Math.min(1, Math.max(0, x2)), y2].map(fmtNum)
    return bezierShape === 'string'
      ? JSON.stringify(`cubic-bezier(${nums.join(', ')})`)
      : `[${nums.join(', ')}]`
  }
  // 'text' | 'color' | 'select' — string literals, quote-safe via JSON.stringify
  if (!isStr(value)) return { error: 'value must be a string' }
  if (value.length > MAX_STRING_VALUE)
    return { error: `string value exceeds ${MAX_STRING_VALUE} chars` }
  // JSON.stringify is JS-quote-safe but NOT HTML-context-safe: a '</script>'
  // inside the rendered string terminates an inline <script> when the target is
  // a previewed .html file, turning a spliced value into live markup. Refuse
  // rather than escape — escaping would corrupt the value in non-JS contexts.
  if (/[<>]/.test(value)) return { error: "string values must not contain '<' or '>'" }
  if (kind === 'color' && !isValidColor(value))
    return { error: 'not a valid color (hex/rgb()/hsl()/var())' }
  if (kind === 'select' && !(param.options ?? []).includes(value))
    return { error: 'value not in options' }
  return JSON.stringify(value)
}

/**
 * Read a literal param's CURRENT value from source (locate + lex + parse back)
 * — values are never stored in the manifest, always re-derived. Returns null
 * when the anchor/literal no longer resolves (the caller marks the param
 * `valid: false`). Bezier values normalize to a `cubic-bezier(...)` string
 * whichever shape the source uses.
 */
export function resolveLiteralValue(
  code: string,
  param: ControlParam
): string | number | boolean | null {
  if (param.apply.strategy !== 'literal') return null
  const loc = locateAnchor(code, param.apply.anchor)
  if ('error' in loc) return null
  const lit = lexLiteral(code, loc.at, param.kind)
  if (!lit) return null
  if (param.kind === 'number') return Number(lit.raw)
  if (param.kind === 'toggle') return lit.raw === 'true'
  if (param.kind === 'bezier') {
    const text = lit.raw.startsWith('[')
      ? lit.raw
      : (unquote(lit.raw) ?? '').replace(BEZIER_STR_RE, '[$1,$2,$3,$4]')
    const nums = text.match(/-?\d*\.?\d+/g)?.map(Number)
    if (!nums || nums.length !== 4 || !nums.every(Number.isFinite)) return null
    return `cubic-bezier(${nums.map(fmtNum).join(', ')})`
  }
  return unquote(lit.raw)
}
