// LKM-352, no desktop: an inline text edit that falls back to the background agent
// hands it the whole text (never the first 200 characters), quoted so quotes and
// backticks survive; a text over the inline limit is refused, not cut; and the
// landing check tells a full edit from a partial one. The landed spawn's report is
// covered end to end in comment-agents.mjs, the chat row in native-chat-controller.mjs.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTextEdit, textAgentPrompt } from '../src/main/props.ts'
import { applySvelteTextEdit } from '../src/main/props-svelte.ts'
import {
  TEXT_EDIT_MAX,
  textEditLanded,
  textEditMismatch,
  textEditTooLong
} from '../src/main/text-edit-check.ts'

/** The text a prompt's fenced block carries, as an agent would copy it. */
const fenced = (prompt) => {
  const m = /\n(`{3,})text\n([\s\S]*?)\n\1$/.exec(prompt)
  assert.ok(m, 'the prompt ends with a fenced text block')
  return m[2]
}

// A 1000-character text is in the prompt in full.
const long = Array.from({ length: 120 }, (_, i) => `word${String(i).padStart(4, '0')} `)
  .join('')
  .slice(0, 1000)
assert.equal(long.length, 1000)
const prompt = textAgentPrompt('/live/src/A.tsx:4:7', long, '/live')
assert.ok(prompt.includes(long), 'the whole 1000-character text is in the prompt')
assert.equal(fenced(prompt), long)
assert.match(prompt, /^In src\/A\.tsx:4:7, /, 'the source stays project-relative')
assert.match(prompt, /\(1000 characters\)/)

// Quotes, apostrophes and backtick runs survive: the fence is longer than any run.
const tricky = 'He said "it\'s ``` done" — and `x` ```` too'
const quoted = textAgentPrompt('src/A.tsx:1', tricky, '/live')
assert.equal(fenced(quoted), tricky)
assert.ok(quoted.includes('\n`````text\n'), 'a five-backtick fence around a four-backtick run')

// The case from the report: a paragraph from a `paragraphs` array rendered through
// `{children}` cannot be spliced, so the agent gets all of it and the text to check.
const root = await mkdtemp(join(tmpdir(), 'trezi-text-edit-agent-'))
try {
  await mkdir(join(root, 'src'))
  const original = 'Old paragraph text.'
  await writeFile(
    join(root, 'src/SelectedWork.tsx'),
    `import { WorkGridParagraph } from './WorkGridParagraph'

const paragraphs = ['I build tools.', '${original}']

export function SelectedWork() {
  return (
    <div>
      {paragraphs.map((p) => (
        <WorkGridParagraph key={p}>{p}</WorkGridParagraph>
      ))}
    </div>
  )
}
`
  )
  const child = `export function WorkGridParagraph({ children }) {
  return <p className="about">{children}</p>
}
`
  await writeFile(join(root, 'src/WorkGridParagraph.tsx'), child)
  const column = child.split('\n')[1].indexOf('<p') + 1
  const typed =
    'I have a knack for finding and fixing unnecessary friction in processes and experiences. ' +
    'Before Remitly, I applied these qualities at Swiftly, building a cross-platform design ' +
    'system, and automating the "handoff" between design and engineering so teams ship what ' +
    "they design — that's the work I love."
  assert.ok(typed.length > 200, `fixture text is ${typed.length} characters`)
  const result = await applyTextEdit(root, {
    source: `src/WorkGridParagraph.tsx:2:${column}`,
    text: `  ${typed.replace(/ /g, '\n  ')}  `
  })
  assert.equal(result.applied, false)
  assert.equal(result.needsAgent, true, 'expression children fall back to the agent')
  assert.equal(result.expectText, typed, 'whitespace-normalised, in full')
  assert.equal(fenced(result.agentPrompt), typed)
  assert.match(result.agentPrompt, /^In src\/WorkGridParagraph\.tsx:2:\d+, /)

  // A mock agent copies the fenced text into the array's string literal.
  const file = join(root, 'src/SelectedWork.tsx')
  const before = await readFile(file, 'utf8')
  const agent = (text) => before.replace(`'${original}'`, JSON.stringify(text))
  await writeFile(file, agent(fenced(result.agentPrompt)))
  const after = await readFile(file, 'utf8')
  assert.ok(after.includes(JSON.stringify(typed)), 'the full text is in the source')
  assert.equal(textEditLanded([after], result.expectText), true)
  // The old prompt's agent: only the first 200 characters land. The check reports it.
  const partial = agent(typed.slice(0, 200))
  assert.equal(textEditLanded([partial], result.expectText), false, 'a cut edit is a mismatch')
  assert.match(textEditMismatch(typed), new RegExp(`\\(${typed.length} characters\\)`))

  // Over the limit: refused with a message, never handed to the agent or cut.
  const huge = 'x'.repeat(TEXT_EDIT_MAX + 1)
  const refused = await applyTextEdit(root, { source: `src/WorkGridParagraph.tsx:2`, text: huge })
  assert.deepEqual(refused, {
    applied: false,
    refused: true,
    error: textEditTooLong(TEXT_EDIT_MAX + 1)
  })
  assert.match(refused.error, /20000/)
  const atLimit = await applyTextEdit(root, {
    source: `src/WorkGridParagraph.tsx:2:${column}`,
    text: 'y'.repeat(TEXT_EDIT_MAX)
  })
  assert.equal(atLimit.needsAgent, true, 'exactly at the limit still goes to the agent')
  assert.equal(fenced(atLimit.agentPrompt).length, TEXT_EDIT_MAX)

  // Svelte's fallback carries the text to check as well.
  await writeFile(join(root, 'src/Card.svelte'), '<p>{copy}</p>\n')
  const svelte = await applySvelteTextEdit(
    root,
    { source: 'src/Card.svelte:1:1', text: typed },
    { file: join(root, 'src/Card.svelte'), line: 1, column: 1 }
  )
  assert.equal(svelte.needsAgent, true)
  assert.equal(svelte.expectText, typed)
  assert.equal(fenced(svelte.agentPrompt), typed)
} finally {
  await rm(root, { recursive: true, force: true })
}

// How source spells rendered text: escapes, entities, JSX spacers, wrapping, case.
const want = 'It\'s "done" — <b> & more'
for (const [code, landed] of [
  [`<p>It&apos;s &quot;done&quot; &mdash; &lt;b&gt; &amp; more</p>`, true],
  [`const a = 'It\\'s "done" \\u2014 <b> & more'`, true],
  [`const a = "It's \\"done\\" — <b> & more"`, true],
  [`<p>\n  It's "done" —{' '}\n  &lt;b&gt; &#38; more\n</p>`, true],
  [`<p style={{ textTransform: 'uppercase' }}>IT'S "DONE" — <B> & MORE</p>`, true],
  [`<p>It's "done" — &lt;b&gt;</p>`, false]
])
  assert.equal(textEditLanded([code], want), landed, code)
assert.equal(textEditLanded([], ''), true, 'an emptied element has nothing to find')
assert.equal(textEditLanded(['other', `x ${want} y`], want), true, 'any edited file')

console.log(
  'Text edit agent: full text in the prompt, quoting, the inline limit and the landing check passed'
)
