/**
 * Cascade provenance for the Styles inspector (LKM-272): which declaration wins, and
 * whether it is conditional. Runs the real `activeDeclarations` walk against a small
 * CSSOM stand-in (no DOM library in this repo); the native smoke covers real WebKit.
 *
 *   bun run test:style-provenance
 */
import assert from 'node:assert/strict'

class CSSStyleRule {
  constructor(selectorText, declarations, important = []) {
    this.selectorText = selectorText
    this.style = {
      getPropertyValue: (p) => declarations[p] ?? '',
      getPropertyPriority: (p) => (important.includes(p) ? 'important' : '')
    }
  }
}
class CSSMediaRule {
  constructor(conditionText, cssRules) {
    this.conditionText = conditionText
    this.cssRules = cssRules
  }
}
class CSSSupportsRule {}
class CSSImportRule {}
class CSSLayerBlockRule {
  constructor(name, cssRules) {
    this.name = name
    this.cssRules = cssRules
  }
}
class CSSLayerStatementRule {
  constructor(nameList) {
    this.nameList = nameList
  }
}
class HTMLElement {
  constructor(classes, inline = {}) {
    this.classes = classes
    this.style = { getPropertyValue: (p) => inline[p] ?? '', getPropertyPriority: () => '' }
  }
  matches(selector) {
    const match = /^\.([\w-]+)$/.exec(selector.trim())
    return !!match && this.classes.includes(match[1])
  }
}
let sheets = []
Object.assign(globalThis, {
  CSSStyleRule,
  CSSMediaRule,
  CSSSupportsRule,
  CSSImportRule,
  CSSLayerBlockRule,
  CSSLayerStatementRule,
  HTMLElement,
  SVGElement: class SVGElement {},
  Element: HTMLElement,
  CSS: { supports: () => true },
  matchMedia: (query) => ({ matches: query === '(min-width: 1px)' }),
  document: {
    get styleSheets() {
      return sheets.map((cssRules) => ({ cssRules, media: { length: 0 }, ownerNode: null }))
    }
  }
})
const { activeDeclarations } = await import('../src/preview/style-provenance.ts')

const read = (rules, element = new HTMLElement(['card']), props = ['gap']) => {
  sheets = [rules]
  return activeDeclarations(element, props)
}

// Tailwind v4 shape: the utility lives in `@layer utilities`, which is not conditional.
let result = read([
  new CSSLayerStatementRule(['theme', 'base', 'components', 'utilities']),
  new CSSLayerBlockRule('utilities', [new CSSStyleRule('.card', { gap: '1rem' })])
])
assert.equal(result.specified.gap, '1rem')
assert.equal(result.origins.gap.layer, 'utilities')
assert.equal(result.origins.gap.conditional, false, 'a cascade layer is not a condition')

// An unlayered rule of equal specificity beats a layered utility, whatever the order.
for (const rules of [
  [
    new CSSLayerBlockRule('utilities', [new CSSStyleRule('.card', { gap: '1rem' })]),
    new CSSStyleRule('.card', { gap: '8px' })
  ],
  [
    new CSSStyleRule('.card', { gap: '8px' }),
    new CSSLayerBlockRule('utilities', [new CSSStyleRule('.card', { gap: '1rem' })])
  ]
]) {
  result = read(rules)
  assert.equal(result.specified.gap, '8px')
  assert.equal(result.origins.gap.layer, undefined, 'the unlayered rule is the reported origin')
}

// A later layer beats an earlier one, even with lower specificity and earlier source order;
// `@layer a, b;` fixes the order up front.
result = read([
  new CSSLayerStatementRule(['base', 'utilities']),
  new CSSLayerBlockRule('utilities', [new CSSStyleRule('.card', { gap: '1rem' })]),
  new CSSLayerBlockRule('base', [new CSSStyleRule('.card', { gap: '2px' })])
])
assert.equal(result.specified.gap, '1rem')

// !important reverses the layer order and unlayered loses to any layer.
result = read([
  new CSSLayerStatementRule(['base', 'utilities']),
  new CSSLayerBlockRule('utilities', [new CSSStyleRule('.card', { gap: '1rem' }, ['gap'])]),
  new CSSLayerBlockRule('base', [new CSSStyleRule('.card', { gap: '2px' }, ['gap'])]),
  new CSSStyleRule('.card', { gap: '8px' }, ['gap'])
])
assert.equal(result.specified.gap, '2px')
assert.equal(result.origins.gap.layer, 'base')
assert.equal(result.origins.gap.important, true)

// Nested layers: the parent's own rules beat its nested layers (normal declarations).
result = read([
  new CSSLayerBlockRule('outer', [
    new CSSLayerBlockRule('inner', [new CSSStyleRule('.card', { gap: '1px' })]),
    new CSSStyleRule('.card', { gap: '2px' })
  ])
])
assert.equal(result.specified.gap, '2px')
assert.equal(result.origins.gap.layer, 'outer')

// Inline wins over layers and unlayered rules; an inactive media rule is not reported.
result = read(
  [
    new CSSLayerBlockRule('utilities', [new CSSStyleRule('.card', { gap: '1rem' })]),
    new CSSStyleRule('.card', { gap: '8px' }),
    new CSSMediaRule('(max-width: 1px)', [new CSSStyleRule('.card', { gap: '99px' })])
  ],
  new HTMLElement(['card'], { gap: '4px' })
)
assert.equal(result.specified.gap, '4px')
assert.equal(result.origins.gap.kind, 'inline')

// A media rule inside a layer is both layered and conditional.
result = read([
  new CSSLayerBlockRule('utilities', [
    new CSSMediaRule('(min-width: 1px)', [new CSSStyleRule('.card', { gap: '3rem' })])
  ])
])
assert.equal(result.specified.gap, '3rem')
assert.equal(result.origins.gap.conditional, true)
assert.equal(result.origins.gap.layer, 'utilities')

console.log('style-provenance: ok')
