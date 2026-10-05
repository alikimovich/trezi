/**
 * Unit test for the pure PR-body builder (no Electron needed). Run via bun so
 * the .ts import transpiles: bun run test:prbody
 */
import assert from 'node:assert'
import { buildPrBody } from '../src/shared/pr-body.ts'

const note = (over = {}) => ({
  id: '1',
  source: 'src/Hero.tsx:7',
  selector: '#hero',
  tag: 'h1',
  text: 'tighten spacing',
  createdAt: '',
  ...over
})

// No annotations → the explicit empty branch.
let body = buildPrBody([], [])
assert.ok(body.includes('_No annotations._'), 'empty-notes branch')

// Notes + changed files render with headings and the source location.
body = buildPrBody([note({ text: 'line1\nline2' })], ['a.tsx', 'b.tsx'])
assert.ok(body.includes('### Notes (1)'), 'notes heading')
assert.ok(body.includes('src/Hero.tsx:7'), 'source shown')
assert.ok(body.includes('line1 line2') && !body.includes('line1\nline2'), 'newlines flattened')
assert.ok(body.includes('### Changed files (2)'), 'changed-files heading')

// Changed-files list is capped at 50.
body = buildPrBody(
  [],
  Array.from({ length: 60 }, (_, i) => `f${i}.tsx`)
)
assert.ok(body.includes('Changed files (60)'), 'full count shown')
assert.ok(body.includes('…and 10 more'), 'overflow summarized')

// Backticks in a value can't break out of the inline-code span.
body = buildPrBody([note({ source: null, selector: '`evil`' })], [])
assert.ok(!body.includes('`evil`'), 'backticks escaped')

console.log('PR-BODY OK')
