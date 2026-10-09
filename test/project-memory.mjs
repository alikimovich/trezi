// Project memory's Bun side: the rules section, the one-time update, the per-project
// evaluation queue and per-session injection, against an in-memory stand-in for the
// owner. The owner itself (files, format, damaged files, stale revisions) is the Swift
// MemoryOwner: test/memory-owner.mjs.
import {
  createProjectMemoryInjection,
  createProjectMemoryUpdateQueue,
  MAX_PROJECT_MEMORY_CHARS,
  projectMemoryRules,
  projectMemoryUpdate
} from '../src/main/project-memory.ts'

const ok = (condition, message) => {
  if (!condition) throw new Error(message)
}
const rejects = async (promise, pattern, message) => {
  try {
    await promise
  } catch (error) {
    ok(pattern.test(error.message), `${message}: ${error.message}`)
    return
  }
  throw new Error(`${message}: did not reject`)
}

/** The owner's contract: `propose` commits only on the version it was evaluated against. */
function memoryStore() {
  const records = new Map()
  let version = 0
  const get = async (root) => records.get(root) ?? { content: '', updatedAt: 0, digest: 'absent' }
  const write = (root, content) => {
    const record = {
      content: content.trim().slice(0, MAX_PROJECT_MEMORY_CHARS),
      updatedAt: ++version,
      digest: `v${version}`
    }
    records.set(root, record)
    return record
  }
  return {
    get,
    save: async (root, content) => write(root, content),
    propose: async (root, base, content) => {
      if (!content.trim()) throw new Error('A proposal cannot erase project memory.')
      return (await get(root)).digest === base.digest ? write(root, content) : null
    }
  }
}

const store = memoryStore()
const a = '/tmp/project-a'

const rules = projectMemoryRules('Keep the rail calm.')
ok(rules.join('\n').includes('<project-memory>'), 'memory is clearly delimited')
ok(rules.join('\n').includes('Keep the rail calm.'), 'rules carry saved content')
ok(projectMemoryRules('').length === 0, 'empty memory injects no noise')
ok(
  projectMemoryRules('x'.repeat(MAX_PROJECT_MEMORY_CHARS + 50))
    .join('\n')
    .includes('x'.repeat(MAX_PROJECT_MEMORY_CHARS)),
  'rules carry bounded memory'
)
ok(
  !projectMemoryRules('x'.repeat(MAX_PROJECT_MEMORY_CHARS + 50))
    .join('\n')
    .includes('x'.repeat(MAX_PROJECT_MEMORY_CHARS + 1)),
  '… and no more'
)
ok(
  projectMemoryUpdate('Use detached worktrees.', 'Fix the card.').endsWith('Fix the card.'),
  'one-time updates preserve the user prompt'
)
ok(
  projectMemoryUpdate('', 'Continue.').includes('memory is now empty'),
  'clearing memory explicitly supersedes an older live-context snapshot'
)

const updates = createProjectMemoryUpdateQueue(store)
await store.save(a, '- Keep existing')
let releaseFirst
const firstGate = new Promise((resolve) => {
  releaseFirst = resolve
})
const first = updates.enqueue(a, async (current) => {
  await firstGate
  return `${current}\n- Learned from chat one`
})
const second = updates.enqueue(a, async (current) => `${current}\n- Learned from chat two`)
releaseFirst()
await Promise.all([first, second])
const merged = (await store.get(a)).content
ok(
  merged.includes('chat one') && merged.includes('chat two'),
  'peer-chat evaluations serialize and merge against the latest memory'
)

let releaseEvaluation,
  markEvaluationStarted,
  evaluations = 0
const evaluationGate = new Promise((resolve) => {
  releaseEvaluation = resolve
})
const evaluationStarted = new Promise((resolve) => {
  markEvaluationStarted = resolve
})
const guarded = updates.enqueue(a, async (current) => {
  evaluations += 1
  if (evaluations === 1) {
    markEvaluationStarted()
    await evaluationGate
  }
  return `${current}\n- Automatically learned`
})
// A user save during the model call is authoritative and forces one re-evaluation.
await evaluationStarted
await store.save(a, `${(await store.get(a)).content}\n- Manually edited`)
releaseEvaluation()
await guarded
const afterManual = (await store.get(a)).content
ok(afterManual.includes('Manually edited'), 'automatic updates preserve concurrent edits')
ok(
  afterManual.includes('Automatically learned'),
  'the re-evaluation merges on top of the manual edit'
)
ok(evaluations === 2, 'a concurrent edit re-evaluates once against current memory')

// Evaluation is best effort: a failing evaluator or owner changes nothing and never throws.
const beforeFailure = await store.get(a)
await updates.enqueue(a, async () => {
  throw new Error('model unavailable')
})
await createProjectMemoryUpdateQueue({
  ...store,
  get: async () => {
    throw new Error('owner unavailable')
  }
}).enqueue(a, async () => '- Generated')
ok((await store.get(a)) === beforeFailure, 'a failed evaluation is a no-op')
await rejects(
  store.propose(a, await store.get(a), '   '),
  /cannot erase/,
  'the stand-in keeps the owner contract'
)

// Injection: a live session receives changed memory once, on its next turn.
{
  const c = '/tmp/project-c'
  let broken = false
  const injection = createProjectMemoryInjection(() => ({
    ...store,
    get: async (root) => {
      if (broken) throw new Error('owner unavailable')
      return store.get(root)
    }
  }))
  await store.save(c, '- Initial')
  ok(
    (await injection.context(c, 's1')) === '- Initial',
    'a new session carries memory in its instructions'
  )
  ok((await injection.prompt(c, 's1', 'Hi')) === 'Hi', 'unchanged memory is not repeated')
  await store.save(c, '- Edited')
  const updated = await injection.prompt(c, 's1', 'Next')
  ok(
    updated.includes('- Edited') && updated.endsWith('Next'),
    'an edit is injected on the next turn'
  )
  ok((await injection.prompt(c, 's1', 'Again')) === 'Again', '… exactly once')
  ok((await injection.context(c, 's2')) === '- Edited', 'peer sessions are tracked separately')
  broken = true
  ok((await injection.context(c, 's3')) === '', 'unreadable memory never fails a new chat')
  ok((await injection.prompt(c, 's1', 'Down')) === 'Down', 'or a turn')
  broken = false
  ok(
    (await injection.prompt(c, 's3', 'Back')).includes('- Edited'),
    'memory arrives once it can be read'
  )
  await store.save(c, '')
  ok(
    (await injection.prompt(c, 's2', 'Cleared')).includes('memory is now empty'),
    'clearing memory is announced'
  )
  injection.forget('s1')
  ok(
    (await injection.prompt(c, 's1', 'Fresh')).includes('memory is now empty'),
    'a forgotten session is re-informed'
  )
}

console.log(
  'PROJECT-MEMORY OK — bounded, prompt-safe; evaluations serialized, stale ones re-evaluated; injected once per change'
)
