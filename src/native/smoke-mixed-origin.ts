/** LKM-407: integrated, deterministic provider turns on a disposable Git project.
 * Every state assertion below reads the live Swift UI or the real service/tool path. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseAgentBrowsersFor } from '../main/agent-browser'
import { setNativeSmokeProvider } from '../main/backends'
import { createRecordCapture } from '../main/backends/record'
import type { ModelProvider, ProviderSession, SpawnContext } from '../main/backends/types'
import { swiftConversationOwner } from '../main/conversation-owner'
import { integrationGate } from '../main/integration-gate'
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

const HEADING = 'Mixed origin fixture'
/** The project is a static web project, so its landing gate needs a browser check. */
const PAGE_HTML = `<!doctype html><html><head><title>${HEADING}</title><link rel="icon" href="data:,"></head><body><h1>${HEADING}</h1></body></html>\n`

const page = (line: string) =>
  `${Array.from({ length: 20 }, (_, i) => (i === 5 ? line : `line ${i}`)).join('\n')}\n`

function setup(project: string) {
  rmSync(project, { recursive: true, force: true })
  mkdirSync(join(project, 'asserts'), { recursive: true })
  // Tracked and empty: worktrees get the folder (Git keeps no empty one), and a chat only
  // reconciles text files its base already has (`canReconcileText`).
  for (const side of ['chat', 'comment', 'background'])
    writeFileSync(join(project, 'asserts', side), '')
  writeFileSync(join(project, 'index.html'), PAGE_HTML)
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

const gateScope = (project: string, worker: Worker) => ({
  emitKey: worker.ctx.emitKey,
  root: worker.cwd,
  liveRoot: project
})

/** The two real checks the gate needs for this static web project, on the worker's exact tree:
 *  the project's own test command and a browser check in its private WebKit page. */
async function checked(project: string, worker: Worker) {
  const scope = {
    ...gateScope(project, worker),
    background: !!worker.ctx.sessionId,
    ...(worker.ctx.sessionId ? { peerId: worker.ctx.sessionId } : {}),
    notify() {}
  }
  const result = (await runTreziTool('run_checks', { checks: ['test'] }, scope)) as {
    results?: { receipt?: { verified?: boolean } }[]
  }
  assert.equal(result.results?.[0]?.receipt?.verified, true, JSON.stringify(result).slice(0, 700))
  // The static server reloads a page already open here after each write to the worktree, and
  // a receipt refuses a document replaced under it: check again, as an agent would, until the
  // page holds still. Only a verified receipt ends this, and the gate reads the newest one.
  let browser: { isError?: boolean; content?: { type: string; text?: string }[] } | undefined
  await waitFor(
    async () => {
      browser = (await runTreziTool(
        'preview_verify',
        { path: '/', checks: [{ kind: 'text', selector: 'h1', equals: HEADING, timeoutMs: 3000 }] },
        scope
      )) as typeof browser
      return !browser?.isError
    },
    `preview_verify passed on ${worker.cwd}`,
    20_000,
    () => JSON.stringify(browser).slice(0, 700),
    250
  )
  await gateOpen(project, worker)
}

/** Names a gate hold as one, instead of a later missing `merged` event. */
async function gateOpen(project: string, worker: Worker) {
  const verdict = await integrationGate(gateScope(project, worker))
  assert.equal(verdict.ok, true, `landing gate open for ${worker.cwd}: ${JSON.stringify(verdict)}`)
  assert.equal(verdict.need, 'browser', 'a static web project needs a browser check')
  assert.ok(
    verdict.evidence.some((item) => item.verified),
    'the gate has a passing receipt on this exact tree'
  )
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
  const notes: Record<string, unknown> = {}
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
      mode === 'compatible'
        ? 'Show delivery note in the hero'
        : 'Make the theme high contrast only',
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
      edit(background.worker, 'background', 'hero theme=contrast', 'theme=contrast')
    }
    for (const worker of [chat, comment.worker, background.worker]) await checked(project, worker)
    // Exact-file coordination only: the semantic "Possible overlap" advisory must not satisfy it.
    const exactOverlap = (card: { id: string; title: string; detail: string }) =>
      card.id === 'peer-work' &&
      card.title === 'Overlaps with other work' &&
      /page\.txt/.test(card.detail) &&
      card.detail.includes('A comment agent') &&
      card.detail.includes('A text edit')
    await waitFor(
      async () => {
        const ui = await host.request('chatInspect')
        return ui.cardStates?.some(exactOverlap)
      },
      'real exact-file overlap with both peers shown in Swift chat',
      20_000
    )
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
      // landing-finished is also emitted for a failed landing: the merge itself must show.
      assert.ok(
        events.some(
          (event) =>
            event.type === 'isolation' && event.state === 'merged' && event.projectKey === chatId
        ),
        'the foreground chat landed through the gate'
      )
      assert.ok(
        readFileSync(join(project, 'page.txt'), 'utf8').includes('price=10'),
        'the foreground behavior is on the live tree'
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
      // The last landing is the exact combined tree: re-checked after combining, and it is HEAD's.
      assert.ok(final)
      assert.equal(
        final.gate?.combinedRechecked,
        true,
        'the last landing re-ran checks on the combination'
      )
      assert.equal(
        final.gate?.tree,
        git(project, 'rev-parse', 'HEAD^{tree}'),
        'the gate verified the tree that is now HEAD'
      )
      assert.equal(git(project, 'status', '--porcelain'), '', 'the fixture project is clean')
      notes.landedGateTree = final.gate?.tree
    } else {
      // The comment finishes first and lands through the existing first-lands gate, so
      // theme=light IS on live before any decision. That is not a silent selection of a
      // side: the held chat and the background peer are the unlanded work.
      const first = await finishSpawn(comment.id, comment.worker)
      assert.equal(first?.outcome, 'applied', 'the comment landed first through the gate')
      const afterComment = git(project, 'rev-parse', 'HEAD')
      assert.notEqual(afterComment, originalHead)
      notes.firstLanded = 'comment (theme=light) via the existing first-lands gate'

      // The background peer's goal cannot hold beside the landed light theme: it
      // reconciles, cannot combine, and ends on a decision with its work kept on a branch.
      const settling = await finishSpawn(background.id, background.worker)
      assert.equal(settling, undefined, 'background task must reconcile against the landed theme')
      background.worker.say(
        'DECISION NEEDED: Should the theme be light only or high contrast only?'
      )
      const peer = await finishSpawn(background.id, background.worker)
      assert.equal(peer?.outcome, 'review', 'background task is kept for review, not landed')
      assert.ok(peer?.branch, 'background task keeps its work on a branch')
      assert.match(peer.decision ?? '', /light only or high contrast only/)
      assert.equal(git(project, 'rev-parse', 'HEAD'), afterComment, 'background did not move live')
      assert.match(
        git(project, 'show', `${peer.branch}:page.txt`),
        /theme=contrast/,
        'background work is recoverable on its branch'
      )
      notes.backgroundBranch = peer.branch
      notes.backgroundDecision = peer.decision

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
      assert.equal(
        git(project, 'rev-parse', 'HEAD'),
        afterComment,
        'neither side silently selected'
      )
      const live = readFileSync(join(project, 'page.txt'), 'utf8')
      assert.match(live, /theme=light/, 'only the comment, which landed first, is on live')
      assert.doesNotMatch(live, /theme=dark|theme=contrast/, 'held work is not on live')
      // "Nothing landed" in the card refers to the held chat only. Read that work itself.
      const parked = events.find(
        (event) =>
          event.type === 'isolation' &&
          event.state === 'parked' &&
          event.projectKey === chatId &&
          !!event.decision
      ) as Extract<AgentEvent, { type: 'isolation' }> | undefined
      assert.ok(parked?.branch, 'the chat parked on a branch with a decision')
      assert.ok(card.detail.includes(parked.branch), 'the card names the branch holding the work')
      assert.match(
        git(project, 'show', `${parked.branch}:page.txt`),
        /theme=dark/,
        'the chat’s work is recoverable on its held branch'
      )
      notes.chatBranch = parked.branch
      notes.chatDecision = parked.decision
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
          skipped: false,
          ...notes
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
    // Held and interrupted work keeps its private WebKit page and server until released.
    for (const worker of workers.values()) await releaseAgentBrowsersFor(worker.cwd).catch(() => {})
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
