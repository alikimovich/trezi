// LKM-346: a Codex chat continues its saved thread after a restart (`resumeThread` with
// the record's `sdkSessionId`), and records the thread id it ran on. A thread the CLI
// cannot continue (it starts a new one, or fails with "no rollout found") is replaced by
// a new thread whose first prompt carries the chat's summary, so the model still knows
// the task. No Codex process: the SDK is a scripted fake.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TREZI_CODEX_STREAM_GRACE_MS = '300'
const scratch = mkdtempSync(join(tmpdir(), 'trezi-codex-resume-'))
// The usage tail looks for rollouts here, never in the user's ~/.codex.
process.env.CODEX_HOME = join(scratch, 'codex-home')

// What the fake CLI knows: the threads it has rollouts for, and how it treats any other.
const saved = new Set()
let unknownThread = 'new-thread' // or 'error'
let fresh = 0
const calls = []
const prompts = []
const fakeThread = (id) => {
  const thread = {
    id,
    runStreamed: async (prompt) => ({
      events: (async function* () {
        prompts.push({ id: thread.id, prompt })
        const known = !thread.id || saved.has(thread.id)
        if (!known && unknownThread === 'error')
          throw new Error(
            `Codex Exec exited with code 1: Error: no rollout found for thread id ${thread.id}`
          )
        // Like `codex exec resume <unknown id>`: a new, empty thread under a new id.
        const started = known && thread.id ? thread.id : `thread-new-${++fresh}`
        saved.add(started)
        thread.id = started
        yield { type: 'thread.started', thread_id: started }
        yield {
          type: 'item.completed',
          item: { id: 'item_0', type: 'agent_message', text: 'Continuing the footer.' }
        }
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }
        }
      })()
    })
  }
  return thread
}
class FakeCodex {
  startThread() {
    calls.push(['start'])
    return fakeThread(null)
  }
  resumeThread(id) {
    calls.push(['resume', id])
    return fakeThread(id)
  }
}
mock.module('@openai/codex-sdk', () => ({ Codex: FakeCodex }))
mock.module('../src/main/backends/codex-mcp.ts', () => ({
  treziMcpConfig: () => ({ mcp_servers: {} }),
  verifyTreziMcp: async () => {},
  isolatedCodexConfig: (config = {}) => config,
  gitAccessHook: () => ({})
}))
mock.module('../src/main/trezi-agent-tools.ts', () => ({
  registerTreziAgentTools: async () => ({ socketPath: '/nowhere', token: 'fake', dispose() {} }),
  shutdownTreziAgentTools: async () => {}
}))

const { codexProvider } = await import('../src/main/backends/codex.ts')
const { RESUME_NOTE, resumeSummary } = await import('../src/main/backends/claude-resume.ts')
const { isCodexResumeFailure } = await import('../src/main/backends/codex-resume.ts')

// The interrupted chat of the report: the request, the reply so far, Trezi's note.
const summary = resumeSummary({
  transcript: [
    { role: 'user', text: 'I want to experiment on a footer with three contact links', at: 1 },
    { role: 'assistant', text: 'I will use the existing Home, About and Projects links.', at: 2 },
    {
      role: 'status',
      text: 'Trezi stopped before this turn finished. Send the message again to continue.',
      at: 3
    }
  ],
  filesTouched: ['src/Footer.tsx']
})

const until = async (check, label) => {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function start(ctx = {}) {
  calls.length = 0
  prompts.length = 0
  const events = []
  const session = await codexProvider.startSession(
    scratch,
    { provider: 'codex', permissionMode: 'auto' },
    () => null,
    { emitKey: 'fixture-codex-resume', ...ctx, onEvent: (event) => events.push(event) }
  )
  const turn = async (text) => {
    const done = events.filter((event) => event.type === 'done').length
    session.send(text)
    await until(() => events.filter((event) => event.type === 'done').length > done, text)
  }
  const notes = () =>
    events.filter((event) => event.type === 'status' && event.text === RESUME_NOTE).length
  const errors = () => events.filter((event) => event.type === 'error')
  return { session, events, turn, notes, errors }
}

const previousBin = process.env.TREZI_CODEX_BIN
process.env.TREZI_CODEX_BIN = '/usr/bin/true' // only the adapter's version probe
try {
  assert.equal(isCodexResumeFailure('Error: no rollout found for thread id 0199'), true)
  assert.equal(isCodexResumeFailure('thread not found: 0199'), true)
  assert.equal(isCodexResumeFailure('exceeded retry limit, last status: 429'), false)
  assert.ok(summary.includes('User: I want to experiment on a footer'), summary)

  // A new chat runs on a new thread and records its id for the next launch.
  {
    const chat = await start()
    await chat.turn('hello')
    assert.deepEqual(calls, [['start']])
    assert.equal(chat.session.record.sdkSessionId, 'thread-new-1')
    await chat.turn('again')
    assert.deepEqual(calls.at(-1), ['resume', 'thread-new-1'])
    assert.equal(chat.notes(), 0)
    chat.session.dispose()
  }

  // Restart with a saved thread id: the next turn continues that thread.
  {
    saved.add('thread-saved')
    const chat = await start({ resumeSessionId: 'thread-saved', resumeSummary: summary })
    await chat.turn('continue')
    assert.ok(
      calls.every(([kind, id]) => kind === 'resume' && id === 'thread-saved'),
      JSON.stringify(calls)
    )
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].id, 'thread-saved')
    assert.ok(prompts[0].prompt.endsWith('continue'))
    assert.ok(!prompts[0].prompt.includes('Earlier context'), 'the thread has its own history')
    assert.equal(chat.session.record.sdkSessionId, 'thread-saved')
    assert.equal(chat.notes(), 0)
    assert.deepEqual(chat.errors(), [])
    chat.session.dispose()
  }

  // A thread the CLI no longer has: it starts a new, empty one instead. The adapter drops
  // that run and starts its own thread with the chat's summary ahead of the message.
  for (const mode of ['new-thread', 'error']) {
    unknownThread = mode
    const chat = await start({ resumeSessionId: 'thread-gone', resumeSummary: summary })
    await chat.turn('continue')
    assert.deepEqual(calls.slice(0, 2), [
      ['resume', 'thread-gone'],
      ['resume', 'thread-gone']
    ])
    assert.deepEqual(calls.at(-1), ['start'], `${mode}: a new thread replaces the lost one`)
    const first = prompts.at(-1).prompt
    assert.ok(first.includes('Earlier context'), `${mode}: the new thread gets the summary`)
    assert.ok(
      first.includes('User: I want to experiment on a footer with three contact links'),
      `${mode}: the model's first context has the last user request`
    )
    assert.ok(first.includes('src/Footer.tsx'))
    assert.ok(first.endsWith('continue'))
    assert.ok(first.indexOf('---') < first.indexOf('Earlier context'), 'Trezi rules first')
    assert.equal(chat.notes(), 1, `${mode}: one note says the context was summarized`)
    assert.deepEqual(chat.errors(), [], `${mode}: a lost resume is not shown as an error`)
    const id = chat.session.record.sdkSessionId
    assert.match(id, /^thread-new-/, `${mode}: the new thread is the chat's resumable id`)
    // The next turn continues the new thread, without the summary again.
    await chat.turn('and the copyright line')
    assert.deepEqual(calls.at(-1), ['resume', id])
    assert.ok(!prompts.at(-1).prompt.includes('Earlier context'))
    assert.equal(chat.notes(), 1)
    chat.session.dispose()
  }
} finally {
  if (previousBin === undefined) delete process.env.TREZI_CODEX_BIN
  else process.env.TREZI_CODEX_BIN = previousBin
  rmSync(scratch, { recursive: true, force: true })
}
console.log('codex-resume: OK')
