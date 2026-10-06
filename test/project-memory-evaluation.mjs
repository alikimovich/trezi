// Project memory evaluation (LKM-177): the evaluator prompt and its JSON protocol,
// Trezi's own pass over a proposal (source tags, the "token exists in code" guard),
// and the "Project memory updated" note with View and Undo. The model is always a
// stand-in here: no provider is called.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  memoryTranscriptDigest,
  parseProjectMemoryEvaluation,
  projectMemoryEvaluationPrompt
} from '../src/main/backends/memory.ts'
import { createProjectMemoryUpdateQueue, projectMemoryRules } from '../src/main/project-memory.ts'
import { refineProjectMemory, textInProject } from '../src/main/project-memory-evaluation.ts'
import {
  memoryChange,
  memoryChangeNote,
  stampProvenance,
  withoutProvenance
} from '../src/main/project-memory-format.ts'
import { showProjectMemoryNote } from '../src/native/memory-note.ts'

const ok = (condition, message) => {
  if (!condition) throw new Error(message)
}

const transcript = [
  { role: 'user', text: 'Use same-level chats. There is no Main chat.', at: 1 },
  { role: 'assistant', text: 'Implemented peer chats.', at: 2 }
]

const digest = memoryTranscriptDigest(transcript)
ok(digest.includes('User: Use same-level chats'), 'digest includes user decisions')
ok(digest.includes('Assistant: Implemented peer chats'), 'digest includes completed outcomes')

// --- The prompt carries the principles, the test, the format and the cleanup ---
const prompt = projectMemoryEvaluationPrompt('- Use a Main chat.', transcript)
ok(prompt?.includes('CURRENT MEMORY'), 'prompt includes current authoritative memory')
ok(prompt?.includes('credentials, secrets, tokens'), 'prompt excludes sensitive data')
ok(prompt?.includes('replaces the older item'), 'prompt lets a newer statement replace the old')
ok(
  /\(a\) Will it still be true next month\?/.test(prompt) &&
    /\(b\) Does it matter for a different, future task\?/.test(prompt) &&
    /\(c\) Is it impossible to discover by reading the code\?/.test(prompt),
  'prompt states the three-question test'
)
for (const heading of ['Preferences', 'Design rules', 'Constraints', 'Project facts', 'Pitfalls'])
  ok(prompt.includes(`## ${heading}`), `prompt names the ${heading} heading`)
ok(/One-off change requests/.test(prompt), 'prompt never stores one-off requests')
ok(/never a substitute for work/.test(prompt), 'prompt: memory is not the change')
ok(/"always", "from now on"/.test(prompt), 'prompt: requests become rules only when general')
ok(/At most about 40 items/.test(prompt), 'prompt bounds the item count')
ok(/CLEANUP/.test(prompt) && /already in the code/.test(prompt), 'prompt asks for cleanup')
ok(/Never write a tag yourself/.test(prompt), 'the model leaves source tags to Trezi')
ok(/Bad: "The Themer preview/.test(prompt), 'prompt shows a bad one-off example')
ok(/\{"memory":null\}/.test(prompt), 'the JSON protocol is unchanged')

ok(
  parseProjectMemoryEvaluation('{"memory":null}', '- Existing') === null,
  'null means no material update'
)
ok(
  parseProjectMemoryEvaluation(
    '```json\n{"memory":"# Decisions\\n\\n- Chats are peers."}\n```',
    '- Existing'
  ) === '# Decisions\n\n- Chats are peers.',
  'fenced JSON is accepted and yields complete markdown'
)
ok(
  parseProjectMemoryEvaluation('{"memory":"   "}', '- Existing') === null,
  'an evaluator cannot erase memory with an empty result'
)
ok(
  parseProjectMemoryEvaluation('not json', '- Existing') === null,
  'malformed model output fails closed'
)

// --- Source tags: Trezi stamps them; kept rules keep theirs ---
const stamped = stampProvenance(
  '## Preferences\n- Answer briefly. <!-- added 2026-09-01 -->\n- Ask before deleting branches.',
  '## Preferences\n- Answer briefly. <!-- added 1999-01-01 -->\n- Ask before deleting branches.\n- Check mobile width after UI changes.',
  '2026-10-06'
)
ok(
  stamped ===
    '## Preferences\n- Answer briefly. <!-- added 2026-09-01 -->\n- Ask before deleting branches.\n- Check mobile width after UI changes. <!-- added 2026-10-06 -->',
  `kept rules keep their tag, user rules stay untagged, new rules get today's: ${stamped}`
)
ok(!withoutProvenance(stamped).includes('<!--'), 'chats never see source tags')
ok(!projectMemoryRules(stamped).join('\n').includes('added 2026'), 'rules section is tag-free')
ok(
  memoryChangeNote('- A', '- A\n- B') === 'Project memory updated: +1 rule',
  'the note counts one added rule'
)
ok(
  memoryChangeNote('- A\n- B\n- C', '- A <!-- added 2026-10-06 -->') ===
    'Project memory updated: −2 rules',
  'the note counts removed rules; a tag alone is no change'
)
ok(memoryChange('- A.', '- a').added === 0, 'rules compare without case or final period')

// --- Fixtures: an existing memory from the operator Mac, then evaluator replies ---
const date = '2026-10-06'
const legacy = [
  '- The Themer preview should show only the Home screen with iPhone styling.',
  '- The Themer preview should use the same iPhone frame image as the device picker.',
  '- The bottom navigation should use an iOS 26+ glass tab bar.',
  '- Check the mobile width after every UI change.'
].join('\n')
// The cleanup the prompt asks for: one-off Themer requests are dropped, the general
// navigation style becomes a rule, the working preference is kept.
const cleaned = [
  '## Preferences',
  '- Check the mobile width after every UI change.',
  '',
  '## Design rules',
  '- Follow iOS 26 glass style for navigation.'
].join('\n')

/** The owner's contract (`propose` on the evaluated version, `restore` on the update's). */
function memoryStore(initial = '') {
  let version = 1
  let record = { content: initial, updatedAt: 1, digest: 'v1', revision: { value: 1 } }
  const write = (content) => {
    version += 1
    record = {
      content: content.trim(),
      updatedAt: version,
      digest: `v${version}`,
      revision: { value: version }
    }
    return record
  }
  return {
    get: async () => record,
    save: async (_root, content) => write(content),
    propose: async (_root, base, content) => {
      if (!content.trim()) throw new Error('A proposal cannot erase project memory.')
      return record.digest === base.digest ? write(content) : null
    },
    restore: async (_root, after, content) =>
      record.digest === after.digest ? write(content) : null
  }
}

/** A stand-in for the native toast: records notes and runs an action like a click. */
function toasts() {
  const shown = []
  return {
    shown,
    toast: (message, actions) => shown.push({ message, actions: [actions ?? []].flat() }),
    click: async (label) => {
      const last = shown.at(-1)
      await last.actions.find((a) => a.label === label).run()
    }
  }
}

const root = '/tmp/project-themer'
/** One evaluation, as `agent.ts` runs it: the model, then Trezi's pass, then the note. */
async function evaluate(store, reply, exists) {
  const notes = toasts()
  const viewed = []
  const queue = createProjectMemoryUpdateQueue(store, (update) =>
    showProjectMemoryNote(notes, update, {
      view: (r) => viewed.push(r),
      undo: (u) => store.restore(u.root, u.after, u.before.content)
    })
  )
  await queue.enqueue(root, async (current) =>
    refineProjectMemory(current, parseProjectMemoryEvaluation(reply(current), current), {
      roots: [],
      date,
      exists: exists ?? (async () => true)
    })
  )
  return { notes, viewed }
}
const json = (memory) => JSON.stringify({ memory })

{
  // Cleanup of an existing memory: Themer one-offs dropped, Undo restores them.
  const store = memoryStore(legacy)
  const { notes, viewed } = await evaluate(store, () => json(cleaned))
  const after = (await store.get()).content
  ok(!/Themer/.test(after), 'one-off Themer requests are dropped')
  ok(!/iPhone frame image/.test(after), 'the implemented frame request is dropped')
  ok(
    after.includes('- Follow iOS 26 glass style for navigation. <!-- added 2026-10-06 -->'),
    'the general navigation style becomes a tagged rule'
  )
  ok(
    after.includes('- Check the mobile width after every UI change.\n'),
    'the working preference is kept, without a tag the user never had'
  )
  ok(notes.shown.length === 1, 'the cleanup shows one note')
  ok(
    notes.shown[0].message === 'Project memory updated: +1 rule, −3 rules',
    `the note summarizes the cleanup: ${notes.shown[0].message}`
  )
  ok(
    notes.shown[0].actions.map((a) => a.label).join() === 'View,Undo',
    'the note offers View and Undo'
  )
  await notes.click('View')
  ok(viewed[0] === root, 'View opens the project memory editor')
  await notes.click('Undo')
  ok((await store.get()).content === legacy, 'Undo restores the memory before the cleanup')
  ok(notes.shown.at(-1).message === 'Project memory change undone', 'Undo confirms itself')
}

{
  // Issue #230: the token was "saved in memory" but never built — not stored.
  const store = memoryStore('## Preferences\n- Answer briefly.')
  const proposal = `## Preferences\n- Answer briefly.\n\n## Design rules\n- Pill-shaped controls use --radius-pill (9999px).`
  const missing = await evaluate(
    store,
    () => json(proposal),
    async () => false
  )
  ok(
    (await store.get()).content === '## Preferences\n- Answer briefly.',
    'a rule about a token missing from the code is not stored'
  )
  ok(missing.notes.shown.length === 0, 'nothing stored, so no note')

  // Once the chat added the token to the code, the same proposal becomes a rule.
  const built = await evaluate(
    store,
    () => json(proposal),
    async (t) => t === '--radius-pill'
  )
  const after = (await store.get()).content
  ok(
    after.includes('- Pill-shaped controls use --radius-pill (9999px). <!-- added 2026-10-06 -->'),
    'the token rule is stored, tagged, once the token exists in code'
  )
  ok(after.includes('- Answer briefly.'), 'the working preference is kept')
  ok(
    built.notes.shown[0].message === 'Project memory updated: +1 rule',
    'the automatic update shows "+1 rule"'
  )
  await built.notes.click('Undo')
  ok(
    (await store.get()).content === '## Preferences\n- Answer briefly.',
    'Undo removes the automatic rule'
  )

  // Undo after a later edit changes nothing and says so.
  const again = await evaluate(
    store,
    () => json(proposal),
    async () => true
  )
  await store.save(root, '- Edited by hand')
  await again.notes.click('Undo')
  ok((await store.get()).content === '- Edited by hand', 'Undo never overwrites a later edit')
  ok(/nothing was undone/.test(again.notes.shown.at(-1).message), 'a refused Undo tells the user')
}

{
  // A command-line flag in a preference is not a design token.
  const store = memoryStore('')
  await evaluate(
    store,
    () => json('## Preferences\n- Never run git push --force without asking.'),
    async () => false
  )
  ok((await store.get()).content.includes('--force'), 'flags outside design rules are kept')
}

// The search behind the guard: tracked and untracked files, never ignored ones.
{
  const dir = mkdtempSync(join(tmpdir(), 'trezi-memory-tokens-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'x.css'), ':root { --ghost-token: 1px }\n')
    ok(!(await textInProject([dir], '--radius-pill')), 'a missing token is not found')
    writeFileSync(join(dir, 'src', 'tokens.css'), ':root { --radius-pill: 9999px; }\n')
    ok(await textInProject([dir], '--radius-pill'), 'an untracked new token is found')
    ok(!(await textInProject([dir], '--ghost-token')), 'ignored folders do not count')
    ok(
      await textInProject([join(dir, 'missing-folder')], '--radius-pill'),
      'a search that cannot run never drops a rule'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(
  'PROJECT-MEMORY-EVALUATION OK — principles prompt, cleanup, token guard, source tags, View/Undo note'
)
