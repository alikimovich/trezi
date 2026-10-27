// LKM-363: chat-driven code navigation. `open_code` with a selected object's source
// stamp maps it read-only to its element or style sources with provenance, opens only
// one certain range, and the editor reveals it only in the asking project and chat.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cssRuleRanges, resolveCodeSources } from '../src/main/code-sources.ts'
import { openAgentCode } from '../src/main/code-tools.ts'
import {
  codeRevealTarget,
  NativeEditorController,
  revealRange
} from '../src/native/editor-controller.ts'

const CARD = [
  "import styles from './Card.module.css'",
  "import './global.css'",
  '',
  'export function Card({ title, rest }) {',
  '  return (',
  '    <section className={styles.card} style={{ padding: 8 }}>',
  '      <h2 className="title">{title}</h2>',
  '      <p className="muted extra">x</p>',
  '      <span className="plain">y</span>',
  '      <b {...rest}>z</b>',
  "      <i className={title ? 'on' : 'off'}>w</i>",
  "      <em style={{ color: 'red' }}>v</em>",
  '    </section>',
  '  )',
  '}',
  ''
].join('\n')
const FILES = {
  'src/Card.tsx': CARD,
  'src/Card.module.css': '.card {\n  display: grid;\n}\n.other { color: red }\n',
  'src/global.css':
    '/* .title in a comment */\n.title {\n  font-weight: 700;\n}\n.muted { color: gray }\n.extra,\n.muted:hover { color: black }\n',
  'src/App.tsx':
    'import { Card } from \'./Card\'\n\nexport default function App() {\n  return <Card title="Hi" />\n}\n',
  'index.html':
    '<!doctype html>\n<html>\n<head><style>\n.card { color: red }\n</style></head>\n<body>\n<div class="card" style="margin: 0">\n  <p>text</p>\n</div>\n</body>\n</html>\n',
  'node_modules/pkg/x.css': '.plain { color: red }\n',
  'notes.md': '# notes\n'
}

const root = await mkdtemp(join(tmpdir(), 'trezi-code-nav-'))
const outside = await mkdtemp(join(tmpdir(), 'trezi-code-nav-outside-'))
const snapshot = async () => {
  const seen = {}
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) seen[path] = await readFile(path, 'utf8')
    }
  }
  await walk(root)
  return seen
}
try {
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), text)
  }
  await writeFile(join(outside, 'Secret.tsx'), 'export const S = () => <div className="plain" />\n')
  await writeFile(join(outside, 'leak.css'), '.plain { color: red }\n.title { color: red }\n')
  await symlink(join(outside, 'Secret.tsx'), join(root, 'src/Escape.tsx'))
  await symlink(join(outside, 'leak.css'), join(root, 'src/leak.css'))
  await symlink(outside, join(root, 'src/linked'))
  const before = await snapshot()

  const events = []
  const call = (args) =>
    openAgentCode(root, '/live/project', 'chat-key', args, (channel, payload) =>
      events.push({ channel, payload })
    )
  const lines = (file, start, end) =>
    FILES[file]
      .split('\n')
      .slice(start - 1, end)
      .join('\n')
  const opened = async (args, file, startLine, endLine) => {
    const count = events.length
    const result = await call(args)
    assert.equal(result.requested, true, JSON.stringify({ args, result }))
    assert.equal(events.length, count + 1)
    const { channel, payload } = events.at(-1)
    assert.equal(channel, 'source:reveal')
    assert.deepEqual(
      {
        root: payload.root,
        key: payload.key,
        source: payload.source,
        startLine: payload.startLine,
        endLine: payload.endLine
      },
      { root: '/live/project', key: 'chat-key', source: `${file}:${startLine}`, startLine, endLine }
    )
    assert.equal(payload.code, lines(file, startLine, endLine))
    assert(typeof result.provenance === 'string' || args.file, 'source mode reports provenance')
    return result
  }
  const candidates = async (args, expected) => {
    const count = events.length
    const result = await call(args)
    assert.equal(result.requested, false, JSON.stringify({ args, result }))
    assert.equal(events.length, count, 'candidates open nothing')
    assert.match(result.message, /Nothing was opened/)
    assert.deepEqual(
      result.candidates.map((c) => [c.kind, c.file, c.startLine, c.endLine]),
      expected
    )
    for (const c of result.candidates)
      assert(c.provenance.length > 10, 'every candidate has provenance')
    return result
  }

  // JSX element: the whole element span from the stamp (column 0-based as JSX stamps are).
  await opened({ source: 'src/Card.tsx:6:4' }, 'src/Card.tsx', 6, 13)
  const h2 = await opened({ source: 'src/Card.tsx:7', target: 'element' }, 'src/Card.tsx', 7, 7)
  assert.equal(h2.element, 'h2')
  // Spread props do not move the element: the element target stays exact.
  await opened({ source: 'src/Card.tsx:10' }, 'src/Card.tsx', 10, 10)
  // HTML element (parse5, 1-based column as HTML stamps are).
  await opened({ source: 'index.html:7:1' }, 'index.html', 7, 9)
  await opened({ source: 'index.html:8' }, 'index.html', 8, 8)

  // CSS rule: one project rule for the literal class; comments and symlinked/vendored CSS ignored.
  const rule = await opened({ source: 'src/Card.tsx:7', target: 'styles' }, 'src/global.css', 2, 4)
  assert.match(rule.provenance, /Global CSS rule `\.title` in src\/global\.css/)
  // Inline style alone.
  const inline = await opened(
    { source: 'src/Card.tsx:12', target: 'styles' },
    'src/Card.tsx',
    12,
    12
  )
  assert.match(inline.provenance, /inline style/)
  // Utility classes no project rule defines: the class list itself, said so.
  const utility = await opened({ source: 'src/Card.tsx:9', target: 'styles' }, 'src/Card.tsx', 9, 9)
  assert.match(utility.provenance, /no project CSS rule matches/)
  // Shared component: its definition.
  const shared = await opened({ source: 'src/App.tsx:4', target: 'styles' }, 'src/Card.tsx', 4, 4)
  assert.match(shared.provenance, /shared component <Card> defined in src\/Card\.tsx/)

  // Multiple sources: inline style + CSS module rule; a rule matching two classes is one candidate.
  await candidates({ source: 'src/Card.tsx:6', target: 'styles' }, [
    ['inline-style', 'src/Card.tsx', 6, 6],
    ['css-rule', 'src/Card.module.css', 1, 3]
  ])
  await candidates({ source: 'src/Card.tsx:8', target: 'styles' }, [
    ['css-rule', 'src/global.css', 5, 5],
    ['css-rule', 'src/global.css', 6, 7]
  ])
  await candidates({ source: 'index.html:7', target: 'styles' }, [
    ['inline-style', 'index.html', 7, 7],
    ['css-rule', 'index.html', 4, 4]
  ])
  // Runtime CSS-module class names (Vite `_local_hash_line`) find the module's rule.
  await candidates({ source: 'src/App.tsx:4', target: 'styles', classes: ['_other_a1b2c_4'] }, [
    ['css-rule', 'src/Card.module.css', 4, 4],
    ['component', 'src/Card.tsx', 4, 4]
  ])

  // Ambiguous mapping: computed className is a candidate, never opened as exact.
  const computed = await candidates({ source: 'src/Card.tsx:11', target: 'styles' }, [
    ['class-attribute', 'src/Card.tsx', 11, 11]
  ])
  assert.equal(
    computed.notes.some((n) => /computed at runtime/.test(n)),
    true
  )
  // Spread props: no mapped style, nothing invented.
  const spread = await call({ source: 'src/Card.tsx:10', target: 'styles' })
  assert.equal(spread.requested, false)
  assert.deepEqual(spread.candidates, [])
  assert.match(spread.message, /do not guess/)
  assert(spread.notes.some((n) => /spread/.test(n)))
  // Stale stamp and unmapped file types: the stamp line as a candidate only.
  const stale = await candidates({ source: 'src/Card.tsx:2' }, [
    ['stamp-line', 'src/Card.tsx', 2, 2]
  ])
  assert.match(stale.notes.join(' '), /may have changed/)
  await candidates({ source: 'notes.md:1' }, [['stamp-line', 'notes.md', 1, 1]])
  await candidates({ source: 'index.html:7:9' }, [['stamp-line', 'index.html', 7, 7]])

  // A requested file still opens its exact range.
  await opened({ file: 'src/global.css', startLine: 2, endLine: 4 }, 'src/global.css', 2, 4)
  // Repeated selection: the same mapping again is a new request.
  const count = events.length
  await opened({ source: 'src/Card.tsx:7', target: 'styles' }, 'src/global.css', 2, 4)
  await opened({ source: 'src/Card.tsx:7', target: 'styles' }, 'src/global.css', 2, 4)
  assert.equal(events.length, count + 2)
  assert.notEqual(events.at(-1).payload.requestId, events.at(-2).payload.requestId)

  // Project-local only: traversal, absolute paths, symlinked files/folders and bad input.
  const quiet = events.length
  for (const args of [
    { source: '../outside/Secret.tsx:1' },
    { source: `${outside}/Secret.tsx:1` },
    { source: 'src/Escape.tsx:1', target: 'styles' },
    { source: 'src/linked/Secret.tsx:1' },
    { source: 'src/leak.css:1' },
    { source: 'src/Card.tsx' },
    { source: 'src/Card.tsx:7', target: 'layout' },
    { source: 42 },
    { file: 'src/linked/leak.css', startLine: 1 }
  ])
    assert((await call(args)).error, JSON.stringify(args))
  assert.equal(events.length, quiet)
  const leaked = await resolveCodeSources(root, 'src/Card.tsx:9', 'styles', ['plain', 'title'])
  assert(
    !leaked.candidates.some((c) => /leak|linked|node_modules/.test(c.file)),
    JSON.stringify(leaked)
  )
  assert.deepEqual(
    leaked.candidates.map((c) => c.file),
    ['src/global.css'],
    'runtime classes only add project rules'
  )
  assert.deepEqual(cssRuleRanges('a{}\n/* .x */\n.x,\n.y { b: c }', 'x'), [
    { startLine: 3, endLine: 4, selector: '.x, .y' }
  ])

  // Navigation never writes.
  assert.deepEqual(await snapshot(), before)
  console.log(
    'CODE-NAV OK — JSX/HTML elements, CSS rule, inline style, module, component, multiple + ambiguous candidates, stale stamps, repeat, boundaries, no writes'
  )
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}

// The editor reveals only in the asking project and chat, and only the exact lines.
const request = {
  root: '/live/a',
  key: 'chat-1',
  source: 'c.tsx:2',
  startLine: 2,
  endLine: 4,
  code: '  <div>\n    x\n  </div>',
  requestId: 'r1'
}
assert.deepEqual(codeRevealTarget(request, { root: '/live/a', chat: 'chat-1' }), {
  root: '/live/a',
  source: 'c.tsx:2',
  range: { startLine: 2, endLine: 4, code: request.code }
})
assert.equal(codeRevealTarget(request, { root: '/live/b', chat: 'chat-1' }), null, 'other project')
assert.equal(codeRevealTarget(request, { root: '/live/a', chat: 'chat-2' }), null, 'other chat')
assert.equal(codeRevealTarget(request, null), null, 'no active chat')
assert.equal(
  codeRevealTarget({ ...request, code: undefined }, { root: '/live/a', chat: 'chat-1' }),
  null
)

const view = (code, extra = {}) => ({ file: 'c.tsx', code, line: 1, ...extra })
const C = 'const C = () => (\n  <div>\n    x\n  </div>\n)\n'
const range = { startLine: 2, endLine: 4, code: request.code }
assert.deepEqual(revealRange({ view: view(C), baseline: C, text: C }, 'c.tsx:2', range).range, {
  startLine: 2,
  endLine: 4
})
const moved = `// draft line\n${C}`
assert.deepEqual(revealRange({ view: view(C), baseline: C, text: moved }, 'c.tsx:2', range).range, {
  startLine: 3,
  endLine: 5
})
const twice = revealRange({ view: view(C), baseline: C, text: `${C}${C}` }, 'c.tsx:2', {
  ...range,
  startLine: 9,
  endLine: 11
})
assert.equal(twice.range, null)
assert.match(twice.error, /more than once/)
const missing = revealRange({ view: view(C), baseline: C, text: 'other\n' }, 'c.tsx:2', range)
assert.equal(missing.range, null)
assert.match(missing.error, /does not contain the requested code/)
const span = view(C, { line: 2, elementStart: 2, elementEnd: 4 })
assert.deepEqual(revealRange({ view: span, baseline: C, text: C }, 'c.tsx:2').range, {
  startLine: 2,
  endLine: 4
})
assert.equal(revealRange({ view: span, baseline: C, text: C }, 'c.tsx:9').range, null)
assert.equal(
  revealRange({ view: span, baseline: C, text: C.replace('    x', '    y') }, 'c.tsx:2').range,
  null,
  'an edited span is not claimed'
)

const files = new Map([
  ['c.tsx', C],
  ['d.css', '.d { color: red }\n']
])
const calls = [],
  states = []
const editor = new NativeEditorController(
  async (channel, _root, source) => {
    calls.push(channel)
    if (channel === 'source:tree') return [...files.keys()]
    if (channel === 'source:read') {
      const file = source.replace(/:\d+(?::\d+)?$/, '')
      const line = Number(source.match(/:(\d+)/)?.[1] ?? 1)
      if (!files.has(file)) return null
      const stamped = file === 'c.tsx' && line >= 2 && line <= 4
      return view(files.get(file), {
        file,
        line,
        ...(stamped ? { elementStart: 2, elementEnd: 4 } : {})
      })
    }
  },
  (state) => states.push(structuredClone(state))
)
const at = () => states.at(-1)
await editor.open('/live/a', 'c.tsx:2', undefined, false, range)
assert.deepEqual(at().range, { startLine: 2, endLine: 4 })
const first = at().reveal
// Repeated selection of the same range reveals again.
await editor.open('/live/a', 'c.tsx:2', undefined, false, range)
assert.deepEqual(at().range, { startLine: 2, endLine: 4 })
assert.equal(at().reveal, first + 1)
// A preview stamp without a range selects its element's span.
await editor.open('/live/a', 'c.tsx:3')
assert.deepEqual(at().range, { startLine: 2, endLine: 4 })
// Dirty buffer: navigation to another file and back keeps the draft, never saves it.
await editor.action({ action: 'edit', root: '/live/a', source: 'c.tsx', revision: 5, text: moved })
const navigating = calls.length
await editor.action({
  action: 'open',
  root: '/live/a',
  source: 'd.css:1',
  range: { startLine: 1, endLine: 1, code: '.d { color: red }' }
})
assert.deepEqual(at().range, { startLine: 1, endLine: 1 })
await editor.open('/live/a', 'c.tsx:2', undefined, false, range)
assert.equal(at().text, moved)
assert.equal(at().dirty, true)
assert.deepEqual(at().range, { startLine: 3, endLine: 5 }, 'the draft is searched, not replaced')
await editor.open('/live/a', 'c.tsx:2', undefined, false, { ...range, code: 'gone' })
assert.equal(at().range, null)
assert.match(at().error, /does not contain/)
assert.equal(at().text, moved)
// (The edit's own debounced draft copy may land meanwhile; it is not a file write.)
const reads = ['source:tree', 'source:read', 'source:drafts', 'source:save-draft']
assert.deepEqual(
  calls.slice(navigating).filter((c) => !reads.includes(c)),
  [],
  'navigation only reads'
)
// Another project's editor is untouched by this one's reveals.
await editor.open('/live/b', 'd.css:1')
assert.equal(editor.session('/live/a').state.text, moved)
assert.equal(editor.session('/live/b').state.range, null)
console.log(
  'CODE-NAV EDITOR OK — chat/project scoping, exact + relocated range, element span, repeat, drafts kept, read-only'
)
