/**
 * Style-token provenance — proves whether a property's value comes from a
 * design token, instead of guessing from value coincidence.
 *
 * `getComputedStyle` always fully resolves `var()`, so it cannot distinguish
 * "this element's color IS `var(--color-text)`" from "this element's color
 * happens to be the same hex, coincidentally." Every value-equality match the
 * Styles panel used to make was really the latter — a guess. This module reads
 * the property's SPECIFIED (unresolved) declaration instead, which is the only
 * place a `var(--name)` reference actually survives, and reports the exact
 * variable name in use, or null when there genuinely isn't one.
 *
 * Split out of preload.ts (already large) so it's a plain DOM module with no
 * `ipcRenderer` import — testable against a real browser (headless Chromium),
 * not just reasoned about, the same way `layers.ts` is split for its own walk.
 */

/** The outermost `--name` in a `var(--name, …fallback)` reference, or null. */
export function varRefName(value: string): string | null {
  const m = /var\(\s*(--[\w-]+)/.exec(value)
  return m ? m[1] : null
}

/**
 * The SPECIFIED value of each of `props` on `el` — unlike computed style, this
 * preserves `var(--x)` literally. Active media/supports blocks are traversed;
 * media-conditional rules retain that context so editors cannot mistake them
 * for an unconditional class rule. Cascade layers (`@layer`, which Tailwind v4
 * emits all utilities into) are not conditional: they only change precedence,
 * and the winner is picked by layer order before specificity. Cross-origin
 * sheets are skipped.
 */
export interface StyleDeclarationOrigin {
  kind: 'inline' | 'rule'
  selector?: string
  href?: string
  important?: boolean
  /** Inside an active @media/@supports/other conditional group rule. */
  conditional?: boolean
  /** Dotted cascade-layer path of the winning rule; absent when unlayered. */
  layer?: string
}

/** Where a declaration sits in the cascade, in order of precedence. */
export interface CascadeRank {
  important: boolean
  inline: boolean
  /** Per-level layer indices in order of first appearance; null when unlayered. */
  layer: number[] | null
  specificity: [number, number, number]
  /** Document order: the later declaration wins a tie. */
  order: number
}

/** Positive when `a` beats `b` among NORMAL declarations: unlayered wins over any layer,
 * later layers win over earlier ones, a layer's own rules win over its nested layers. */
function compareLayers(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return a === b ? 0 : !a ? 1 : -1
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return b.length - a.length
}

/** Whether `a` wins over `b` (CSS Cascade 5): importance, then the style attribute,
 * then layers (reversed for !important), then specificity, then source order. */
export function outranks(a: CascadeRank, b: CascadeRank): boolean {
  if (a.important !== b.important) return a.important
  if (a.inline !== b.inline) return a.inline
  const layers = compareLayers(a.layer, b.layer) * (a.important ? -1 : 1)
  if (layers !== 0) return layers > 0
  for (let i = 0; i < 3; i++)
    if (a.specificity[i] !== b.specificity[i]) return a.specificity[i] > b.specificity[i]
  return a.order > b.order
}

/** Layer names in order of first appearance per parent, which is the layer order. */
class LayerOrder {
  private children = new Map<string, string[]>()
  index(path: string[]): number[] {
    return path.map((name, depth) => {
      const parent = path.slice(0, depth).join('\0')
      const names = this.children.get(parent) ?? []
      this.children.set(parent, names)
      const at = names.indexOf(name)
      return at >= 0 ? at : names.push(name) - 1
    })
  }
}

interface WalkContext {
  conditional: boolean
  layer: string[] | null
}

/** Active declarations with their source. A selector whose specificity cannot be
 * compared safely is still displayed, but consumers must treat its source as ambiguous. */
export function activeDeclarations(
  el: Element,
  props: string[]
): {
  specified: Record<string, string>
  origins: Record<string, StyleDeclarationOrigin>
} {
  const specified: Record<string, string> = {}
  const origins: Record<string, StyleDeclarationOrigin> = {}
  const ranks: Record<string, CascadeRank> = {}
  const layers = new LayerOrder()
  let order = 0
  let anonymous = 0
  const offer = (
    prop: string,
    value: string,
    origin: StyleDeclarationOrigin,
    priority: string,
    specificity: [number, number, number],
    layer: string[] | null = null,
    inline = false
  ) => {
    const rank: CascadeRank = {
      important: priority === 'important',
      inline,
      layer: layer ? layers.index(layer) : null,
      specificity,
      order: ++order
    }
    const previous = ranks[prop]
    if (previous && !outranks(rank, previous)) return
    ranks[prop] = rank
    specified[prop] = value.trim()
    origins[prop] = {
      ...origin,
      important: rank.important,
      ...(layer ? { layer: layer.join('.') } : {})
    }
  }
  const specificity = (selector: string): [number, number, number] => {
    // Conservative CSS specificity for ordinary project selectors. Complex
    // functional pseudo classes are left as unknown source by the editor.
    const ids = (selector.match(/#[\w-]+/g) ?? []).length
    const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length
    const types = (
      selector
        .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:{1,2}[\w-]+(?:\([^)]*\))?/g, ' ')
        .match(/(^|[\s>+~])(?:[a-z][\w-]*)/gi) ?? []
    ).length
    return [ids, classes, types]
  }
  // Not in every lib.dom this project builds against, so looked up at runtime.
  const LayerBlock = (globalThis as any).CSSLayerBlockRule as (new () => any) | undefined
  const LayerStatement = (globalThis as any).CSSLayerStatementRule as (new () => any) | undefined
  const layerPath = (parent: string[] | null, name: string): string[] => [
    ...(parent ?? []),
    ...(name ? name.split('.') : [`(anonymous ${++anonymous})`])
  ]
  const walk = (
    rules: CSSRuleList | undefined,
    href: string | undefined,
    context: WalkContext = { conditional: false, layer: null }
  ): void => {
    if (!rules) return
    const { conditional, layer } = context
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        let matches = false
        try {
          matches = el.matches(rule.selectorText)
        } catch {
          continue // an unsupported/invalid selector — not a usage signal
        }
        if (!matches) continue
        const selector =
          rule.selectorText.split(',').find((part) => {
            try {
              return el.matches(part.trim())
            } catch {
              return false
            }
          }) ?? rule.selectorText
        for (const p of props) {
          const v = rule.style.getPropertyValue(p)
          if (v)
            offer(
              p,
              v,
              { kind: 'rule', selector, href, conditional },
              rule.style.getPropertyPriority(p),
              specificity(selector),
              layer
            )
        }
      } else if (rule instanceof CSSImportRule) {
        // An @import's nested sheet hangs off `.styleSheet`, NOT `.cssRules` —
        // the grouping-rule branch below would silently skip it. Same
        // cross-origin caveat as the top-level loop, hence its own try.
        try {
          if (!rule.styleSheet || (rule.media.length && !matchMedia(rule.media.mediaText).matches))
            continue
          const importLayer = (rule as any).layerName as string | null | undefined
          const imported = typeof importLayer === 'string' ? layerPath(layer, importLayer) : layer
          if (imported && imported !== layer) layers.index(imported)
          walk(rule.styleSheet.cssRules, rule.styleSheet.href ?? href, {
            conditional: conditional || rule.media.length > 0,
            layer: imported
          })
        } catch {
          /* cross-origin import — not the previewed app's own CSS */
        }
      } else if (LayerStatement && rule instanceof LayerStatement) {
        // `@layer a, b;` fixes the layer order without holding any rules.
        for (const name of (rule as any).nameList as string[]) layers.index(layerPath(layer, name))
      } else if (LayerBlock && rule instanceof LayerBlock) {
        const path = layerPath(layer, (rule as any).name as string)
        layers.index(path)
        walk((rule as CSSGroupingRule).cssRules, href, { conditional, layer: path })
      } else if ('cssRules' in rule) {
        if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue
        if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue
        walk((rule as CSSGroupingRule).cssRules, href, { conditional: true, layer })
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    if (sheet.media.length && !matchMedia(sheet.media.mediaText).matches) continue
    const owner = sheet.ownerNode instanceof Element ? sheet.ownerNode : null
    walk(rules, sheet.href ?? owner?.getAttribute('data-vite-dev-id') ?? undefined)
  }
  if (el instanceof HTMLElement || el instanceof SVGElement) {
    for (const p of props) {
      const inline = el.style.getPropertyValue(p)
      if (inline)
        offer(
          p,
          inline,
          { kind: 'inline' },
          el.style.getPropertyPriority(p),
          [1000000, 0, 0],
          null,
          true
        )
    }
  }
  return { specified, origins }
}

export function specifiedValues(el: Element, props: string[]): Record<string, string> {
  return activeDeclarations(el, props).specified
}

/**
 * Per property, the `--name` a design token would need to match to be real
 * usage evidence — or null when the specified declaration isn't a `var()` at
 * all (a literal value: no token is in play, coincidence or not).
 */
export function declaredVarsFor(el: Element, props: string[]): Record<string, string | null> {
  const specified = specifiedValues(el, props)
  const out: Record<string, string | null> = {}
  for (const p of props) out[p] = varRefName(specified[p] ?? '')
  return out
}
