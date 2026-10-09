/**
 * Unit test for serve-time HTML stamping + text splicing (vanilla-JS editing,
 * Tier 2). Exercises real parse5. Pure bun — no fs, no Electron.
 * Run with: bun run test:html-source
 */
import assert from 'node:assert'
import { spliceHtmlText, stampHtml } from '../src/main/html-source.ts'

const HTML = `<!doctype html>
<html>
<head><title>Hi</title><style>.a{color:red}</style></head>
<body>
  <h1>Hello</h1>
  <p class="lead">Some <strong>bold</strong> text</p>
  <p>Plain</p>
  <script>console.log('x')</script>
</body>
</html>`

// --- stampHtml --------------------------------------------------------------

const stamped = await stampHtml(HTML, 'index.html')

// Body elements get a stamp; head/title/style/script do not.
assert.ok(/<h1 data-trezi-source="index\.html:\d+:\d+">/.test(stamped), 'h1 stamped')
assert.ok(
  /<p data-trezi-source="index\.html:\d+:\d+" class="lead">/.test(stamped),
  'p stamped, before existing attrs'
)
assert.ok(/<strong data-trezi-source=/.test(stamped), 'nested strong stamped')
assert.ok(!/<title data-trezi-source/.test(stamped), 'title not stamped')
assert.ok(!/<style data-trezi-source/.test(stamped), 'style not stamped')
assert.ok(!/<script data-trezi-source/.test(stamped), 'script not stamped')
assert.ok(!/<body data-trezi-source/.test(stamped), 'body not stamped')

// The stamp is the ONLY change: stripping the injected attrs restores the input.
const unstamped = stamped.replace(/ data-trezi-source="[^"]*"/g, '')
assert.equal(unstamped, HTML, 'stamping only inserts attributes, nothing else')

// Idempotent — stamping already-stamped HTML adds nothing.
assert.equal(await stampHtml(stamped, 'index.html'), stamped, 'stamping is idempotent')

// Template instrumentation knows the original source, unlike the served HTML.
for (const attribute of ['data-praxis-source', 'data-trezi-source']) {
  const template = `<h1 ${attribute}="templates/title.html:42:7">Hello</h1>`
  assert.equal(await stampHtml(template, 'index.html'), template, `${attribute} mapping preserved`)
  const nested = `<section ${attribute}="templates/card.html:12:3"><strong>Hi</strong></section>`
  const result = await stampHtml(nested, 'index.html')
  assert.ok(result.startsWith(`<section ${attribute}="templates/card.html:12:3">`))
  assert.ok(result.includes('<strong data-trezi-source="index.html:'))
  assert.equal(await stampHtml(result, 'index.html'), result)
}

// --- spliceHtmlText (via a real stamp) --------------------------------------

// Pull the <h1>'s stamp coordinates out of the stamped HTML and edit its text.
const h1 = /<h1 data-trezi-source="index\.html:(\d+):(\d+)">/.exec(stamped)
const [h1Line, h1Col] = [Number(h1[1]), Number(h1[2])]
const edited = await spliceHtmlText(HTML, h1Line, h1Col, 'Goodbye')
assert.ok(
  edited?.includes('<h1>Goodbye</h1>'),
  `h1 text rewritten: ${edited?.match(/<h1>.*<\/h1>/)?.[0]}`
)
assert.ok(
  edited.includes('<p class="lead">Some <strong>bold</strong> text</p>'),
  'other elements untouched'
)

// New text is HTML-escaped so it can't break out of the element.
const escaped = await spliceHtmlText(HTML, h1Line, h1Col, 'a < b & c > d')
assert.ok(escaped.includes('<h1>a &lt; b &amp; c &gt; d</h1>'), 'text is escaped')

// An element with element children (the <p class="lead"> wrapping <strong>) is
// NOT a safe splice → null (agent fallback).
const lead = /<p data-trezi-source="index\.html:(\d+):(\d+)" class="lead">/.exec(stamped)
const leadRes = await spliceHtmlText(HTML, Number(lead[1]), Number(lead[2]), 'nope')
assert.equal(leadRes, null, 'mixed element content falls back to agent (null)')

// A line:col that matches no element → null.
assert.equal(await spliceHtmlText(HTML, 999, 1, 'x'), null, 'no element at line:col → null')

console.log('HTML-SOURCE OK — serve-time stamping + text splicing')
