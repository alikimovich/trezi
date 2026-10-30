import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubAgentSendForSmoke } from '../main/agent'
import type { AgentEvent } from '../shared/api'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { requireCleanSharedChat } from './smoke-shared-chat'
import { restoreSidebarFocus } from './smoke-sidebar'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

/**
 * The sidebar's chat status, with a real background turn (LKM-268's indicators, moved from the
 * retired chat-header history menu to the nested chat rows). A turn runs in chat A while chat B
 * is active, so A's row spins and reads "Running"; its answer then finishes in the background
 * and the row shows the green unread dot until A is opened from the sidebar. The sidebar image
 * lands in the artifacts folder for inspection.
 */
let stub: ReturnType<typeof stubAgentSendForSmoke> | undefined
let home = ''

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Shell = any

export async function checkSidebarStatus(host: NativeBridge, artifacts: string) {
  const a = nativeChat.active
  home = a
  const shell = (): Promise<Shell> => host.request('shellInspect')
  const row = (state: Shell, chat: string) =>
    state.sidebarChats?.find((r: Shell) => r.id === `chat:${chat}`)
  const rowIs = (chat: string, what: string, test: (item: Shell) => boolean) =>
    waitFor(
      async () => {
        const state = await shell()
        const item = row(state, chat)
        return item && test(item) && state
      },
      `sidebar row ${chat} ${what}`,
      10000,
      async () => row(await shell(), chat)
    )
  const sent: unknown[][] = []
  stub = stubAgentSendForSmoke(a, (...args) => {
    sent.push(args)
  })

  // A turn in chat A; then chat B becomes the active chat and A is a background chat.
  await requireCleanSharedChat(host, 'sidebar-status', {
    state: () => nativeChat.services.invoke('agent:turn-state', a),
    controller: () => nativeChat.get(a)
  })
  const collapsed = (await shell()).sidebarCollapsed
  if (collapsed) await host.request('shellPerform', { action: 'toggle-sidebar' })
  await host.request('composerPerform', { text: 'Sidebar indicator turn' })
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
  const running = await rowIs(
    a,
    'spins',
    (item) => item.running && item.spinning && !item.unreadDot && item.label.endsWith(', Running')
  )
  if (!nativeChat.get(a).unreadAnswer)
    throw new Error('A background answer did not set the unread flag')
  const active = row(running, b)
  if (!active?.selected || active.running || active.unreadDot)
    throw new Error(`The active chat's row is not a selected idle row: ${JSON.stringify(active)}`)

  // The answer finishes in the background: the spinner stops and the green dot shows.
  stub.emit({ type: 'done' } as AgentEvent)
  const unread = await rowIs(
    a,
    'shows the unread dot',
    (item) =>
      !item.running && !item.spinning && item.unreadDot && item.label.endsWith(', Unread answer')
  )
  if (Math.abs(row(unread, a).textOffset) >= 1)
    throw new Error('The unread dot moved the chat title')
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1') {
    await restoreSidebarFocus(host, 'sidebar-status before capture')
    const image = await host.request('captureVisibleSidebar')
    writeFileSync(join(artifacts, 'sidebar-status-unread.png'), Buffer.from(image.png, 'base64'))
  } else console.log('Sidebar status: background run, unread row not captured.')

  // Opening the conversation from the sidebar clears the dot.
  await host.request('shellPerform', { action: 'select-row', row: `chat:${a}` })
  await waitFor(() => nativeChat.active === a, 'sidebar row opened chat A')
  await rowIs(a, 'is read', (item) => item.selected && !item.unreadDot && item.label === item.title)
  if (nativeChat.get(a).unreadAnswer)
    throw new Error('Opening the unread conversation did not clear its flag')
  if (collapsed) await host.request('shellPerform', { action: 'toggle-sidebar' })
  await restoreSidebarStatus()
}

/** Leaves the stub off and chat A active. */
export async function restoreSidebarStatus() {
  stub?.restore()
  stub = undefined
  const key = nativeWorkspace.state.activeKey
  if (home && key && nativeChat.active !== home)
    await nativeWorkspace.command({ type: 'chat', key, session: home }).catch(() => {})
}
