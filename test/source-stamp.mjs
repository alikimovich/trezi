import assert from 'node:assert/strict'
import { sourceSelector } from '../src/preview/source-stamp.ts'

// Bun's HTML selector engine supports the attribute selectors and :not, but
// not the outer :is wrapper. Exercise its equivalent selector list here; the
// native DOM regression exercises the unmodified selector and CSS.escape.
globalThis.CSS = { escape: (value) => value } // These unit values are identifiers.
const html = `<div id="conflict" data-trezi-source="new" data-praxis-source="old"></div>
<div id="legacy" data-praxis-source="old"></div>
<div id="canonical" data-trezi-source="old"></div>
<div id="empty" data-trezi-source="" data-praxis-source="old"></div>
<div id="same" data-trezi-source="old" data-praxis-source="old"></div>
<div id="unstamped"></div>`
for (const [value, expected] of [
  ['old', ['legacy', 'canonical', 'same']],
  ['new', ['conflict']],
  ['', ['empty']],
  [undefined, ['conflict', 'legacy', 'canonical', 'empty', 'same']]
]) {
  const selector = sourceSelector(value)
  assert.ok(selector.startsWith(':is(') && selector.endsWith(')'))
  const matches = []
  await new HTMLRewriter()
    .on(selector.slice(4, -1), {
      element(element) {
        matches.push(element.getAttribute('id'))
      }
    })
    .transform(new Response(html))
    .text()
  assert.deepEqual(matches, expected)
}
console.log(
  'Source selectors: canonical precedence, legacy fallback, empty and equal stamps passed'
)
