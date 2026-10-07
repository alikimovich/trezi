/**
 * Token categories (LKM-183). The backend never picks colours: a TextMate theme whose
 * "colours" are category numbers (`#0000NN`) classifies each token, and the Swift
 * editor maps the number to its Xcode-like light or dark colour (`SourceSyntax.swift`),
 * so an appearance change recolours without tokenizing again.
 * Keep this order in sync with `SourceSyntaxCategory` in Swift.
 */
export const SYNTAX_CATEGORIES = [
  'plain',
  'comment',
  'keyword',
  'string',
  'number',
  'regex',
  'type',
  'function',
  'typeDeclaration',
  'declaration',
  'property',
  'tag',
  'attribute',
  'preprocessor',
  'constant',
  'embedded',
  'heading',
  'emphasis',
  'strong',
  'link'
] as const
export type SyntaxCategory = (typeof SYNTAX_CATEGORIES)[number]

/** TextMate scope selectors per category. A more specific selector wins, as in VS Code. */
const RULES: [SyntaxCategory, string[]][] = [
  ['comment', ['comment', 'punctuation.definition.comment', 'markup.quote']],
  [
    'keyword',
    [
      'keyword',
      'storage.type',
      'storage.modifier',
      'constant.language',
      'variable.language',
      'keyword.operator.new',
      'keyword.operator.expression',
      'keyword.operator.word',
      'keyword.control.import',
      'keyword.control.export',
      'keyword.control.from',
      'meta.special punctuation.definition.keyword.svelte',
      'punctuation.definition.list.begin.markdown'
    ]
  ],
  // Operators (and `=>`) and Swift parameter labels stay plain, as in Xcode; other
  // punctuation takes its parent's category.
  [
    'plain',
    [
      'keyword.operator',
      'storage.type.function.arrow',
      'meta.embedded',
      'variable.parameter',
      'invalid',
      'meta.parameter-clause.swift entity.name.function.swift'
    ]
  ],
  [
    'string',
    [
      'string',
      'punctuation.definition.string',
      'markup.inline.raw',
      'markup.fenced_code',
      'markup.raw'
    ]
  ],
  [
    'number',
    ['constant.numeric', 'constant.character', 'constant.character.escape', 'keyword.other.unit']
  ],
  [
    'regex',
    [
      'string.regexp',
      'string.regexp punctuation.definition.string',
      'string.regexp keyword',
      'string.regexp keyword.operator',
      'string.regexp keyword.control',
      'string.regexp constant.other',
      'string.regexp constant.character',
      'string.regexp support.other'
    ]
  ],
  [
    'type',
    [
      'entity.name.type',
      'support.type.primitive',
      'support.type.builtin',
      'entity.name.class',
      'support.type',
      'support.class',
      'entity.other.inherited-class',
      'support.class.component',
      'entity.name.tag support.class.component',
      'storage.type.class.jsdoc'
    ]
  ],
  [
    'function',
    ['entity.name.function', 'support.function', 'meta.function-call entity.name.function']
  ],
  [
    'typeDeclaration',
    [
      'meta.class entity.name.type.class',
      'meta.interface entity.name.type.interface',
      'meta.type.declaration entity.name.type.alias',
      'meta.enum.declaration entity.name.type.enum',
      'meta.definition.type entity.name.type',
      'entity.name.type.class.swift',
      'entity.name.type.struct.swift',
      'entity.name.type.enum.swift',
      'entity.name.type.protocol.swift'
    ]
  ],
  [
    'declaration',
    [
      'meta.definition.function entity.name.function',
      'meta.definition.method entity.name.function',
      'meta.function.swift entity.name.function',
      'entity.name.function.swift',
      'meta.definition.variable variable.other.constant',
      'meta.definition.variable variable.other.readwrite'
    ]
  ],
  [
    'property',
    [
      'variable.other.property',
      'variable.other.object.property',
      'support.variable.property',
      'meta.object-literal.key',
      'support.type.property-name',
      'meta.property-name',
      'entity.name.tag.yaml',
      'meta.structure.dictionary.key.json string',
      'support.type.property-name.json',
      'support.type.property-name.json punctuation.definition.string'
    ]
  ],
  ['tag', ['entity.name.tag', 'punctuation.definition.tag']],
  // Svelte directives (`on:click`, `class:x`) read as one attribute, like Vue's `@click`.
  [
    'attribute',
    [
      'entity.other.attribute-name',
      'entity.other.attribute-name.class.css',
      'meta.directive keyword.control.svelte',
      'meta.directive punctuation.definition.keyword.svelte',
      'meta.directive entity.name.type.svelte'
    ]
  ],
  [
    'preprocessor',
    [
      'meta.decorator',
      'punctuation.decorator',
      'entity.name.function.decorator',
      'meta.preprocessor',
      'keyword.control.directive',
      'keyword.control.at-rule',
      'storage.modifier.attribute',
      'keyword.other.attribute',
      'meta.attribute.swift',
      'storage.type.attribute.swift',
      'meta.directive.vue',
      'keyword.other.important'
    ]
  ],
  [
    'constant',
    [
      'support.constant',
      'constant.other.color',
      'support.constant.property-value',
      'constant.other',
      'variable.other.enummember'
    ]
  ],
  [
    'embedded',
    [
      'punctuation.definition.template-expression',
      'punctuation.section.embedded',
      'punctuation.definition.interpolation',
      'punctuation.section.embedded.begin',
      'punctuation.section.embedded.end'
    ]
  ],
  ['heading', ['markup.heading', 'entity.name.section', 'punctuation.definition.heading']],
  ['emphasis', ['markup.italic']],
  ['strong', ['markup.bold']],
  [
    'link',
    ['markup.underline.link', 'string.other.link', 'markup.link', 'constant.other.reference.link']
  ]
]

/** `#0000NN`: only digits and A–F, so the TextMate colour map's upper-casing keeps it. */
const colour = (category: SyntaxCategory) =>
  `#0000${SYNTAX_CATEGORIES.indexOf(category).toString(16).padStart(2, '0').toUpperCase()}`

/** The category a colour-map entry stands for; anything unknown is plain. */
export function syntaxCategoryOf(color: string | undefined): number {
  const match = /^#0000([0-9A-F]{2})$/i.exec(color ?? '')
  const index = match ? Number.parseInt(match[1], 16) : 0
  return index < SYNTAX_CATEGORIES.length ? index : 0
}

/** The classifying theme handed to Shiki. */
export const SYNTAX_THEME = {
  name: 'trezi-categories',
  type: 'light' as const,
  fg: colour('plain'),
  bg: '#FFFFFF',
  settings: [
    { settings: { foreground: colour('plain'), background: '#FFFFFF' } },
    ...RULES.map(([category, scope]) => ({ scope, settings: { foreground: colour(category) } }))
  ]
}
