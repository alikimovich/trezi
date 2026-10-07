// LKM-182 New chat opens instantly: the native workspace and chat controllers on the
// real agent.ts, with the real Swift conversation, repository, editing and workspace
// owners, and a repository owner whose worktree creation takes 3 s. A scripted provider
// (never a real SDK) records where each session starts and what it is sent.
// - New chat shows a ready, focused composer within 100 ms, before any provider starts;
// - its first send waits for the pending worktree ("Preparing workspace…"), then works;
// - the next chat takes the prewarmed spare, synced from the live tree, without waiting;
// - a chat closed while being prepared tears down what was made;
// - closing the project removes the unused spare.
import './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { projectKey } from '../src/shared/projectKey.ts'
import { workspaceService } from './helpers/workspace-fixture.mjs'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-new-chat-')))
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))
process.env.TREZI_USER_DATA = join(temp, 'profile')
const repo = join(temp, 'repo')
mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'Fixture')
git('config', 'user.email', 'fixture@example.test')
git('config', 'commit.gpgsign', 'false')
writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n')
writeFileSync(join(repo, 'a.txt'), 'one\n')
git('add', '.')
git('commit', '-qm', 'Initial')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(condition, label, timeout = 15_000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`)
    await sleep(10)
  }
}

// A repository owner whose `git worktree add` takes `delay` ms.
const { repositoryOwner, setRepositoryOwner } = await import('../src/main/repository-owner.ts')
const realOwner = repositoryOwner()
let delay = 0
setRepositoryOwner(
  new Proxy(realOwner, {
    get(target, name) {
      const value = target[name]
      if (name === 'createWorktree')
        return async (...args) => {
          await sleep(delay)
          return value.apply(target, args)
        }
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
)

const providers = []
mock.module('../src/main/backends/index.ts', () => ({
  pickProvider: () => ({
    supportsSpawn: true,
    generateTitle: async () => 'Fixture title',
    startSession: async (cwd, options, getWindow, context) => {
      const cap = createRecordCapture(cwd, projectKey(cwd))
      const entry = { cwd, options, sent: [], at: Date.now(), disposed: false }
      const emit = (event) => {
        if (entry.disposed) return
        const tagged = { ...event, projectKey: context.emitKey }
        context.onEvent?.(tagged)
        getWindow()?.webContents.send('agent:event', tagged)
      }
      entry.session = {
        key: projectKey(cwd),
        root: cwd,
        options,
        record: cap.record,
        pending: new Map(),
        pendingQuestions: new Map(),
        finalize: cap.finalize,
        emit,
        dispose() {
          entry.disposed = true
        },
        shutdown() {},
        send(text) {
          entry.sent.push(text)
        },
        interrupt: async () => {
          cap.finalize()
          emit({ type: 'done' })
        }
      }
      entry.done = () => {
        cap.finalize()
        emit({ type: 'done' })
      }
      providers.push(entry)
      return entry.session
    }
  })
}))

const { registerAgentIpc } = await import('../src/main/agent.ts')
const { spareReady, releaseSpare } = await import('../src/main/chat-spare.ts')
const { NativeChatController } = await import('../src/native/chat-controller.ts')
const { NativeWorkspaceController } = await import('../src/native/workspace-controller.ts')

const handlers = new Map(),
  events = []
let chats
registerAgentIpc(
  () => ({
    webContents: {
      isDestroyed: () => false,
      send: (_, event) => {
        events.push(event)
        chats?.event(event)
      }
    }
  }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
const agent = (name, ...args) => handlers.get(name)({}, ...args)
const invoke = async (channel, ...args) => {
  if (handlers.has(channel)) return agent(channel, ...args)
  if (channel === 'project:detect')
    return { name: 'repo', devCommand: 'bun run dev', framework: 'vite', previewKind: 'web' }
  if (channel === 'devserver:info') return { running: false }
  if (channel === 'devserver:start') return { url: 'http://127.0.0.1:7784' }
  if (channel === 'sessions:list') return []
  return { ok: true }
}
chats = new NativeChatController({ invoke, render() {}, effect() {} })
let focusedAt = 0
const store = (await workspaceService(join(temp, 'workspace'))).store
const workspace = new NativeWorkspaceController({
  invoke,
  store,
  render() {},
  closeChat: (key) => chats.close(key),
  reusableChat: () => false,
  focusComposer: () => {
    focusedAt = Date.now()
  },
  activate: async (entry) => {
    await chats.command({
      type: 'context',
      context: {
        chat: entry?.activeSessionKey ?? '',
        root: entry?.root ?? null,
        selection: null,
        turn: {},
        setup: { needed: false, dismissed: false, status: null },
        tokens: { needed: false, dismissed: false },
        notes: [],
        spawns: []
      }
    })
  }
})
const key = projectKey(repo)
const text = (prompt) => prompt.split('\n').at(-1)

/** New chat through the workspace controller: how long until a ready, focused composer. */
async function newChat() {
  focusedAt = 0
  const opened = providers.length
  const started = Date.now()
  await workspace.command({ type: 'new-chat', key })
  const chat = workspace.active.activeSessionKey
  assert.ok(focusedAt, 'the composer was focused')
  assert.equal(chats.active, chat, 'the new chat is the shown one')
  assert.equal(chats.get(chat).ready, true, 'the new chat is ready for input')
  assert.equal(providers.length, opened, 'no provider starts before the chat shows')
  return { chat, ms: focusedAt - started, started }
}

await workspace.command({ type: 'attach' })
await workspace.open(repo)
await until(() => providers.length === 1, 'project chat')
// Start without a spare: every new chat below creates or takes one explicitly.
assert.ok(await spareReady(repo), 'opening the project prewarms a spare')
await releaseSpare(repo)
delay = 3_000

// 1. Instant with a 3 s worktree; the first send waits for it, then works.
const first = await newChat()
assert.ok(first.ms < 100, `New chat composer ready in ${first.ms} ms (limit 100)`)
const sending = chats.command({ type: 'submit', chat: first.chat, text: 'hello' })
await until(
  () =>
    events.some(
      (e) =>
        e.type === 'progress' && e.projectKey === first.chat && e.step === 'Preparing workspace…'
    ),
  'Preparing workspace…'
)
assert.equal(chats.get(first.chat).progressStep, 'Preparing workspace…')
await until(() => providers.length === 2 && providers[1].sent.length === 1, 'first send')
await sending
const p1 = providers[1]
assert.ok(Date.now() - first.started >= 2_500, 'the first send waited for the worktree')
assert.notEqual(p1.cwd, repo, 'the chat runs in its own worktree')
assert.equal(text(p1.sent[0]), 'hello')
assert.equal(chats.get(first.chat).progressStep, 'Thinking…')
p1.done()
await until(() => !chats.get(first.chat).isRunning, 'first turn ended')

// 2. The next chat takes the spare prewarmed after the first, synced from live on take.
const spare = await spareReady(repo)
assert.ok(spare && existsSync(spare.path), 'a spare was prewarmed after the new chat')
writeFileSync(join(repo, 'live.txt'), 'uncommitted\n')
const second = await newChat()
assert.ok(second.ms < 100, `New chat composer ready in ${second.ms} ms (limit 100)`)
await until(() => providers.length === 3, 'second chat provider')
const p2 = providers[2]
assert.equal(p2.cwd, spare.path, 'the new chat took the spare')
assert.ok(p2.at - second.started < delay, 'taking the spare skips the worktree creation')
assert.equal(readFileSync(join(p2.cwd, 'live.txt'), 'utf8'), 'uncommitted\n', 'synced on take')
await chats.command({ type: 'submit', chat: second.chat, text: 'again' })
await until(() => p2.sent.length === 1, 'second send')
p2.done()
await until(() => !chats.get(second.chat).isRunning, 'second turn ended')
rmSync(join(repo, 'live.txt'))

// 3. A chat closed while it is still being prepared tears down what was made.
const next = await spareReady(repo)
await releaseSpare(repo)
assert.ok(next && !existsSync(next.path), 'releasing removes the spare')
const third = await agent('agent:new-chat', repo, { provider: 'claude' })
assert.equal(third.ok, true)
const closed = await agent('agent:close-chat', repo, third.sessionKey)
assert.ok(!closed.remaining.includes(third.sessionKey))
await sleep(delay + 500)
assert.equal(providers.length, 3, 'a closed pending chat starts no provider')
const worktrees = () =>
  git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
const open = new Set(providers.map((p) => p.cwd))
await until(
  () => worktrees().every((line) => open.has(line.slice(9)) || line.slice(9) === repo),
  'the closed chat worktree removed'
)

// 4. Closing the project removes its unused spare.
assert.equal(await spareReady(repo), null, 'a closed pending chat prewarms no spare')
const fourth = await newChat()
assert.ok(fourth.ms < 100)
await chats.command({ type: 'submit', chat: fourth.chat, text: 'last' })
await until(() => providers.length === 4 && providers[3].sent.length === 1, 'fourth send')
providers[3].done()
const unused = await spareReady(repo)
assert.ok(unused && existsSync(unused.path))
await workspace.close(key)
await until(() => !existsSync(unused.path), 'unused spare removed on project close')
await until(() => worktrees().length === 1, 'every chat worktree removed on close')
assert.equal(await spareReady(repo), null)

console.log(
  `PASS new chat instant: composer ${first.ms}/${second.ms}/${fourth.ms} ms with a 3 s worktree, first send waits, spare reuse and cleanup`
)
process.exit(0)
