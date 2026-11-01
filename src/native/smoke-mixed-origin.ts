/** LKM-407: integrated, deterministic provider turns on a disposable Git project.
 * Every state assertion below reads the live Swift UI or the real service/tool path. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setNativeSmokeProvider } from '../main/backends'
import { createRecordCapture } from '../main/backends/record'
import type { ModelProvider, ProviderSession, SpawnContext } from '../main/backends/types'
import { swiftConversationOwner } from '../main/conversation-owner'
import { runTreziTool } from '../main/session-tools'
import type { AgentEvent, AgentOptions } from '../shared/api'
import { projectKey } from '../shared/projectKey'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { type NativeView, serviceEvents } from './platform'
import { git, initRepo } from './smoke-swift-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

type Worker = {
  cwd: string
  ctx: SpawnContext
  session: ProviderSession
  sent: string[]
  say: (text: string) => void
  done: () => void
}

const workers = new Map<string, Worker>()
const events: AgentEvent[] = []
const checks = `import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
appendFileSync('.runs', 'x')
const page = readFileSync('page.txt', 'utf8')
if (/^(<{7}|>{7})/m.test(page)) process.exit(2)
for (const name of existsSync('asserts') ? readdirSync('asserts') : []) {
  const expected = readFileSync('asserts/' + name, 'utf8').trim()
  if (expected && !page.includes(expected)) process.exit(3)
}
`

const provider: ModelProvider = {
  id: 'native-mixed-origin-stub',
  supportsSpawn: true,
  async startSession(
    cwd: string,
    options: AgentOptions,
    getWindow: () => NativeView | null,
    ctx?: SpawnContext
  ) {
    assert.ok(ctx, 'the fixture needs a real session context')
    const capture = createRecordCapture(cwd, projectKey(cwd))
    let disposed = false
    const sent: string[] = []
    const emit = (event: AgentEvent) => {
      if (disposed) return
      const tagged = {
        ...event,
        projectKey: ctx.emitKey,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {})
      } as AgentEvent
      ctx.onEvent?.(tagged)
      getWindow()?.webContents.send('agent:event', tagged)
    }
    const session: ProviderSession = {
      key: projectKey(cwd),
      root: cwd,
      options,
      record: capture.record,
      pending: new Map(),
      pendingQuestions: new Map(),
      finalize: capture.finalize,
      dispose: () => {
        disposed = true
      },
      shutdown: () => {},
      send: (text) => {
        sent.push(text)
      },
      emit,
      interrupt: async () => {
        capture.finalize()
        emit({ type: 'done' } as AgentEvent)
        return undefined
      }
    }
    const worker: Worker = {
      cwd,
      ctx,
      session,
      sent,
      say: (text) => capture.appendAssistant(text),
      done: () => {
        capture.finalize()
        emit({ type: 'done' } as AgentEvent)
      }
    }
    workers.set(ctx.sessionId ?? ctx.emitKey, worker)
    return session
  }
}

const page = (line: string) =>
  `${Array.from({ length: 20 }, (_, i) => (i === 5 ? line : `line ${i}`)).join('\n')}\n`

function setup(project: string) {
  rmSync(project, { recursive: true, force: true })
  mkdirSync(join(project, 'asserts'), { recursive: true })
  writeFileSync(join(project, 'index.html'), '<h1>Mixed origin fixture</h1>\n')
  writeFileSync(join(project, 'page.txt'), page('hero base'))
  writeFileSync(join(project, 'package.json'), '{"scripts":{"test":"bun check.mjs"}}\n')
  writeFileSync(join(project, 'check.mjs'), checks)
  writeFileSync(join(project, '.gitignore'), '.runs\n')
  initRepo(project)
}

function edit(worker: Worker, side: string, line: string, behavior: string) {
  writeFileSync(join(worker.cwd, 'page.txt'), page(line))
  writeFileSync(join(worker.cwd, 'asserts', side), `${behavior}\n`)
}

async function checked(project: string, worker: Worker) {
  const result = (await runTreziTool(
    'run_checks',
    { checks: ['test'] },
    {
      root: worker.cwd,
      liveRoot: project,
      emitKey: worker.ctx.emitKey,
      background: !!worker.ctx.sessionId,
      ...(worker.ctx.sessionId ? { peerId: worker.ctx.sessionId } : {}),
      notify() {}
    }
  )) as { results?: { receipt?: { verified?: boolean } }[] }
  assert.equal(result.results?.[0]?.receipt?.verified, true, JSON.stringify(result).slice(0, 700))
}

async function snapshot(
  host: NativeBridge,
  artifacts: string,
  label: string,
  project: string,
  chatId: string
) {
  const [chat, shell] = await Promise.all([
    host.request('chatInspect'),
    host.request('shellInspect')
  ])
  const source = {
    head: git(project, 'rev-parse', 'HEAD'),
    tree: git(project, 'rev-parse', 'HEAD^{tree}'),
    page: readFileSync(join(project, 'page.txt'), 'utf8'),
    branches: git(project, 'branch', '--list'),
    peerFeed: await swiftConversationOwner()?.peers(project, chatId),
    chat,
    shell,
    events: events.filter((event) =>
      ['peer-state', 'isolation', 'landing-finished', 'spawn-finished'].includes(event.type)
    )
  }
  writeFileSync(join(artifacts, `${label}.json`), JSON.stringify(source, null, 2))
  const visible = await host.request('captureVisibleWindow')
  writeFileSync(join(artifacts, `${label}.png`), Buffer.from(visible.png, 'base64'))
  return source
}

async function spawn(
  project: string,
  parent: string,
  goal: string,
  origin: 'comment' | 'text-edit'
) {
  const result = await nativeChat.services.invoke(
    'agent:spawn-comment',
    project,
    goal,
    parent,
    { provider: 'codex' },
    origin
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.queued, undefined, `${origin} started from the common base`)
  const worker = workers.get(result.spawnId)
  assert.ok(worker, `${origin} got a deterministic provider session`)
  return { worker, id: result.spawnId, branch: result.branch }
}

async function finishSpawn(id: string, worker: Worker) {
  const before = worker.sent.length
  worker.done()
  await waitFor(
    () =>
      events.find((event) => event.type === 'spawn-finished' && event.sessionId === id) ||
      worker.sent.length > before,
    `spawn ${id} settles`,
    60_000
  )
  return events.find((event) => event.type === 'spawn-finished' && event.sessionId === id) as
    | Extract<AgentEvent, { type: 'spawn-finished' }>
    | undefined
}

function combine(worker: Worker, line: string) {
  const source = readFileSync(join(worker.cwd, 'page.txt'), 'utf8')
  assert.match(source, /<<<<<<< /, 'real reconciliation put conflict markers in the worktree')
  writeFileSync(
    join(worker.cwd, 'page.txt'),
    source.replace(/<<<<<<< [^\n]*\n[\s\S]*?>>>>>>> [^\n]*\n/g, `${line}\n`)
  )
}

async function caseRun(
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  sourceRoot: string,
  mode: 'compatible' | 'incompatible'
) {
  const previous = nativeWorkspace.state.activeKey
  assert.ok(previous)
  const project = join(fixture, `../Mixed Origin ${mode}`)
  const started = performance.now()
  const activeSpawns: string[] = []
  events.length = 0
  workers.clear()
  const observe = (channel: string, event: AgentEvent) => {
    if (channel === 'agent:event') events.push(event)
  }
  serviceEvents.on('event', observe)
  setup(project)
  setNativeSmokeProvider(provider)
  try {
    await nativeWorkspace.command({ type: 'open', root: project })
    await waitFor(
      () =>
        nativeWorkspace.active?.root === project && nativeChat.chats.get(nativeChat.active)?.ready,
      'mixed-origin project ready',
      40_000
    )
    const chatId = nativeChat.active
    const chat = workers.get(chatId)
    assert.ok(chat, 'foreground chat uses the stub provider')
    const goal = mode === 'compatible' ? 'Show price in the hero' : 'Make the theme dark only'
    await host.request('composerPerform', { text: goal })
    await waitFor(
      async () => (await host.request('composerInspect')).enabled,
      'mixed-origin composer enabled',
      20_000
    )
    await host.request('composerPerform', { action: 'send' })
    await waitFor(() => chat.sent.length === 1, 'foreground turn reached provider', 30_000)
    const comment = await spawn(
      project,
      chatId,
      mode === 'compatible' ? 'Show sale badge in the hero' : 'Make the theme light only',
      'comment'
    )
    const background = await spawn(
      project,
      chatId,
      mode === 'compatible' ? 'Show delivery note in the hero' : 'Make the theme light only',
      'text-edit'
    )
    activeSpawns.push(comment.id, background.id)
    const originalHead = git(project, 'rev-parse', 'HEAD')
    if (mode === 'compatible') {
      edit(chat, 'chat', 'hero price=10', 'price=10')
      edit(comment.worker, 'comment', 'hero badge=sale', 'badge=sale')
      edit(background.worker, 'background', 'hero delivery=free', 'delivery=free')
    } else {
      edit(chat, 'chat', 'hero theme=dark', 'theme=dark')
      edit(comment.worker, 'comment', 'hero theme=light', 'theme=light')
      edit(background.worker, 'background', 'hero theme=light', 'theme=light')
    }
    for (const worker of [chat, comment.worker, background.worker]) await checked(project, worker)
    const overlap = await waitFor(
      async () => {
        const ui = await host.request('chatInspect')
        return (
          ui.cardStates?.find(
            (card: any) => card.id === 'peer-work' && /overlap/i.test(card.title)
          ) && ui
        )
      },
      'real overlap shown in Swift chat',
      20_000
    )
    assert.ok(overlap.cardStates.some((card: any) => card.id === 'peer-work'))
    await snapshot(host, artifacts, `mixed-${mode}-overlap`, project, chatId)
    assert.equal(git(project, 'rev-parse', 'HEAD'), originalHead, 'all three began from one base')
    if (mode === 'compatible') {
      chat.done()
      await waitFor(
        () =>
          events.some((event) => event.type === 'landing-finished' && event.projectKey === chatId),
        'foreground landing',
        60_000
      )
      const first = await finishSpawn(comment.id, comment.worker)
      assert.equal(first, undefined, 'comment must reconcile the overlapping source')
      combine(comment.worker, 'hero price=10 badge=sale')
      await checked(project, comment.worker)
      const second = await finishSpawn(comment.id, comment.worker)
      assert.equal(second?.outcome, 'applied', 'the checked combined comment landed')
      const third = await finishSpawn(background.id, background.worker)
      assert.equal(third, undefined, 'background task must reconcile the overlapping source')
      combine(background.worker, 'hero price=10 badge=sale delivery=free')
      await checked(project, background.worker)
      const final = await finishSpawn(background.id, background.worker)
      assert.equal(final?.outcome, 'applied', 'the checked combined background task landed')
      execFileSync('bun', ['check.mjs'], { cwd: project })
      const live = readFileSync(join(project, 'page.txt'), 'utf8')
      for (const behavior of ['price=10', 'badge=sale', 'delivery=free'])
        assert.ok(live.includes(behavior), `${behavior} exists on the exact landed tree`)
      assert.notEqual(git(project, 'rev-parse', 'HEAD'), originalHead)
    } else {
      const first = await finishSpawn(comment.id, comment.worker)
      assert.equal(first?.outcome, 'applied')
      const before = git(project, 'rev-parse', 'HEAD')
      chat.done()
      await waitFor(() => chat.sent.length > 1, 'incompatible chat reconciliation prompt', 60_000)
      chat.say('DECISION NEEDED: Should the theme be dark only or light only?')
      chat.done()
      const held = await waitFor(
        async () => {
          const ui = await host.request('chatInspect')
          return ui.cardStates?.find((card: any) => card.title === 'Decision needed') && ui
        },
        'decision on the existing Swift card',
        60_000
      )
      const card = held.cardStates.find((value: any) => value.title === 'Decision needed')
      assert.match(card.detail, /dark only or light only/)
      assert.deepEqual(card.actions, ['Discard'])
      assert.equal(git(project, 'rev-parse', 'HEAD'), before, 'neither side silently selected')
      assert.match(readFileSync(join(project, 'page.txt'), 'utf8'), /theme=light/)
      assert.ok(git(project, 'branch', '--list', 'trezi/chat-*'), 'held chat branch is recoverable')
      assert.ok(
        background.worker.cwd !== project,
        'background task remains separate and recoverable'
      )
    }
    const final = await snapshot(host, artifacts, `mixed-${mode}-final`, project, chatId)
    const runtimeMs = Math.round(performance.now() - started)
    const bytes = Buffer.byteLength(JSON.stringify(final))
    writeFileSync(
      join(artifacts, `mixed-${mode}-evidence.json`),
      JSON.stringify(
        {
          sourceSha: git(sourceRoot, 'rev-parse', 'HEAD'),
          fixtureHead: final.head,
          fixtureTree: final.tree,
          runtimeMs,
          stateBytes: bytes,
          provider: 'deterministic stub',
          skipped: false
        },
        null,
        2
      )
    )
    console.log(
      `Mixed origin ${mode}: ${runtimeMs} ms, ${bytes} state bytes; deterministic provider stub.`
    )
  } finally {
    for (const id of activeSpawns)
      if (!events.some((event) => event.type === 'spawn-finished' && event.sessionId === id))
        await nativeChat.services.invoke('agent:spawn-interrupt', id).catch(() => {})
    setNativeSmokeProvider(undefined)
    if (nativeWorkspace.active?.root === project) {
      await nativeWorkspace.command({ type: 'close', key: nativeWorkspace.active.key })
    }
    if (previous && nativeWorkspace.state.activeKey !== previous)
      await host.request('shellPerform', { action: 'select-row', row: `project:${previous}` })
    serviceEvents.off('event', observe)
    workers.clear()
  }
}

export const checkMixedOriginCompatible = (
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  sourceRoot: string
) => caseRun(host, fixture, artifacts, sourceRoot, 'compatible')
export const checkMixedOriginIncompatible = (
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  sourceRoot: string
) => caseRun(host, fixture, artifacts, sourceRoot, 'incompatible')
