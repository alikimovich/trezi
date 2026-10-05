import './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordCapture } from '../src/main/backends/record.ts'

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
      const session = {
        record: cap.record,
        pending: new Map(),
        finalize: cap.finalize,
        dispose() {},
        shutdown() {},
        send() {},
        interrupt: async () => context.onEvent({ type: 'done' })
      }
      providers.push({ root, context, session, options })
      return session
    }
  })
}))
const { registerAgentIpc, projectHasRunningAgents } = await import('../src/main/agent.ts')
registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
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
  for (const p of active) p.context.onEvent({ type: 'done' })
  await wait(() => parallel.every((r) => finished(r.spawnId)))
  assert.equal(readFileSync(join(repo, 'color.txt'), 'utf8'), 'purple\n')
  assert.equal(readFileSync(join(repo, 'border.txt'), 'utf8'), 'none\n')
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
