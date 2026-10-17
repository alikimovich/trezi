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
 * preserves `var(--x)` literally. Checked in a rough cascade approximation:
 * matched same-origin stylesheet rules in document order, THEN inline
 * (`el.style`), which overwrites since it's closest to the top of the real
 * cascade. We don't evaluate `@media`/`@supports` conditions before walking
 * their body — a declaration inside a currently-inactive block still counts as
 * usage evidence, which only WIDENS what's provable, never invents a match to
 * an unrelated token. A cross-origin sheet throws on `.cssRules` access; it
 * can't be the previewed app's own CSS, so it's simply skipped.
 */
export interface StyleDeclarationOrigin {
  kind: 'inline' | 'rule'
  selector?: string
  href?: string
  important?: boolean
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
  const ranks: Record<string, [number, number, number, number, number]> = {}
  let order = 0
  const offer = (
    prop: string,
    value: string,
    origin: StyleDeclarationOrigin,
    priority: string,
    specificity: [number, number, number]
  ) => {
    const rank: [number, number, number, number, number] = [
      priority === 'important' ? 1 : 0,
      ...specificity,
      ++order
    ]
    const previous = ranks[prop]
    if (previous && rank.findIndex((part, index) => part !== previous[index]) >= 0) {
      const index = rank.findIndex((part, i) => part !== previous[i])
      if (rank[index] < previous[index]) return
    }
    ranks[prop] = rank
    specified[prop] = value.trim()
    origins[prop] = { ...origin, important: priority === 'important' }
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
  const walk = (rules: CSSRuleList | undefined, href?: string): void => {
    if (!rules) return
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
              { kind: 'rule', selector, href },
              rule.style.getPropertyPriority(p),
              specificity(selector)
            )
        }
      } else if (rule instanceof CSSImportRule) {
        // An @import's nested sheet hangs off `.styleSheet`, NOT `.cssRules` —
        // the grouping-rule branch below would silently skip it. Same
        // cross-origin caveat as the top-level loop, hence its own try.
        try {
          if (!rule.styleSheet || (rule.media.length && !matchMedia(rule.media.mediaText).matches))
            continue
          walk(rule.styleSheet.cssRules, rule.styleSheet.href ?? href)
        } catch {
          /* cross-origin import — not the previewed app's own CSS */
        }
      } else if ('cssRules' in rule) {
        if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue
        if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue
        walk((rule as CSSGroupingRule).cssRules, href)
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
        offer(p, inline, { kind: 'inline' }, el.style.getPropertyPriority(p), [1000000, 0, 0])
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
