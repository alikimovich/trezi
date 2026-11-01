// LKM-405: the real lifecycle behind `test/resolved-lessons.mjs`: `agent:send` and
// `agent:spawn-comment`, the Swift owners (project memory included), disposable Git repos
// and real `run_checks` runs. Stub providers only: their replies are scripted.
import './with-service-owners.mjs'
import './with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createRecordCapture } from '../../src/main/backends/record.ts'
import { serviceProjectMemory } from '../../src/native/project-memory-service.ts'
import { projectKey } from '../../src/shared/projectKey.ts'
import { swiftBuild } from './swift-build.mjs'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-resolved-lessons-')))
process.env.TREZI_USER_DATA = join(temp, 'profile')
mkdirSync(join(temp, 'memory/trezi/project-memories'), { recursive: true })

// The real memory owner, so every proposal below passes its compare-and-swap.
const binary = join(temp, 'memory-fixture')
swiftBuild(
  'memory-owner',
  [
    ...[
      'ServiceContract',
      'LedgerStore',
      'OperationLedger',
      'PreferencesFile',
      'PreferencesOwner',
      'WorkspaceFile',
      'WorkspaceOwner',
      'DomainChannel',
      'MemoryFile',
      'MemoryOwner'
    ].map((name) => `src/service/${name}.swift`),
    'test/fixtures/memory-owner/main.swift'
  ],
  { out: binary }
)
const memoryChild = spawn(binary, [join(temp, 'memory')], { stdio: ['pipe', 'pipe', 'inherit'] })
const pipe = Object.assign(new EventEmitter(), {
  sendService: (frame) => memoryChild.stdin.write(`${JSON.stringify(frame)}\n`)
})
await new Promise((resolve) => {
  createInterface({ input: memoryChild.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.ready) resolve()
    else pipe.emit(message.event, message)
  })
})
export const memory = serviceProjectMemory(pipe, 5_000)
let beforePropose = null
/** A manual save the next proposal races, as if the editor saved mid-flow. */
export const raceNextProposal = (race) => {
  beforePropose = race
}
const racing = {
  ...memory,
  propose: async (root, base, content) => {
    const race = beforePropose
    beforePropose = null
    if (race) await race(root)
    return memory.propose(root, base, content)
  }
}

export const providers = []
export const events = []
export const evaluated = []
const handlers = new Map()
let evaluation = null
/** What the stub provider's general memory evaluator answers from now on. */
export const answerEvaluations = (answer) => {
  evaluation = answer
}
mock.module('../../src/main/backends/index.ts', () => ({
  pickProvider: () => ({
    supportsSpawn: true,
    generateTitle: async () => 'Fixture title',
    updateProjectMemory: async (current, transcript) => {
      evaluated.push({ current, transcript })
      return evaluation ? evaluation(current) : null
    },
    startSession: async (cwd, options, getWindow, context) => {
      const cap = createRecordCapture(cwd, projectKey(cwd))
      const entry = { cwd, context, sent: [] }
      const emit = (event) => {
        const tagged = {
          ...event,
          projectKey: context.emitKey,
          ...(context.sessionId ? { sessionId: context.sessionId } : {})
        }
        context.onEvent?.(tagged)
        getWindow()?.webContents.send('agent:event', tagged)
      }
      const session = {
        key: projectKey(cwd),
        root: cwd,
        options,
        record: cap.record,
        pending: new Map(),
        pendingQuestions: new Map(),
        finalize: cap.finalize,
        emit,
        dispose() {},
        shutdown() {},
        send: (text) => entry.sent.push(text),
        interrupt: async () => {
          cap.finalize()
          emit({ type: 'done' })
        }
      }
      Object.assign(entry, {
        session,
        say: (text) => cap.appendAssistant(text),
        done: () => {
          cap.finalize()
          emit({ type: 'done' })
        }
      })
      providers.push(entry)
      return session
    }
  })
}))
const agent = await import('../../src/main/agent.ts')
export const { onProjectMemoryUpdated, projectHasRunningAgents, undoProjectMemoryUpdate } = agent
const { runTreziTool } = await import('../../src/main/session-tools.ts')
agent.setProjectMemoryOwner(() => racing)
agent.registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
export const invoke = (name, ...args) => handlers.get(name)({}, ...args)
export const wait = async (condition, what) => {
  for (let i = 0; i < 1000; i++) {
    const value = await condition()
    if (value) return value
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
export function closeFixture() {
  memoryChild.kill('SIGKILL')
  rmSync(temp, { recursive: true, force: true })
}

const CHECK = `import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
appendFileSync('.runs', 'x')
const page = readFileSync('page.txt', 'utf8')
if (/^(<{7}|>{7})/m.test(page)) process.exit(2)
for (const name of existsSync('asserts') ? readdirSync('asserts') : [])
  if (!page.includes(readFileSync('asserts/' + name, 'utf8').trim())) process.exit(3)
`
const LINES = Array.from({ length: 30 }, (_, i) => `line ${i}`)
export const page = (changes = {}) => `${LINES.map((line, i) => changes[i] ?? line).join('\n')}\n`

let repos = 0
export function project() {
  const repo = join(temp, `repo-${++repos}`)
  mkdirSync(join(repo, 'asserts'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(repo, 'package.json'), '{"scripts":{"test":"bun check.mjs"}}\n')
  writeFileSync(join(repo, 'check.mjs'), CHECK)
  writeFileSync(join(repo, '.gitignore'), '.runs\n')
  writeFileSync(join(repo, 'page.txt'), page())
  for (const side of ['a', 'b', 'chat']) writeFileSync(join(repo, `asserts/${side}`), '')
  git('add', '.')
  git('commit', '-qm', 'Initial')
  return {
    repo,
    git,
    parent: projectKey(repo),
    live: () => readFileSync(join(repo, 'page.txt'), 'utf8')
  }
}

const scope = (p, worker) => ({
  root: worker.cwd,
  liveRoot: p.repo,
  emitKey: worker.key ?? p.parent,
  background: !worker.key,
  ...(worker.id ? { peerId: worker.id } : {}),
  notify() {}
})
export const tool = (p, worker, name, args = {}) => runTreziTool(name, args, scope(p, worker))
export async function check(p, worker, passes = true) {
  const answer = await tool(p, worker, 'run_checks', { checks: ['test'] })
  assert.equal(answer.results?.[0]?.receipt?.verified, passes, JSON.stringify(answer).slice(0, 400))
}
export const put = (worker, file, text) => {
  mkdirSync(dirname(join(worker.cwd, file)), { recursive: true })
  writeFileSync(join(worker.cwd, file), text)
}
export function edit(worker, side, changes, behaviour) {
  put(worker, 'page.txt', page(changes))
  put(worker, `asserts/${side}`, `${behaviour}\n`)
}
export function combine(worker, line) {
  const current = readFileSync(join(worker.cwd, 'page.txt'), 'utf8')
  assert.match(current, /<<<<<<< /)
  put(worker, 'page.txt', current.replace(/<<<<<<< [^\n]*\n[\s\S]*?>>>>>>> [^\n]*\n/g, `${line}\n`))
}

export async function comment(p, goal) {
  const started = await invoke('agent:spawn-comment', p.repo, goal, 'parent', { provider: 'codex' })
  assert.equal(started.ok, true)
  assert.ok(!started.queued)
  const worker = providers.at(-1)
  worker.id = started.spawnId
  return worker
}
export const finished = (id) =>
  events.find((e) => e.type === 'spawn-finished' && e.sessionId === id)
export async function finish(worker) {
  const sent = worker.sent.length
  worker.done()
  await wait(() => finished(worker.id) || worker.sent.length > sent, 'the comment to settle')
  return finished(worker.id) ?? { continued: worker.sent.at(-1) }
}
export const applied = (result) => assert.equal(result.outcome, 'applied', result.summary)

export async function openChat(p) {
  const opened = await invoke('agent:open-project', p.repo, { provider: 'codex' })
  assert.notEqual(opened.ok, false, opened.error)
  const worker = providers.at(-1)
  worker.key = p.parent
  return worker
}
let turns = 0
export async function send(worker, text) {
  const id = `turn-${++turns}`
  const sent = worker.sent.length
  const queued = await invoke('agent:send', text, [], worker.key, {}, id)
  assert.notEqual(queued?.ok, false, queued?.error)
  await wait(() => worker.sent.length > sent, 'the chat turn to reach its provider')
  return id
}
export const landed = (id) => events.some((e) => e.type === 'landing-finished' && e.turn === id)
export const parkEvent = (key) =>
  events.filter((e) => e.type === 'isolation' && e.projectKey === key).at(-1)

/** Two comments overlap on one line; the second is left holding the conflict markers. */
export async function overlappingComments(p) {
  const a = await comment(p, 'Show the price')
  const b = await comment(p, 'Show the sale badge')
  edit(a, 'a', { 5: 'header price=10' }, 'price=10')
  edit(b, 'b', { 5: 'header badge=sale' }, 'badge=sale')
  await check(p, a)
  await check(p, b)
  applied(await finish(a))
  const { continued } = await finish(b)
  assert.match(continued, /conflict markers/)
  return { a, b, prompt: continued }
}
/** A chat overlaps a comment that landed first; its reconciliation turn is running. */
export async function overlappingChat(p) {
  const chat = await openChat(p)
  const turn = await send(chat, 'Show the price')
  edit(chat, 'chat', { 5: 'header price=10' }, 'price=10')
  await check(p, chat)
  const b = await comment(p, 'Show the sale badge')
  edit(b, 'b', { 5: 'header badge=sale' }, 'badge=sale')
  await check(p, b)
  applied(await finish(b))
  const sent = chat.sent.length
  chat.done()
  await wait(() => chat.sent.length > sent, 'the reconciliation turn')
  return { chat, turn, prompt: chat.sent.at(-1) }
}

/** The saved lesson lines of a project; waits for every queued memory write first. */
export async function lessons(p) {
  // The CI-rule handler queues on the same per-project chain, so it settles what came first.
  await invoke('project-memory:ci-rule', p.repo, 'settle')
  const { content } = await memory.get(p.repo)
  return content.split('\n').filter((line) => /<!--\s*lesson\b/.test(line))
}
export const provenance = (line) => {
  const tag = /<!-- lesson task=(\S+) commit=(\S+) files=(\S+) -->/.exec(line)
  assert.ok(tag, `a linked lesson: ${line}`)
  return {
    task: decodeURIComponent(tag[1]),
    commit: tag[2],
    files: tag[3].split(',').map(decodeURIComponent)
  }
}
export const REUSABLE = 'LESSON: Keep the price and the badge in the header together.'
