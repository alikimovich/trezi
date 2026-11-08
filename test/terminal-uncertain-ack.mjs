// LKM-585: a turn's terminal claim that the Swift conversation owner committed, but
// whose answer Bun never got: the reply was lost or late (Bun's client timed out), or
// the owner's checkpoint after the claim failed. Bun's catch frees the chat without
// landing it; the owner still holds the turn, claimed, in `landing`. The chosen outcome:
// the claimed turn is never landed twice (a late or repeated terminal for it is refused,
// so nothing lands from it), its edits stay in the chat's worktree, and the next send
// releases the owner's orphaned turn and lands those edits once, with its own.
// The real agent.ts and Swift conversation and repository owners, a scripted provider
// (never a real SDK) and the owner's terminal answer replaced by hand after it ran: no
// sleeps decide an ordering, no provider or network calls.
import { serviceProfile } from './helpers/with-service-owners.mjs'
import './helpers/with-provider-owner.mjs'
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordCapture } from '../src/main/backends/record.ts'
import { ConversationError, swiftConversationOwner } from '../src/main/conversation-owner.ts'
import { projectKey } from '../src/shared/projectKey.ts'
import { passCheck } from './helpers/gate-checks.mjs'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-terminal-ack-')))
process.env.TREZI_USER_DATA = join(temp, 'profile')

const providers = [],
  events = [],
  handlers = new Map()
mock.module('../src/main/backends/index.ts', () => ({
  pickProvider: () => ({
    supportsSpawn: true,
    generateTitle: async () => 'Fixture title',
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
        edit: (file, text) => {
          writeFileSync(join(cwd, file), text)
          cap.appendAssistant(`Edited ${file}.`)
          emit({ type: 'delta', text: `Edited ${file}.` })
        },
        done: () => {
          cap.finalize()
          emit({ type: 'done' })
        },
        error: () => emit({ type: 'error', message: 'scripted provider error' })
      })
      providers.push(entry)
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
const until = async (condition, what, ms = 20_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await condition()
    if (value) return value
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

// The owner's terminal answer for a turn named in `faults`, after the real owner decided
// it: 'lost' (the claim committed, the answer never reached Bun: its client times out)
// or 'checkpoint' (the owner's checkpoint after the claim really fails: its live
// checkpoint folder is read-only for that one request).
const owner = swiftConversationOwner()
const realTerminal = owner.terminal.bind(owner)
const faults = new Map()
const answers = []
const liveCheckpoints = join(serviceProfile, 'service/conversation/live')
owner.terminal = async (chat, turn, run, kind, record) => {
  const fault = faults.get(turn)
  if (!fault) {
    const answer = await realTerminal(chat, turn, run, kind, record)
    answers.push({ turn, kind, answer })
    return answer
  }
  faults.delete(turn)
  if (fault === 'lost') {
    const answer = await realTerminal(chat, turn, run, kind, record)
    answers.push({ turn, kind, answer, hidden: true })
    throw new ConversationError('deadlineExceeded', 'scripted: the answer was lost')
  }
  assert.ok(existsSync(liveCheckpoints), 'the owner checkpoints live chats here')
  chmodSync(liveCheckpoints, 0o500)
  try {
    const answer = await realTerminal(chat, turn, run, kind, record)
    answers.push({ turn, kind, answer })
    return answer
  } catch (error) {
    answers.push({ turn, kind, error: error.code })
    throw error
  } finally {
    chmodSync(liveCheckpoints, 0o700)
  }
}
const ownerChat = async (chat) => (await owner.snapshot()).chats.find((c) => c.chat === chat)

let repos = 0
async function openChat() {
  const repo = join(temp, `repo-${++repos}`)
  mkdirSync(join(repo, 'src'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(repo, 'src/A.ts'), 'a0\n')
  writeFileSync(join(repo, 'src/B.ts'), 'b0\n')
  git('add', '.')
  git('commit', '-qm', 'Initial')
  const opened = await invoke('agent:open-project', repo, { provider: 'codex' })
  assert.notEqual(opened.ok, false, opened.error)
  const worker = providers.at(-1)
  worker.key = projectKey(repo)
  worker.repo = repo
  worker.git = git
  worker.read = (file) => readFileSync(join(repo, file), 'utf8')
  assert.notEqual(worker.cwd, repo, 'the chat runs in its own worktree')
  return worker
}
const finished = (turn) =>
  events.filter((e) => e.type === 'landing-finished' && e.turn === turn).length
const reconciled = (turn) =>
  events.filter((e) => e.type === 'reconciliation-started' && e.turn === turn).length

/** A turn that edits `file` and ends with `done`. */
async function turn(worker, id, file, text) {
  const sent = worker.sent.length
  await invoke('agent:send', `Edit ${file}`, [], worker.key, {}, id)
  await until(() => worker.sent.length > sent, `${id} to reach its provider`)
  worker.edit(file, text)
  // The host check every landing requires, passed on the worktree's source now.
  await passCheck(worker.context.emitKey ?? worker.key, worker.cwd)
  worker.done()
}

const titled = (worker) =>
  events.some((e) => e.type === 'title' && e.projectKey === (worker.context.emitKey ?? worker.key))

const failures = []
const check = async (name, run) => {
  try {
    await run()
    console.log(`  ok: ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  FAILED: ${name}: ${String(error?.stack ?? error).slice(0, 900)}`)
  }
}

await check('control: an acknowledged first turn lands and names the chat', async () => {
  const worker = await openChat()
  await turn(worker, 'ctl', 'src/A.ts', 'a1\n')
  await until(() => finished('ctl') === 1, 'ctl to land')
  await until(() => titled(worker), 'the chat to be named')
})
for (const fault of ['lost', 'checkpoint']) {
  await check(
    `terminal claim committed, answer ${fault}: lands once, with the next send`,
    async () => {
      const worker = await openChat()
      const a = `turn-${fault}-a`,
        b = `turn-${fault}-b`
      faults.set(a, fault)
      await turn(worker, a, 'src/A.ts', 'a1\n')
      await until(() => finished(a) === 1, `${a}'s UI release`)
      const held = await ownerChat(worker.key)
      assert.equal(held.turn, a, 'the owner still holds the claimed turn')
      assert.equal(held.phase, 'landing', 'claimed, never landed')
      if (fault === 'checkpoint')
        assert.equal(
          answers.at(-1).error,
          'ioFailure',
          'the owner checkpoint failed after the claim'
        )
      assert.equal(worker.read('src/A.ts'), 'a0\n', 'the unacknowledged turn did not land')
      assert.equal(reconciled(a), 0)
      const commits = Number(worker.git('rev-list', '--count', 'HEAD'))
      const state = await invoke('agent:turn-state', worker.key)
      assert.equal(state.turn, a)

      // A late or repeated terminal for the claimed turn: refused, nothing lands.
      // The tracker already credited this turn's `done`, so a late one names no turn and
      // never reaches the owner (which would answer `duplicate`).
      const asked = answers.length
      worker.error()
      worker.done()
      const late = events.filter((e) => e.type === 'error' || e.type === 'done').slice(-2)
      assert.ok(
        late.every((e) => e.turn === undefined),
        'late terminals name no turn'
      )
      assert.equal(answers.length, asked, 'no late terminal reached the owner')
      assert.equal(worker.read('src/A.ts'), 'a0\n', 'a late terminal lands nothing')
      assert.equal(finished(a), 1, 'the claimed turn is released once')

      // The next send releases the owner's orphaned turn and lands both edits, once.
      await turn(worker, b, 'src/B.ts', 'b1\n')
      await until(() => finished(b) === 1, `${b} to land`)
      assert.equal(worker.read('src/A.ts'), 'a1\n', 'the held edit lands with the next turn')
      assert.equal(worker.read('src/B.ts'), 'b1\n', 'the next turn lands')
      assert.equal((await ownerChat(worker.key)).phase, 'idle')
      const landedCommits = Number(worker.git('rev-list', '--count', 'HEAD')) - commits
      assert.equal(landedCommits, 1, 'both edits landed in one landing, once')
      assert.equal(finished(a), 1, 'the orphaned turn never finishes again')
      assert.equal(answers.filter((x) => x.turn === a).length, 1, 'one terminal decision for it')
      // The claim marked a name as being generated; Bun never heard it, so the next
      // claimed success must still be allowed to name the chat.
      await until(() => titled(worker), 'the chat to be named after the next turn')
    }
  )
}

if (failures.length) {
  console.log(`Uncertain terminal acknowledgement FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('Uncertain terminal acknowledgement: claimed turns land once; no provider calls')
process.exit(0)
