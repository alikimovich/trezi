/**
 * Unit test for the pure inline-style splicers (no Electron needed). Run via
 * bun so the .ts import transpiles: bun run test:inline-style
 */
import assert from 'node:assert'
import {
  cssPropToJsKey,
  mergeStyleObjectSource,
  mergeStyleString
} from '../src/main/inline-style.ts'

// --- cssPropToJsKey ---------------------------------------------------------

assert.strictEqual(cssPropToJsKey('background-color'), 'backgroundColor', 'two words')
assert.strictEqual(
  cssPropToJsKey('transition-timing-function'),
  'transitionTimingFunction',
  'three words'
)
assert.strictEqual(cssPropToJsKey('opacity'), 'opacity', 'no hyphen unchanged')

// --- mergeStyleString (style="…") -------------------------------------------

// Empty / absent style → bare declaration.
assert.strictEqual(mergeStyleString('', 'color', 'red'), 'color: red', 'empty style')
assert.strictEqual(mergeStyleString(null, 'color', 'red'), 'color: red', 'null style')
assert.strictEqual(mergeStyleString(undefined, 'color', 'red'), 'color: red', 'absent style')

// Append when the prop isn't present; existing declarations kept verbatim.
assert.strictEqual(
  mergeStyleString('padding: 8px', 'background-color', 'red'),
  'padding: 8px; background-color: red',
  'append'
)

// Replace in place, other declarations untouched.
assert.strictEqual(
  mergeStyleString('color: blue; padding: 8px', 'color', 'red'),
  'color: red; padding: 8px',
  'replace'
)

// Commas inside parens don't split — a bezier survives an unrelated edit…
assert.strictEqual(
  mergeStyleString(
    'transition-timing-function: cubic-bezier(0.1, 0.2, 0.3, 0.4); color: blue',
    'color',
    'red'
  ),
  'transition-timing-function: cubic-bezier(0.1, 0.2, 0.3, 0.4); color: red',
  'bezier survives neighbor edit'
)
// …and can itself be replaced by another paren-heavy value.
assert.strictEqual(
  mergeStyleString(
    'transition-timing-function: cubic-bezier(0.1, 0.2, 0.3, 0.4)',
    'transition-timing-function',
    'cubic-bezier(0.5, 0, 1, 1)'
  ),
  'transition-timing-function: cubic-bezier(0.5, 0, 1, 1)',
  'bezier replaced'
)

// Semicolons inside quoted strings don't split.
assert.strictEqual(
  mergeStyleString("content: 'a;b'; color: blue", 'color', 'red'),
  "content: 'a;b'; color: red",
  'quoted semicolon survives'
)

// Trailing semicolon → no empty declaration in the output.
assert.strictEqual(
  mergeStyleString('color: blue;', 'padding', '4px'),
  'color: blue; padding: 4px',
  'trailing semicolon'
)

// Editing a longhand leaves an existing SHORTHAND for the same area untouched.
assert.strictEqual(
  mergeStyleString('transition: opacity 150ms ease', 'transition-duration', '300ms'),
  'transition: opacity 150ms ease; transition-duration: 300ms',
  'shorthand untouched'
)

// Property match is case-insensitive; duplicates collapse to one declaration.
assert.strictEqual(
  mergeStyleString('COLOR: blue', 'color', 'red'),
  'color: red',
  'case-insensitive'
)
assert.strictEqual(
  mergeStyleString('color: a; color: b', 'color', 'red'),
  'color: red',
  'duplicates collapse'
)

// --- mergeStyleObjectSource (JSX style={{…}}) --------------------------------

// Append to an empty object.
assert.strictEqual(
  mergeStyleObjectSource('{}', 'background-color', 'red'),
  '{ backgroundColor: "red" }',
  'append to {}'
)
assert.strictEqual(
  mergeStyleObjectSource('{  }', 'color', 'red'),
  '{ color: "red" }',
  'append to whitespace-only {}'
)

// Append after existing entries; trailing comma handled.
assert.strictEqual(
  mergeStyleObjectSource("{ padding: '8px' }", 'color', 'red'),
  '{ padding: \'8px\', color: "red" }',
  'append'
)
assert.strictEqual(
  mergeStyleObjectSource("{ padding: '8px', }", 'color', 'red'),
  '{ padding: \'8px\', color: "red" }',
  'append after trailing comma'
)

// Replace a string-literal value; neighbors and their quoting untouched.
assert.strictEqual(
  mergeStyleObjectSource("{ color: 'blue', padding: '8px' }", 'color', 'red'),
  '{ color: "red", padding: \'8px\' }',
  'replace string literal'
)

// Replace a number-literal value (result is always a quoted string).
assert.strictEqual(
  mergeStyleObjectSource('{ opacity: 0.5 }', 'opacity', '0.8'),
  '{ opacity: "0.8" }',
  'replace number literal'
)

// Quoted css-form key matches too.
assert.strictEqual(
  mergeStyleObjectSource("{ 'background-color': 'blue' }", 'background-color', 'red'),
  '{ \'background-color\': "red" }',
  'quoted css key'
)

// Commas inside a paren-heavy string value don't split entries.
assert.strictEqual(
  mergeStyleObjectSource(
    "{ transitionTimingFunction: 'cubic-bezier(0.1, 0.2, 0.3, 0.4)', color: 'blue' }",
    'color',
    'red'
  ),
  '{ transitionTimingFunction: \'cubic-bezier(0.1, 0.2, 0.3, 0.4)\', color: "red" }',
  'bezier entry survives'
)

// Multiline formatting is preserved around a replaced value.
assert.strictEqual(
  mergeStyleObjectSource("{\n  color: 'blue',\n  padding: '8px'\n}", 'color', 'red'),
  '{\n  color: "red",\n  padding: \'8px\'\n}',
  'multiline preserved'
)

// Spread anywhere → null (final object unknowable).
assert.strictEqual(
  mergeStyleObjectSource("{ ...base, color: 'blue' }", 'color', 'red'),
  null,
  'spread → null'
)

// Target value is a non-literal expression → null.
assert.strictEqual(
  mergeStyleObjectSource('{ color: theme.primary }', 'color', 'red'),
  null,
  'expression value → null'
)
assert.strictEqual(
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
  mergeStyleObjectSource('{ padding: `${x}px` }', 'padding', '4px'),
  null,
  'template literal → null'
)
assert.strictEqual(
  mergeStyleObjectSource('{ color }', 'color', 'red'),
  null,
  'shorthand target → null'
)

// Comments anywhere in the object → null: the splicers are comment-blind, so
// an append after `// tweak me` would land INSIDE the comment — code compiles,
// edit reports success, style silently never applies.
assert.strictEqual(
  mergeStyleObjectSource('{ padding: 4 // tweak me\n}', 'padding-top', '8px'),
  null,
  'trailing line comment → null, not a swallowed append'
)
assert.strictEqual(
  mergeStyleObjectSource('{ padding: 4 /* px */ }', 'color', 'red'),
  null,
  'block comment → null'
)
// A '/' inside a quoted value is not a comment; division isn't either.
assert.strictEqual(
  mergeStyleObjectSource("{ backgroundImage: 'url(https://x/y.png)' }", 'color', 'red'),
  '{ backgroundImage: \'url(https://x/y.png)\', color: "red" }',
  'quoted // is not a comment'
)
assert.strictEqual(
  mergeStyleObjectSource("{ width: size / 2, color: 'blue' }", 'color', 'red'),
  '{ width: size / 2, color: "red" }',
  'division is not a comment'
)

// Duplicate keys: the LAST one wins at runtime, so that's the one replaced.
assert.strictEqual(
  mergeStyleObjectSource("{ color: 'red', color: 'blue' }", 'color', '#0f0'),
  '{ color: \'red\', color: "#0f0" }',
  'duplicate keys → last occurrence replaced'
)
assert.strictEqual(
  mergeStyleObjectSource(
    "{ 'background-color': 'red', backgroundColor: 'blue' }",
    'background-color',
    '#0f0'
  ),
  "{ 'background-color': 'red', backgroundColor: \"#0f0\" }",
  'mixed-form duplicate → last occurrence replaced'
)

// Spread AFTER the target still poisons the object (it may override the prop).
assert.strictEqual(
  mergeStyleObjectSource("{ color: 'blue', ...base }", 'color', 'red'),
  null,
  'spread after match → null'
)

// A non-target expression entry doesn't block editing another prop.
assert.strictEqual(
  mergeStyleObjectSource("{ width: size * 2, color: 'blue' }", 'color', 'red'),
  '{ width: size * 2, color: "red" }',
  'non-target expression ok (replace)'
)
assert.strictEqual(
  mergeStyleObjectSource('{ color }', 'padding', '4px'),
  '{ color, padding: "4px" }',
  'non-target shorthand ok (append)'
)

console.log('INLINE-STYLE OK')
