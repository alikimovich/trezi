import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stubPlanningForSmoke } from '../main/agent'
import { workflowOwner } from '../main/workflow-owner'
import type { WorkspaceSnapshot } from '../shared/api'
import type { ProviderReadinessMap } from '../shared/provider-readiness'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { nativeWorkspace } from './workspace-runtime'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const background = () => process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'
const NORMAL = { width: 1320, height: 860 }
const NARROW = { width: 860, height: 640 }

let saved: {
  invoke: typeof nativeChat.services.invoke
  readiness: ProviderReadinessMap
  window: { width: number; height: number }
  root: string
  temporary: string
  stub: { restore(): void }
  workspaceInvoke: typeof nativeWorkspace.services.invoke
  choices: typeof nativeChat.choices
} | null = null

async function until<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  label: string
): Promise<T> {
  let last: T | undefined
  for (const end = Date.now() + 20_000; Date.now() < end; await pause(50)) {
    last = await read()
    if (check(last)) return last
  }
  throw new Error(`Start composer: ${label}: ${JSON.stringify(last)}`)
}

/** The real host/layout, with provider intelligence stubbed at the planning IPC seam. */
export async function checkStartComposer(host: NativeBridge, _fixture: string, artifacts: string) {
  const project = nativeWorkspace.active
  assert.ok(project, 'The native suite starts with its disposable fixture project')
  const temporary = mkdtempSync(join(tmpdir(), 'trezi-planning-smoke-'))
  const destination = join(temporary, 'price-board')
  let completions = 0
  const stub = stubPlanningForSmoke({
    complete: async () => {
      completions++
      return completions === 1
        ? JSON.stringify({
            reply: 'What should the pricing page compare?',
            choices: ['Three plans', 'Two products']
          })
        : JSON.stringify({
            reply: 'I recommend a small static site for this pricing page.',
            plan: { name: 'Price Board', stack: 'Static HTML and CSS', template: 'empty' }
          })
    },
    create: (root) =>
      workflowOwner().createProject(
        root,
        {
          'index.html': '<!doctype html><title>Price Board</title><h1>Price Board</h1>'
        },
        null
      )
  })
  saved = {
    invoke: nativeChat.services.invoke,
    readiness: structuredClone(nativeChat.readiness),
    window: (await host.request('startPerform', {})).window,
    root: project.root,
    temporary,
    stub,
    workspaceInvoke: nativeWorkspace.services.invoke,
    choices: [...nativeChat.choices]
  }
  let continuationSends = 0
  let fixtureSends = 0
  const original = saved.invoke
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'providers:check-login') return { loggedIn: true }
    if (channel === 'agent:send' && nativeWorkspace.active?.root === destination) {
      continuationSends++
      const key = String(args[2])
      queueMicrotask(() => nativeChat.event({ type: 'done', projectKey: key }))
      return { ok: true }
    }
    if (channel === 'agent:send' && nativeWorkspace.active?.root === project.root) {
      fixtureSends++
      const key = String(args[2])
      queueMicrotask(() => nativeChat.event({ type: 'done', projectKey: key }))
      return { ok: true }
    }
    if (channel === 'agent:restart-chat' && args[0] === project.root) return { ok: true }
    return original(channel, ...args)
  }

  await nativeWorkspace.command({ type: 'close', key: project.key })
  nativeChat.checkReadiness()
  await nativeChat.refreshReadiness()
  await host.request('startPerform', { reduceMotion: false })
  const start = () => host.request('startPerform', {})
  const home = await until(
    start,
    (state) => state.wantsCentered && state.progress === 0 && state.surface.home,
    'full-width home'
  )
  assert.equal(home.surface.heading, 'What do you want to create?')
  assert.equal(home.composer.projectTitle, 'New Project')
  assert.equal(home.composer.projectVisible, true)
  assert.equal(home.surface.recents.includes(project.name), true)
  assert.equal((await host.request('shellInspect')).sidebarCollapsed, true)
  assert.equal((await host.request('sheetInspect')).visible, false)

  for (const size of [NORMAL, NARROW]) {
    await host.request('startPerform', size)
    for (const appearance of ['light', 'dark']) {
      const capture = await host.request('startPerform', {
        appearance,
        capture: background() ? 'offscreen' : 'foreground'
      })
      assert.equal(capture.dark, appearance === 'dark')
      const name = `start-home-${size === NARROW ? 'narrow' : 'normal'}-${appearance}`
      writeFileSync(join(artifacts, `${name}.png`), Buffer.from(capture.png, 'base64'))
      writeFileSync(join(artifacts, `${name}.json`), JSON.stringify(capture.start, null, 2))
    }
    await host.request('startPerform', { appearance: null })
  }
  await host.request('startPerform', NORMAL)
  await host.request('composerPerform', { text: 'Build a pricing page' })
  await host.request('composerPerform', { action: 'send' })
  const docked = await until(
    start,
    (state) => state.start.planning && state.progress === 1,
    'planning chat docks'
  )
  assert.equal(docked.glides, home.glides + 1, 'The first accepted send docks once')
  const planningId = nativeChat.active
  assert.equal(completions, 1)
  assert.equal(nativeChat.get(planningId).messages[0].text, 'Build a pricing page')
  assert.equal((await host.request('sheetInspect')).visible, false, 'No setup sheet appears')
  assert.equal(nativeWorkspace.active, null, 'Planning does not fabricate an open project')
  const planning = await host.request('startPerform', {
    appearance: 'light',
    capture: background() ? 'offscreen' : 'foreground'
  })
  writeFileSync(join(artifacts, 'start-planning-light.png'), Buffer.from(planning.png, 'base64'))
  await host.request('startPerform', { appearance: null })
  const question = nativeChat
    .get(planningId)
    .messages.flatMap((message) => message.segments)
    .find((segment) => segment.kind === 'ui' && segment.ui.component.kind === 'options')
  assert.ok(
    question && question.kind === 'ui',
    'The provider question appears as a native answer card'
  )
  await nativeChat.action({
    chat: planningId,
    action: 'chat-ui',
    id: question.ui.id,
    value: JSON.stringify({ choice: '0' })
  })
  await until(start, () => completions === 2, 'the quick answer reaches planning')
  const form = await until(
    async () =>
      nativeChat
        .get(planningId)
        .messages.flatMap((message) => message.segments)
        .find((segment) => segment.kind === 'ui' && segment.ui.component.kind === 'form'),
    (segment) => !!segment,
    'the inline destination form'
  )
  assert.ok(form && form.kind === 'ui')
  assert.equal(nativeWorkspace.active, null, 'A proposed plan creates no project')
  await nativeChat.action({
    chat: planningId,
    action: 'chat-ui',
    id: form.ui.id,
    value: JSON.stringify({
      values: { name: 'Price Board', destination, stack: 'Static HTML and CSS' }
    })
  })
  await until(
    start,
    () => nativeWorkspace.active?.root === destination,
    'the service-created project opens'
  )
  await until(
    async () => nativeWorkspace.active?.url ?? '',
    (url) => !!url,
    'managed preview URL'
  )
  const title = await until(
    () => host.request('evaluate', { view: 'preview', code: 'document.title' }),
    (value) => String(value).includes('Price Board'),
    'the managed preview loads'
  )
  assert.match(String(title), /Price Board/)
  assert.equal(completions, 2, 'The initial brief is not sent twice')
  assert.equal((await host.request('sheetInspect')).visible, false)
  const bound: WorkspaceSnapshot = await original('agent:workspace-snapshot')
  assert.equal(
    bound.projects.find((item) => item.root === destination)?.chats[0].record.id,
    planningId,
    'The same session record binds to the new project'
  )
  assert.equal(
    nativeChat
      .get(nativeWorkspace.active!.activeSessionKey)
      .messages.some((message) => message.text === 'Build a pricing page'),
    true,
    'The transcript binds to the project'
  )
  assert.equal(continuationSends, 1, 'The agreed plan continues without repeating the first prompt')
  await nativeWorkspace.command({ type: 'close', key: nativeWorkspace.active!.key })
  await until(
    start,
    (state) => state.wantsCentered && state.progress === 0,
    'closing the new project returns home'
  )
  const sendsBeforePicker = continuationSends
  const fixtureSendsBeforePicker = fixtureSends
  await host.request('startPerform', { action: 'start-target', value: project.root })
  const selected = await start()
  assert.equal(selected.composer.projectTitle, project.name)
  assert.equal(nativeWorkspace.active, null, 'The picker keeps the centered home')
  assert.equal(selected.progress, 0)
  assert.equal(continuationSends, sendsBeforePicker)
  assert.equal(fixtureSends, fixtureSendsBeforePicker)
  assert.equal((await host.request('shellInspect')).sidebarCollapsed, true)
  await host.request('composerPerform', { text: 'Use the fixture project' })
  assert.equal(nativeWorkspace.active, null, 'Typing does not open the project')
  assert.equal((await host.request('shellInspect')).sidebarCollapsed, true)
  assert.equal((await start()).progress, 0)
  await host.request('startPerform', { action: 'start-target-new' })
  assert.equal((await start()).composer.projectTitle, 'New Project')
  assert.equal(nativeChat.get('').text, 'Use the fixture project')
  await host.request('startPerform', { action: 'start-target', value: project.root })
  const homeSettings = nativeChat.get('').settings
  const baseModel = nativeChat.choices.find((choice) => choice.provider === homeSettings.provider)
  assert.ok(baseModel, 'The home provider has a model')
  const otherModel = {
    ...baseModel,
    value: 'lkm243-fixture-model',
    modelId: 'lkm243-fixture-model',
    label: 'Fixture Model'
  }
  nativeChat.choices = [...nativeChat.choices, otherModel]
  nativeChat.changed()
  await nativeChat.composer({ chat: '', action: 'choice', label: 'Model', value: otherModel.value })
  await host.request('composerPerform', { files: [join(_fixture, 'index.html')] })
  await until(
    () => Promise.resolve(nativeChat.get('').attachments.length),
    (count) => count === 1,
    'the home attachment'
  )
  await host.request('composerPerform', { action: 'send' })
  await host.request('composerPerform', { action: 'send' })
  await until(
    start,
    () => nativeWorkspace.active?.root === project.root && !nativeChat.start.pending,
    'Send opens and settles the selected target'
  )
  assert.equal(nativeChat.get('').text, '', 'The sent draft leaves home once')
  assert.equal(nativeChat.start.pending, false)
  await until(
    () => Promise.resolve(fixtureSends),
    (count) => count === fixtureSendsBeforePicker + 1,
    'one provider send'
  )
  const sentChat = nativeChat.get(nativeWorkspace.active!.activeSessionKey)
  assert.equal(sentChat.settings.model, otherModel.value)
  const sentMessages = sentChat.messages.filter(
    (message) => message.role === 'user' && message.text === 'Use the fixture project'
  )
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].attachments?.[0]?.name, 'index.html')
  assert.equal((await start()).progress, 1)
  assert.equal((await host.request('shellInspect')).sidebarCollapsed, false)
  // The fixture model was remembered as the preferred one; later checks open chats from it.
  nativeChat.services.effect({
    type: 'settings',
    chat: sentChat.chat,
    root: sentChat.root,
    settings: { ...homeSettings }
  })
  nativeChat.get('').settings = homeSettings
  await nativeWorkspace.command({ type: 'close', key: nativeWorkspace.active!.key })
  await until(
    start,
    (state) => state.wantsCentered && state.progress === 0,
    'home after selected project'
  )
  await host.request('composerPerform', { text: 'Keep this unsent' })
  await host.request('startPerform', { action: 'start-recent', value: project.root })
  await until(
    start,
    () => nativeWorkspace.active?.root === project.root,
    'bottom recent opens directly'
  )
  assert.equal(
    nativeChat.get('').text,
    'Keep this unsent',
    'Direct navigation keeps the home draft'
  )
  await nativeWorkspace.command({ type: 'close', key: nativeWorkspace.active!.key })
  await until(
    start,
    (state) => state.wantsCentered && state.progress === 0,
    'home after direct navigation'
  )
  await host.request('composerPerform', { text: '' })
  await host.request('composerPerform', { text: 'Cancel this plan' })
  await host.request('composerPerform', { action: 'send' })
  await until(
    start,
    (state) => state.start.planning && state.progress === 1,
    'planning before cancel'
  )
  await nativeChat.action({ chat: nativeChat.start.planningKey!, action: 'planning-cancel' })
  const canceled = await until(
    start,
    (state) =>
      state.wantsCentered &&
      state.progress === 0 &&
      state.surface.home &&
      state.hits?.[project.root] === 'surface' &&
      state.hits?.open === 'surface',
    'cancel returns to reachable home controls'
  )
  assert.equal(canceled.composer.projectTitle, 'New Project')
  await host.request('startPerform', { action: 'start-recent', value: project.root })
  await until(
    start,
    () => nativeWorkspace.active?.root === project.root,
    'recent opens after planning cancel'
  )
  assert.equal(fixtureSends, fixtureSendsBeforePicker + 1, 'recent sends no draft')
  await nativeWorkspace.command({ type: 'close', key: nativeWorkspace.active!.key })
  await until(
    start,
    (state) => state.wantsCentered && state.progress === 0,
    'home after canceled-plan recent'
  )
  const workspaceInvoke = saved.workspaceInvoke
  nativeWorkspace.services.invoke = async (channel, ...args) =>
    channel === 'project:pick' ? project.root : workspaceInvoke(channel, ...args)
  await host.request('startPerform', { action: 'start-open' })
  await until(
    start,
    () => nativeWorkspace.active?.root === project.root,
    'Open Project opens after planning cancel'
  )
  assert.equal(fixtureSends, fixtureSendsBeforePicker + 1, 'Open Project sends no draft')
  nativeWorkspace.services.invoke = saved.workspaceInvoke
  await until(
    start,
    (state) => !state.wantsCentered && nativeWorkspace.active?.root === project.root,
    'fixture reopened'
  )
}

export async function restoreStartComposer(host: NativeBridge) {
  if (!saved) return
  const { invoke, readiness, window, root, temporary, stub, workspaceInvoke, choices } = saved
  saved = null
  if (nativeChat.start.planningKey)
    await nativeChat.action({ chat: nativeChat.start.planningKey, action: 'planning-cancel' })
  nativeChat.services.invoke = invoke
  nativeWorkspace.services.invoke = workspaceInvoke
  nativeChat.choices = choices
  stub.restore()
  nativeChat.start.enabled = false
  Object.assign(nativeChat.readiness, readiness)
  await host.request('startPerform', { reduceMotion: null, appearance: null, ...window })
  if (nativeWorkspace.active?.root !== root) await nativeWorkspace.command({ type: 'open', root })
  rmSync(temporary, { recursive: true, force: true })
  nativeChat.changed()
}
