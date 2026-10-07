// Code editor grammar highlighting (LKM-183): language detection, the category theme,
// incremental per-line tokenization with revision-tagged batches (driven by a small
// fake grammar, so it always runs) and Shiki's token output and typing cost on real
// TSX/CSS/Swift samples. The Shiki half prints SKIP when the package is not installed.
import assert from 'node:assert/strict'
import { SyntaxDocument } from '../src/main/syntax-document.ts'
import { syntaxLanguage } from '../src/main/syntax-languages.ts'
import { SYNTAX_CATEGORIES, SYNTAX_THEME, syntaxCategoryOf } from '../src/main/syntax-theme.ts'
import {
  SYNTAX_BATCH_LINES,
  SYNTAX_MARGIN,
  SyntaxController
} from '../src/native/syntax-controller.ts'
import { tsxSample } from '../src/native/syntax-sample.ts'

const category = (name) => SYNTAX_CATEGORIES.indexOf(name)

// --- Languages and theme ---
for (const [path, language] of [
  ['src/App.tsx', 'tsx'],
  ['src/a.ts', 'typescript'],
  ['a.mts', 'typescript'],
  ['index.js', 'javascript'],
  ['x.jsx', 'jsx'],
  ['styles/site.css', 'css'],
  ['s.scss', 'scss'],
  ['index.html', 'html'],
  ['package.json', 'json'],
  ['tsconfig.json', 'jsonc'],
  ['tsconfig.app.json', 'jsonc'],
  ['README.md', 'markdown'],
  ['doc.mdx', 'mdx'],
  ['App.svelte', 'svelte'],
  ['App.vue', 'vue'],
  ['Host.swift', 'swift'],
  ['ci.yml', 'yaml'],
  ['a.yaml', 'yaml'],
  ['install.sh', 'shellscript'],
  ['.zshrc', 'shellscript'],
  ['LICENSE', 'plaintext'],
  ['notes.txt', 'plaintext'],
  ['.gitignore', 'plaintext']
])
  assert.equal(syntaxLanguage(path), language, path)
assert.equal(syntaxCategoryOf('#000000'), 0)
assert.equal(syntaxCategoryOf('#000002'), category('keyword'))
assert.equal(syntaxCategoryOf('#00000a'), 10)
assert.equal(syntaxCategoryOf('#FF0000'), 0, 'foreign colours are plain')
assert.equal(syntaxCategoryOf('#0000FF'), 0, 'out-of-range categories are plain')
for (const rule of SYNTAX_THEME.settings.slice(1))
  assert.match(rule.settings.foreground, /^#0000[0-9A-F]{2}$/)

// --- A fake grammar: keywords, "strings", // and /* */ comments across lines ---
class State {
  constructor(comment) {
    this.comment = comment
  }
  equals(other) {
    return other instanceof State && other.comment === this.comment
  }
}
const OUTSIDE = new State(false),
  INSIDE = new State(true)
let calls = 0
const fake = {
  category: (metadata) => (metadata >>> 15) & 0x1ff,
  tokenizeLine2(line, state) {
    calls++
    const tokens = []
    const push = (start, kind) => tokens.push(start, category(kind) << 15)
    let comment = state?.comment ?? false,
      i = 0
    while (i < line.length) {
      if (comment) {
        push(i, 'comment')
        const end = line.indexOf('*/', i)
        if (end < 0) {
          i = line.length
          break
        }
        i = end + 2
        comment = false
        continue
      }
      const rest = line.slice(i)
      const match =
        /^\/\*/.exec(rest) ??
        /^\/\/.*/.exec(rest) ??
        /^"[^"]*"/.exec(rest) ??
        /^\b(?:const|let|function|return)\b/.exec(rest) ??
        /^[^/"a-z]+|^[a-z]+|^./.exec(rest)
      const text = match[0]
      if (text === '/*') {
        comment = true
        continue
      }
      push(
        i,
        text.startsWith('//')
          ? 'comment'
          : text.startsWith('"')
            ? 'string'
            : /^(const|let|function|return)$/.test(text)
              ? 'keyword'
              : 'plain'
      )
      i += text.length
    }
    return { tokens: Uint32Array.from(tokens), ruleStack: comment ? INSIDE : OUTSIDE }
  }
}
const lines = (count, line = (i) => `const value${i} = "text${i}" // note`) =>
  Array.from({ length: count }, (_, i) => line(i)).join('\n')
const decode = (doc, batch) => {
  const runs = []
  for (let i = 0; i < batch.runs.length; i += 3)
    runs.push([
      doc.text.slice(batch.runs[i], batch.runs[i] + batch.runs[i + 1]),
      SYNTAX_CATEGORIES[batch.runs[i + 2]]
    ])
  return runs
}

// Absolute offsets and merged runs.
{
  const doc = new SyntaxDocument('const a = "x"\nlet b // c')
  assert.equal(doc.tokenize(fake, doc.length), true)
  const batch = doc.batch(doc.pending(0, doc.length, 10), 1)
  assert.deepEqual(batch.spans, [0, doc.text.length], 'contiguous lines share one span')
  assert.deepEqual(decode(doc, batch), [
    ['const', 'keyword'],
    ['"x"', 'string'],
    ['let', 'keyword'],
    ['// c', 'comment']
  ])
  assert.equal(doc.settled, true)
}

// Typing in one line re-tokenizes that line only and sends only it.
{
  const doc = new SyntaxDocument(lines(100))
  doc.tokenize(fake, doc.length)
  doc.batch(doc.pending(0, doc.length, 1000), 1)
  calls = 0
  const next = doc.text.replace('value50 =', 'value50x =')
  assert.equal(doc.update(next), 50)
  doc.tokenize(fake, doc.length)
  assert.equal(calls, 1, `one line re-tokenized (got ${calls})`)
  assert.deepEqual(doc.pending(0, doc.length, 1000), [50])
  doc.batch([50], 2)
  // A new line in the middle shifts the rest without re-tokenizing it.
  calls = 0
  doc.update(next.replace('// note\nconst value60', '// note\nlet extra\nconst value60'))
  doc.tokenize(fake, doc.length)
  assert.equal(calls, 1)
  assert.deepEqual(doc.pending(0, doc.length, 1000), [60])
  const batch = doc.batch([60], 2)
  assert.deepEqual(decode(doc, batch), [['let', 'keyword']])
  assert.equal(doc.text.slice(batch.spans[0], batch.spans[0] + batch.spans[1]), 'let extra')
}

// Opening a block comment re-tokenizes to the end; closing it converges again.
{
  const doc = new SyntaxDocument(lines(200))
  doc.tokenize(fake, doc.length)
  doc.batch(doc.pending(0, doc.length, 1000), 1)
  calls = 0
  const open = doc.text.replace('const value10 =', '/* const value10 =')
  doc.update(open)
  doc.tokenize(fake, doc.length)
  assert.equal(calls, 190, 'every line after the opened comment')
  assert.equal(doc.pending(0, doc.length, 1000).length, 190)
  const batch = doc.batch(doc.pending(0, doc.length, 1000), 2)
  assert.ok(decode(doc, batch).every(([, kind]) => kind === 'comment'))
  calls = 0
  doc.update(open.replace('note\nconst value20 =', 'note */\nconst value20 ='))
  doc.tokenize(fake, doc.length)
  assert.equal(calls, 181, 'the closing line (19), then every line after it')
  calls = 0
  doc.update(doc.text.replace('const value150 =', 'let value150 ='))
  doc.tokenize(fake, doc.length)
  assert.equal(calls, 1, 'converges right after a local edit again')
}

// Deadlines slice the work; a dropped result and a replaced text are sent again.
{
  const doc = new SyntaxDocument(lines(2000))
  assert.equal(
    doc.tokenize(fake, doc.length, performance.now() - 1),
    false,
    'one line per expired slice'
  )
  assert.equal(doc.valid, 1)
  doc.tokenize(fake, doc.length)
  doc.batch(doc.pending(0, 10, 1000), 3)
  doc.batch(doc.pending(10, 20, 1000), 4)
  assert.equal(doc.pending(0, 20, 1000).length, 0)
  doc.dropped(3)
  assert.deepEqual(doc.pending(0, 20, 1000), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  doc.batch(doc.pending(0, 10, 1000), 5)
  doc.reset(5)
  assert.deepEqual(doc.pending(0, 20, 1000), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  doc.reset()
  assert.equal(doc.pending(0, doc.length, 5000).length, 2000)
}

// --- The controller: visible lines first, revisions, stale results ---
{
  const sent = []
  const controller = new SyntaxController(
    (message) => sent.push(message),
    async () => fake
  )
  const text = lines(3000)
  controller.document('/p', 'big.ts', text, 7, true)
  controller.report('/p', { source: 'big.ts', first: 2000, last: 2040 })
  await controller.idle('/p')
  assert.ok(sent.length >= 3000 / SYNTAX_BATCH_LINES, `${sent.length} batches`)
  const firstLine = (message) => text.slice(0, message.spans[0]).split('\n').length - 1
  assert.equal(firstLine(sent[0]), 2000 - SYNTAX_MARGIN, 'the visible lines and margin come first')
  assert.ok(
    sent.every((m) => m.revision === 7 && m.source === 'big.ts' && m.language === 'typescript')
  )
  const covered = sent.reduce((sum, m) => sum + m.lines, 0)
  assert.equal(covered, 3000, 'every line is sent exactly once')
  // An edit sends only the changed line, tagged with the new revision.
  sent.length = 0
  controller.document('/p', 'big.ts', text.replace('value2010 =', 'value2010x ='), 8, true)
  await controller.idle('/p')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].revision, 8)
  assert.equal(sent[0].lines, 1)
  // The editor dropped revision 8 (it was already at 9): the line goes again for 9.
  sent.length = 0
  controller.document('/p', 'big.ts', text.replace('value2010 =', 'value2010xy ='), 9, true)
  controller.report('/p', { source: 'big.ts', dropped: 8 })
  await controller.idle('/p')
  assert.ok(sent.every((m) => m.revision === 9))
  // An older state never moves the document back; another file starts over.
  sent.length = 0
  controller.document('/p', 'big.ts', text, 8, true)
  await controller.idle('/p')
  assert.equal(sent.length, 0)
  controller.document('/p', 'notes.txt', 'plain words', 1, true)
  await controller.idle('/p')
  assert.equal(sent.length, 0, 'plain text sends nothing')
  // A missing highlighter is reported once per document and sends nothing.
  const warnings = []
  const broken = new SyntaxController(
    (message) => sent.push(message),
    async () => {
      throw new Error("Cannot find package 'shiki'")
    },
    (message) => warnings.push(message)
  )
  broken.document('/q', 'a.ts', 'const a = 1', 1, true)
  await broken.idle('/q')
  assert.equal(sent.length, 0)
  assert.match(warnings[0], /Syntax highlighting unavailable: Cannot find package 'shiki'/)
}

// --- Shiki: real grammars ---
let shiki
try {
  shiki = await import('../src/main/syntax-shiki.ts')
  await shiki.syntaxTokenizer('css')
} catch (error) {
  console.log(
    `SYNTAX-HIGHLIGHT SKIP — Shiki token and typing checks not run: ${String(error.message).split('\n')[0]}`
  )
  console.log('SYNTAX-HIGHLIGHT OK — languages, theme, incremental tokenization and controller')
  process.exit(0)
}
const highlight = async (language, text) => {
  const doc = new SyntaxDocument(text)
  doc.tokenize(await shiki.syntaxTokenizer(language), doc.length)
  return { doc, runs: decode(doc, doc.batch(doc.pending(0, doc.length, doc.length), 1)) }
}
const expect = (runs, expected, label) => {
  for (const [text, kind] of expected)
    assert.ok(
      runs.some(([t, k]) => k === kind && t.includes(text)),
      `${label}: ${JSON.stringify(text)} as ${kind}; got ${JSON.stringify(runs.filter(([t]) => t.includes(text)))}`
    )
}
{
  const { runs } = await highlight(
    'tsx',
    [
      "import { useState } from 'react'",
      'interface Props { label: string }',
      '// a comment',
      'export function Counter({ label }: Props) {',
      '  const [count, setCount] = useState(42)',
      '  const pattern = /ab+c/g',
      '  return <div className="row">{`${label}: ${count}`}<Button onClick={() => setCount(count + 1)} /></div>',
      '}'
    ].join('\n')
  )
  expect(
    runs,
    [
      ['import', 'keyword'],
      ["'react'", 'string'],
      ['interface', 'keyword'],
      ['Props', 'typeDeclaration'],
      ['string', 'type'],
      ['// a comment', 'comment'],
      ['Counter', 'declaration'],
      ['useState', 'function'],
      ['42', 'number'],
      ['ab+c', 'regex'],
      ['div', 'tag'],
      ['className', 'attribute'],
      ['"row"', 'string'],
      ['${', 'embedded'],
      ['Button', 'type'],
      ['onClick', 'attribute']
    ],
    'TSX'
  )
}
{
  const { runs } = await highlight(
    'css',
    '/* card */\n.card:hover {\n  color: #ff0000;\n  margin: 4px auto;\n  display: flex !important;\n}\n@media (min-width: 600px) { a { color: red } }'
  )
  expect(
    runs,
    [
      ['/* card */', 'comment'],
      ['card', 'attribute'],
      ['color', 'property'],
      ['#ff0000', 'constant'],
      ['4', 'number'],
      ['flex', 'constant'],
      ['@media', 'preprocessor']
    ],
    'CSS'
  )
}
{
  const { runs } = await highlight(
    'swift',
    'import AppKit\n/// Docs\nstruct Point: Equatable {\n    @MainActor var x = 1.5\n    func moved(by delta: Double) -> Point { Point(x: x + delta) }\n}\nlet label = "x = \\(1)"'
  )
  expect(
    runs,
    [
      ['import', 'keyword'],
      ['/// Docs', 'comment'],
      ['struct', 'keyword'],
      ['Point', 'typeDeclaration'],
      ['1.5', 'number'],
      ['func', 'keyword'],
      ['moved', 'declaration'],
      ['Double', 'type'],
      ['"x = ', 'string'],
      ['@MainActor', 'preprocessor']
    ],
    'Swift'
  )
}
for (const [language, text, sample] of [
  ['json', '{ "name": "trezi", "n": 1 }', ['"name"', 'property']],
  ['markdown', '# Title\n\nSome **bold** text', ['Title', 'heading']],
  ['yaml', 'name: ci\non: [push]', ['name', 'property']],
  ['shellscript', 'echo "hi" # note', ['# note', 'comment']],
  ['html', '<a href="x">y</a>', ['href', 'attribute']],
  ['svelte', '<script>let a = 1</script>\n{#if a}<p>{a}</p>{/if}', ['let', 'keyword']],
  [
    'vue',
    '<template><p :title="a">{{ a }}</p></template>\n<script setup>const a = 1</script>',
    ['const', 'keyword']
  ],
  ['scss', '$gap: 4px;\n.a { margin: $gap; }', ['margin', 'property']],
  ['jsonc', '// c\n{ "a": 1 }', ['// c', 'comment']],
  ['mdx', '# Hi\n\nimport X from "./x"', ['Hi', 'heading']],
  ['javascript', 'const a = 1', ['const', 'keyword']],
  ['jsx', 'const a = <b>x</b>', ['b', 'tag']],
  ['typescript', 'type A = number', ['type', 'keyword']]
]) {
  const { runs } = await highlight(language, text)
  expect(runs, [sample], language)
}

// Typing cost on a 3,000-line TSX file: the first full pass, then one keystroke's re-tokenization.
{
  const text = tsxSample(3000)
  const tokenizer = await shiki.syntaxTokenizer('tsx')
  const doc = new SyntaxDocument(text)
  let started = performance.now()
  doc.tokenize(tokenizer, doc.length)
  const full = performance.now() - started
  doc.batch(doc.pending(0, doc.length, doc.length), 1)
  const times = []
  let current = text
  const at = current.indexOf('const total') + 'const total'.length
  for (let i = 0; i < 40; i++) {
    current = `${current.slice(0, at + i)}x${current.slice(at + i)}`
    started = performance.now()
    doc.update(current)
    doc.tokenize(tokenizer, doc.length)
    const pending = doc.pending(0, doc.length, SYNTAX_BATCH_LINES)
    doc.batch(pending, i + 2)
    times.push(performance.now() - started)
    assert.ok(pending.length <= 2, `one keystroke resends ${pending.length} lines`)
  }
  times.sort((a, b) => a - b)
  const p95 = times[Math.floor(times.length * 0.95)]
  console.log(
    `SYNTAX-HIGHLIGHT perf: 3000-line TSX full pass ${full.toFixed(1)} ms, keystroke p95 ${p95.toFixed(2)} ms, max ${times.at(-1).toFixed(2)} ms`
  )
  assert.ok(p95 < 16, `keystroke re-tokenization p95 ${p95.toFixed(2)} ms`)
}
console.log(
  'SYNTAX-HIGHLIGHT OK — languages, theme, incremental tokenization, controller and Shiki tokens'
)
