import './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { textEditMismatch } from '../src/main/text-edit-check.ts'
import { projectKey } from '../src/shared/projectKey.ts'
import { passCheck } from './helpers/gate-checks.mjs'

const temp = mkdtempSync(join(tmpdir(), 'trezi-comments-'))
process.env.TREZI_USER_DATA = join(temp, 'profile')
const repo = join(temp, 'repo')
mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
git('init', '-q')
git('config', 'user.name', 'Fixture')
git('config', 'user.email', 'fixture@example.test')
writeFileSync(join(repo, 'color.txt'), 'red\n')
writeFileSync(join(repo, 'border.txt'), 'solid\n')
git('add', '.')
git('commit', '-qm', 'Initial')
const providers = [],
  events = [],
  handlers = new Map()
mock.module('../src/main/backends/index.ts', () => ({
  pickProvider: () => ({
    supportsSpawn: true,
    startSession: async (root, options, window, context) => {
      const cap = createRecordCapture(root, 'fixture')
      const sent = []
      const session = {
        record: cap.record,
        pending: new Map(),
        pendingQuestions: new Map(),
        emit: (event) => events.push({ ...event, sessionId: context.sessionId }),
        finalize: cap.finalize,
        dispose() {},
        shutdown() {},
        send: (text) => sent.push(text),
        interrupt: async () => context.onEvent({ type: 'done' })
      }
      providers.push({ root, context, session, options, sent })
      return session
    }
  })
}))
const { registerAgentIpc, projectHasRunningAgents } = await import('../src/main/agent.ts')
const { applyTextEdit } = await import('../src/main/props.ts')
registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
// 'parent' is no open chat, so a spawn's tools (and its checks) run under the project key.
const parent = projectKey(repo)
const invoke = (name, ...args) => handlers.get(name)({}, ...args)
const start = () =>
  invoke('agent:spawn-comment', repo, 'Change color and border', 'parent', { provider: 'codex' })
const wait = async (condition) => {
  for (let i = 0; i < 400; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('Timed out waiting for comment lifecycle')
}
const finished = (id) => events.find((e) => e.type === 'spawn-finished' && e.sessionId === id)
try {
  const first = await start(),
    a = providers.at(-1)
  assert.equal(first.ok, true)
  assert.equal(a.options.model, 'gpt-6-sol')
  writeFileSync(join(a.root, 'color.txt'), 'blue\n')
  await passCheck(parent, a.root)
  a.context.onEvent({ type: 'done' })
  a.context.onEvent({ type: 'done' })
  assert.equal(projectHasRunningAgents(repo), true, 'Landing must remain busy')
  await wait(() => finished(first.spawnId))
  assert.equal(finished(first.spawnId).outcome, 'applied')
  assert.equal(readFileSync(join(repo, 'color.txt'), 'utf8'), 'blue\n')
  assert.equal(
    events.filter((e) => e.type === 'spawn-finished' && e.sessionId === first.spawnId).length,
    1
  )
  // LOCAL-WEBKIT-3: no passing check on its exact source, so nothing lands: the branch is
  // kept for review with the reason, and live is unchanged.
  const unchecked = await start(),
    u = providers.at(-1)
  writeFileSync(join(u.root, 'color.txt'), 'orange\n')
  u.context.onEvent({ type: 'done' })
  await wait(() => finished(unchecked.spawnId))
  assert.equal(finished(unchecked.spawnId).outcome, 'review')
  assert.ok(finished(unchecked.spawnId).branch)
  assert.match(finished(unchecked.spawnId).summary, /^Not applied: no check passed/)
  assert.equal(readFileSync(join(repo, 'color.txt'), 'utf8'), 'blue\n')
  // A check that passed, then an edit after it: the edit was never checked.
  const stale = await start(),
    v = providers.at(-1)
  writeFileSync(join(v.root, 'color.txt'), 'cyan\n')
  await passCheck(parent, v.root)
  writeFileSync(join(v.root, 'color.txt'), 'magenta\n')
  v.context.onEvent({ type: 'done' })
  await wait(() => finished(stale.spawnId))
  assert.equal(finished(stale.spawnId).outcome, 'review')
  assert.equal(readFileSync(join(repo, 'color.txt'), 'utf8'), 'blue\n')
  const empty = await start()
  providers.at(-1).context.onEvent({ type: 'done' })
  await wait(() => finished(empty.spawnId))
  assert.equal(finished(empty.spawnId).outcome, 'no-change')
  const failed = await start(),
    b = providers.at(-1)
  writeFileSync(join(b.root, 'color.txt'), 'green\n')
  b.context.onEvent({ type: 'error', message: 'Fixture failure' })
  b.context.onEvent({ type: 'done' })
  await wait(() => finished(failed.spawnId))
  assert.equal(finished(failed.spawnId).summary, 'Fixture failure')
  assert.equal(finished(failed.spawnId).outcome, 'failed')
  assert.ok(finished(failed.spawnId).branch)
  assert.equal(readFileSync(join(repo, 'color.txt'), 'utf8'), 'blue\n')
  const cancelled = await start()
  await invoke('agent:spawn-interrupt', cancelled.spawnId)
  await wait(() => finished(cancelled.spawnId))
  assert.equal(finished(cancelled.spawnId).outcome, 'cancelled')
  const parallel = await Promise.all([start(), start(), start(), start()])
  assert.equal(parallel.filter((r) => r.queued).length, 1, 'Fourth comment must queue')
  const queued = parallel.find((r) => r.queued)
  await invoke('agent:spawn-interrupt', queued.spawnId)
  assert.equal(finished(queued.spawnId).outcome, 'cancelled')
  const active = providers.slice(-3)
  writeFileSync(join(active[0].root, 'color.txt'), 'purple\n')
  writeFileSync(join(active[1].root, 'border.txt'), 'none\n')
  for (const p of active.slice(0, 2)) await passCheck(parent, p.root)
  for (const p of active) p.context.onEvent({ type: 'done' })
  await wait(() => parallel.every((r) => finished(r.spawnId)))
  // LOCAL-WEBKIT-3: the first lands. The second was checked on a base live no longer
  // has, so the merged result was never checked: it is kept for review, not applied.
  assert.equal(finished(active[0].context.sessionId).outcome, 'applied')
  assert.equal(finished(active[1].context.sessionId).outcome, 'review')
  assert.match(finished(active[1].context.sessionId).summary, /project changed since/)
  assert.equal(readFileSync(join(repo, 'color.txt'), 'utf8'), 'purple\n')
  assert.equal(readFileSync(join(repo, 'border.txt'), 'utf8'), 'solid\n')
  // LKM-193: a background agent's question settles through the chat's answer path, and
  // Cancel dismisses one still waiting.
  const asking = await start(),
    d = providers.at(-1)
  assert.equal(d.context.sessionId, asking.spawnId)
  const settled = []
  d.session.pendingQuestions.set('q-1', { settle: (answers) => settled.push(answers) })
  await invoke('agent:respond-question', 'q-1', { 'Which color?': 'Teal' })
  assert.deepEqual(settled, [{ 'Which color?': 'Teal' }])
  assert.ok(
    events.some(
      (e) => e.type === 'question-resolved' && e.id === 'q-1' && e.sessionId === asking.spawnId
    )
  )
  d.session.pendingQuestions.delete('q-1')
  d.session.pendingQuestions.set('q-2', { settle: (answers) => settled.push(answers) })
  await invoke('agent:spawn-interrupt', asking.spawnId)
  assert.deepEqual(settled.at(-1), null, 'Cancel dismisses the waiting question')
  await wait(() => finished(asking.spawnId))
  assert.equal(finished(asking.spawnId).outcome, 'cancelled')
  // LKM-352: an inline text edit's spawn gets the whole text; a mock agent copies what
  // the prompt carries into source. A full copy lands clean; a cut one lands reported.
  const typed =
    'I have a knack for finding and fixing unnecessary friction in processes and experiences. ' +
    'Before Remitly, I applied these qualities at Swiftly, building a cross-platform design ' +
    'system, and automating the "handoff" between design and engineering.'
  assert.ok(typed.length > 200)
  writeFileSync(join(repo, 'SelectedWork.tsx'), "const paragraphs = ['Old paragraph text.']\n")
  git('add', 'SelectedWork.tsx')
  git('commit', '-qm', 'Paragraphs')
  const textEdit = async (agent) => {
    const edit = await applyTextEdit(repo, { source: 'SelectedWork.tsx:1:20', text: typed })
    assert.equal(edit.needsAgent, true)
    const started = await invoke(
      'agent:spawn-comment',
      repo,
      edit.agentPrompt,
      'parent',
      { provider: 'codex' },
      'text-edit',
      undefined,
      edit.expectText
    )
    const p = providers.at(-1)
    const copied = /\n(`{3,})text\n([\s\S]*?)\n\1$/.exec(p.sent.at(-1))[2]
    writeFileSync(
      join(p.root, 'SelectedWork.tsx'),
      `const paragraphs = [${JSON.stringify(agent(copied))}]\n`
    )
    await passCheck(parent, p.root)
    p.context.onEvent({ type: 'done' })
    await wait(() => finished(started.spawnId))
    return finished(started.spawnId)
  }
  const full = await textEdit((text) => text)
  assert.equal(full.outcome, 'applied')
  assert.equal(full.origin, 'text-edit')
  assert.equal(full.mismatch, undefined, 'the full text landed')
  assert.equal(
    readFileSync(join(repo, 'SelectedWork.tsx'), 'utf8'),
    `const paragraphs = [${JSON.stringify(typed)}]\n`
  )
  const cut = await textEdit((text) => text.slice(0, 200))
  assert.equal(cut.outcome, 'applied')
  assert.equal(cut.mismatch, textEditMismatch(typed), 'a cut text is reported')
  const broken = await start(),
    c = providers.at(-1)
  rmSync(c.root, { recursive: true, force: true })
  c.context.onEvent({ type: 'done' })
  await wait(() => finished(broken.spawnId))
  assert.equal(finished(broken.spawnId).outcome, 'failed')
  await wait(() => !projectHasRunningAgents(repo))
  console.log(
    'Comment agents: real Git landing, no-change, duplicate terminals, failure recovery, cancellation and finalizer errors passed; no provider calls'
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
