import { readFile } from 'fs/promises'
import { ipcMain } from '../native/platform'
import type { PropEditResult, StyleEdit, StyleEditResult } from '../shared/api'
import { projectRelative } from '../shared/project-path'
import { STYLE_PROPS as STYLE_PROP_LIST } from '../shared/style-props'
import { mergeStyleObjectSource } from './inline-style'
import { renderJsxAttribute } from './jsx-attribute-literals'
import { classNameStringNode, commitEdit, findElementAtLine, resolveSource } from './props'
import { applyClassRule, resolveClassRule } from './style-class-rule'
import { type ResolvedTokenRef, resolveTokenRef, tokenClassRewrite } from './style-tokens'
import { applyStyleEditSvelte } from './styles-svelte'
import { looksTailwind } from './tw-styles'

/**
 * The Styles-panel commit engine (v10). A scrub previews live via CSS injection
 * in the preview preload; on release the island sends `styles:apply` and this
 * module writes the change into source, Tailwind-first:
 *
 *  - S1 tailwind — the element's live classes look like utilities AND its
 *    `className` is a literal string → rewrite the single family-matching class
 *    (`p-4` → `p-[13px]`) and splice the new string.
 *  - S2 inline — no/ambiguous utility path → merge into an EXISTING JSX
 *    `style={{…}}` literal. Trezi never ADDS a style attribute that wasn't
 *    there: a project styling from a stylesheet/CSS module shouldn't silently
 *    grow inline styles because someone scrubbed a value, so an absent
 *    attribute is S3's problem, not something to invent a convention for.
 *  - S3 agent — anything we can't prove safe OR in-convention (no element at
 *    the stamp, dynamic className with no inline path, no `style` attribute to
 *    extend, `style={expr}`, spread, existing inline `transition` shorthand
 *    when editing a `transition-*` longhand) → hand back `needsAgent` + a ready
 *    prompt, like prop editing.
 *
 * `.svelte` stamps dispatch to the Svelte adapter (styles-svelte.ts), same as
 * props.ts does. Every write goes through `commitEdit`, so HMR + undo are free;
 * the key coalesces a scrub burst into one undo step.
 */

/**
 * The fixed v1 editable property set — the canonical list now lives in
 * `shared/style-props.ts` (both main and the renderer's `css-values.ts`
 * `STYLE_PROP_META` table derive from it, so the two can't drift apart by
 * hand again). Anything else is rejected before any file is read.
 */
export const STYLE_PROPS: ReadonlySet<string> = new Set(STYLE_PROP_LIST)

/**
 * A css value we're willing to splice into source: non-empty, bounded, and free
 * of `;` `}` `"` and newlines OUTSIDE function parens — those could terminate a
 * declaration, escape a style object, or break attribute quoting. Inside parens
 * (`cubic-bezier(…)`, `var(…)`) commas and dots are business as usual.
 */
export function isSafeStyleValue(value: string, maxLength = 200): boolean {
  if (!value.trim() || value.length > maxLength) return false
  let depth = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) return false
      depth--
    } else if (depth === 0 && (ch === ';' || ch === '}' || ch === '"' || ch === '\n')) {
      return false
    }
  }
  return depth === 0
}

/**
 * The S3 seed. The closing convention sentence is load-bearing: S2 now refuses
 * to CREATE a `style` attribute, so most of what lands here is "this element
 * has nowhere obvious to put a declaration." Without being told, the agent
 * reaches for the inline prop anyway — re-introducing exactly what the ladder
 * just declined to write.
 */
export function styleAgentPrompt(
  edit: StyleEdit,
  root: string,
  element?: string,
  token?: ResolvedTokenRef | null
): string {
  const el = element ? `<${element}> element` : 'selected element'
  const what = token
    ? `the design token \`${token.name}\` (\`${token.ref}\`, currently \`${edit.value}\`), ` +
      `using the project's token reference rather than the literal value`
    : `\`${edit.value}\``
  // The authored text does double duty: it tells the agent to keep the
  // project's unit (a px scrub target on a rem-authored declaration should
  // land as rem), and it's a greppable needle for FINDING the declaration.
  const unit =
    edit.authored && !token
      ? ` It is currently authored as \`${edit.authored}\` — keep the project's unit and ` +
        'idiom, converting the target value if needed.'
      : ''
  return (
    `In ${projectRelative(edit.source, root)}, set the css property \`${edit.prop}\` of the ${el} to ${what}.${unit} ` +
    'Style it the way this project already styles things — a stylesheet, CSS module, ' +
    'styled-component or utility class — and do NOT add an inline `style` prop unless ' +
    'the element already has one.'
  )
}

/** Map a commitEdit result into a StyleEditResult carrying the strategy used. */
function committed(
  res: PropEditResult,
  strategy: 'tailwind' | 'inline',
  wroteToken = false
): StyleEditResult {
  return res.applied
    ? { applied: true, strategy, wroteToken }
    : { applied: false, error: res.error }
}

/** The static key name of a style object entry (null for computed/spread/etc). */
function styleObjectKey(p: { type: string; [k: string]: unknown }): string | null {
  if (p.type !== 'ObjectProperty' || p.computed) return null
  const k = p.key as { type?: string; name?: string; value?: string } | undefined
  if (k?.type === 'Identifier') return k.name ?? null
  if (k?.type === 'StringLiteral') return k.value ?? null
  return null
}

/**
 * Apply a style edit from the island's Styles tab. Dispatches by the stamped
 * file's extension (`.svelte` → styles-svelte.ts), then walks the S1 → S2 → S3
 * strategy ladder above. Commit key `${source}:style:${prop}` keeps one undo
 * step per scrubbed property.
 */
export async function applyStyleEdit(root: string, edit: StyleEdit): Promise<StyleEditResult> {
  if (!STYLE_PROPS.has(edit.prop)) {
    return { applied: false, error: 'Unsupported style property.' }
  }
  if (
    typeof edit.value !== 'string' ||
    !isSafeStyleValue(edit.value, edit.prop === 'box-shadow' ? 1024 : 200)
  ) {
    return { applied: false, error: 'Invalid style value.' }
  }
  const loc = resolveSource(root, edit.source)
  if (!loc) return { applied: false, error: 'Could not resolve the source location.' }
  // Normalize the island-supplied fields BEFORE any dispatch — both engines
  // read them, and the IPC boundary doesn't guarantee their shape. `group` is
  // an opaque undo-batch label, so a bound + type check is all it needs.
  edit = {
    ...edit,
    classes: Array.isArray(edit.classes) ? edit.classes : [],
    group: typeof edit.group === 'string' && edit.group ? edit.group.slice(0, 120) : undefined,
    // Prompt-context only, never spliced — but it lands inside backticks in
    // the prompt, so it gets the same splice-safety gate as a value anyway.
    authored:
      typeof edit.authored === 'string' && edit.authored.trim() && isSafeStyleValue(edit.authored)
        ? edit.authored.slice(0, 120)
        : undefined
  }
  // Resolve a token pick BEFORE the framework dispatch, so both engines get the
  // same already-validated reference. The token's value comes from the repo's
  // own (semi-trusted) theme file, so the reference goes through the same
  // splice guard as any other value; failing it drops back to a plain edit.
  let token: ResolvedTokenRef | null = await resolveTokenRef(root, edit)
  if (token && !isSafeStyleValue(token.ref)) token = null
  if (loc.file.endsWith('.svelte')) return applyStyleEditSvelte(root, edit, loc, token)
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const found = await findElementAtLine(code, loc.line, loc.column)
  const toAgent = (): StyleEditResult => ({
    applied: false,
    needsAgent: true,
    agentPrompt: styleAgentPrompt(edit, root, found?.name, token)
  })
  if (!found) return toAgent() // stale stamp — the agent can still find it
  // An element-level spread could carry className/style at runtime — the final
  // attributes are unknowable, so neither a class rewrite nor an inserted style
  // attr is provably effective (same gate as the Svelte adapter).
  if ((found.opening.attributes ?? []).some((a) => a.type === 'JSXSpreadAttribute')) {
    return toAgent()
  }
  const key = `${edit.source}:style:${edit.prop}`
  const classes = edit.classes

  // S1 — Tailwind class rewrite: live classes look like utilities AND the
  // className is a literal string (same gate as the T2 token swap in props.ts).
  // An ambiguous rewrite (>1 family match) returns null → inline path.
  if (looksTailwind(classes)) {
    const classAttr = (found.opening.attributes ?? []).find(
      (a) => a.type === 'JSXAttribute' && (a.name as { name?: string })?.name === 'className'
    )
    const strNode = classNameStringNode(classAttr?.value ?? null)
    if (strNode) {
      const current = String((strNode as unknown as { value: string }).value)
      const rewritten = tokenClassRewrite(current, edit, token)
      if (rewritten != null) {
        const next =
          code.slice(0, strNode.start) +
          (classAttr?.value?.type === 'StringLiteral'
            ? renderJsxAttribute(rewritten, code[strNode.start])
            : JSON.stringify(rewritten)) +
          code.slice(strNode.end)
        return committed(
          await commitEdit(root, loc.file, code, next, key, edit.group),
          'tailwind',
          token != null
        )
      }
    }
  }

  // S2 — merge into an EXISTING inline style object. With a resolved token this
  // writes the REFERENCE (`var(--color-text)`) rather than what it resolves to.
  const written = token?.ref ?? edit.value
  const styleAttr = (found.opening.attributes ?? []).find(
    (a) => a.type === 'JSXAttribute' && (a.name as { name?: string })?.name === 'style'
  )
  // Nothing to extend. Adding `style={{…}}` here would be Trezi choosing a
  // styling convention on the project's behalf — the one thing a design tool
  // editing someone else's repo must not do. The agent gets it instead, and its
  // prompt explicitly forbids reaching for the inline prop.
  if (!styleAttr) return toAgent()
  const attrVal = styleAttr.value
  const expr = attrVal?.type === 'JSXExpressionContainer' ? attrVal.expression : undefined
  if (expr?.type === 'ObjectExpression') {
    // Editing a transition longhand while the object carries the `transition`
    // SHORTHAND: merging the longhand would silently lose to (or fight) the
    // shorthand at runtime — untangling it is the agent's job.
    const entries = (expr as { properties?: Array<{ type: string; [k: string]: unknown }> })
      .properties
    if (
      edit.prop.startsWith('transition-') &&
      (entries ?? []).some((p) => styleObjectKey(p) === 'transition')
    ) {
      return toAgent()
    }
    const merged = mergeStyleObjectSource(code.slice(expr.start, expr.end), edit.prop, written)
    if (merged != null) {
      const next = code.slice(0, expr.start) + merged + code.slice(expr.end)
      return committed(
        await commitEdit(root, loc.file, code, next, key, edit.group),
        'inline',
        token != null
      )
    }
  }

  // S3 — style={expr}, a spread/non-literal entry inside the object (merge
  // returned null), or a string-valued style attr (invalid JSX anyway).
  return toAgent()
}

export function registerStylesIpc(): void {
  // No sender check (matches props:*); path safety comes from resolveSource's
  // within-root containment + the allowlist/value validation above.
  ipcMain.handle('styles:apply', (_e, root: string, edit: StyleEdit) => applyStyleEdit(root, edit))
  ipcMain.handle('styles:resolve-class', (_e, root: string, classes: string[]) =>
    resolveClassRule(root, classes)
  )
  ipcMain.handle('styles:apply-class', (_e, root: string, edit: StyleEdit) =>
    applyClassRule(root, edit.classes, edit.prop, edit.value, edit.group)
  )
}
