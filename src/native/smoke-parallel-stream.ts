import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubAgentSendForSmoke } from '../main/agent'
import { isolatedCwd } from '../main/chat-isolation'
import type { AgentEvent } from '../shared/api'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import {
  cleanSharedChat,
  endSharedTurn,
  requireCleanSharedChat,
  sharedTurnProblems
} from './smoke-shared-chat'
import {
  formatTimeline,
  type StreamSample,
  streamSample,
  watchStream
} from './smoke-stream-timeline'
import { initRepo } from './smoke-swift-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

/**
 * LKM-383: two chats stream at once while the check switches between them, as a user does from the
 * sidebar. A chat streams through the provider stub, New chat opens a second one, which sends and
 * streams too. At every step (`smoke-stream-timeline.ts`) Swift shows the active chat, the column
 * is visible, a message row is in view and the last row reaches Bun's text. This is the blank chat
 * column of LKM-354's watch item; the trigger is still unknown, this case does not produce it.
 * Captures and the timeline land in the artifacts folder.
 *
 * LKM-412: the check runs in its own disposable Git project. The suite's project has no Git
 * repository, so its chats share the live folder and LKM-404 admits one writer turn at a time
 * there; only per-chat worktrees can stream at once.
 */
const CHUNK_MS = 90
const SWITCHES = 3
const PROJECT = 'Parallel Stream'
/** Opening a project and forking a chat's worktree take longer than a step of the stream. */
const SETUP_MS = 30_000
const para =
  'This streamed answer has enough words to wrap across several lines of the chat column, so the row grows. '

let suiteProject = ''
let sharedChat = ''
let home = ''
let second = ''
const stubs = new Map<string, ReturnType<typeof stubAgentSendForSmoke>>()
const timers: ReturnType<typeof setInterval>[] = []

const turn = (chat: string) => ({
  state: () => nativeChat.services.invoke('agent:turn-state', chat),
  controller: () => nativeChat.get(chat)
})

const stopStreams = () => {
  for (const timer of timers.splice(0)) clearInterval(timer)
}

export async function checkParallelStream(host: NativeBridge, fixture: string, artifacts: string) {
  const first = nativeWorkspace.state.activeKey
  assert.ok(first, 'Parallel streams need an open project')
  const shared = nativeChat.active
  // An earlier check's turn may still be settling; a real leftover is named by the guard.
  await waitFor(
    async () => !(await sharedTurnProblems(turn(shared))).length,
    'shared chat idle',
    5000
  ).catch(() => {})
  await requireCleanSharedChat(host, 'parallel-stream', turn(shared))
  suiteProject = first
  sharedChat = shared
  home = ''
  second = ''

  const project = join(fixture, `../${PROJECT}`)
  rmSync(project, { recursive: true, force: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'index.html'), '<h1 id="parallel-stream">Parallel streams</h1>\n')
  initRepo(project)
  await nativeWorkspace.command({ type: 'open', root: project })
  const opened = await waitFor(
    () => nativeWorkspace.active?.key !== first && nativeWorkspace.active,
    'parallel-stream Git project open',
    SETUP_MS
  )
  const { key, root } = opened
  await waitFor(
    () => nativeChat.active !== shared && nativeChat.chats.get(nativeChat.active)?.ready,
    'parallel-stream chat ready',
    SETUP_MS
  )
  const a = nativeChat.active
  home = a
  const timeline: StreamSample[] = []

  const read = async (label: string, chat: string) => {
    const swift = await host.request('chatInspect')
    const shell = await host.request('shellInspect')
    const active = nativeChat.active
    return streamSample(label, chat, swift, shell, {
      active,
      messages: nativeChat.get(active).messages
    })
  }
  const step = async (label: string, chat: string, rows = true) => {
    await watchStream({ label, read: () => read(label, chat), timeline, rows })
    writeFileSync(
      join(artifacts, `parallel-stream-${label}.png`),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
  }
  const send = async (chat: string, text: string) => {
    const sent: unknown[] = []
    // A new chat's provider session can land just after the chat became active.
    const stub = await waitFor(
      () => stubAgentSendForSmoke(chat, (...args) => void sent.push(args)),
      `provider session of ${chat}`,
      SETUP_MS
    )
    stubs.set(chat, stub)
    assert.notEqual(await isolatedCwd(root, chat), root, `${chat} has a worktree of its own`)
    await host.request('composerPerform', { text })
    await waitFor(
      async () => {
        const composer = await host.request('composerInspect')
        return composer.enabled && composer.text === text
      },
      `composer holds "${text}"`,
      SETUP_MS
    )
    await host.request('composerPerform', { action: 'send' })
    await waitFor(() => sent.length === 1, `"${text}" reached the provider stub`, SETUP_MS)
    return stub
  }
  const stream = (stub: ReturnType<typeof stubAgentSendForSmoke>, name: string) => {
    let chunk = 0
    timers.push(
      setInterval(
        () => stub.emit({ type: 'delta', text: `${name}${++chunk} ${para}` } as AgentEvent),
        CHUNK_MS
      )
    )
  }
  const select = (chat: string) =>
    host.emit('shell-action', { action: 'select', id: `chat:${chat}`, project: key })

  try {
    const stubA = await send(a, 'Parallel turn A')
    stream(stubA, 'A')
    await step('a-streaming', a)
    host.emit('shell-action', { action: 'new-chat', project: key })
    await waitFor(() => nativeChat.active !== a, 'second chat became active')
    const b = nativeChat.active
    second = b
    await step('b-new', b, false)
    const stubB = await send(b, 'Parallel turn B')
    await step('b-sent', b)
    stream(stubB, 'B')
    await step('b-streaming', b)
    for (let i = 0; i < SWITCHES; i++) {
      select(a)
      await step(`to-a-${i}`, a)
      select(b)
      await step(`to-b-${i}`, b)
    }
    stopStreams()
    stubB.emit({ type: 'done' } as AgentEvent)
    stubA.emit({ type: 'done' } as AgentEvent)
    await step('done-b', b)
    select(a)
    await step('done-a', a)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason}\n${formatTimeline(timeline)}`, { cause: error })
  } finally {
    writeFileSync(
      join(artifacts, 'parallel-stream-timeline.json'),
      JSON.stringify(timeline, null, 1)
    )
  }
  await restoreParallelStream(host)
}

/** Stops the streams, ends both turns, restores the stubs, closes the second chat, returns to the
 *  suite's project and chat and closes the disposable project. Every step runs; the first failure
 *  is thrown at the end. */
export async function restoreParallelStream(host: NativeBridge) {
  stopStreams()
  const key = nativeWorkspace.state.projects.find((p) => p.root.endsWith(`/${PROJECT}`))?.key
  const [first, shared, a, b] = [suiteProject, sharedChat, home, second]
  suiteProject = ''
  sharedChat = ''
  home = ''
  second = ''
  let failure: unknown
  const note = (error: unknown) => {
    failure ??= error
  }
  const finish = (chat: string) => () => stubs.get(chat)?.emit({ type: 'done' } as AgentEvent)
  if (b) await endSharedTurn(turn(b), finish(b)).catch(note)
  if (a && key && nativeChat.active !== a) {
    await nativeWorkspace.command({ type: 'chat', key, session: a }).catch(note)
    await waitFor(() => nativeChat.active === a, 'first chat active again').catch(note)
  }
  if (a) note(await cleanSharedChat(host, turn(a), finish(a)))
  for (const stub of stubs.values()) stub.restore()
  stubs.clear()
  if (b && key) await nativeWorkspace.command({ type: 'close-chat', key, session: b }).catch(note)
  if (first) {
    if (nativeWorkspace.active?.key !== first) {
      await host
        .request('shellPerform', { action: 'select-row', row: `project:${first}` })
        .catch(note)
      await waitFor(() => nativeWorkspace.active?.key === first, 'suite project selected').catch(
        note
      )
    }
    if (key) await nativeWorkspace.command({ type: 'close', key }).catch(note)
    if (shared && nativeChat.active !== shared)
      await nativeWorkspace.command({ type: 'chat', key: first, session: shared }).catch(note)
    // Switching back restarts the suite project's preview; the next checks drive it.
    await waitFor(
      async () =>
        nativeWorkspace.state.status.kind === 'running' &&
        !(await host.request('layoutInspect')).previewHidden,
      'suite project preview shown',
      SETUP_MS
    ).catch(note)
  }
  if (failure) throw failure
}
