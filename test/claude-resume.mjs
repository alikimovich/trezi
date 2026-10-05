/** LKM-165: a Claude resume the CLI refuses starts a new session and completes the turn. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answer, calls, noConversation, scripts } from './helpers/claude-sdk-mock.mjs'

let failed = 0
const ok = (condition, message) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    failed++
  }
}
const { claudeProvider } = await import('../src/main/backends/claude.ts')
const { RESUME_NOTE } = await import('../src/main/backends/claude-resume.ts')

const root = mkdtempSync(join(tmpdir(), 'claude-resume-'))
const run = async (script, context) => {
  scripts.push(...script)
  const events = []
  const session = await claudeProvider.startSession(root, {}, () => null, {
    emitKey: 'p#chat',
    onEvent: (event) => events.push(event),
    ...context
  })
  return { session, events }
}
const settled = async (events, type) => {
  for (let i = 0; i < 200 && !events.some((e) => e.type === type); i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
}

// An unknown session id: no raw error, one note, the turn succeeds on a new session.
{
  const before = calls.length
  const { session, events } = await run([noConversation('gone'), answer('done here')], {
    resumeSessionId: 'gone',
    resumeSummary: 'Last messages:\nUser: add a footer\nAssistant: added it'
  })
  session.send('now make it blue')
  await settled(events, 'done')
  ok(calls[before].options.resume === 'gone', 'the first query resumed the stored session')
  ok(calls.length === before + 2, 'a new query replaced the failed resume')
  ok(!('resume' in calls[before + 1].options), 'the new session does not resume')
  const prompt = String(calls[before + 1].prompts[0])
  ok(prompt.includes('now make it blue'), 'the new session got the user message')
  ok(prompt.includes('add a footer'), 'the new session was seeded with the chat summary')
  ok(!events.some((e) => e.type === 'error'), 'no error event reaches the chat')
  ok(!JSON.stringify(events).includes('No conversation found'), 'the raw error never shows')
  ok(
    events.filter((e) => e.type === 'status' && e.text === RESUME_NOTE).length === 1,
    'exactly one recovery note'
  )
  ok(
    events.some((e) => e.type === 'done'),
    'the turn completed'
  )
  ok(
    events.some((e) => e.type === 'delta' || e.type === 'usage' || e.type === 'done'),
    'events flowed'
  )
  session.shutdown()
}

// The CLI answers with an error result instead of throwing: same recovery.
{
  const before = calls.length
  const resultError = async function* (input) {
    for await (const _ of input) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['No conversation found with session ID: gone']
      }
      return
    }
  }
  const { session, events } = await run([resultError, answer()], { resumeSessionId: 'gone' })
  session.send('hello')
  await settled(events, 'done')
  ok(calls.length === before + 2, 'an error result on resume starts a new session')
  ok(String(calls[before + 1].prompts[0]).includes('hello'), 'the same turn was replayed')
  ok(!events.some((e) => e.type === 'error'), 'no error event for an error result either')
  ok(events.filter((e) => e.type === 'done').length === 1, 'exactly one done for the turn')
  session.shutdown()
}

// A session that was not resumed reports its failures as before.
{
  const { session, events } = await run([noConversation('x')], {})
  session.send('hi')
  await settled(events, 'error')
  ok(
    events.some((e) => e.type === 'error'),
    'a fresh session still reports its own error'
  )
  session.shutdown()
}

if (failed) process.exit(1)
console.log('claude-resume: OK')
process.exit(0)
