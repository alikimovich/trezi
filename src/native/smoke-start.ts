import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubAgentSendForSmoke } from '../main/agent'
import type { AgentEvent } from '../shared/api'
import { providerKeyFor, providerOptions } from '../shared/provider-choices'
import type { ProviderReadinessMap } from '../shared/provider-readiness'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { restoreSidebarFocus } from './smoke-sidebar'
import { nativeWorkspace } from './workspace-runtime'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const background = () => process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'
const NORMAL = { width: 1320, height: 860 }
const NARROW = { width: 860, height: 640 }

/** "{{x, y}, {w, h}}" from NSStringFromRect. */
function rect(value: string) {
  const [x, y, width, height] = (value.match(/-?[\d.]+/g) ?? []).map(Number)
  return { x, y, width, height }
}

/** A new chat's provider session is prepared in the background (LKM-182): stub its send
 *  once it exists, and only then send, so no provider is ever called. */
async function stubSend(chat: string, send: Parameters<typeof stubAgentSendForSmoke>[1]) {
  for (const end = Date.now() + 30000; ; await pause(100)) {
    try {
      return stubAgentSendForSmoke(chat, send)
    } catch (error) {
      if (Date.now() > end) throw error
    }
  }
}

let saved: {
  invoke: typeof nativeChat.services.invoke
  readiness: ProviderReadinessMap
  window: { width: number; height: number }
  session: string
  stubs: { restore(): void }[]
} | null = null

/**
 * LKM-232: a new, empty chat in the loaded project opens on the centered start composer;
 * its first accepted message moves the same chat (text, attachment, model, focus) to the
 * left column with the preview, through the real composer and project-menu actions.
 * Readiness is a scripted `providers:check-login` and the provider's send is stubbed: no
 * provider call, no keychain, no system setting. Window appearance and Reduce Motion are
 * overridden on Trezi's own window only and restored in `restoreStartComposer`.
 */
export async function checkStartComposer(host: NativeBridge, fixture: string, artifacts: string) {
  const key = nativeWorkspace.state.activeKey!
  const project = nativeWorkspace.active!.name
  const initial = await host.request('startPerform', {})
  const login: Record<string, boolean> = { claude: true, codex: true }
  const sent: unknown[][] = []
  saved = {
    invoke: nativeChat.services.invoke,
    readiness: structuredClone(nativeChat.readiness),
    window: initial.window,
    session: nativeChat.active,
    stubs: []
  }
  const original = saved.invoke
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'providers:check-login') return { loggedIn: login[String(args[0])] }
    return original(channel, ...args)
  }
  const until = async (method: string, check: (s: any) => boolean, label: string, params = {}) => {
    let last: any
    for (const end = Date.now() + 15000; Date.now() < end; await pause(50)) {
      last = await host.request(method, params)
      if (check(last)) return last
    }
    throw new Error(`Start composer: ${label}: ${JSON.stringify(last)}`)
  }
  const start = (check: (s: any) => boolean, label: string) => until('startPerform', check, label)
  const centered = (s: any) => s.wantsCentered && s.progress === 0 && s.surface.visible
  const docked = (s: any) => !s.wantsCentered && s.progress === 1 && !s.animating
  const newChat = async () => {
    const before = nativeChat.active
    host.emit('shell-action', { action: 'new-chat', project: key })
    await until('composerInspect', () => nativeChat.active !== before, 'a new chat')
    await until('composerInspect', () => !!nativeChat.get(nativeChat.active)?.ready, 'chat ready')
    return nativeChat.active
  }
  const geometry = (s: any, stage: string) => {
    const column = rect(s.composer.column)
    const frame = rect(s.composer.frame)
    const expected = Math.min(860, Math.max(Math.min(560, column.width - 48), column.width * 0.46))
    assert.ok(
      Math.abs(frame.width - expected) <= 1 &&
        Math.abs(frame.x - (column.width - expected) / 2) <= 1,
      `Start composer ${stage}: centered at ~46% of the content width: ${JSON.stringify(s.composer)}`
    )
    assert.ok(frame.x >= 0 && frame.x + frame.width <= column.width, `${stage}: fits the window`)
  }
  const capture = async (stage: string, size: { width: number; height: number }) => {
    const shots: Record<string, unknown> = {}
    await host.request('startPerform', size)
    for (const appearance of ['light', 'dark']) {
      const shot = await host.request('startPerform', {
        appearance,
        capture: background() ? 'offscreen' : 'foreground'
      })
      assert.equal(shot.dark, appearance === 'dark', `${stage} ${appearance}: window appearance`)
      const name = `start-${stage}-${size === NARROW ? 'narrow' : 'normal'}-${appearance}`
      writeFileSync(join(artifacts, `${name}.png`), Buffer.from(shot.png, 'base64'))
      shots[appearance] = shot.start
    }
    await host.request('startPerform', { appearance: null })
    const state = await host.request('startPerform', {})
    writeFileSync(
      join(artifacts, `start-${stage}-${size === NARROW ? 'narrow' : 'normal'}.json`),
      JSON.stringify(
        {
          stage,
          size,
          state,
          shots,
          capture: background()
            ? 'offscreen (TREZI_NATIVE_BACKGROUND_TEST=1: reduced coverage)'
            : 'foreground window'
        },
        null,
        2
      )
    )
    return state
  }
  if (background())
    console.log(
      'Reduced coverage: start composer captured offscreen (TREZI_NATIVE_BACKGROUND_TEST).'
    )
  else await restoreSidebarFocus(host, 'start composer')

  nativeChat.checkReadiness()
  await nativeChat.refreshReadiness()
  await host.request('startPerform', { reduceMotion: false })

  // A new, empty chat centers: heading, one wide composer, the project in its menu.
  const first = await newChat()
  let state = await start(centered, 'the new chat centers')
  assert.equal(state.surface.heading, 'What do you want to create?')
  assert.equal(state.composer.visible, true)
  assert.equal(state.composer.superview, true, 'The one composer stays in the chat column')
  assert.equal(state.composer.projectVisible, true)
  assert.equal(state.composer.projectTitle, project)
  assert.ok(state.composer.projectItems.includes('Open Project…'), JSON.stringify(state.composer))
  assert.ok(state.composer.projectItems.includes('New Project…'))
  await until('startPerform', (s) => s.composer.firstResponder, 'the composer takes focus')
  geometry(state, 'normal')
  assert.equal(state.pageSurfaceAlpha, 0, "The page's titlebar fill and edge wait for the preview")
  assert.notEqual(state.tint, '', 'The address follows the start surface, not the hidden page')

  for (const size of [NORMAL, NARROW]) geometry(await capture('centered', size), 'resized')
  await host.request('startPerform', NORMAL)

  // An empty send stays centered.
  await host.request('composerPerform', { text: '' })
  await host.request('composerPerform', { action: 'send' })
  await pause(200)
  assert.ok(centered(await host.request('startPerform', {})), 'An empty send stays centered')
  assert.equal(nativeChat.get(first).messages.length, 0)

  // Losing the selected provider keeps the draft and offers the other one.
  await host.request('composerPerform', { text: 'Keep this draft' })
  const selected = nativeChat.get(first).settings
  const other = providerOptions(nativeChat.choices).find(
    (option) => !option.connectionId && option.key !== providerKeyFor(selected)
  )
  if (!selected.connectionId && other) {
    login[selected.provider] = false
    await nativeChat.refreshReadiness()
    state = await start(
      (s) => s.start?.notice?.actions?.some((a: any) => a.action === 'start-provider'),
      'the switch notice'
    )
    assert.ok(centered(state), 'Another provider can still answer: the screen stays usable')
    await until('composerInspect', (s) => !s.enabled, 'Send waits for a provider')
    await host.request('composerPerform', { action: 'send' })
    await pause(200)
    assert.equal(nativeChat.get(first).messages.length, 0, 'A lost provider never sends')
    await host.request('startPerform', { action: 'start-provider', value: other.key })
    await until(
      'composerInspect',
      () => providerKeyFor(nativeChat.get(first).settings) === other.key,
      'switched provider'
    )
    assert.equal(nativeChat.get(first).text, 'Keep this draft', 'The draft survives the switch')
    login[selected.provider] = true
    await nativeChat.refreshReadiness()
    await start((s) => !s.start?.notice, 'the notice clears')
    // The empty chat may be the shared smoke chat: later checks expect its provider.
    await nativeChat.choice(nativeChat.get(first), 'Provider', providerKeyFor(selected))
    await until(
      'composerInspect',
      () => {
        const chat = nativeChat.get(first)
        return providerKeyFor(chat.settings) === providerKeyFor(selected) && !chat.switching
      },
      'the original provider again'
    )
  } else console.log('Start composer: one built-in provider listed; provider switch not exercised')

  // The first send: text, attachment, model and focus survive the move; sent once.
  const model = nativeChat.get(first).settings.model
  const provider = await stubSend(first, (...args) => {
    sent.push(args)
  })
  saved.stubs.push(provider)
  await host.request('composerPerform', {
    text: 'Build a pricing page',
    files: [join(fixture, 'native-style.tsx')]
  })
  await until(
    'composerInspect',
    (s) => s.attachments?.length === 1 && s.enabled,
    'a draft with a file'
  )
  const focused = (await host.request('startPerform', {})).composer.firstResponder
  const glides = state.glides
  await host.request('composerPerform', { action: 'send' })
  const frames: any[] = []
  for (const end = Date.now() + 5000; Date.now() < end; await pause(16)) {
    const s = await host.request('startPerform', {})
    frames.push({ progress: s.progress, composer: s.composer.visible, column: s.columnHidden })
    if (docked(s)) break
  }
  state = await start(docked, 'the chat docks left')
  assert.equal(state.glides, glides + 1, 'The move animates')
  assert.ok(
    frames.every((f) => f.composer && !f.column),
    `No blank frame during the move: ${JSON.stringify(frames)}`
  )
  assert.equal(state.columnHidden, false)
  assert.equal(state.surface.visible, false)
  assert.equal(state.pageSurfaceAlpha, 1)
  assert.equal(state.tint, '', 'The address follows the page again')
  assert.equal(state.composer.projectVisible, false, 'The docked composer has no project menu')
  assert.equal(state.composer.firstResponder, focused, 'Focus stays in the composer')
  const layout = await host.request('layoutInspect')
  assert.equal(layout.previewHidden, false, 'The preview is revealed')
  const users = nativeChat.get(first).messages.filter((m) => m.role === 'user')
  assert.deepEqual(
    users.map((m) => m.text),
    ['Build a pricing page'],
    'The first prompt appears exactly once'
  )
  assert.equal(users[0].attachments?.length, 1, 'The attachment moves with it')
  assert.equal(nativeChat.get(first).settings.model, model, 'The model is kept')
  await until('composerInspect', () => sent.length > 0, 'the provider send')
  await pause(200)
  assert.equal(sent.length, 1, 'One provider send')
  // The reply streams into the docked chat.
  provider.emit({ type: 'delta', text: 'Streaming after the move.' } as AgentEvent)
  provider.emit({ type: 'done' } as AgentEvent)
  await until(
    'chatInspect',
    (s) => s.messages.some((m: any) => m.role === 'assistant' && m.text.includes('Streaming')),
    'the streamed reply'
  )
  for (const size of [NORMAL, NARROW]) await capture('docked', size)
  await host.request('startPerform', NORMAL)

  // Zero providers: the project's new chat shows LKM-231's card in the left layout.
  const second = await newChat()
  await start(centered, 'another new chat centers')
  login.claude = login.codex = false
  await nativeChat.refreshReadiness()
  await start((s) => !s.wantsCentered, 'no provider leaves the centered screen')
  await until('chatInspect', (s) => s.cards.includes('provider-start'), 'the provider card')
  login.claude = login.codex = true
  await nativeChat.refreshReadiness()
  await start(centered, 'a provider centers the empty chat again')

  // Reduce Motion: the move is immediate.
  await host.request('startPerform', { reduceMotion: true })
  let reducedSends = 0
  const reduced = await stubSend(second, () => {
    reducedSends++
  })
  saved.stubs.push(reduced)
  await host.request('composerPerform', { text: 'Reduced motion' })
  await until('composerInspect', (s) => s.enabled, 'a reduced-motion draft')
  const snap = (await host.request('startPerform', {})).glides
  await host.request('composerPerform', { action: 'send' })
  state = await start(docked, 'reduced motion docks')
  assert.equal(state.glides, snap, 'Reduce Motion: no glide')
  assert.equal(state.reduceMotion, true)
  // End the stubbed turn once it reached the provider (after the dock): later checks
  // count the project's running chats.
  await until('composerInspect', () => reducedSends > 0, 'the reduced-motion provider send')
  reduced.emit({ type: 'done' } as AgentEvent)
  await until('composerInspect', () => !nativeChat.get(second).isRunning, 'the turn ends')

  // Reopening a conversation opens it in the left layout, with no glide.
  await nativeWorkspace.command({ type: 'chat', key, session: first })
  state = await start((s) => docked(s) && s.chat === first, 'the reopened chat')
  assert.equal(state.glides, snap)
}

export async function restoreStartComposer(host: NativeBridge) {
  if (!saved) return
  const { invoke, readiness, window, session, stubs } = saved
  saved = null
  for (const stub of stubs) stub.restore()
  nativeChat.services.invoke = invoke
  nativeChat.start.enabled = false
  Object.assign(nativeChat.readiness, readiness)
  await host.request('startPerform', { reduceMotion: null, appearance: null, ...window })
  const key = nativeWorkspace.state.activeKey
  if (key && session && nativeChat.active !== session)
    await nativeWorkspace.command({ type: 'chat', key, session })
  nativeChat.changed()
}
