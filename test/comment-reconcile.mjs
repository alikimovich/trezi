// LKM-382: comments never cancel each other. Every comment forks from live when it
// starts, so the ones that finish after another landed bring themselves up to date with
// live (the checks run again on that exact tree, LOCAL-WEBKIT-3) and land with no Retry;
// overlapping lines go back to the comment's own agent on the new base. Real Git and the
// Swift repository owner; a mock provider, no provider calls.
import './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { projectKey } from '../src/shared/projectKey.ts'
import { passCheck, replayFixtureChecks } from './helpers/gate-checks.mjs'

const temp = mkdtempSync(join(tmpdir(), 'trezi-comment-reconcile-'))
process.env.TREZI_USER_DATA = join(temp, 'profile')
const repo = join(temp, 'repo')
mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
git('init', '-q')
git('config', 'user.name', 'Fixture')
git('config', 'user.email', 'fixture@example.test')
// Lines far enough apart that changes to different ones merge cleanly.
const LINES = Array.from({ length: 30 }, (_, i) => `line ${i}`)
const page = (changes = {}) => `${LINES.map((line, i) => changes[i] ?? line).join('\n')}\n`
writeFileSync(join(repo, 'page.txt'), page())
git('add', '.')
git('commit', '-qm', 'Initial')

const providers = [],
  events = [],
  handlers = new Map()
mock.module('../src/main/backends/index.ts', () => ({
  pickProvider: () => ({
    supportsSpawn: true,
    startSession: async (root, _options, _window, context) => {
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
      providers.push({ root, context, session, sent })
      return session
    }
  })
}))
const { registerAgentIpc, projectHasRunningAgents } = await import('../src/main/agent.ts')
registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
let replayPasses = true
const replays = replayFixtureChecks(() => replayPasses)
const parent = projectKey(repo)
const invoke = (name, ...args) => handlers.get(name)({}, ...args)
const wait = async (condition, what) => {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const finished = (id) => events.find((e) => e.type === 'spawn-finished' && e.sessionId === id)
const live = () => readFileSync(join(repo, 'page.txt'), 'utf8')
const read = (c) => readFileSync(join(c.p.root, 'page.txt'), 'utf8')

/** Starts one comment; its agent edits `changes` (line → text) and checks its work. */
async function comment(changes) {
  const started = await invoke('agent:spawn-comment', repo, 'Edit the page', 'parent', {
    provider: 'codex'
  })
  assert.equal(started.ok, true)
  assert.ok(!started.queued, 'at most three comments run at once')
  const p = providers.at(-1)
  writeFileSync(join(p.root, 'page.txt'), page(changes))
  await passCheck(parent, p.root)
  return { id: started.spawnId, p, changes }
}
/** The agent's turn ends; resolves once Trezi has either landed it or continued it. */
async function finish(c) {
  const sent = c.p.sent.length
  c.p.context.onEvent({ type: 'done' })
  await wait(() => finished(c.id) || c.p.sent.length > sent, 'the comment to land or continue')
  return finished(c.id) ?? { continued: c.p.sent.at(-1) }
}
/** The agent combines both sides as asked: every marker block becomes `text`. */
function resolve(c, line, text) {
  const current = read(c)
  assert.match(current, /<<<<<<< /, 'the overlap reaches the agent as conflict markers')
  const merged = current.replace(/<<<<<<< [^\n]*\n[\s\S]*?>>>>>>> [^\n]*\n/g, `${text}\n`)
  assert.equal(merged.split('\n')[line], text)
  writeFileSync(join(c.p.root, 'page.txt'), merged)
}
const applied = (result) => {
  assert.equal(result.outcome, 'applied', result.summary)
  assert.doesNotMatch(result.summary ?? '', /Not applied/)
}
const notApplied = () =>
  events.filter((e) => e.type === 'spawn-finished' && /Not applied/.test(e.summary ?? ''))

try {
  // Two comments on different lines of one file, finishing in either order.
  for (const order of [
    [0, 1],
    [1, 0]
  ]) {
    const pair = [await comment({ 2: 'A two' }), await comment({ 20: 'B twenty' })]
    const before = replays.length
    for (const i of order) applied(await finish(pair[i]))
    assert.equal(replays.length, before + 1, 'the later comment was checked again on live')
    assert.ok(
      pair.every((c) => c.p.sent.length === 1),
      'no agent rerun for a clean merge'
    )
    assert.equal(live(), page({ 2: 'A two', 20: 'B twenty' }))
    writeFileSync(join(repo, 'page.txt'), page())
    git('commit', '-qam', 'Reset fixture')
  }

  // Three comments on one file, finishing in every order.
  for (const order of [
    [0, 1, 2],
    [2, 0, 1],
    [1, 2, 0]
  ]) {
    const trio = [
      await comment({ 2: 'A two' }),
      await comment({ 12: 'B twelve' }),
      await comment({ 24: 'C twenty-four' })
    ]
    for (const i of order) applied(await finish(trio[i]))
    assert.equal(live(), page({ 2: 'A two', 12: 'B twelve', 24: 'C twenty-four' }))
    writeFileSync(join(repo, 'page.txt'), page())
    git('commit', '-qam', 'Reset fixture')
  }

  // Two comments on the SAME line: the later one goes back to its own agent with the
  // overlap on live's tree, then lands; the user is never asked.
  {
    const a = await comment({ 5: 'A five' })
    const b = await comment({ 5: 'B five' })
    applied(await finish(a))
    const next = await finish(b)
    assert.match(next.continued, /conflict markers/, 'the agent combines both sides')
    assert.equal(finished(b.id), undefined, 'still running, no Not applied card')
    assert.equal(projectHasRunningAgents(repo), true)
    resolve(b, 5, 'A and B five')
    const before = replays.length
    applied(await finish(b))
    assert.equal(replays.length, before + 1, 'the combined tree was checked before landing')
    assert.equal(live(), page({ 5: 'A and B five' }))
    writeFileSync(join(repo, 'page.txt'), page())
    git('commit', '-qam', 'Reset fixture')
  }

  // Three comments on the same line, finishing in any order: each later one is combined
  // on the newest live tree, again if another landed while its agent worked.
  {
    const a = await comment({ 8: 'A' })
    const b = await comment({ 8: 'B' })
    const c = await comment({ 8: 'C' })
    applied(await finish(b))
    assert.ok((await finish(c)).continued)
    assert.ok((await finish(a)).continued)
    resolve(c, 8, 'B+C')
    applied(await finish(c))
    // A combined against B only; C landed meanwhile, so it combines again.
    resolve(a, 8, 'B+A')
    assert.ok((await finish(a)).continued, 'combined again on the newest live')
    resolve(a, 8, 'B+C+A')
    applied(await finish(a))
    assert.equal(live(), page({ 8: 'B+C+A' }))
    writeFileSync(join(repo, 'page.txt'), page())
    git('commit', '-qam', 'Reset fixture')
  }

  assert.deepEqual(notApplied(), [], 'no comment ended as Not applied')

  // A true conflict the agent cannot combine (it leaves the markers): only now is the
  // user asked, and nothing lands.
  {
    const a = await comment({ 10: 'A ten' })
    const b = await comment({ 10: 'B ten' })
    applied(await finish(a))
    assert.ok((await finish(b)).continued)
    const left = await finish(b)
    assert.equal(left.outcome, 'review')
    assert.match(left.summary, /^Not applied: .*could not combine them \(page\.txt\)/)
    assert.equal(live(), page({ 10: 'A ten' }))
    writeFileSync(join(repo, 'page.txt'), page())
    git('commit', '-qam', 'Reset fixture')
  }

  // LOCAL-WEBKIT-3: a reconciled tree whose check fails on it never lands.
  {
    const a = await comment({ 3: 'A three' })
    const b = await comment({ 27: 'B twenty-seven' })
    applied(await finish(a))
    replayPasses = false
    const held = await finish(b)
    replayPasses = true
    assert.equal(held.outcome, 'review')
    assert.match(held.summary, /^Not applied: the check "command fixture-check" did not pass/)
    assert.equal(live(), page({ 3: 'A three' }))
  }
  await wait(() => !projectHasRunningAgents(repo), 'every comment to settle')
  console.log(
    'Comment reconcile: 2 and 3 comments in every order, same-line overlaps and a true conflict passed; no provider calls'
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
