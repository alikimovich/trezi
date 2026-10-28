import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubAgentSendForSmoke } from '../main/agent'
import type { AgentEvent } from '../shared/api'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { requireCleanSharedChat } from './smoke-shared-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

/**
 * LKM-268: the chat header's history menu, opened through AppKit's real tracking loop
 * (`HistoryVerification.swift`). A turn runs in chat A while chat B is active, so A's row shows
 * Running; its answer then finishes in the background and the row shows the unread dot until A is
 * opened. Reduce Motion is a test override of the menu alone; no system setting changes. Appearance
 * is forced on the menu only. The menu images land in the artifacts folder for inspection.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let stub: ReturnType<typeof stubAgentSendForSmoke> | undefined
let home = ''

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Shell = any

export async function checkHistoryMenu(host: NativeBridge, artifacts: string) {
  const a = nativeChat.active
  home = a
  const menu = (op: string, extra: object = {}) => host.request('historyMenu', { op, ...extra })
  const shell = (): Promise<Shell> => host.request('shellInspect')
  const row = (state: Shell, chat: string) =>
    state.historyRows?.find((r: Shell) => r.id === `chat:${chat}`)
  const label = async (chat: string) => row(await shell(), chat)?.label ?? ''
  const labelEnds = (chat: string, suffix: string) =>
    waitFor(async () => {
      const state = await shell()
      return (row(state, chat)?.label ?? '').endsWith(suffix) && state
    }, `history row ${chat} ends with ${suffix}`)
  const sent: unknown[][] = []
  stub = stubAgentSendForSmoke(a, (...args) => {
    sent.push(args)
  })

  // A turn in chat A; then chat B becomes the active chat and A is a background chat.
  await requireCleanSharedChat(host, 'history-menu', {
    state: () => nativeChat.services.invoke('agent:turn-state', a),
    controller: () => nativeChat.get(a)
  })
  await host.request('composerPerform', { text: 'History indicator turn' })
  await waitFor(async () => (await host.request('composerInspect')).enabled, 'composer enabled')
  await host.request('composerPerform', { action: 'send' })
  await waitFor(() => sent.length === 1, 'turn reached the provider stub')
  host.emit('shell-action', { action: 'new-chat', project: nativeWorkspace.state.activeKey })
  await waitFor(() => nativeChat.active !== a, 'second chat became active')
  const b = nativeChat.active
  stub.emit({
    type: 'delta',
    text: 'An answer that arrives while this chat is in the background.'
  } as AgentEvent)

  // Running takes precedence over unread; the unread flag is already set underneath it.
  const running = await labelEnds(a, ', Running')
  if (!nativeChat.get(a).unreadAnswer)
    throw new Error('A background answer did not set the unread flag')
  if (!row(running, b)?.label.endsWith(', Read') || !row(running, b).selected)
    throw new Error(
      `The active chat's row is not a selected Read row: ${JSON.stringify(row(running, b))}`
    )
  if (row(running, a).slotLength !== 3 || row(running, a).selected)
    throw new Error('The running background row lost its fixed dot slot or gained a checkmark')

  const reduce = (value: boolean | null) => menu('reduce-motion', { value })
  const capture = async (name: string) => {
    const shot = await waitFor(
      () => menu('capture').catch(() => false),
      `history menu capture ${name}`
    )
    writeFileSync(join(artifacts, `history-menu-${name}.png`), Buffer.from(shot.png, 'base64'))
    return shot
  }
  const open = async (appearance: 'light' | 'dark') => {
    await menu('open', { appearance })
    return waitFor(
      async () => (await shell()).historyTracking && (await shell()),
      `history menu tracking (${appearance})`
    )
  }
  const close = async () => {
    await menu('close')
    const closed = await waitFor(async () => {
      const state = await shell()
      return !state.historyTracking && state
    }, 'history menu dismissed')
    if (closed.historyTimer) throw new Error('History pulse timer survived menu dismissal')
    // The forced appearance is released once `popUp` returns, a moment after the delegate's close.
    await waitFor(
      async () => !(await shell()).historyAppearanceForced,
      'forced menu appearance released after dismissal'
    )
    return closed
  }
  const steady = async (chat: string) => {
    await sleep(1300)
    const state = await shell()
    if (state.historyTimer || !state.historyPulse || !(await label(chat)).endsWith(', Running'))
      throw new Error(
        `Reduce Motion left the running indicator animating: ${JSON.stringify({ timer: state.historyTimer, pulse: state.historyPulse })}`
      )
  }
  // The arrow keys drive AppKit's own highlight (`willHighlight`); a posted event first, then a CGEvent.
  const highlight = async (chat: string) => {
    for (const via of ['event', 'cgevent'])
      for (let i = 0; i < 8; i++) {
        await menu('key', { key: 'down', via })
        await sleep(150)
        const state = await shell()
        if (state.historyHighlighted === `chat:${chat}`) return state
      }
    throw new Error(`The arrow keys never highlighted the history row for ${chat}`)
  }
  const sameSize = (first: Shell, second: Shell, what: string) => {
    if (first.frame.width !== second.frame.width || first.frame.height !== second.frame.height)
      throw new Error(
        `${what}: the menu resized (${JSON.stringify(first.frame)} -> ${JSON.stringify(second.frame)})`
      )
  }

  // Session 0 (dark, Reduce Motion): a running row is steady, with no timer at all.
  await reduce(true)
  let state = await open('dark')
  if (state.historyTimer || !state.historyReduceMotion)
    throw new Error('Reduce Motion still started the pulse timer')
  await steady(a)
  const runningDark = await capture('running-dark')
  state = await close()

  // Session 1 (light): the pulse runs, then Reduce Motion, then the answer finishes while the menu is open.
  await reduce(false)
  state = await open('light')
  if (!state.historyTimer || state.historyReduceMotion)
    throw new Error('A running row did not start the pulse timer while tracking')
  const initial = state.historyPulse
  await waitFor(
    async () => (await shell()).historyPulse !== initial,
    'history pulse toggles during tracking',
    3000
  )
  const trackedA = row(state, a)
  const trackedWidth = state.historyMenuWidth
  await reduce(true)
  state = await waitFor(
    async () => !(await shell()).historyTimer && (await shell()),
    'pulse timer stops under Reduce Motion'
  )
  await steady(a)
  const runningLight = await capture('running-light')
  sameSize(runningDark, runningLight, 'running dark/light')
  stub.emit({ type: 'done' } as AgentEvent)
  state = await labelEnds(a, ', Unread answer')
  const unreadA = row(state, a)
  if (
    !state.historyTracking ||
    state.historyTimer ||
    unreadA.identity !== trackedA.identity ||
    unreadA.slotLength !== 3 ||
    !row(state, b).selected ||
    state.historyMenuWidth !== trackedWidth
  )
    throw new Error(
      `The live update replaced a tracked item, lost the checkmark or resized: ${JSON.stringify(unreadA)}`
    )
  const unreadLight = await capture('unread-light')
  sameSize(runningLight, unreadLight, 'running/unread light')
  await highlight(a)
  const highlightedLight = await capture('unread-highlighted-light')
  sameSize(unreadLight, highlightedLight, 'unread/highlighted light')
  state = await close()
  // Opening, highlighting and closing the menu did not read the answer.
  if (!(await label(a)).endsWith(', Unread answer') || !nativeChat.get(a).unreadAnswer)
    throw new Error('Opening the history menu marked the answer read')

  // Session 2 (dark): the same unread row, and its highlight.
  state = await open('dark')
  const unreadDark = await capture('unread-dark')
  sameSize(unreadLight, unreadDark, 'unread light/dark')
  await highlight(a)
  await capture('unread-highlighted-dark')
  state = await close()

  // Opening the conversation clears the dot.
  await reduce(null)
  await host.request('shellPerform', { action: 'history-select', row: `chat:${a}` })
  await waitFor(() => nativeChat.active === a, 'history row opened chat A')
  state = await labelEnds(a, ', Read')
  if (nativeChat.get(a).unreadAnswer || !row(state, a).selected)
    throw new Error('Opening the unread conversation did not clear its dot')
  if (state.historyTimer || state.historyTracking)
    throw new Error('A closed history menu kept tracking state')
  await restoreHistoryMenu(host)
}

/** Leaves the menu closed, the system Reduce Motion preference in charge, the stub off and chat A active. */
export async function restoreHistoryMenu(host: NativeBridge) {
  await host.request('historyMenu', { op: 'close' }).catch(() => {})
  await host.request('historyMenu', { op: 'reduce-motion', value: null }).catch(() => {})
  stub?.restore()
  stub = undefined
  const key = nativeWorkspace.state.activeKey
  if (home && key && nativeChat.active !== home)
    await nativeWorkspace.command({ type: 'chat', key, session: home }).catch(() => {})
}
