// LKM-165, no desktop: "This chat is already running." is never a dead end. A landing
// that never completes shows as running and names the landing; Stop ends it; the next
// message is queued or accepted, never refused. A stalled landing and a silent turn end
// on their own, and a busy refusal from the backend queues the message.
import assert from 'node:assert/strict'
import { LandingEnded, LandingGuard, TurnWatchdog } from '../src/main/chat-watchdog.ts'
import { ReconciliationCoordinator } from '../src/main/conflict-resolution.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { CHAT_BUSY, isChatBusy } from '../src/shared/chat-busy.ts'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const never = () => new Promise(() => {})
const live = '/Users/me/app'

// The bounded waits, alone.
{
  const guard = new LandingGuard(20)
  await assert.rejects(guard.run('k', never()), LandingEnded, 'a stalled landing is ended')
  assert.equal(guard.has('k'), false)
  const stopped = guard.run('k', never(), 60_000)
  assert.equal(guard.has('k'), true)
  assert.equal(guard.abandon('k', 'Stopped.'), true)
  await assert.rejects(stopped, /Stopped\./)
  assert.equal(guard.abandon('k', 'again'), false, 'nothing left to stop')
  assert.equal(await guard.run('k', Promise.resolve(7)), 7, 'a landing that finishes is untouched')
  await assert.rejects(guard.run('k', Promise.reject(new Error('git failed'))), /git failed/)

  let now = 0
  const dog = new TurnWatchdog(1000, () => now)
  assert.deepEqual(dog.stuck(['a']), [], 'a chat first seen starts its clock')
  now = 999
  assert.deepEqual(dog.stuck(['a']), [])
  dog.touch('a')
  now = 1500
  assert.deepEqual(dog.stuck(['a']), [], 'progress restarts the clock')
  now = 1999
  assert.deepEqual(dog.stuck(['a', 'idle']), ['a'], 'silence past the limit is stuck')
  dog.forget('a')
  assert.deepEqual(dog.stuck(['a']), [])
  assert.ok(isChatBusy(new Error(CHAT_BUSY)) && isChatBusy(`Error: ${CHAT_BUSY}`))
  assert.ok(!isChatBusy(new Error('This chat is closed.')))
}

// A backend double: the coordinator and landing guard as `agent.ts` wires them, with a
// landing that never completes, behind the same channels the native controller calls.
function harness({ stuckMs = 60_000, busyOnce = false } = {}) {
  const calls = [],
    renders = [],
    running = new Set(),
    preparations = new Map()
  const guard = new LandingGuard(stuckMs)
  let controller
  const session = {
    record: { transcript: [{ role: 'user', text: 'hi', at: 1 }] },
    emit: (event) => controller.event({ projectKey: 'a', ...event })
  }
  const coordinator = new ReconciliationCoordinator({
    running,
    preparations,
    currentSession: () => session,
    begin: () => {},
    // `afterTurn`: the landing is bounded, and a landing that ends is held, not thrown.
    land: (key) =>
      guard.run(key, never()).catch((error) => {
        session.emit({
          type: 'isolation',
          state: 'parked',
          files: ['src/a.tsx'],
          reason: 'failed',
          error: error.message
        })
        return null
      }),
    showParked: () => {}
  })
  let busy = busyOnce
  controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: live,
              chats: [
                {
                  sessionKey: 'a',
                  record: { transcript: [] },
                  isRunning: false,
                  options: { provider: 'claude' }
                }
              ]
            }
          ]
        }
      if (channel === 'providers:choices') return []
      if (channel === 'agent:send') {
        if (busy) throw new Error(`Error: ${CHAT_BUSY}`)
        if (running.has('a')) throw new Error(CHAT_BUSY)
        running.add('a')
        const turn = args[4]
        session.emit({ type: 'delta', text: 'Done.', turn })
        // The model finished; its landing never does.
        session.emit({ type: 'done', landingPending: true, turn })
        void coordinator.finish('a', 'edit', 'success', turn)
        return undefined
      }
      if (channel === 'agent:interrupt') {
        guard.abandon('a', 'Stopped before the landing finished.')
        return undefined
      }
      return { ok: true }
    },
    render: (state) => renders.push(structuredClone(state)),
    effect: () => {}
  })
  return {
    controller,
    calls,
    renders,
    running,
    session,
    release: () => {
      busy = false
    },
    sent: () => calls.filter((c) => c[0] === 'agent:send'),
    last: () => renders.at(-1),
    say: async (text, revision) => {
      await controller.composer({ chat: 'a', action: 'input', text, caret: text.length, revision })
      await controller.composer({ chat: 'a', action: 'send' })
      await tick(5)
    }
  }
}
const open = async (h) =>
  h.controller.command({
    type: 'context',
    context: {
      chat: 'a',
      root: live,
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
const transcript = (h) => JSON.stringify(h.last().messages.map((m) => m.text ?? ''))

// 1. A landing that never completes: running, named, Stop ends it, the next message goes.
{
  const h = harness()
  await open(h)
  await h.say('Wrap the bar', 1)
  assert.equal(h.sent().length, 1)
  assert.equal(h.last().activity.kind, 'applying', 'the chat shows it is still running')
  assert.match(h.last().activity.label, /Landing changes/, 'the activity row names the landing')
  assert.ok(h.running.has('a'))
  // A message sent meanwhile is queued, not refused.
  await h.say('Then make it blue', 2)
  assert.equal(h.sent().length, 1, 'the second message waits in the composer queue')
  assert.equal(h.controller.get('a').queue.length, 1)
  assert.ok(!transcript(h).includes('already running'))
  // Stop works on a landing.
  await h.controller.action({ chat: 'a', action: 'stop' })
  await tick(10)
  assert.equal(h.running.has('a'), false, 'the backend is free after Stop')
  assert.equal(h.controller.get('a').isRunning, false, 'the chat is no longer running')
  assert.equal(h.controller.get('a').landingError.length > 0, true, 'the work is held with Retry')
  assert.equal(h.last().activity ?? null, null)
  // The queued message is sent (Send now after Stop), and the backend accepts it.
  await h.controller.action({ chat: 'a', action: 'queue-resume' })
  await tick(10)
  assert.equal(h.sent().length, 2, 'the queued message reached the backend')
  assert.equal(h.sent()[1][1], 'Then make it blue')
  assert.ok(!transcript(h).includes('already running'))
  assert.ok(!transcript(h).includes('Unable to send'))
}

// 2. A landing that stalls ends on its own, with the work held, and the chat takes a message.
{
  const h = harness({ stuckMs: 30 })
  await open(h)
  await h.say('Wrap the bar', 1)
  assert.equal(h.controller.get('a').isRunning, true)
  await tick(120)
  assert.equal(h.running.has('a'), false, 'the stalled landing released the backend')
  assert.equal(h.controller.get('a').isRunning, false, 'and the chat')
  assert.match(h.controller.get('a').landingError, /no progress/)
  await h.say('Try again', 2)
  assert.equal(h.sent().length, 2, 'a new message is accepted')
  assert.ok(!transcript(h).includes('already running'))
}

// 3. The backend refuses with "already running" for a turn the chat did not know of:
//    the message is queued, the chat shows what runs, and it goes once that ends.
{
  const h = harness({ busyOnce: true })
  await open(h)
  await h.say('Wrap the bar', 1)
  assert.equal(h.sent().length, 1)
  assert.ok(!transcript(h).includes('Unable to send'), 'a busy refusal is not shown')
  assert.ok(!transcript(h).includes('already running'))
  assert.equal(h.controller.get('a').queue.length, 1, 'the message waits in the queue')
  assert.equal(h.controller.get('a').messages.length, 0, 'no half-sent message is left behind')
  assert.equal(h.last().activity.kind, 'applying')
  assert.match(h.last().activity.label, /Finishing the previous step/)
  h.release()
  h.session.emit({ type: 'landing-finished' })
  await tick(10)
  assert.equal(h.sent().length, 2, 'the queued message is sent when the busy turn ends')
  assert.equal(h.sent()[1][1], 'Wrap the bar')
}

console.log('chat-stuck-turn: OK')
process.exit(0)
