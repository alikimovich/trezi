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
    stub
  }
  let continuationSends = 0
  const original = saved.invoke
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'providers:check-login') return { loggedIn: true }
    if (channel === 'agent:send' && nativeWorkspace.active?.root === destination) {
      continuationSends++
      const key = String(args[2])
      queueMicrotask(() => nativeChat.event({ type: 'done', projectKey: key }))
      return { ok: true }
    }
    return original(channel, ...args)
  }

  if ((await host.request('shellInspect')).sidebarCollapsed)
    await host.request('shellPerform', { action: 'toggle-sidebar' })
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
  assert.equal(await host.request('shellPerform', { action: 'toggle-sidebar' }), false)
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
  const planningShell = await host.request('shellInspect')
  assert.equal(planningShell.sidebarCollapsed, false, 'Docked planning restores the sidebar')
  assert.ok(
    planningShell.visibleToolbar.includes('NSToolbarToggleSidebarItem'),
    'Native sidebar toggle is visible'
  )
  assert.deepEqual(planningShell.sidebarActions, ['new-project', 'open-project'])
  assert.equal(await host.request('shellPerform', { action: 'toggle-sidebar' }), true)
  assert.equal((await host.request('shellInspect')).sidebarCollapsed, true)
  assert.equal(await host.request('shellPerform', { action: 'toggle-sidebar' }), true)
  assert.equal((await host.request('shellInspect')).sidebarCollapsed, false)
  assert.equal(nativeChat.active, planningId)
  assert.equal(nativeChat.get(planningId).messages[0].text, 'Build a pricing page')
  assert.equal(completions, 1, 'Toggling the sidebar does not send again')
  const planning = await host.request('startPerform', {
    appearance: 'light',
    capture: background() ? 'offscreen' : 'foreground'
  })
  writeFileSync(join(artifacts, 'start-planning-light.png'), Buffer.from(planning.png, 'base64'))
  for (const size of [NORMAL, NARROW]) {
    await host.request('startPerform', size)
    for (const appearance of ['light', 'dark']) {
      const capture = await host.request('startPerform', {
        appearance,
        capture: background() ? 'offscreen' : 'foreground'
      })
      const shell = await host.request('shellInspect')
      assert.equal(shell.sidebarCollapsed, false)
      assert.ok(shell.sidebarWidth >= 180 && shell.detailWidth >= 500)
      const name = `start-planning-${size === NARROW ? 'narrow' : 'normal'}-${appearance}`
      writeFileSync(join(artifacts, `${name}.png`), Buffer.from(capture.png, 'base64'))
      writeFileSync(
        join(artifacts, `${name}.json`),
        JSON.stringify({ start: capture.start, shell }, null, 2)
      )
    }
  }
  await host.request('startPerform', NORMAL)
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
  await nativeWorkspace.command({ type: 'open', root: project.root })
  await until(
    start,
    (state) => !state.wantsCentered && nativeWorkspace.active?.root === project.root,
    'fixture reopened'
  )
}

export async function restoreStartComposer(host: NativeBridge) {
  if (!saved) return
  const { invoke, readiness, window, root, temporary, stub } = saved
  saved = null
  if (nativeChat.start.planningKey)
    await nativeChat.action({ chat: nativeChat.start.planningKey, action: 'planning-cancel' })
  nativeChat.services.invoke = invoke
  stub.restore()
  nativeChat.start.enabled = false
  Object.assign(nativeChat.readiness, readiness)
  await host.request('startPerform', { reduceMotion: null, appearance: null, ...window })
  if (nativeWorkspace.active?.root !== root) await nativeWorkspace.command({ type: 'open', root })
  rmSync(temporary, { recursive: true, force: true })
  nativeChat.changed()
}
