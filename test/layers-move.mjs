/**
 * layers-move unit test (pure — no Electron, no babel/svelte/parse5 parse).
 * The Layers panel's drag-to-reorder SPLICE algorithm
 * (`moveSiblingWithinParent`, shared by all three movers — React/Svelte/
 * static-HTML) against HAND-BUILT `{start,end}` node stand-ins over literal
 * code strings: no real AST needed, since the algorithm only ever touches
 * spans + a whitespace predicate. Covers reorder up/down, self-closing-shaped
 * nodes, indentation preservation via the borrowed separator, the
 * no-separator-to-borrow fallback, and the defensive not-found/same-node
 * refusals.
 *
 * The AST-aware gating this algorithm sits behind (same-source, same-parent,
 * templated-container detection) lives in move-node.ts/-svelte.ts/-html.ts,
 * which import `props.ts` (electron) and so can't be unit-tested directly —
 * that gating is covered end-to-end in test/layers-panel.mjs instead.
 *
 * Run with: bun test/layers-move.mjs
 */
import { moveSiblingWithinParent } from '../src/main/move-node-splice.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (actual, expected, msg) =>
  ok(
    actual === expected,
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )

// A node stand-in: {start, end, ws?} — `ws: true` marks a whitespace-only
// separator (the React/Svelte/HTML movers each derive this from their own
// AST's text-node shape; the algorithm itself only needs the predicate).
const node = (start, end, ws = false) => ({ start, end, ws })
const isWs = (n) => n.ws

// --- a simple <ul><li>A</li>\n  <li>B</li>\n  <li>C</li></ul>-shaped list ---
// Positions chosen to match a real 2-space-indented list so the separator
// math is checked against a realistic string, not an abstract one.
const listCode = '<ul>\n  <li>A</li>\n  <li>B</li>\n  <li>C</li>\n</ul>'
//                 0123456789...
// Index the substrings directly rather than hand-counting offsets.
const iA = listCode.indexOf('<li>A</li>')
const iB = listCode.indexOf('<li>B</li>')
const iC = listCode.indexOf('<li>C</li>')
const wsBeforeA = listCode.indexOf('\n  <li>A')
const wsBeforeB = listCode.indexOf('\n  <li>B')
const wsBeforeC = listCode.indexOf('\n  <li>C')
const wsAfterC = listCode.indexOf('\n</ul>')

const A = node(iA, iA + '<li>A</li>'.length)
const B = node(iB, iB + '<li>B</li>'.length)
const C = node(iC, iC + '<li>C</li>'.length)
const wsA = node(wsBeforeA, iA, true) // '\n  ' before A
const wsB = node(wsBeforeB, iB, true) // '\n  ' before B
const wsC = node(wsBeforeC, iC, true) // '\n  ' before C
const wsEnd = node(wsAfterC, wsAfterC + 1, true) // trailing '\n' before </ul>

const listChildren = [wsA, A, wsB, B, wsC, C, wsEnd]

// --- reorder: move B before A ---
{
  const out = moveSiblingWithinParent(listCode, listChildren, B, A, 'before', isWs)
  eq(out, '<ul>\n  <li>B</li>\n  <li>A</li>\n  <li>C</li>\n</ul>', 'move B before A')
}

// --- reorder: move A after C (moving the FIRST item to the end) ---
{
  const out = moveSiblingWithinParent(listCode, listChildren, A, C, 'after', isWs)
  eq(out, '<ul>\n  <li>B</li>\n  <li>C</li>\n  <li>A</li>\n</ul>', 'move A after C')
}

// --- reorder: move C before B (moving the LAST item earlier) ---
{
  const out = moveSiblingWithinParent(listCode, listChildren, C, B, 'before', isWs)
  eq(out, '<ul>\n  <li>A</li>\n  <li>C</li>\n  <li>B</li>\n</ul>', 'move C before B')
}

// --- self-closing-shaped nodes (no children to worry about — same algorithm,
// just a different raw-text shape) ---
{
  const code = '<div>\n  <Icon a/>\n  <Icon b/>\n  <Icon c/>\n</div>'
  const ia = code.indexOf('<Icon a/>')
  const ib = code.indexOf('<Icon b/>')
  const ic = code.indexOf('<Icon c/>')
  const a = node(ia, ia + '<Icon a/>'.length)
  const b = node(ib, ib + '<Icon b/>'.length)
  const c = node(ic, ic + '<Icon c/>'.length)
  const children = [
    node(code.indexOf('\n  <Icon a'), ia, true),
    a,
    node(code.indexOf('\n  <Icon b'), ib, true),
    b,
    node(code.indexOf('\n  <Icon c'), ic, true),
    c,
    node(code.indexOf('\n</div>'), code.indexOf('\n</div>') + 1, true)
  ]
  const out = moveSiblingWithinParent(code, children, c, a, 'before', isWs)
  eq(
    out,
    '<div>\n  <Icon c/>\n  <Icon a/>\n  <Icon b/>\n</div>',
    'self-closing nodes reorder cleanly'
  )
}

// --- no separator to borrow: a compact, no-whitespace-between-siblings file —
// preserve exactly what surrounds it, don't invent a newline where none existed ---
{
  const code = '<div><A/><B/><C/></div>'
  const ia = code.indexOf('<A/>')
  const ib = code.indexOf('<B/>')
  const ic = code.indexOf('<C/>')
  const a = node(ia, ia + 4)
  const b = node(ib, ib + 4)
  const c = node(ic, ic + 4)
  const children = [a, b, c] // no whitespace-only siblings at all
  const out = moveSiblingWithinParent(code, children, c, a, 'before', isWs)
  eq(out, '<div><C/><A/><B/></div>', 'no separator to borrow → none invented')
}

// --- defensive refusals ---
ok(
  moveSiblingWithinParent(listCode, listChildren, A, node(0, 0), 'before', isWs) === null,
  'target not present in children → null'
)
ok(
  moveSiblingWithinParent(listCode, listChildren, A, A, 'before', isWs) === null,
  'dragged === target → null (nothing to do)'
)

if (failed === 0) {
  console.log(
    'LAYERS-MOVE OK — splice reorder up/down, self-closing, indentation, no-separator fallback, refusals'
  )
} else {
  console.error(`LAYERS-MOVE: ${failed} assertion(s) failed`)
}
process.exitCode = failed === 0 ? 0 : 1
