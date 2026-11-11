// LKM-639: phase timing of one inspector Apply (`text-edit` spawn) through the real
// agent.ts spawn path and the real Swift owners (worktree, lease, gate, landing), with a
// fake provider standing in for the model. Measures Trezi's own overhead around the model
// on the owner's primary case, `padding: 2rem` → `0.75rem`: cold (first spawn of the
// process) vs warm, and idle vs a repository lease held by another operation. Asserts the
// spans are attributed where the time went and never double counted. Model time here is
// the fixture's, not a provider's: it is unmeasured by this suite.
import './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privatePageId } from '../src/main/agent-browser.ts'
import {
  agentRuntimes,
  ensureAgentRuntime,
  installAgentRuntimes
} from '../src/main/agent-runtime.ts'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { enqueueRepoWrite } from '../src/main/repo-write-queue.ts'
import { sourceSnapshot } from '../src/main/source-snapshot.ts'
import { finishedSpawnPhases, landingStepFields, spawnSpans } from '../src/main/spawn-phases.ts'
import { setSpawnPrewarm } from '../src/main/spawn-prewarm.ts'
import { newReceiptId, receiptSession, recordReceipt } from '../src/main/verification-receipts.ts'
import { projectKey } from '../src/shared/projectKey.ts'
import { passCheck } from './helpers/gate-checks.mjs'

const temp = mkdtempSync(join(tmpdir(), 'trezi-spawn-phases-'))
process.env.TREZI_USER_DATA = join(temp, 'profile')
const repo = join(temp, 'repo')
mkdirSync(join(repo, 'src'), { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
git('init', '-q')
git('config', 'user.name', 'Fixture')
git('config', 'user.email', 'fixture@example.test')
const CSS = '.card {\n  display: grid;\n  padding: 2rem;\n}\n'
writeFileSync(join(repo, 'src', 'card.css'), CSS)
git('add', '.')
git('commit', '-qm', 'Initial')

/** How long the fake "model" takes before its edit and after it (ms). */
let modelDelay = 0
/** Whether the fixture is a web project, whose landing check needs its private server. */
let web = false
/** A private dev server's cold start: Next 15's measured "Ready" on a minimal app (~2 s). */
const SERVER_START_MS = 2000
/** How long the agent's check waited for its private server, per worktree. */
const serverWaits = new Map()
const runtimeCalls = []
/** A verified preview_verify receipt on the worktree's exact source and server generation. */
async function passBrowserCheck(emitKey, root, server) {
  const snapshot = await sourceSnapshot(root)
  recordReceipt(receiptSession(emitKey, projectKey(root)), {
    id: newReceiptId(),
    createdAt: new Date().toISOString(),
    engine: 'webkit',
    engineDetail: 'fixture',
    input: 'synthetic-dom',
    coverage: {
      engine: 'webkit',
      os: 'macOS',
      emulated: { viewport: '', colorScheme: '' },
      notCovered: []
    },
    runtime: {
      kind: 'private',
      agent: server.agent,
      root,
      url: server.url,
      generation: server.generation
    },
    source: {
      snapshot: snapshot.id,
      tree: snapshot.tree,
      head: snapshot.head,
      dirty: snapshot.dirty
    },
    document: { url: `${server.url}/`, navigation: 1, startedAt: new Date().toISOString() },
    viewport: { width: 1280, height: 800, theme: 'light' },
    steps: [],
    checks: [{ index: 0, check: 'fixture', pass: true, expected: null, actual: null, ms: 1 }],
    artifacts: [],
    checksPassed: true,
    verified: true,
    reason: null,
    ms: 1
  })
}
let generation = 0
await installAgentRuntimes({
  async detect() {
    return web
      ? { previewKind: 'web', framework: 'next', devCommand: 'next dev', setupRequired: false }
      : { previewKind: 'none', framework: 'none', devCommand: '', setupRequired: false }
  },
  async startAgent(opts) {
    runtimeCalls.push(['start', opts.agent])
    await new Promise((r) => setTimeout(r, SERVER_START_MS))
    return {
      url: `http://127.0.0.1:${4100 + generation}`,
      pid: 1,
      agent: opts.agent,
      generation: ++generation
    }
  },
  async stopAgent(agent) {
    runtimeCalls.push(['stop', agent])
  },
  async stopAgents(agent) {
    runtimeCalls.push(['stop', agent ?? null])
    return 0
  },
  onAgentExit() {},
  onAgentLog() {}
})
const events = [],
  handlers = new Map(),
  providers = []
const parent = projectKey(repo)
mock.module('../src/main/backends/index.ts', () => ({
  pickProvider: () => ({
    supportsSpawn: true,
    startSession: async (root, _options, _window, context) => {
      const cap = createRecordCapture(root, 'fixture')
      const session = {
        record: cap.record,
        pending: new Map(),
        pendingQuestions: new Map(),
        emit: () => {},
        finalize: cap.finalize,
        dispose() {},
        shutdown() {},
        // The fixture "model": edit the one declaration, record a passing check, finish.
        send: () => {
          void (async () => {
            await new Promise((r) => setTimeout(r, modelDelay))
            const file = join(root, 'src', 'card.css')
            writeFileSync(
              file,
              readFileSync(file, 'utf8').replace(/padding: [^;]+;/, 'padding: 0.75rem;')
            )
            cap.noteTool('Edit', { file_path: file })
            context.onEvent?.({ type: 'status', text: 'Edit' })
            // A web project's check (preview_verify) first needs the worktree's private
            // server, under its private page's id, exactly as the page asks for it.
            if (web) {
              const asked = Date.now()
              const server = await ensureAgentRuntime(privatePageId(context.emitKey, root), root)
              serverWaits.set(root, Date.now() - asked)
              await passBrowserCheck(context.emitKey, root, server)
            } else await passCheck(parent, root)
            await new Promise((r) => setTimeout(r, modelDelay))
            context.onEvent?.({ type: 'done' })
          })()
        },
        interrupt: async () => context.onEvent({ type: 'done' })
      }
      providers.push({ root, context, session })
      return session
    }
  })
}))
const { registerAgentIpc } = await import('../src/main/agent.ts')
registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
const invoke = (name, ...args) => handlers.get(name)({}, ...args)
const wait = async (condition) => {
  for (let i = 0; i < 1500; i++) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('Timed out waiting for the Apply to finish')
}
const finished = (id) => events.find((e) => e.type === 'spawn-finished' && e.sessionId === id)
const reset = () => {
  writeFileSync(join(repo, 'src', 'card.css'), CSS)
  git('add', '.')
  git('commit', '-qm', 'Reset', '--allow-empty')
}
async function apply(label) {
  const started = Date.now()
  const result = await invoke(
    'agent:spawn-comment',
    repo,
    'Apply this single batch of Styles preview drafts: set padding to 0.75rem',
    'parent',
    { provider: 'claude' },
    'text-edit',
    'Apply padding: 0.75rem on <div> in card.css',
    undefined,
    { kind: 'inspector-apply', summary: 'padding: 0.75rem on <div> in card.css' }
  )
  assert.equal(result.ok, true)
  await wait(() => finished(result.spawnId))
  const wall = Date.now() - started
  assert.equal(finished(result.spawnId).outcome, 'applied', label)
  assert.match(readFileSync(join(repo, 'src', 'card.css'), 'utf8'), /padding: 0\.75rem;/)
  const timeline = finishedSpawnPhases(result.spawnId)
  assert.ok(timeline, `${label}: phases recorded under the operation id`)
  const spans = spawnSpans(timeline)
  const parts = Object.entries(spans)
    .filter(([name]) => name !== 'totalMs')
    .reduce((sum, [, ms]) => sum + ms, 0)
  assert.equal(parts, spans.totalMs, `${label}: spans add up to the total, none counted twice`)
  assert.ok(spans.totalMs <= wall + 5, `${label}: total within the observed wall time`)
  assert.equal(timeline.checks, 1, `${label}: the agent's check is attributed`)
  for (const mark of [
    'admitted',
    'lane',
    'worktree',
    'provider',
    'sent',
    'first-edit',
    'model-done',
    'lease'
  ])
    assert.ok(timeline.marks[mark] !== undefined, `${label}: ${mark} reached`)
  const steps = landingStepFields(timeline)
  const stepSum = Object.values(steps).reduce((sum, ms) => sum + ms, 0)
  assert.ok(stepSum <= spans.landingMs + 5, `${label}: landing steps are parts of landing`)
  const root = providers.at(-1).root
  spans.serverWaitMs = serverWaits.get(root) ?? 0
  await wait(() => !agentRuntimes().length)
  console.log(
    `${label}: wall=${wall}ms ${JSON.stringify(spans)} checkMs=${timeline.checkMs} landing=${JSON.stringify(steps)}`
  )
  reset()
  return { ...spans, steps }
}

try {
  const cold = await apply('cold idle')
  const warm = await apply('warm idle')
  // A model that takes 300 ms each side of its edit: it shows up as model time only.
  modelDelay = 300
  const slow = await apply('warm idle, 600 ms fixture model')
  assert.ok(slow.toFirstEditMs + slow.modelMs >= 590, 'fixture model time lands in the model spans')
  assert.ok(slow.worktreeMs < slow.toFirstEditMs + slow.modelMs + warm.worktreeMs + 1000)
  modelDelay = 0
  // Occupied: another repository operation holds the lease for 400 ms when Apply starts.
  let release
  const held = enqueueRepoWrite(repo, () => new Promise((r) => (release = r)))
  setTimeout(() => release(), 400)
  const occupied = await apply('warm, repository lease held 400 ms')
  await held
  assert.ok(occupied.laneWaitMs >= 350, 'a held lease is queue time, not worktree setup')
  assert.ok(occupied.worktreeMs < occupied.laneWaitMs + cold.worktreeMs, 'setup not inflated')
  console.log('cold vs warm worktree ms:', cold.worktreeMs, warm.worktreeMs)
  // Web project, the agent's check needs a cold private server (2 s), model 2 × 1.5 s.
  web = true
  modelDelay = 1500
  setSpawnPrewarm(false)
  const serial = await apply('web, server started by the check (main)')
  assert.ok(serial.serverWaitMs >= SERVER_START_MS - 50, 'main: the check waits for a cold start')
  setSpawnPrewarm(true)
  const prestarted = await apply('web, server prestarted with the worktree')
  assert.ok(prestarted.serverWaitMs < 700, 'the check finds the server started or nearly so')
  // What the prestart moves is the agent's run up to its check (the model spans hold the
  // check's server wait). Landing and the hand-off to it (git and owner work, queueing)
  // vary with machine load, so they are reported, not compared: a loaded parallel unit run
  // once stalled the hand-off alone for 1.8 s.
  const toCheck = (s) => s.toFirstEditMs + s.modelMs
  assert.ok(
    toCheck(prestarted) <= toCheck(serial) - 1000,
    `the cold start is off the critical path before landing (${toCheck(serial)} → ${toCheck(prestarted)} ms)`
  )
  // One start per Apply, never a second server for the same page, and it stops with the spawn.
  const starts = runtimeCalls.filter(([kind]) => kind === 'start')
  assert.equal(starts.length, 2)
  assert.equal(new Set(starts.map(([, id]) => id)).size, 2)
  for (const [, id] of starts)
    assert.ok(
      runtimeCalls.some(([kind, agent]) => kind === 'stop' && agent === id),
      'stopped'
    )
  // A spawn that finishes before its server is up leaves none behind.
  modelDelay = 0
  await apply('web, finishes during the prestart')
  await new Promise((r) => setTimeout(r, SERVER_START_MS + 200))
  assert.equal(agentRuntimes().length, 0, 'no private server outlives its spawn')
  console.log(
    'serial vs prestarted to-check ms:',
    toCheck(serial),
    toCheck(prestarted),
    'landingMs:',
    serial.landingMs,
    prestarted.landingMs
  )
} finally {
  // Worktrees live under the fixture's temp dir; the service fixture is killed on exit.
}
console.log('spawn-phases: OK')
process.exit(0)
