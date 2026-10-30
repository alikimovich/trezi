// LKM-377: the native chat check's no-terminal Stop overrides agent:interrupt and
// agent:turn-state, so the controller settles while Bun's conversation owner still runs
// the turn. LKM-376 reset only the composer; sidebar-status's next send then got CHAT_BUSY
// and was queued. This drives the same sequence through the real agent.ts (turn tracker,
// provider event hook, agent:send busy gate, agent:turn-state) on the real Swift owners,
// with the provider's send stubbed by `stubAgentSendForSmoke` as in the smoke, and checks
// the cleanup that native-chat runs (`cleanSharedChat`) against two broken variants.
import './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { isChatBusy } from '../src/shared/chat-busy.ts'
import { projectKey } from '../src/shared/projectKey.ts'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-stop-cleanup-')))
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))
process.env.TREZI_USER_DATA = join(temp, 'profile')
// The provider stub refuses to install outside a native test process.
process.argv.push('--test')

const repository = (name) => {
  const repo = join(temp, name)
  mkdirSync(repo)
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-qm', 'Initial')
  return repo
}

// A scripted provider (never a real SDK). Its `send` is replaced by the smoke stub below.
mock.module('../src/main/backends/index.ts', () => ({
  pickProvider: () => ({
    supportsSpawn: true,
    generateTitle: async () => 'Fixture title',
    startSession: async (cwd, options, getWindow, context) => {
      const cap = createRecordCapture(cwd, projectKey(cwd))
      let disposed = false
      const emit = (event) => {
        if (disposed) return
        const tagged = { ...event, projectKey: context.emitKey }
        context.onEvent?.(tagged)
        getWindow()?.webContents.send('agent:event', tagged)
      }
      return {
        key: projectKey(cwd),
        root: cwd,
        options,
        record: cap.record,
        pending: new Map(),
        pendingQuestions: new Map(),
        finalize: cap.finalize,
        emit,
        dispose() {
          disposed = true
        },
        shutdown() {},
        send() {},
        interrupt: async () => {
          cap.finalize()
          emit({ type: 'done' })
        }
      }
    }
  })
}))
mock.module('../src/main/providers.ts', () => ({ registerProviderIpc: () => {} }))

const { registerAgentIpc, stubAgentSendForSmoke } = await import('../src/main/agent.ts')
const { NativeChatController } = await import('../src/native/chat-controller.ts')
const { cleanSharedChat, requireCleanSharedChat, resetSharedChat } = await import(
  '../src/native/smoke-shared-chat.ts'
)
const { waitFor } = await import('../src/native/smoke-wait.ts')

const handlers = new Map()
let window = () => {}
registerAgentIpc(
  () => ({ webContents: { isDestroyed: () => false, send: (_, event) => window(event) } }),
  { handle: (name, fn) => handlers.set(name, fn) }
)
const agent = (name, ...args) => handlers.get(name)({}, ...args)

/** The smoke's Stop/queue check on a fresh chat, then `cleanup`, then sidebar-status's send
 *  (guarded, through the composer) or, `immediate`, an unguarded send right away. */
async function stopQueueThen(name, cleanup, { immediate = false } = {}) {
  const repo = repository(name)
  const key = projectKey(repo)
  await agent('agent:open-project', repo, { provider: 'claude' })
  let noTerminalStop = false
  const busy = []
  // smoke-chat.ts's override: a Stop with no terminal, reported idle by the controller's
  // view of agent:turn-state only. Bun's own handlers stay untouched.
  const real = async (channel, ...args) => {
    if (handlers.has(channel)) return agent(channel, ...args)
    return undefined
  }
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      if (noTerminalStop && channel === 'agent:interrupt') return undefined
      if (noTerminalStop && channel === 'agent:turn-state')
        return { turn: controller.get(key).turn, running: false }
      try {
        return await real(channel, ...args)
      } catch (error) {
        if (channel === 'agent:send' && isChatBusy(error)) busy.push(args[4])
        throw error
      }
    },
    render: (state) => {
      composer = state.composer
    },
    effect() {}
  })
  let composer = {}
  window = (event) => controller.event(event)
  const sent = []
  const stub = stubAgentSendForSmoke(key, (...args) => {
    sent.push(args)
  })
  // Swift replies to chatPerform/composerPerform before Bun handles the forwarded action.
  let revision = 0
  const host = {
    async request(method, data = {}) {
      if (method === 'composerInspect') return { ...composer, queueCount: composer.queue.length }
      if (method === 'chatPerform')
        void controller.action({ chat: key, action: data.action, id: data.card })
      else if (method === 'composerPerform' && 'text' in data)
        void controller.composer({
          chat: key,
          action: 'input',
          text: data.text,
          caret: data.text.length,
          revision: ++revision
        })
      else if (method === 'composerPerform' && data.action === 'send')
        void controller.composer({ chat: key, action: 'send' })
      else throw new Error(`Unexpected host request ${method}`)
    }
  }
  const composerUntil = (check, label) =>
    waitFor(async () => {
      const value = await host.request('composerInspect')
      return check(value) && value
    }, label)
  await controller.command({
    type: 'context',
    context: {
      chat: key,
      root: repo,
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
  const turn = {
    state: () => real('agent:turn-state', key),
    controller: () => controller.get(key)
  }

  // The Stop/queue sequence of smoke-chat.ts with its unchanged assertions.
  await host.request('composerPerform', { text: 'Stop fixture turn' })
  await host.request('composerPerform', { action: 'send' })
  await waitFor(() => sent.length === 1, 'stop fixture reached the provider')
  await host.request('composerPerform', { text: 'Keep queued message' })
  await host.request('composerPerform', { action: 'send' })
  await composerUntil((value) => value.queueCount === 1, 'message queued')
  await host.request('composerPerform', { text: 'Keep draft' })
  await composerUntil((value) => value.text === 'Keep draft', 'draft kept')
  noTerminalStop = true
  const stoppedTurn = controller.get(key).turn
  await host.request('chatPerform', { action: 'stop' })
  await waitFor(() => !controller.get(key).isRunning, 'Stop settled')
  const stopped = await host.request('composerInspect')
  assert.equal(stopped.queuePaused, true)
  assert.equal(stopped.queueCount, 1)
  assert.equal(stopped.queue[0].text, 'Keep queued message')
  assert.equal(stopped.text, 'Keep draft')
  assert.equal(sent.length, 1, 'Stop sent a queued message automatically')
  // The override hid it: Bun still runs the stopped turn (the praxis-25 state).
  assert.deepEqual(await real('agent:turn-state', key), { turn: stoppedTurn, running: true })
  noTerminalStop = false

  const failure = await cleanup({ host, turn, stub, stoppedTurn })
  let guard
  if (immediate) {
    // The next send right after the cleanup returned, with no guard in between.
    await real('agent:send', 'Sidebar indicator turn', undefined, key, {}, 'history').catch(
      (error) => {
        if (!isChatBusy(error)) throw error
        busy.push('history')
      }
    )
  } else {
    guard = await requireCleanSharedChat(host, 'sidebar-status', turn).then(
      () => undefined,
      (error) => error
    )
    // sidebar-status's turn on the same chat.
    await host.request('composerPerform', { text: 'Sidebar indicator turn' })
    await composerUntil((value) => value.text === 'Sidebar indicator turn', 'history draft')
    await host.request('composerPerform', { action: 'send' })
    await composerUntil((value) => value.text === '', 'history turn submitted')
  }
  await waitFor(
    () => sent.length === 2 || busy.length,
    'history send reached the provider or was refused busy'
  )
  const queued = controller.get(key).queue.map((q) => q.text)
  // Leave nothing running for the next scenario; a queued send must not drain into a new turn.
  controller.get(key).paused = true
  controller.get(key).queue.splice(0)
  stub.emit({ type: 'done' })
  await waitFor(async () => !(await real('agent:turn-state', key)).running, `${name} ended`)
  stub.restore()
  await agent('agent:close-project', repo)
  window = () => {}
  return { failure, guard, sent: sent.length, busy, queued }
}

// The native-chat cleanup: composer reset, the provider's untagged `done`, then the real
// turn state and the controller idle. The next send reaches the provider stub.
{
  const result = await stopQueueThen('repo-clean', ({ host, turn, stub }) =>
    cleanSharedChat(host, turn, () => stub.emit({ type: 'done' }))
  )
  assert.equal(result.failure, undefined, String(result.failure?.message))
  assert.equal(result.guard, undefined, String(result.guard?.message))
  assert.deepEqual(result.busy, [], 'history send got CHAT_BUSY after the cleanup')
  assert.equal(result.sent, 2, 'history send did not reach the provider stub')
  assert.deepEqual(result.queued, [])
}

// LKM-376's cleanup ended with a turn-tagged `done`: the tracker treats it as stale, the
// owner keeps running, the cleanup's bounded wait names it and the guard names it; the
// next send is refused CHAT_BUSY and queued, never reaching the stub.
{
  const result = await stopQueueThen('repo-tagged-done', ({ host, turn, stub, stoppedTurn }) =>
    cleanSharedChat(host, turn, () => stub.emit({ type: 'done', turn: stoppedTurn }), 1500)
  )
  assert.match(
    String(result.failure?.message),
    /backend turn ended \(agent:turn-state not running\)/
  )
  assert.match(
    String(result.guard?.message),
    /sidebar-status: an earlier check left a running backend turn/
  )
  assert.equal(result.busy.length, 1, 'the history send was not refused busy')
  assert.equal(result.sent, 1)
  assert.deepEqual(result.queued, ['Sidebar indicator turn'])
}

// An untagged `done` without waiting for the real turn state: the owner is still claiming
// and landing the stopped turn, so a send that follows is refused CHAT_BUSY. The same send
// right after the full cleanup reaches the stub.
{
  const result = await stopQueueThen(
    'repo-no-wait',
    async ({ host, stub }) => {
      await resetSharedChat(host)
      stub.emit({ type: 'done' })
    },
    { immediate: true }
  )
  assert.equal(result.failure, undefined)
  assert.deepEqual(result.busy, ['history'], 'the following send was not refused busy')
  assert.equal(result.sent, 1)
}
{
  const result = await stopQueueThen(
    'repo-clean-immediate',
    ({ host, turn, stub }) => cleanSharedChat(host, turn, () => stub.emit({ type: 'done' })),
    { immediate: true }
  )
  assert.equal(result.failure, undefined, String(result.failure?.message))
  assert.deepEqual(result.busy, [], 'the send right after the cleanup got CHAT_BUSY')
  assert.equal(result.sent, 2)
}

// native-chat runs this cleanup in its `finally`, never a turn-tagged `done`, and with the
// real agent:turn-state; sidebar-status's guard checks the backend turn before it sends.
{
  const chat = readFileSync(new URL('../src/native/smoke-chat.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(chat, /type: 'done', turn/, 'native-chat emits a turn-tagged done')
  const cleanup = chat.slice(chat.lastIndexOf('} finally {'))
  const at = cleanup.indexOf('cleanSharedChat(')
  assert.ok(at > 0, 'native-chat finally lost its cleanup')
  assert.ok(at < cleanup.indexOf('provider.restore()'), 'the stub is restored before cleanup')
  assert.match(cleanup, /originalInvoke\('agent:turn-state'/)
  assert.match(cleanup, /send\(\{ type: 'done' \}\)/)
  const history = readFileSync(
    new URL('../src/native/smoke-sidebar-status.ts', import.meta.url),
    'utf8'
  )
  assert.match(history, /requireCleanSharedChat\(host, 'sidebar-status', \{\s+state:/)
}

console.log(
  'Native smoke Stop cleanup: the untagged done and real turn-state wait free the backend; a tagged done or no wait leaves the next send CHAT_BUSY.'
)
process.exit(0)
