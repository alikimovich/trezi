import { readFile } from 'fs/promises'
import type { StyleEdit, StyleEditResult } from '../shared/api'
import { projectRelative } from '../shared/project-path'
import { mergeStyleString } from './inline-style'
import { commitEdit, type ResolvedSource } from './props'
import { findElement } from './props-svelte'
import { type ResolvedTokenRef, tokenClassRewrite } from './style-tokens'
import { looksTailwind } from './tw-styles'

/**
 * Svelte adapter for the Styles engine — the `.svelte` counterpart of styles.ts,
 * mirroring the props.ts / props-svelte.ts pairing. Same S1/S2/S3 contract:
 * S1 rewrite a Tailwind utility in a literal `class="…"`, S2 merge into an
 * EXISTING literal `style="…"`, S3 hand anything dynamic (class:/style:
 * directives, spreads, expression attributes) — or any element with no
 * `style` attribute to extend — to the agent. Commits go through the shared
 * commitEdit seam with the same `${source}:style:${prop}` key, so scrub bursts
 * coalesce into one undo step.
 *
 * S2 deliberately never CREATES the attribute. A Svelte component almost always
 * styles its elements from its own scoped `<style>` block, so inserting
 * `style="…"` would both impose a foreign convention and outrank the block it
 * belongs in — silently winning on specificity forever after.
 *
 * svelte/compiler is ESM-only, so it's loaded via dynamic import() like the
 * other ESM engines (Agent SDK, babel, react-docgen).
 */

type SvelteCompiler = typeof import('svelte/compiler')
let sveltePromise: Promise<SvelteCompiler> | null = null
const loadSvelte = (): Promise<SvelteCompiler> => (sveltePromise ??= import('svelte/compiler'))

/** The (unexported) AST node shape props-svelte.ts's findElement speaks. */
type SvelteNode = Parameters<typeof findElement>[0]

async function parseSvelte(code: string): Promise<SvelteNode | null> {
  try {
    const { parse } = await loadSvelte()
    return parse(code, { modern: true }) as unknown as SvelteNode
  } catch {
    return null
  }
}

/** A plain attribute's whole span (`name="…"`) + its literal single-Text value
 *  (null when the value is an expression tag or a `"a {x}"` concatenation). */
interface AttrInfo {
  start: number
  end: number
  literal: string | null
}

function findAttr(el: SvelteNode, name: string): AttrInfo | null {
  for (const attr of el.attributes ?? []) {
    if (attr.type !== 'Attribute' || attr.name !== name) continue
    const start = attr.start ?? 0
    const end = attr.end ?? 0
    const value = attr.value
    if (value === true) return { start, end, literal: '' } // bare attribute
    // `name="x"` → array of Text/ExpressionTag; `name={x}` → single ExpressionTag.
    const single = Array.isArray(value)
      ? value.length === 1
        ? (value[0] as SvelteNode)
        : null
      : value && typeof value === 'object'
        ? (value as SvelteNode)
        : null
    if (single?.type === 'Text') {
      return { start, end, literal: String((single as { data?: string }).data ?? '') }
    }
    return { start, end, literal: null } // dynamic
  }
  return null
}

const hasAttrOfType = (el: SvelteNode, type: string): boolean =>
  (el.attributes ?? []).some((a) => a.type === type)

// Defense in depth for splicing into a quoted attribute: the text must not be
// able to close the quote or the tag. (The IPC layer validates values too.)
const SPLICE_SAFE_RE = /^[^"<>]*$/

/** Does a `style="…"` literal declare the `transition` SHORTHAND? The split is
 *  quote-blind (unlike mergeStyleString's), but that only risks a false
 *  positive on a pathological quoted `;` — which merely routes to the agent. */
const hasTransitionShorthand = (styleValue: string): boolean =>
  styleValue.split(';').some((decl) => {
    const colon = decl.indexOf(':')
    return (colon === -1 ? decl : decl.slice(0, colon)).trim().toLowerCase() === 'transition'
  })

/**
 * The S3 seed. The scoped-`<style>` sentence is load-bearing: a Svelte
 * component usually styles its elements from its own `<style>` block, which
 * neither S1 nor S2 can reach — without saying so, the agent hunts for a class
 * or style attribute that isn't there.
 */
export const styleAgentPrompt = (edit: StyleEdit, root: string, token: ResolvedTokenRef | null): string => {
  const what = token
    ? `to the design token \`${token.name}\` (\`${token.ref}\`, currently \`${edit.value}\`), ` +
      'using the token reference rather than the literal value,'
    : `to \`${edit.value}\``
  // Caller (styles.ts) has already bounded/validated `authored`. Doubles as a
  // greppable needle for finding the declaration (often a global stylesheet,
  // not the component itself).
  const unit = edit.authored && !token
    ? ` It is currently authored as \`${edit.authored}\` — keep the project's unit and ` +
      'idiom, converting the target value if needed.'
    : ''
  return (
    `Set the CSS property \`${edit.prop}\` ${what} on the element at ${projectRelative(edit.source, root)}.${unit}` +
    "Its styles may live in this component's own `<style>` block or a global " +
    'stylesheet rather than a class or style attribute — edit whichever the ' +
    'project already uses, and do NOT add an inline `style` attribute where ' +
    'there is none.'
  )
}

/**
 * Apply a StyleEdit to a `.svelte` file. `resolved` is the stamp's location
 * (from resolveSource); the caller (styles.ts) has already validated the
 * prop/value against the v1 allowlist and re-resolved any design-token pick.
 */
export async function applyStyleEditSvelte(
  root: string,
  edit: StyleEdit,
  resolved: ResolvedSource,
  token: ResolvedTokenRef | null = null
): Promise<StyleEditResult> {
  const toAgent = (): StyleEditResult => ({
    applied: false,
    needsAgent: true,
    agentPrompt: styleAgentPrompt(edit, root, token)
  })
  let code: string
  try {
    code = await readFile(resolved.file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const ast = await parseSvelte(code)
  if (!ast) return toAgent()
  const el = findElement(ast, code, resolved.line, resolved.column)
  if (!el) return toAgent()

  // A spread could carry class/style — the element's final attributes are unknowable.
  if (hasAttrOfType(el, 'SpreadAttribute')) return toAgent()

  const commit = async (next: string, strategy: 'tailwind' | 'inline'): Promise<StyleEditResult> => {
    const key = `${edit.source}:style:${edit.prop}`
    const res = await commitEdit(root, resolved.file, code, next, key, edit.group)
    return res.applied
      ? { applied: true, strategy, wroteToken: token != null }
      : { applied: false, error: res.error }
  }

  // S1 — Tailwind class rewrite on a literal `class="…"`. A class: directive
  // could toggle a same-family utility we can't see, so its presence forfeits
  // the rewrite (the inline path below still works — it wins on specificity).
  const classAttr = findAttr(el, 'class')
  if (looksTailwind(edit.classes) && classAttr?.literal != null && !hasAttrOfType(el, 'ClassDirective')) {
    const rewritten = tokenClassRewrite(classAttr.literal, edit, token)
    if (rewritten != null && SPLICE_SAFE_RE.test(rewritten)) {
      // findAttr spans the WHOLE attribute (`class="…"`) — rewrite it.
      const next = `${code.slice(0, classAttr.start)}class="${rewritten}"${code.slice(classAttr.end)}`
      return commit(next, 'tailwind')
    }
  }

  // S2 — merge into an EXISTING `style="…"`. A style: directive overrides the
  // attribute per-property at runtime, so merging under one would silently not apply.
  if (hasAttrOfType(el, 'StyleDirective')) return toAgent()
  const styleAttr = findAttr(el, 'style')
  // No attribute to extend → the agent (see the header note: creating one here
  // would impose a convention AND outrank the scoped <style> block it belongs in).
  if (!styleAttr) return toAgent()
  if (styleAttr.literal == null) return toAgent() // style={expr} / concat
  // Editing a transition longhand while the literal carries the `transition`
  // SHORTHAND: mergeStyleString replaces an existing longhand IN PLACE, so a
  // later shorthand would silently reset it by cascade order — untangling that
  // is the agent's job (same guard as the JSX path in styles.ts).
  if (edit.prop.startsWith('transition-') && hasTransitionShorthand(styleAttr.literal)) {
    return toAgent()
  }
  // With a resolved token this writes the REFERENCE, not what it resolves to.
  const merged = mergeStyleString(styleAttr.literal, edit.prop, token?.ref ?? edit.value)
  if (!SPLICE_SAFE_RE.test(merged)) return toAgent()
  const next = `${code.slice(0, styleAttr.start)}style="${merged}"${code.slice(styleAttr.end)}`
  return commit(next, 'inline')
}
